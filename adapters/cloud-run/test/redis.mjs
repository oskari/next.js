// Builds the Cache Components fixture with the Redis cache handlers, runs two
// server instances against one local redis-server, and checks that cached
// values and invalidations are shared between them.
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  adapterDir,
  build,
  eventually,
  freePort,
  runTests,
  startServer,
} from './helpers.mjs'

try {
  execFileSync('redis-server', ['--version'], { stdio: 'ignore' })
} catch {
  console.log('redis-server not found; skipping the Redis cache test')
  process.exit(0)
}

const fixtureDir = path.join(adapterDir, 'test/fixture-redis')
// A default build: the handlers use Redis because REDIS_URL is set below.
build(fixtureDir)

const redisPort = await freePort()
const redis = spawn(
  'redis-server',
  ['--port', String(redisPort), '--save', '', '--appendonly', 'no'],
  { stdio: 'ignore' }
)
const env = { REDIS_URL: `redis://127.0.0.1:${redisPort}` }
const a = await startServer(fixtureDir, env)
const b = await startServer(fixtureDir, env)

async function read(server, pathname, label) {
  const html = await (await server.get(pathname)).text()
  const match = html.match(new RegExp(`${label}:(?:<!-- -->)?(\\d+)`))
  assert.ok(match, `no ${label} value in ${pathname}`)
  return match[1]
}

async function revalidateTag(server, tag) {
  const res = await server.get(`/api/revalidate?tag=${tag}`, { method: 'POST' })
  assert.equal(res.status, 200)
}

const tests = {
  async "'use cache: remote' entries are shared between instances"() {
    const first = await read(a, '/remote', 'remote')
    assert.equal(await read(b, '/remote', 'remote'), first)
  },
  async "revalidateTag on one instance invalidates 'use cache' on another"() {
    const before = await read(b, '/remote', 'remote')
    await revalidateTag(a, 'remote')
    const after = await eventually(async () => {
      const value = await read(b, '/remote', 'remote')
      assert.notEqual(value, before)
      return value
    })
    assert.equal(await read(a, '/remote', 'remote'), after)
  },
  async 'revalidateTag on one instance invalidates a prerendered page on another'() {
    const before = await read(b, '/cached', 'time')
    assert.equal(await read(a, '/cached', 'time'), before)
    await revalidateTag(a, 'time')
    await eventually(async () => {
      assert.notEqual(await read(b, '/cached', 'time'), before)
    })
  },
  async 'on-demand ISR on one instance updates the page on another'() {
    const before = await read(b, '/isr', 'pages')
    const res = await a.get('/api/revalidate-pages', { method: 'POST' })
    assert.equal(res.status, 200)
    await eventually(async () => {
      assert.notEqual(await read(b, '/isr', 'pages'), before)
    })
  },
  async 'optimized images are shared between instances'() {
    const url = '/_next/image?url=%2Fphoto.png&w=640&q=75'
    const headers = { accept: 'image/webp' }
    const first = await a.get(url, { headers })
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('content-type'), 'image/webp')
    assert.equal(first.headers.get('x-nextjs-cache'), 'MISS')
    const second = await b.get(url, { headers })
    assert.equal(second.headers.get('x-nextjs-cache'), 'HIT')
    assert.equal(second.headers.get('etag'), first.headers.get('etag'))
  },
  async 'pages still render quickly when Redis is unreachable'() {
    const down = await startServer(fixtureDir, {
      REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    })
    try {
      for (const pathname of ['/remote', '/cached', '/isr']) {
        const start = Date.now()
        const res = await down.get(pathname)
        await res.text()
        assert.equal(res.status, 200, pathname)
        // At most the one-time 2s wait for the initial connection.
        assert.ok(
          Date.now() - start < 3000,
          `${pathname} took ${Date.now() - start}ms`
        )
      }
    } finally {
      down.stop()
    }
  },
  async 'entries are stored under the build-scoped prefix'() {
    const buildId = (
      await import(
        path.join(fixtureDir, '.cloud-run/app/cloud-run-manifest.json'),
        {
          with: { type: 'json' },
        }
      )
    ).default.buildId
    const keys = execFileSync('redis-cli', [
      '-p',
      String(redisPort),
      'keys',
      '*',
    ])
      .toString()
      .trim()
      .split('\n')
    assert.ok(keys.includes('next:tags'), 'tag hash missing')
    assert.ok(
      keys.some((key) => key.startsWith(`next:${buildId}:u:`)),
      'no use cache entries'
    )
    assert.ok(
      keys.some((key) => key.startsWith(`next:${buildId}:r:`)),
      'no response entries'
    )
  },
}

await runTests(tests, async () => {
  a.stop()
  b.stop()
  redis.kill()
})
