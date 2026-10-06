import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { NextAdapter } from 'next'
import type {
  CloudRunManifest,
  FunctionEntry,
  ImagesEntry,
} from './manifest.js'

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
      // Share optimized images (`/_next/image`) through Redis too, unless the
      // app brings its own cacheHandler and decides that itself.
      if (!config.cacheHandler && config.images) {
        updated.images = { ...config.images, customCacheHandler: true }
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

    // Build outputs don't include the `public/` folder; serve it like
    // `next start` does, at `<basePath>/<file>`.
    const publicDir = path.join(ctx.projectDir, 'public')
    const publicFiles: { pathname: string; filePath: string }[] = []
    for (const relative of await fs
      .readdir(publicDir, { recursive: true })
      .catch(() => [])) {
      const filePath = path.join(publicDir, relative)
      if (!(await fs.stat(filePath)).isFile()) continue
      publicFiles.push({
        pathname: `${ctx.config.basePath || ''}/${relative.split(path.sep).join('/')}`,
        filePath,
      })
    }

    const staticFiles: Record<string, string> = {}
    for (const file of [...outputs.staticFiles, ...publicFiles]) {
      // A static file can share a pathname with a function (e.g. a static
      // HTML page that also has an RSC function); prefer the function. Build
      // outputs take precedence over public files.
      if (functions[file.pathname]) continue
      if (!('type' in file) && staticFiles[file.pathname]) continue
      const relative = file.pathname.replace(/^\/+/, '') || 'index'
      const destination = path.join(staticDir, relative)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(file.filePath, destination)
      staticFiles[file.pathname] = relative
    }

    const images = await addImageOptimizer(ctx, copyAsset)

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
      images,
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
    for (const file of ['server', 'image', 'gcs-image']) {
      await fs.copyFile(
        path.join(runtimeDir, `${file}.js`),
        path.join(runtimeTarget, `${file}.mjs`)
      )
    }
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

/** The container platform: `node:<major>-slim` is Debian (glibc) on x64. */
const TARGET = { os: 'linux', cpu: 'x64', libc: 'glibc' }

/**
 * Prepares `/_next/image`, served like `next start` by Next.js' own image
 * optimizer. Traces `next/dist/server/image-optimizer` (and through it
 * `sharp` with its `@img/*` native packages) with the copy of @vercel/nft
 * that Next.js ships, keeping only the sharp binaries for the container.
 */
async function addImageOptimizer(
  ctx: BuildCompleteContext,
  copyAsset: (target: string, source: string) => Promise<void>
): Promise<ImagesEntry | undefined> {
  const { config } = ctx
  // Like `next start`, other loaders and unoptimized images 404 here.
  if (config.images.unoptimized || config.images.loader !== 'default') return
  if (config.output === 'export') return

  const nextRequire = createRequire(path.join(ctx.projectDir, 'package.json'))
  const optimizer = nextRequire.resolve('next/dist/server/image-optimizer')
  const { nodeFileTrace } = nextRequire('next/dist/compiled/@vercel/nft')
  const { fileList, esmFileList } = await nodeFileTrace([optimizer], {
    base: ctx.repoRoot,
  })
  const files = [...new Set<string>([...fileList, ...esmFileList])]

  // Keep only the `@img/sharp-*` packages that run in the container; the
  // WebAssembly build is a fallback when no native one is installed.
  const imgPackage = /(?:^|\/)node_modules\/@img\/([^/]+)\//
  const platforms = new Map<string, 'native' | 'wasm' | 'other'>()
  for (const file of files) {
    const match = file.match(imgPackage)
    const name = match?.[1]
    if (!match || !name || platforms.has(name) || name === 'colour') continue
    const pkgDir = file.slice(0, match.index! + match[0].length)
    const pkg = JSON.parse(
      await fs
        .readFile(path.join(ctx.repoRoot, pkgDir, 'package.json'), 'utf8')
        .catch(() => '{}')
    )
    const matches = (list: string[] | undefined, value: string) =>
      !list || list.includes(value)
    platforms.set(
      name,
      name.endsWith('-wasm32') || pkg.cpu?.includes('wasm32')
        ? 'wasm'
        : matches(pkg.os, TARGET.os) &&
            matches(pkg.cpu, TARGET.cpu) &&
            matches(pkg.libc, TARGET.libc)
          ? 'native'
          : 'other'
    )
  }
  const hasSharp = files.some((file) =>
    /(?:^|\/)node_modules\/sharp\/package\.json$/.test(file)
  )
  const hasNative = [...platforms.values()].includes('native')
  const keep = (kind: string | undefined) =>
    !kind || kind === 'native' || (kind === 'wasm' && !hasNative)

  if (!hasSharp) {
    console.warn(
      '[cloud-run] `sharp` was not found, so /_next/image will serve images unoptimized. Install it in the app: npm install sharp'
    )
  } else if (![...platforms.values()].some((kind) => keep(kind))) {
    console.warn(
      `[cloud-run] sharp has no ${TARGET.os}-${TARGET.cpu} (${TARGET.libc}) binaries installed, so /_next/image will serve images unoptimized in the container. Build on linux x64, or install them: npm install --os=${TARGET.os} --cpu=${TARGET.cpu} --libc=${TARGET.libc} sharp`
    )
  }

  for (const file of files) {
    if (!keep(platforms.get(file.match(imgPackage)?.[1] ?? ''))) continue
    await copyAsset(file, path.join(ctx.repoRoot, file))
  }

  const experimental = Object.fromEntries(
    Object.entries(config.experimental).filter(
      ([key]) => key.startsWith('imgOpt') || key === 'isrFlushToDisk'
    )
  )
  let cacheHandler: string | undefined
  if (config.images.customCacheHandler && config.cacheHandler) {
    const handler = config.cacheHandler.startsWith('file://')
      ? fileURLToPath(config.cacheHandler)
      : path.resolve(ctx.projectDir, config.cacheHandler)
    cacheHandler = path.relative(ctx.repoRoot, handler)
    await copyAsset(cacheHandler, handler)
  }

  return {
    pathname: `${config.basePath || ''}/_next/image`,
    nextConfig: {
      basePath: config.basePath || '',
      images: config.images,
      experimental,
      cacheMaxMemorySize: config.cacheMaxMemorySize,
    },
    cacheHandler,
  }
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
