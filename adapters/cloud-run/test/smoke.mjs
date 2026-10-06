// Builds the fixture app with the adapter, starts the generated Cloud Run
// server locally and checks the main routing paths end to end.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const adapterDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const fixtureDir = path.join(adapterDir, 'test/fixture')
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_ADAPTER_PATH: path.join(adapterDir, 'dist/index.js'),
}

if (!process.argv.includes('--skip-build')) {
  execFileSync(
    process.execPath,
    [
      path.join(adapterDir, 'node_modules/next/dist/bin/next'),
      'build',
      fixtureDir,
    ],
    { env, stdio: 'inherit' }
  )
}

const port = await new Promise((resolve) => {
  const srv = createServer().listen(0, () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})
const base = `http://127.0.0.1:${port}`
const server = spawn(
  process.execPath,
  [path.join(fixtureDir, '.cloud-run/app/server.mjs')],
  {
    env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
  }
)

async function get(pathname, init) {
  return fetch(base + pathname, { redirect: 'manual', ...init })
}

const tests = {
  async 'static page with config headers'() {
    const res = await get('/')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-custom'), 'yes')
    assert.match(await res.text(), /id="home">home/)
  },
  async 'prerendered dynamic route'() {
    assert.match(
      await (await get('/blog/first')).text(),
      /slug:(<!-- -->)?first/
    )
  },
  async 'on-demand dynamic route'() {
    assert.match(
      await (await get('/blog/other')).text(),
      /slug:(<!-- -->)?other/
    )
  },
  async 'config rewrite'() {
    assert.match(await (await get('/alias')).text(), /slug:(<!-- -->)?alias/)
  },
  async 'config redirect'() {
    const res = await get('/old')
    assert.equal(res.status, 307)
    assert.equal(res.headers.get('location'), '/')
  },
  async 'RSC request'() {
    const res = await get('/blog/first', { headers: { rsc: '1' } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/x-component/)
  },
  async 'app route handler GET and POST'() {
    assert.deepEqual(await (await get('/api/hello')).json(), { hello: 'world' })
    const res = await get('/api/hello', { method: 'POST', body: 'ping' })
    assert.deepEqual(await res.json(), { echo: 'ping' })
  },
  async 'pages API route'() {
    const body = await (await get('/api/legacy?a=1')).json()
    assert.deepEqual(body, { legacy: true, query: { a: '1' } })
  },
  async 'middleware request headers'() {
    assert.match(await (await get('/dynamic')).text(), /header:(<!-- -->)?hi/)
  },
  async 'middleware redirect'() {
    const res = await get('/mw-redirect')
    assert.equal(res.status, 307)
    assert.match(res.headers.get('location'), /\/$/)
  },
  async 'middleware rewrite'() {
    assert.match(
      await (await get('/mw-rewrite')).text(),
      /slug:(<!-- -->)?rewritten/
    )
  },
  async 'middleware response'() {
    const res = await get('/mw-respond')
    assert.equal(res.status, 418)
    assert.equal(await res.text(), 'from proxy')
  },
  async 'static asset'() {
    const html = await (await get('/')).text()
    const chunk = html.match(/\/_next\/static\/[^"]+\.js/)[0]
    const res = await get(chunk)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('cache-control'), /immutable/)
  },
  async 'not found'() {
    const res = await get('/does-not-exist')
    assert.equal(res.status, 404)
    assert.match(await res.text(), /could not be found/)
  },
  async 'ISR revalidates in the background'() {
    const time = async () =>
      (await (await get('/isr')).text()).match(/time:(?:<!-- -->)?(\d+)/)[1]
    const first = await time()
    await sleep(1500)
    await time() // stale: serves the old value and triggers revalidation
    for (let i = 0; i < 20; i++) {
      if ((await time()) !== first) return
      await sleep(250)
    }
    assert.fail('ISR page never revalidated')
  },
}

let failed = 0
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(base)
      break
    } catch (err) {
      if (i > 100) throw err
      await sleep(100)
    }
  }
  for (const [name, test] of Object.entries(tests)) {
    try {
      await test()
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`)
    }
  }
} finally {
  server.kill('SIGTERM')
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exitCode = failed ? 1 : 0
