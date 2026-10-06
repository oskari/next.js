import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { NextAdapter } from 'next'
import type { CloudRunManifest, FunctionEntry } from './manifest.js'

type BuildCompleteContext = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]
type RouteOutput =
  | BuildCompleteContext['outputs']['pages'][number]
  | BuildCompleteContext['outputs']['pagesApi'][number]
  | BuildCompleteContext['outputs']['appPages'][number]
  | BuildCompleteContext['outputs']['appRoutes'][number]
  | NonNullable<BuildCompleteContext['outputs']['middleware']>

const nodeRequire = createRequire(import.meta.url)
const distDir = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.join(distDir, 'runtime')
const cacheDir = path.join(distDir, 'cache')

// Build artifacts under distDir that the server never reads at runtime.
const SKIPPED_DIST_ENTRIES = new Set([
  'cache',
  'standalone',
  'static',
  'adapter',
  'diagnostics',
  'trace',
  'trace-build',
  'types',
  'dev',
])

/**
 * Output layout (relative to `<projectDir>/.cloud-run`):
 *
 *   app/       container root. Mirrors the repo root so traced paths resolve.
 *     server.mjs, cloud-run-manifest.json, .cloud-run-runtime/
 *   static/    files served at their URL pathname. Upload to Cloud Storage
 *              to serve them from Cloud CDN; the server also serves them.
 *   Dockerfile
 */
