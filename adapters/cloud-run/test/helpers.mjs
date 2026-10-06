import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const adapterDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

export const baseEnv = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_ADAPTER_PATH: path.join(adapterDir, 'dist/index.js'),
}

/** Builds a fixture with the adapter unless --skip-build is passed. */
export function build(fixtureDir, env = {}) {
  if (process.argv.includes('--skip-build')) return
  execFileSync(
    process.execPath,
    [
      path.join(adapterDir, 'node_modules/next/dist/bin/next'),
      'build',
      fixtureDir,
    ],
    { env: { ...baseEnv, ...env }, stdio: 'inherit' }
  )
}

export function freePort() {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitForPort(port) {
  for (let i = 0; ; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}`)
      return
    } catch (err) {
      if (i > 100) throw err
      await sleep(100)
    }
  }
}

/** Starts the generated server; returns `get(path, init)` and `stop()`. */
export async function startServer(fixtureDir, env = {}) {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [path.join(fixtureDir, '.cloud-run/app/server.mjs')],
    {
      env: { ...baseEnv, ...env, PORT: String(port), HOSTNAME: '127.0.0.1' },
      stdio: 'inherit',
    }
  )
  await waitForPort(port)
  return {
    get: (pathname, init) =>
      fetch(`http://127.0.0.1:${port}${pathname}`, {
        redirect: 'manual',
        ...init,
      }),
    stop: () => child.kill('SIGTERM'),
  }
}

/** Retries `fn` until it stops throwing, for eventually consistent checks. */
export async function eventually(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (Date.now() > deadline) throw err
      await sleep(200)
    }
  }
}

export async function runTests(tests, cleanup) {
  let failed = 0
  try {
    for (const [name, test] of Object.entries(tests)) {
      try {
        await test()
        console.log(`  ✓ ${name}`)
      } catch (err) {
        failed++
        console.log(
          `  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`
        )
      }
    }
  } finally {
    await cleanup()
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exitCode = failed ? 1 : 0
}
