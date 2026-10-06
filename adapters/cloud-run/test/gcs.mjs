// Runs server instances of the smoke fixture with the Cloud Storage image
// cache pointed at an in-process mock of the two GCS JSON API calls it uses,
// and checks that optimized images are shared through the bucket, never
// written to the instance's disk, and served quickly when the bucket fails.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  adapterDir,
  build,
  eventually,
  runTests,
  startServer,
} from './helpers.mjs'
import {
  GcsImageCache,
  decode,
  encode,
  gcsImageCacheFromEnv,
} from '../dist/runtime/gcs-image.js'

const BUCKET = 'test-bucket'
const PREFIX = 'images/'
const TIMEOUT_MS = 2000 // the default NEXT_CLOUD_RUN_GCS_TIMEOUT

/**
 * The media download and upload endpoints, backed by a Map of
 * `<bucket>/<object name>` → bytes. `mode.read` / `mode.write` switch either
 * call to 'error' (HTTP 500) or 'hang' (never respond).
 */
function createMockGcs() {
  const objects = new Map()
  const requests = []
  const mode = { read: 'ok', write: 'ok' }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const op = url.pathname.startsWith('/upload/') ? 'write' : 'read'
    requests.push({ op, method: req.method, url: req.url })
    if (mode[op] === 'hang') return
    if (mode[op] === 'error') {
      res.statusCode = 500
      return res.end('{"error":{"code":500,"message":"backend error"}}')
    }
    let match
    if (
      req.method === 'GET' &&
      (match = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/)) &&
      url.searchParams.get('alt') === 'media'
    ) {
      const object = objects.get(
        `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
      )
      if (!object) {
        res.statusCode = 404
        return res.end('No such object')
      }
      res.setHeader('content-type', 'application/octet-stream')
      return res.end(object)
    }
    if (
      req.method === 'POST' &&
      (match = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/)) &&
      url.searchParams.get('uploadType') === 'media' &&
      url.searchParams.get('name') &&
      req.headers['content-type'] === 'application/octet-stream'
    ) {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const name = url.searchParams.get('name')
        objects.set(
          `${decodeURIComponent(match[1])}/${name}`,
          Buffer.concat(chunks)
        )
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ bucket: match[1], name }))
      })
      return
    }
    res.statusCode = 400
    res.end('unexpected request')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        objects,
        requests,
        mode,
        close() {
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}

const fixtureDir = path.join(adapterDir, 'test/fixture')
build(fixtureDir)

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(fixtureDir, '.cloud-run/app/cloud-run-manifest.json'),
    'utf8'
  )
)
const imageCacheDir = path.join(
  fixtureDir,
  '.cloud-run/app',
  manifest.relativeProjectDir,
  manifest.distDir,
  'cache/images'
)
// Left over from --skip-build runs of the smoke test.
fs.rmSync(imageCacheDir, { recursive: true, force: true })

const gcs = await createMockGcs()
const env = {
  NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET: BUCKET,
  NEXT_CLOUD_RUN_GCS_ENDPOINT: gcs.endpoint,
}
const servers = []
async function start(extraEnv = env) {
  const server = await startServer(fixtureDir, extraEnv)
  servers.push(server)
  return server
}
const a = await start()
const b = await start()

// Every request below uses a fresh cache key (width × format).
const widths = [640, 750, 828, 1080, 1200, 1920, 2048, 3840]
let nextKey = 0
function nextImage() {
  const i = nextKey++
  return {
    url: `/_next/image?url=%2Fphoto.png&w=${widths[i % widths.length]}&q=75`,
    headers: {
      accept: i < widths.length ? 'image/webp' : 'image/avif,image/webp',
    },
  }
}

async function timed(server, { url, headers }) {
  const start = Date.now()
  const res = await server.get(url, { headers })
  const body = Buffer.from(await res.arrayBuffer())
  return { res, body, ms: Date.now() - start }
}

const objectKeys = () =>
  [...gcs.objects.keys()].filter((key) => key.startsWith(`${BUCKET}/`))

const shared = nextImage()

const tests = {
  async 'optimized images are shared between instances through the bucket'() {
    const first = await timed(a, shared)
    assert.equal(first.res.status, 200)
    assert.equal(first.res.headers.get('content-type'), 'image/webp')
    assert.equal(first.res.headers.get('x-nextjs-cache'), 'MISS')
    const second = await timed(b, shared)
    assert.equal(second.res.status, 200)
    assert.equal(second.res.headers.get('x-nextjs-cache'), 'HIT')
    assert.equal(second.res.headers.get('etag'), first.res.headers.get('etag'))
    assert.ok(second.body.equals(first.body), 'different image bytes')
  },
  async 'entries are stored as one object under the prefix'() {
    const keys = objectKeys()
    assert.equal(keys.length, 1, `objects: ${keys.join(', ')}`)
    assert.match(keys[0], new RegExp(`^${BUCKET}/${PREFIX}[\\w-]+$`))
    const entry = decode(gcs.objects.get(keys[0]))
    assert.ok(entry, 'malformed object')
    assert.equal(entry.meta.extension, 'webp')
    assert.equal(entry.meta.revalidate, 14400) // images.minimumCacheTTL
    assert.ok(Math.abs(entry.meta.lastModified - Date.now()) < 60_000)
    const res = await b.get(shared.url, { headers: shared.headers })
    assert.ok(res.headers.get('etag').includes(entry.meta.etag))
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(entry.buffer))
    // Exactly the media download and upload calls.
    assert.deepEqual(
      [...new Set(gcs.requests.map(({ op, method }) => `${op} ${method}`))],
      ['read GET', 'write POST']
    )
  },
  async 'stale entries are served STALE and regenerated in the background'() {
    const [key] = objectKeys()
    const entry = decode(gcs.objects.get(key))
    // Written long before images.minimumCacheTTL.
    gcs.objects.set(
      key,
      encode({ ...entry.meta, lastModified: 1 }, entry.buffer)
    )
    const res = await b.get(shared.url, { headers: shared.headers })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-nextjs-cache'), 'STALE')
    await eventually(() => {
      const updated = decode(gcs.objects.get(key))
      assert.ok(updated.meta.lastModified > 1, 'entry was not rewritten')
    })
    const fresh = await b.get(shared.url, { headers: shared.headers })
    assert.equal(fresh.headers.get('x-nextjs-cache'), 'HIT')
  },
  async 'nothing is written to the instance image cache directory'() {
    for (const server of [a, b]) {
      const res = await timed(server, nextImage())
      assert.equal(res.res.status, 200)
    }
    assert.equal(fs.existsSync(imageCacheDir), false, imageCacheDir)
    // Without a bucket, the same output does use it.
    const local = await start({})
    const res = await timed(local, nextImage())
    assert.equal(res.res.headers.get('x-nextjs-cache'), 'MISS')
    await eventually(() => assert.ok(fs.readdirSync(imageCacheDir).length > 0))
    local.stop()
  },
  async 'images are served quickly when Cloud Storage returns errors'() {
    const server = await start()
    await timed(server, nextImage()) // load the optimizer and sharp
    gcs.mode.read = gcs.mode.write = 'error'
    try {
      const before = gcs.requests.length
      const { res, ms } = await timed(server, nextImage())
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-nextjs-cache'), 'MISS')
      assert.ok(ms < TIMEOUT_MS, `took ${ms}ms`)
      const ops = gcs.requests.slice(before).map(({ op }) => op)
      assert.deepEqual(ops, ['read', 'write'])
    } finally {
      gcs.mode.read = gcs.mode.write = 'ok'
      server.stop()
    }
  },
  async 'a hanging bucket delays images by at most the timeout'() {
    const server = await start()
    await timed(server, nextImage())
    gcs.mode.read = gcs.mode.write = 'hang'
    try {
      const before = gcs.requests.length
      const first = await timed(server, nextImage())
      assert.equal(first.res.status, 200)
      assert.equal(first.res.headers.get('x-nextjs-cache'), 'MISS')
      assert.ok(first.ms >= TIMEOUT_MS - 100, `took only ${first.ms}ms`)
      assert.ok(first.ms < 5000, `took ${first.ms}ms`)
      // The write is skipped after the read timed out, and so is the bucket
      // for the next requests.
      assert.equal(gcs.requests.length - before, 1)
      const second = await timed(server, nextImage())
      assert.equal(second.res.status, 200)
      assert.ok(second.ms < TIMEOUT_MS, `took ${second.ms}ms`)
      assert.equal(gcs.requests.length - before, 1)
    } finally {
      gcs.mode.read = gcs.mode.write = 'ok'
      server.stop()
    }
  },
  async 'a hanging upload delays images by at most the timeout'() {
    const server = await start()
    await timed(server, nextImage())
    gcs.mode.write = 'hang'
    try {
      const { res, ms } = await timed(server, nextImage())
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-nextjs-cache'), 'MISS')
      assert.ok(ms < 5000, `took ${ms}ms`)
    } finally {
      gcs.mode.write = 'ok'
      server.stop()
    }
  },
  async 'requests use a cached metadata server token on Cloud Run'() {
    const realFetch = globalThis.fetch
    const calls = []
    let tokens = 0
    let expiresIn = 3600
    let storageStatus = 404
    globalThis.fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers)
      calls.push({ url: String(url), init, headers })
      if (String(url).startsWith('http://metadata.google.internal/')) {
        assert.equal(headers.get('metadata-flavor'), 'Google')
        await new Promise((resolve) => setTimeout(resolve, 50))
        return Response.json({
          access_token: `token-${++tokens}`,
          expires_in: expiresIn,
          token_type: 'Bearer',
        })
      }
      if (init.method === 'POST') return Response.json({})
      return new Response('', { status: storageStatus })
    }
    try {
      const cache = new GcsImageCache({ bucket: 'my-bucket' })
      // Concurrent requests share one token fetch.
      assert.deepEqual(
        await Promise.all([cache.get('k1'), cache.get('k2'), cache.get('k3')]),
        [null, null, null]
      )
      await cache.set(
        'k1',
        {
          kind: 'IMAGE',
          etag: 'e',
          upstreamEtag: 'u',
          extension: 'webp',
          buffer: Buffer.from('img'),
          revalidate: 60,
        },
        { cacheControl: { revalidate: 60 } }
      )
      assert.equal(tokens, 1)
      const storage = calls.filter(({ url }) => !url.includes('metadata'))
      assert.equal(storage.length, 4)
      for (const { headers } of storage) {
        assert.equal(headers.get('authorization'), 'Bearer token-1')
      }
      assert.equal(
        storage[0].url,
        'https://storage.googleapis.com/storage/v1/b/my-bucket/o/images%2Fk1?alt=media'
      )
      assert.equal(
        storage[3].url,
        'https://storage.googleapis.com/upload/storage/v1/b/my-bucket/o?uploadType=media&name=images%2Fk1'
      )
      assert.equal(
        storage[3].headers.get('content-type'),
        'application/octet-stream'
      )
      const uploaded = decode(Buffer.from(storage[3].init.body))
      assert.equal(uploaded.meta.etag, 'e')
      assert.equal(uploaded.buffer.toString(), 'img')

      // A 401 drops the cached token.
      storageStatus = 401
      await cache.get('k1')
      storageStatus = 404
      await cache.get('k1')
      assert.equal(tokens, 2)

      // Tokens are refreshed shortly before they expire.
      expiresIn = 30
      const shortLived = new GcsImageCache({ bucket: 'my-bucket' })
      await shortLived.get('k1')
      await shortLived.get('k1')
      assert.equal(tokens, 4)

      // A custom endpoint (emulator) is used without auth.
      calls.length = 0
      const emulator = gcsImageCacheFromEnv({
        NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET: 'gs://b/',
        NEXT_CLOUD_RUN_IMAGE_CACHE_PREFIX: 'cache/img',
        NEXT_CLOUD_RUN_GCS_ENDPOINT: 'http://localhost:4443/',
      })
      assert.equal(emulator.location, 'gs://b/cache/img/')
      assert.equal(emulator.timeoutMs, TIMEOUT_MS)
      await emulator.get('k')
      assert.deepEqual(
        calls.map(({ url }) => url),
        ['http://localhost:4443/storage/v1/b/b/o/cache%2Fimg%2Fk?alt=media']
      )
      assert.equal(calls[0].headers.get('authorization'), null)
      assert.equal(gcsImageCacheFromEnv({}), undefined)
    } finally {
      globalThis.fetch = realFetch
    }
  },
}

await runTests(tests, async () => {
  for (const server of servers) server.stop()
  gcs.close()
})
