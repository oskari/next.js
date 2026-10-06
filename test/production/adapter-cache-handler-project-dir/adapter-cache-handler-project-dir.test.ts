import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import execa from 'execa'
import { nextTestSetup } from 'e2e-utils'
import type { NextAdapter } from 'next'

// Adapters may invoke entrypoints with process.cwd() outside the project
// directory and point at the project with `requestMeta.relativeProjectDir`.
// The custom `cacheHandler` must still resolve relative to the project.
describe('adapter-cache-handler-project-dir', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: true,
  })

  it('loads cacheHandler relative to relativeProjectDir', async () => {
    await next.build()

    const {
      outputs,
      repoRoot,
      projectDir,
    }: Parameters<NextAdapter['onBuildComplete']>[0] = await next.readJSON(
      'build-complete.json'
    )
    const routeOutput = outputs.appRoutes.find(
      (output) => output.pathname === '/isr'
    )
    expect(routeOutput).toBeDefined()

    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'next-adapter-cache-handler-')
    )

    try {
      // Mirror the repo root one level below cwd, so cwd is not the project.
      const functionDir = path.join(cwd, 'function')
      const copies = Object.entries(routeOutput!.assets)
      copies.push([
        path.relative(repoRoot, routeOutput!.filePath),
        routeOutput!.filePath,
      ])
      for (const [target, source] of copies) {
        const destination = path.join(functionDir, target)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.cp(source, destination, {
          recursive: true,
          verbatimSymlinks: true,
        })
      }

      const functionProjectDir = path.join(
        functionDir,
        path.relative(repoRoot, projectDir)
      )
      const entry = path.join(
        functionDir,
        path.relative(repoRoot, routeOutput!.filePath)
      )
      const script = `
        const http = require('http')
        require(require.resolve('next/setup-node-env', {
          paths: [${JSON.stringify(functionProjectDir)}],
        }))
        const { handler } = require(${JSON.stringify(entry)})
        const server = http.createServer((req, res) => {
          handler(req, res, {
            waitUntil() {},
            requestMeta: {
              relativeProjectDir: ${JSON.stringify(path.relative(cwd, functionProjectDir))},
            },
          }).catch((err) => {
            console.error(err)
            res.statusCode = 500
            res.end()
          })
        })
        server.listen(0, async () => {
          const res = await fetch('http://127.0.0.1:' + server.address().port + '/isr')
          console.log(JSON.stringify({
            status: res.status,
            loaded: globalThis.__testCacheHandlerLoaded === true,
          }))
          server.close()
        })
      `

      const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
      if (process.env.IS_TURBOPACK_TEST) {
        env.TURBOPACK = '1'
      } else {
        delete env.TURBOPACK
      }

      const { stdout } = await execa(process.execPath, ['-e', script], {
        cwd,
        env,
      })
      expect(JSON.parse(stdout.trim().split('\n').pop()!)).toEqual({
        status: 200,
        loaded: true,
      })
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})
