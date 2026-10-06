# next-adapter-cloud-run

A [Next.js Deployment Adapter](../../docs/01-app/03-api-reference/07-adapters/index.mdx) that packages a Next.js app as a single Google Cloud Run service.

> Status: scaffold. It handles routing, middleware/proxy, app and pages router entrypoints, ISR and static assets. See [Limitations](#limitations) and [Roadmap](#roadmap) before using it in production.

## How it works

At build time (`onBuildComplete`) the adapter writes `<project>/.cloud-run/`:

```
.cloud-run/
  Dockerfile
  app/                        container root, mirrors the repo root
    server.mjs                entry point (node server.mjs)
    cloud-run-manifest.json   routing table + pathname → entrypoint map
    .cloud-run-runtime/       runtime server + bundled @next/routing
    <traced files>            each route's entrypoint and traced dependencies
    <project>/.next/...       manifests and prerendered pages (ISR seed cache)
  static/                     /_next/static and other static files, by URL path
```

At runtime, `server.mjs` handles every request:

1. Resolves Next.js routing (redirects, rewrites, headers, middleware/proxy, dynamic routes) with [`@next/routing`](../../packages/next-routing).
2. Calls the Node.js middleware entrypoint when `routing.middlewareMatchers` match.
3. Serves the static file, or calls the matched entrypoint's `handler(req, res, ctx)` with the resolved invocation target.
4. Tracks `ctx.waitUntil` promises and drains them on `SIGTERM`.

ISR runs inside Next.js: each instance uses the file-system incremental cache seeded from the build, and revalidates stale pages in the background.

## Usage

```bash
npm install --save-dev next-adapter-cloud-run
```

```js filename="next.config.js"
module.exports = {
  adapterPath: require.resolve('next-adapter-cloud-run'),
}
```

or set `NEXT_ADAPTER_PATH=/path/to/next-adapter-cloud-run/dist/index.js` without changing the config.

Run it locally:

```bash
next build
PORT=3000 node .cloud-run/app/server.mjs
```

### Deploy

```bash
next build
SERVICE=my-app REGION=europe-north1 PUBLIC=1 scripts/deploy.sh .
```

`scripts/deploy.sh` runs `gcloud run deploy --source .cloud-run`, so Cloud Build builds the image from the generated Dockerfile. It sets:

- `--no-cpu-throttling`, so background work started through `waitUntil` (ISR revalidation, `after()`) keeps CPU after the response is sent.
- `--timeout` to the longest `maxDuration` of any route (at least 300s).

Build on Linux x64 (or in Cloud Build) when the app has native dependencies such as `sharp`, so the traced binaries match the container.

### Serving static assets from Cloud CDN (optional)

The service serves `/_next/static` itself, with immutable cache headers. To serve those assets from Cloud CDN instead:

1. Create a Cloud Storage bucket and a global external Application Load Balancer with a backend bucket (Cloud CDN enabled) for `/_next/static/*` and a serverless NEG for the Cloud Run service as the default backend.
2. Build with `NEXT_CLOUD_RUN_ASSET_PREFIX=https://cdn.example.com` (the adapter sets `assetPrefix`), or leave it unset when the load balancer serves both on one domain.
3. Deploy with `BUCKET=my-bucket scripts/deploy.sh .`, which uploads the hashed assets before deploying the new revision and never deletes old ones.

## Configuration

| Variable                       | When        | Description                                                   |
| ------------------------------ | ----------- | ------------------------------------------------------------- |
| `NEXT_CLOUD_RUN_OUT_DIR`       | build       | Output directory, relative to the project (default `.cloud-run`) |
| `NEXT_CLOUD_RUN_ASSET_PREFIX`  | build       | Sets `assetPrefix` when the config does not                   |
| `PORT`                         | runtime     | Port to listen on (Cloud Run sets it; default `8080`)          |
| `HOSTNAME`                     | runtime     | Interface to bind (default `0.0.0.0`)                          |
| `NEXT_CLOUD_RUN_STATIC_DIR`    | runtime     | Directory with static files (default: baked into the image)   |

## Testing

```bash
npm test
```

builds `test/fixture` with the adapter, starts the generated server and checks pages, route handlers, rewrites, redirects, middleware, RSC requests, static assets, 404s and ISR revalidation.

### Next.js compatibility suite

`scripts/e2e-deploy.sh`, `scripts/e2e-logs.sh` and `scripts/e2e-cleanup.sh` implement the [adapter test harness contract](../../docs/01-app/03-api-reference/07-adapters/04-testing-adapters.mdx). From a Next.js checkout:

```bash
NEXT_TEST_MODE=deploy \
ADAPTER_DIR=/path/to/adapters/cloud-run \
NEXT_TEST_DEPLOY_SCRIPT_PATH=$ADAPTER_DIR/scripts/e2e-deploy.sh \
NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH=$ADAPTER_DIR/scripts/e2e-logs.sh \
NEXT_TEST_CLEANUP_SCRIPT_PATH=$ADAPTER_DIR/scripts/e2e-cleanup.sh \
NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json \
node run-tests.js --type e2e
```

By default each test app runs locally; set `NEXT_CLOUD_RUN_E2E_TARGET=gcp` to deploy every test app to Cloud Run instead.

## Limitations

- **Edge runtime** outputs are skipped with a warning. The edge runtime is deprecated; use the Node.js runtime.
- **Image optimization** (`/_next/image`) is not served. Set `images.unoptimized` or a custom `images.loader`.
- **Caching is per instance.** Time-based ISR works, but `revalidateTag`/`revalidatePath` only reach the instance that handled the call. For multi-instance consistency configure [`cacheHandler`](../../docs/01-app/03-api-reference/05-config/01-next-config-js/incrementalCacheHandlerPath.mdx) and [`cacheHandlers`](../../docs/01-app/03-api-reference/05-config/01-next-config-js/cacheHandlers.mdx) backed by shared storage (Memorystore, Firestore) that implement `updateTags`/`refreshTags`.
- **PPR** works from the origin in one pass; the shell is not served from the CDN.
- Request bodies are buffered in memory when middleware runs on a request with a body.

## Roadmap

- Shared cache handlers for Memorystore/Firestore and Cloud Storage.
- Offload ISR revalidation to Cloud Tasks or Pub/Sub so instances can run with CPU throttling.
- Image optimization with `sharp`.
- Cloud CDN integration: cache tags and invalidation on revalidation, immutable assets (`supportsImmutableAssets`).
- PPR: serve the cached shell immediately and resume the dynamic parts with `next-resume`.
