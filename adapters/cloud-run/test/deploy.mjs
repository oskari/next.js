// Runs scripts/deploy.sh against fake `gcloud` and `terraform` binaries that
// log their arguments, and checks the release steps it performs.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { adapterDir, runTests } from './helpers.mjs'

const fixtureDir = path.join(adapterDir, 'test/fixture')
if (!fs.existsSync(path.join(fixtureDir, '.cloud-run/Dockerfile'))) {
  console.log('test/fixture is not built; run node test/smoke.mjs first')
  process.exit(1)
}
const buildId = fs
  .readFileSync(path.join(fixtureDir, '.next/BUILD_ID'), 'utf8')
  .trim()

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-run-deploy-test-'))
const log = path.join(bin, 'calls.log')
fs.writeFileSync(
  path.join(bin, 'gcloud'),
  `#!/usr/bin/env bash
echo "gcloud $*" >> "${log}"
case "$*" in
  *"services describe"*) echo "https://described.run.app" ;;
esac
`,
  { mode: 0o755 }
)
fs.writeFileSync(
  path.join(bin, 'terraform'),
  `#!/usr/bin/env bash
echo "terraform $*" >> "${log}"
cat "$FAKE_TF_OUTPUTS"
`,
  { mode: 0o755 }
)

function deploy(env, outputs) {
  fs.writeFileSync(log, '')
  const outputsFile = path.join(bin, 'outputs.json')
  if (outputs) {
    fs.writeFileSync(
      outputsFile,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(outputs).map(([key, value]) => [key, { value }])
        )
      )
    )
  }
  const stdout = execFileSync(
    'bash',
    [path.join(adapterDir, 'scripts/deploy.sh'), fixtureDir],
    {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        FAKE_TF_OUTPUTS: outputsFile,
        ...(outputs ? { TF_DIR: '/infra' } : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  )
    .toString()
    .trim()
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
  return { stdout, calls }
}

const terraformOutputs = {
  project_id: 'my-proj',
  region: 'europe-north1',
  app_service: 'shop',
  image_service: 'shop-images',
  static_bucket: 'my-proj-shop-static',
  image_cache_bucket: 'my-proj-shop-image-cache',
  artifact_repository: 'europe-north1-docker.pkg.dev/my-proj/shop',
  url: 'https://shop.example.com',
}
const image = `europe-north1-docker.pkg.dev/my-proj/shop/shop:${buildId}`

const tests = {
  async 'a release builds, uploads static assets, then rolls out both services'() {
    const { stdout, calls } = deploy({}, terraformOutputs)
    assert.equal(stdout, 'https://shop.example.com')
    assert.deepEqual(calls, [
      'terraform -chdir=/infra output -json',
      `gcloud builds submit ${fixtureDir}/.cloud-run --tag ${image} --project my-proj`,
      `gcloud storage rsync --recursive ${fixtureDir}/.cloud-run/static/_next/static gs://my-proj-shop-static/_next/static --cache-control=public, max-age=31536000, immutable --project my-proj`,
      `gcloud run deploy shop --image ${image} --region europe-north1 --project my-proj`,
      `gcloud run deploy shop-images --image ${image} --region europe-north1 --project my-proj`,
    ])
  },
  async 'without an image service or static bucket only the app is deployed'() {
    const { stdout, calls } = deploy(
      {},
      {
        ...terraformOutputs,
        image_service: null,
        static_bucket: null,
        url: null,
      }
    )
    assert.equal(stdout, 'https://described.run.app')
    assert.ok(!calls.some((call) => call.includes('storage rsync')))
    assert.deepEqual(
      calls.filter((call) => call.startsWith('gcloud run deploy')),
      [
        `gcloud run deploy shop --image ${image} --region europe-north1 --project my-proj`,
      ]
    )
  },
  async 'environment values override Terraform outputs'() {
    const { calls } = deploy(
      { REGION: 'us-central1', IMAGE_SERVICE: 'other-images' },
      terraformOutputs
    )
    assert.ok(
      calls.includes(
        `gcloud run deploy other-images --image ${image} --region us-central1 --project my-proj`
      )
    )
  },
  async 'output values are passed through literally'() {
    const { stdout } = deploy(
      {},
      { ...terraformOutputs, url: `https://x.example/it's $HOME` }
    )
    assert.equal(stdout, `https://x.example/it's $HOME`)
  },
  async 'without Terraform it deploys one public service from source'() {
    const { stdout, calls } = deploy({ SERVICE: 'quick' })
    assert.equal(stdout, 'https://described.run.app')
    assert.equal(
      calls[0],
      `gcloud run deploy quick --source ${fixtureDir}/.cloud-run --region us-central1 --allow-unauthenticated`
    )
  },
  async 'PUBLIC=0 keeps the quick-start service private'() {
    const { calls } = deploy({ SERVICE: 'quick', PUBLIC: '0' })
    assert.ok(calls[0].endsWith('--no-allow-unauthenticated'))
  },
}

await runTests(tests, () => fs.rmSync(bin, { recursive: true, force: true }))