const adapter: NextAdapter = {
  name: 'cloud-run',

  modifyConfig(config, { phase }) {
    if (phase !== 'phase-production-build') return config
    const updated = { ...config }

    // Serve hashed build assets from Cloud CDN (a Cloud Storage bucket)
    // instead of the Cloud Run service.
    const assetPrefix = process.env.NEXT_CLOUD_RUN_ASSET_PREFIX
    if (assetPrefix && !config.assetPrefix) {
      updated.assetPrefix = assetPrefix
    }

    // Share the ISR, data and 'use cache' caches across instances through
    // Redis (Memorystore). Handlers the app configures itself take priority.
    if (process.env.NEXT_CLOUD_RUN_CACHE === 'redis') {
      const useCacheHandler = path.join(cacheDir, 'use-cache.js')
      updated.cacheHandler ??= path.join(cacheDir, 'incremental.js')
      // The defaults hold `undefined` entries, so only keep set ones.
      const configured = Object.fromEntries(
        Object.entries(config.cacheHandlers ?? {}).filter(([, value]) => value)
      )
      updated.cacheHandlers = {
        default: useCacheHandler,
        remote: useCacheHandler,
        ...configured,
      }
    }
    return updated
  },

  async onBuildComplete(ctx) {
    const outDir = path.resolve(
      ctx.projectDir,
      process.env.NEXT_CLOUD_RUN_OUT_DIR || '.cloud-run'
    )
    const appDir = path.join(outDir, 'app')
    const staticDir = path.join(outDir, 'static')

    await fs.rm(outDir, { recursive: true, force: true })
    await fs.mkdir(appDir, { recursive: true })
    await fs.mkdir(staticDir, { recursive: true })

    const toRepoRelative = (file: string) => path.relative(ctx.repoRoot, file)
    const functions: Record<string, FunctionEntry> = {}
    const entriesById = new Map<string, FunctionEntry>()
    const copied = new Set<string>()

    const copyAsset = async (target: string, source: string) => {
      if (copied.has(target)) return
      copied.add(target)
      const destination = path.join(appDir, target)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      // Traced assets can be symlinks (pnpm); keep them as-is.
      await fs.cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        force: true,
      })
    }

    const addRouteOutput = async (output: RouteOutput) => {
      if (output.runtime === 'edge') {
        // The edge runtime is deprecated and has no Cloud Run equivalent.
        console.warn(
          `[cloud-run] skipping edge runtime output ${output.pathname}; use the Node.js runtime instead`
        )
        return
      }
      for (const [target, source] of Object.entries(output.assets)) {
        await copyAsset(target, source)
      }
      const entry: FunctionEntry = {
        type: output.type,
        entry: toRepoRelative(output.filePath),
        maxDuration: output.config.maxDuration,
      }
      await copyAsset(entry.entry, output.filePath)
      entriesById.set(output.id, entry)
      if (output.type !== 'MIDDLEWARE') {
        functions[output.pathname] = entry
      }
      return entry
    }

    const { outputs } = ctx
    const { images } = ctx.config
    if (!images.unoptimized && images.loader === 'default') {
      console.warn(
        '[cloud-run] /_next/image is not served by this adapter yet; set images.unoptimized or a custom images.loader'
      )
    }
    for (const output of [
      ...outputs.appPages,
      ...outputs.appRoutes,
      ...outputs.pages,
      ...outputs.pagesApi,
    ]) {
      await addRouteOutput(output)
    }
    const middleware = outputs.middleware
      ? await addRouteOutput(outputs.middleware)
      : undefined

    // Prerendered pathnames are served by their parent function, which reads
    // the seeded entry from Next.js' incremental cache in distDir.
    for (const prerender of outputs.prerenders) {
      const parent = entriesById.get(prerender.parentOutputId)
      if (parent && !functions[prerender.pathname]) {
        functions[prerender.pathname] = parent
      }
    }

    // Copy the distDir (prerender cache seeds, manifests) so the incremental
    // cache works without a shared backend. Swap in `cacheHandler` /
    // `cacheHandlers` for multi-instance deployments.
    for (const dirent of await fs.readdir(ctx.distDir, {
      withFileTypes: true,
    })) {
      if (SKIPPED_DIST_ENTRIES.has(dirent.name)) continue
      const source = path.join(ctx.distDir, dirent.name)
      await copyAsset(toRepoRelative(source), source)
    }

    const staticFiles: Record<string, string> = {}
    for (const file of outputs.staticFiles) {
      // A static file can share a pathname with a function (e.g. a static
      // HTML page that also has an RSC function); prefer the function.
      if (functions[file.pathname]) continue
      const relative = file.pathname.replace(/^\/+/, '') || 'index'
      const destination = path.join(staticDir, relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(file.filePath, destination)
      staticFiles[file.pathname] = relative
    }

    const manifest: CloudRunManifest = {
      version: 1,
      nextVersion: ctx.nextVersion,
      buildId: ctx.buildId,
      basePath: ctx.config.basePath || '',
      i18n: ctx.config.i18n ?? undefined,
      relativeProjectDir: toRepoRelative(ctx.projectDir) || '.',
      distDir: path.relative(ctx.projectDir, ctx.distDir),
      turbopack: Boolean(process.env.TURBOPACK),
      routing: ctx.routing,
      functions,
      middleware,
      staticFiles,
      notFound: functions['/_not-found'] ?? functions['/404'],
      error: functions['/_error'],
    }
    await fs.writeFile(
      path.join(appDir, 'cloud-run-manifest.json'),
      JSON.stringify(manifest, null, 2)
    )

    // The runtime server plus its @next/routing dependency (a single bundled
    // file), so the container needs no install step of its own.
    const runtimeTarget = path.join(appDir, '.cloud-run-runtime')
    await fs.mkdir(runtimeTarget, { recursive: true })
    await fs.copyFile(
      nodeRequire.resolve('@next/routing'),
      path.join(runtimeTarget, 'routing.cjs')
    )
    await fs.copyFile(
      path.join(runtimeDir, 'server.js'),
      path.join(runtimeTarget, 'server.mjs')
    )
    await fs.writeFile(
      path.join(appDir, 'server.mjs'),
      "import './.cloud-run-runtime/server.mjs'\n"
    )
    await fs.writeFile(path.join(outDir, 'Dockerfile'), dockerfile())

    console.log(
      `[cloud-run] wrote ${Object.keys(functions).length} routes and ${
        Object.keys(staticFiles).length
      } static files to ${path.relative(ctx.projectDir, outDir)}`
    )
  },
}

function dockerfile() {
  const nodeMajor = process.versions.node.split('.')[0]
  return `FROM node:${nodeMajor}-slim
WORKDIR /app
ENV NODE_ENV=production
COPY app/ ./
COPY static/ ./.cloud-run-static/
EXPOSE 8080
CMD ["node", "server.mjs"]
`
}

export default adapter
