# next-adapter-cloud-run

A [Next.js Deployment Adapter](../../docs/01-app/03-api-reference/07-adapters/index.mdx) that packages a Next.js app as a single Google Cloud Run service.

> Status: scaffold. It handles routing, middleware/proxy, app and pages router entrypoints, ISR, static and `public/` files, image optimization, and an optional shared cache on Memorystore. See [Limitations](#limitations) and [Roadmap](#roadmap) before using it in production.

## How it works

At build time (`onBuildComplete`) the adapter writes `<project>/.cloud-run/`:

```
.cloud-run/
  Dockerfile
  app/                        container root, mirrors the repo root
    server.mjs                entry point (node server.mjs)
    cloud-run-manifest.json   routing table + pathname → entrypoint map
    .cloud-run-runtime/       runtime server, image optimizer, bundled @next/routing
    <traced files>            each route's entrypoint and traced dependencies
    <project>/.next/...       manifests and prerendered pages (ISR seed cache)
  static/                     /_next/static, public/ and other static files, by URL path
```

At runtime, `server.mjs` handles every request:

1. Resolves Next.js routing (redirects, rewrites, headers, middleware/proxy, dynamic routes) with [`@next/routing`](../../packages/next-routing).
2. Calls the Node.js middleware entrypoint when `routing.middlewareMatchers` match.
3. Serves the static file, optimizes `/_next/image` requests, or calls the matched entrypoint's `handler(req, res, ctx)` with the resolved invocation target.
4. Tracks `ctx.waitUntil` promises and drains them on `SIGTERM`.

ISR runs inside Next.js and revalidates stale pages in the background. By default each instance uses the file-system cache seeded from the build; see [Shared cache on Memorystore](#shared-cache-on-memorystore) to share it across instances.

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

Build on Linux x64 (or in Cloud Build), so native dependencies match the container. This matters for `sharp`, which image optimization uses: the adapter keeps only the linux-x64-glibc `@img/sharp-*` binaries and warns at build time when they are missing. On another platform, run `npm install --os=linux --cpu=x64 --libc=glibc sharp` before building.

### Image optimization

`/_next/image` is served with Next.js' own image optimizer and the same validation, headers and caching as `next start`. Local images are fetched through the server's in-process routing; remote images must match `images.remotePatterns`. Optimized images are cached on the instance's disk, or in Memorystore when the shared cache is enabled. With `images.unoptimized`, a custom `images.loader` or `output: 'export'`, `/_next/image` returns 404 as in `next start`. Without `sharp`, the original image is served and a warning is logged.

### Shared cache on Memorystore

Build with `NEXT_CLOUD_RUN_CACHE=redis` to point `cacheHandler` and `cacheHandlers` (`default`, `remote`) at the adapter's Redis handlers. Handlers configured by the app take priority. Then ISR and route responses, the `fetch` data cache, `'use cache'` entries and optimized images are shared by all instances, and `revalidateTag`/`revalidatePath` reach every instance.

```bash
NEXT_CLOUD_RUN_CACHE=redis next build
REDIS_URL=redis://10.0.0.3:6379 VPC_NETWORK=default scripts/deploy.sh .
```

- Use Memorystore for Redis, or Memorystore for Valkey with cluster mode disabled. Reach it over Direct VPC egress (`VPC_NETWORK`/`VPC_SUBNET`). Use `rediss://` and `REDIS_CA_CERT` for in-transit encryption.
- Set `maxmemory-policy` to `allkeys-lru` so Redis evicts old entries under memory pressure. Entries also expire after their `expire` time, or `NEXT_REDIS_DEFAULT_TTL` (30 days) when they have none.
- Response, image and `'use cache'` entries are scoped to the build ID, so a new revision never reads another build's pages. `fetch` entries and tags are shared across builds.
- A miss falls back to the build's prerendered pages on local disk.
- When Redis is unreachable, requests are served as cache misses after at most a one-time 2s wait for the first connection, and tag invalidations apply only on the instance that received them.

### Serving static assets from Cloud CDN (optional)

The service serves `/_next/static` itself, with immutable cache headers. To serve those assets from Cloud CDN instead:

1. Create a Cloud Storage bucket and a global external Application Load Balancer with a backend bucket (Cloud CDN enabled) for `/_next/static/*` and a serverless NEG for the Cloud Run service as the default backend.
2. Build with `NEXT_CLOUD_RUN_ASSET_PREFIX=https://cdn.example.com` (the adapter sets `assetPrefix`), or leave it unset when the load balancer serves both on one domain.
3. Deploy with `BUCKET=my-bucket scripts/deploy.sh .`, which uploads the hashed assets before deploying the new revision and never deletes old ones.

## Configuration

| Variable                      | When    | Description                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------------- |
| `NEXT_CLOUD_RUN_OUT_DIR`      | build   | Output directory, relative to the project (default `.cloud-run`) |
| `NEXT_CLOUD_RUN_ASSET_PREFIX` | build   | Sets `assetPrefix` when the config does not                      |
| `NEXT_CLOUD_RUN_CACHE`        | build   | `redis` enables the Memorystore cache handlers                   |
| `REDIS_URL`                   | runtime | Memorystore endpoint (`redis://` or `rediss://`)                 |
| `REDIS_CA_CERT`               | runtime | PEM CA certificate for `rediss://`                               |
| `NEXT_REDIS_KEY_PREFIX`       | runtime | Redis key prefix (default `next`)                                |
| `NEXT_REDIS_DEFAULT_TTL`      | runtime | TTL in seconds for entries without an expire time                |
| `NEXT_REDIS_COMMAND_TIMEOUT`  | runtime | Redis command timeout in ms (default `1000`)                     |
| `PORT`                        | runtime | Port to listen on (Cloud Run sets it; default `8080`)            |
| `HOSTNAME`                    | runtime | Interface to bind (default `0.0.0.0`)                            |
| `NEXT_CLOUD_RUN_STATIC_DIR`   | runtime | Directory with static files (default: baked into the image)      |

## Testing

```bash
npm test
```

builds `test/fixture` with the adapter, starts the generated server and checks pages, route handlers, rewrites, redirects, middleware, RSC requests, static and `public/` files, image optimization, 404s and ISR revalidation. It then builds `test/fixture-redis` with the Redis handlers and runs two instances against a local `redis-server` (skipped when it is not installed) to check that cached values, tag invalidations, on-demand ISR and optimized images are shared, and that pages stay fast when Redis is down.

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
- **Caching is per instance** unless the [shared cache](#shared-cache-on-memorystore) is enabled.
- **Stale-while-revalidate for tagged pages** needs a numeric revalidate time. `revalidateTag(tag, profile)` on a page without one regenerates it on the next request instead of in the background.
- **Optimized images in Memorystore** count against its memory and keep the default TTL.
- **PPR** works from the origin in one pass; the shell is not served from the CDN.
- Request bodies are buffered in memory when middleware runs on a request with a body.

## Roadmap

- Firestore and Cloud Storage cache handlers, and Memorystore cluster mode.
- Offload ISR revalidation to Cloud Tasks or Pub/Sub so instances can run with CPU throttling.
- Cloud CDN integration: cache tags and invalidation on revalidation, immutable assets (`supportsImmutableAssets`).
- PPR: serve the cached shell immediately and resume the dynamic parts with `next-resume`.
