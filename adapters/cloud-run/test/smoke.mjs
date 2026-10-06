// Builds the fixture app with the adapter, starts the generated Cloud Run
// server locally and checks the main routing paths end to end.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import sharp from 'sharp'
import { adapterDir, build, runTests, startServer } from './helpers.mjs'

const fixtureDir = path.join(adapterDir, 'test/fixture')
build(fixtureDir)
const { get, stop } = await startServer(fixtureDir)

// A "remote" image origin, allowed by the fixture's images.remotePatterns.
const photo = fs.readFileSync(path.join(fixtureDir, 'public/photo.png'))
const remote = http
  .createServer((req, res) => {
    res.setHeader('content-type', 'image/png')
    res.end(photo)
  })
  .listen(0, '127.0.0.1')
await new Promise((resolve) => remote.once('listening', resolve))
const remoteUrl = `http://127.0.0.1:${remote.address().port}/remote.png`

const image = (url, w = 640, q = 75) =>
  `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=${q}`

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
  async 'public file'() {
    const res = await get('/photo.png')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
  },
  async 'next/image renders optimizer URLs'() {
    const html = await (await get('/image')).text()
    assert.match(html, /\/_next\/image\?url=%2Fphoto\.png&amp;w=640&amp;q=75/)
    assert.match(html, /\/_next\/image\?url=%2F_next%2Fstatic%2Fmedia%2F/)
  },
  async '/_next/image resizes a local image to WebP'() {
    const res = await get(image('/photo.png'), {
      headers: { accept: 'image/webp,*/*' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/webp')
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=14400, must-revalidate'
    )
    assert.equal(res.headers.get('vary'), 'Accept')
    assert.ok(res.headers.get('etag'))
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="photo.webp"'
    )
    assert.match(res.headers.get('content-security-policy'), /sandbox/)
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(meta.width, 640)
  },
  async '/_next/image prefers AVIF per Accept and images.formats'() {
    const res = await get(image('/photo.png', 750), {
      headers: { accept: 'image/avif,image/webp,*/*' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/avif')
  },
  async '/_next/image caches optimized images'() {
    // A fresh source URL, as the image cache outlives --skip-build runs.
    const url = image(`${remoteUrl}?t=${Date.now()}`, 828)
    const headers = { accept: 'image/webp' }
    const first = await get(url, { headers })
    assert.equal(first.headers.get('x-nextjs-cache'), 'MISS')
    const second = await get(url, { headers })
    assert.equal(second.headers.get('x-nextjs-cache'), 'HIT')
    assert.equal(second.headers.get('etag'), first.headers.get('etag'))
    // fetch() adds `cache-control: no-cache` to conditional requests, which
    // rules out a 304, so ask with node:http like a browser would.
    const status = await new Promise((resolve, reject) => {
      const { port } = new URL(second.url)
      http
        .get(
          `http://127.0.0.1:${port}${url}`,
          {
            headers: { ...headers, 'if-none-match': first.headers.get('etag') },
          },
          (res) => resolve(res.resume().statusCode)
        )
        .on('error', reject)
    })
    assert.equal(status, 304)
  },
  async '/_next/image serves imported images as immutable'() {
    const html = await (await get('/image')).text()
    const src = html.match(/url=(%2F_next%2Fstatic%2Fmedia%2F[^&]+)/)[1]
    const res = await get(image(decodeURIComponent(src)), {
      headers: { accept: 'image/webp' },
    })
    assert.equal(res.status, 200)
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=315360000, immutable'
    )
  },
  async '/_next/image rejects invalid parameters'() {
    const cases = [
      [image('/photo.png', 123), '"w" parameter (width) of 123 is not allowed'],
      [
        image('/photo.png', 640, 50),
        '"q" parameter (quality) of 50 is not allowed',
      ],
      ['/_next/image?w=640&q=75', '"url" parameter is required'],
      [image('https://example.com/a.png'), '"url" parameter is not allowed'],
    ]
    for (const [url, message] of cases) {
      const res = await get(url)
      assert.equal(res.status, 400, url)
      assert.equal(await res.text(), message)
    }
  },
  async '/_next/image 404s for a missing local image'() {
    const res = await get(image('/missing.png'))
    assert.equal(res.status, 404)
  },
  async '/_next/image optimizes an allowed remote image'() {
    const res = await get(image(remoteUrl), {
      headers: { accept: 'image/webp' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/webp')
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="remote.webp"'
    )
  },
}

await runTests(tests, () => {
  remote.close()
  return stop()
})
