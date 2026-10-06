/**
 * Runtime server copied into the container as `.cloud-run-runtime/server.mjs`.
 * It resolves Next.js routing with @next/routing and invokes the matched
 * build entrypoint. Only Node.js built-ins are imported; @next/routing is
 * copied next to this file as a single bundled module.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type * as Routing from '@next/routing'
import type { CloudRunManifest, FunctionEntry } from '../manifest.js'

type NodeHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RouteContext
) => Promise<unknown>
type WebHandler = (request: Request, ctx: RouteContext) => Promise<Response>
interface RouteContext {
  waitUntil: (promise: Promise<unknown>) => void
  requestMeta: Record<string, unknown>
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)
const manifest: CloudRunManifest = JSON.parse(
  fs.readFileSync(path.join(appRoot, 'cloud-run-manifest.json'), 'utf8')
)
const { resolveRoutes, responseToMiddlewareResult } = nodeRequire(
  './routing.cjs'
) as typeof Routing

const projectDir = path.join(appRoot, manifest.relativeProjectDir)
const distDir = path.join(projectDir, manifest.distDir)

// Run from the project directory like `next start`: entrypoints resolve the
// project from process.cwd(), and Next.js resolves the relative
// `cacheHandler`/`cacheHandlers` paths against it.
process.chdir(projectDir)
const env = process.env as Record<string, string | undefined>
env.NODE_ENV ||= 'production'
if (manifest.turbopack) env.TURBOPACK ||= '1'
// Scopes the Redis cache handlers' entries to this build.
env.NEXT_CLOUD_RUN_BUILD_ID ||= manifest.buildId

const staticDir = [
  process.env.NEXT_CLOUD_RUN_STATIC_DIR,
  path.join(appRoot, '.cloud-run-static'),
  path.join(appRoot, '..', 'static'),
].find((dir): dir is string => !!dir && fs.existsSync(dir))

// Initializes Node.js globals the entrypoints expect, without next-server.
createRequire(path.join(projectDir, 'package.json'))('next/setup-node-env')

const port = Number(process.env.PORT) || 8080
const hostname = process.env.HOSTNAME || '0.0.0.0'
const pathnames = [
  ...Object.keys(manifest.functions),
  ...Object.keys(manifest.staticFiles),
]
// Next.js mutates requestMeta per request (e.g. isRSCRequest), so every
// invocation gets its own copy.
const baseRequestMeta = {
  relativeProjectDir: '.',
  distDir,
  // Revalidate in-process over loopback instead of the public URL.
  revalidate: async ({
    urlPath,
    headers,
  }: {
    urlPath: string
    headers: Record<string, string>
  }) => {
    await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'HEAD',
      headers,
    })
  },
}

// Background work (ISR revalidation, after()) the instance must finish before
// it shuts down. Cloud Run needs CPU allocated outside requests for this.
const pending = new Set<Promise<unknown>>()
function waitUntil(promise: Promise<unknown>) {
  const tracked: Promise<unknown> = promise
    .catch((err) => console.error('[cloud-run] waitUntil rejected', err))
    .finally(() => pending.delete(tracked))
  pending.add(tracked)
}

const entryCache = new Map<string, { handler: unknown }>()
function loadEntry(fn: FunctionEntry) {
  let mod = entryCache.get(fn.entry)
  if (!mod) {
    mod = nodeRequire(path.join(appRoot, fn.entry)) as { handler: unknown }
    entryCache.set(fn.entry, mod)
  }
  return mod.handler
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  // Clients must never be able to set internal middleware headers.
  for (const key of Object.keys(req.headers)) {
    if (key.startsWith('x-middleware-')) delete req.headers[key]
  }

  const proto =
    firstHeader(req.headers['x-forwarded-proto'])?.split(',')[0] || 'http'
  // Cloud Run sets Host; x-forwarded-host is client-controlled, so ignore it.
  const host = req.headers.host || `localhost:${port}`
  const url = new URL(req.url || '/', `${proto}://${host}`)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

  // Middleware and the matched route can both read the body, so it is
  // buffered only when middleware actually runs.
  let body: Buffer | undefined
  let middlewareResponse: Response | undefined
  let middlewareRequestHeaders: Headers | undefined

  const result = await resolveRoutes({
    url,
    buildId: manifest.buildId,
    basePath: manifest.basePath,
    i18n: (manifest.i18n ?? undefined) as Routing.ResolveRoutesParams['i18n'],
    headers: toWebHeaders(req.headers),
    requestBody: new ReadableStream({ start: (c) => c.close() }),
    pathnames,
    routes: manifest.routing,
    invokeMiddleware: async (ctx) => {
      if (hasBody) body ??= await readBody(req)
      const handler = loadEntry(manifest.middleware!) as WebHandler
      const response = await handler(
        new Request(ctx.url, {
          method: req.method,
          headers: ctx.headers,
          body: body ? new Uint8Array(body) : undefined,
        }),
        { waitUntil, requestMeta: { ...baseRequestMeta } }
      )
      const middlewareResult = responseToMiddlewareResult(
        response,
        ctx.headers,
        ctx.url
      )
      if (middlewareResult.bodySent) {
        middlewareResponse = response
      } else {
        middlewareRequestHeaders = middlewareResult.requestHeaders
      }
      return middlewareResult
    },
  })

  if (result.middlewareResponded && middlewareResponse) {
    return sendWebResponse(res, middlewareResponse)
  }

  applyHeaders(res, result.resolvedHeaders)

  if (result.redirect) {
    res.statusCode = result.redirect.status
    if (!res.hasHeader('location')) {
      res.setHeader('location', result.redirect.url.toString())
    }
    return res.end()
  }

  if (result.externalRewrite) {
    const response = await fetch(result.externalRewrite, {
      method: req.method,
      headers: withoutHost(
        middlewareRequestHeaders ?? toWebHeaders(req.headers)
      ),
      body: hasBody ? new Uint8Array(body ?? (await readBody(req))) : undefined,
      redirect: 'manual',
    })
    return sendWebResponse(res, response)
  }

  const resolved = result.resolvedPathname
  if (!resolved) {
    // Routing stopped without a match, e.g. a header-only redirect rule.
    if (result.status && res.hasHeader('location')) {
      res.statusCode = result.status
      return res.end()
    }
    return notFound(req, res, body)
  }

  const fn = manifest.functions[resolved]
  if (fn) {
    if (result.invocationTarget) {
      req.url =
        result.invocationTarget.pathname +
        toSearch(result.invocationTarget.query)
    }
    if (middlewareRequestHeaders) {
      req.headers = toNodeHeaders(middlewareRequestHeaders)
    }
    if (result.status) res.statusCode = result.status
    return invokeNode(fn, body ? replayRequest(req, body) : req, res)
  }

  const staticFile = manifest.staticFiles[resolved]
  if (staticFile) {
    return serveStatic(req, res, staticFile, result.status)
  }

  return notFound(req, res, body)
}

async function invokeNode(
  fn: FunctionEntry,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const handler = loadEntry(fn) as NodeHandler
  await handler(req, res, { waitUntil, requestMeta: { ...baseRequestMeta } })
}

async function notFound(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer | undefined
) {
  res.statusCode = 404
  if (manifest.notFound) {
    return invokeNode(
      manifest.notFound,
      body ? replayRequest(req, body) : req,
      res
    )
  }
  if (manifest.staticFiles['/404']) {
    return serveStatic(req, res, manifest.staticFiles['/404'], 404)
  }
  res.end('Not Found')
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  relativePath: string,
  status?: number
) {
  if (!staticDir) {
    res.statusCode = 500
    return res.end('Static directory not found')
  }
  const file = path.join(staticDir, relativePath)
  if (status) res.statusCode = status
  if (!res.hasHeader('content-type')) {
    // Extensionless files are auto-statically optimized pages.
    const ext = path.extname(relativePath)
    res.setHeader('content-type', CONTENT_TYPES[ext] ?? CONTENT_TYPES['.html'])
  }
  if (!res.hasHeader('cache-control')) {
    res.setHeader(
      'cache-control',
      relativePath.startsWith('_next/static/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate'
    )
  }
  if (req.method === 'HEAD') return res.end()
  return new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on('error', reject)
      .pipe(res)
      .on('finish', resolve)
  })
}

async function sendWebResponse(res: http.ServerResponse, response: Response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie' || key.startsWith('x-middleware-')) return
    res.setHeader(key, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) res.setHeader('set-cookie', cookies)
  if (!response.body) return res.end()
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as any)
      .on('error', reject)
      .pipe(res)
      .on('finish', resolve)
  })
}

function applyHeaders(res: http.ServerResponse, headers: Headers | undefined) {
  if (!headers) return
  headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value)
  })
  const cookies = headers.getSetCookie()
  if (cookies.length) res.appendHeader('set-cookie', cookies)
}

function toWebHeaders(headers: http.IncomingHttpHeaders) {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((v) => result.append(key, v))
    else if (value !== undefined) result.set(key, value)
  }
  return result
}

function toNodeHeaders(headers: Headers) {
  const result: http.IncomingHttpHeaders = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  const cookies = headers.getSetCookie()
  if (cookies.length) result['set-cookie'] = cookies
  return result
}

function withoutHost(headers: Headers) {
  const copy = new Headers(headers)
  copy.delete('host')
  return copy
}

function toSearch(query: Routing.ResolveRoutesQuery) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value])
      params.append(key, v)
  }
  const search = params.toString()
  return search ? `?${search}` : ''
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** A fresh readable request carrying an already-consumed body. */
function replayRequest(req: http.IncomingMessage, body: Buffer) {
  const replay = Readable.from([body]) as unknown as http.IncomingMessage
  Object.assign(replay, {
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    httpVersionMajor: req.httpVersionMajor,
    httpVersionMinor: req.httpVersionMinor,
    socket: req.socket,
    connection: req.socket,
    complete: true,
    trailers: {},
    rawTrailers: [],
  })
  return replay
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[cloud-run] request failed', req.url, err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.end('Internal Server Error')
    } else {
      res.destroy(err)
    }
  })
})

server.listen(port, hostname, () => {
  console.log(`[cloud-run] listening on http://${hostname}:${port}`)
})

// Cloud Run sends SIGTERM and allows ~10s before SIGKILL; drain background work.
process.on('SIGTERM', () => {
  server.close()
  const timeout = new Promise((resolve) => setTimeout(resolve, 9000).unref())
  Promise.race([Promise.allSettled(pending), timeout]).then(() =>
    process.exit(0)
  )
})
