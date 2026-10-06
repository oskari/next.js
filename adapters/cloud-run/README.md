# next-adapter-cloud-run

A [Next.js Deployment Adapter](https://nextjs.org/docs/app/api-reference/adapters) that packages a Next.js app as a single Google Cloud Run service.

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

1. Resolves Next.js routing (redirects, rewrites, headers, middleware/proxy, dynamic routes) with [`@next/routing`](https://github.com/vercel/next.js/tree/canary/packages/next-routing).
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

`/_next/image` is served with Next.js' own image optimizer and the same validation, headers and caching as `next start`. Local images are fetched through the server's in-process routing; remote images must match `images.remotePatterns`. Optimized images are cached in the [image cache bucket](#load-balancer-cloud-cdn-and-a-dedicated-image-service) when one is configured, otherwise in Memorystore when the shared cache is enabled, otherwise on the instance's disk (which is memory on Cloud Run). With `images.unoptimized`, a custom `images.loader` or `output: 'export'`, `/_next/image` returns 404 as in `next start`. Without `sharp`, the original image is served and a warning is logged.

### Shared cache on Memorystore

Every build points `cacheHandler` and `cacheHandlers` (`default`, `remote`) at the adapter's handlers. Handlers configured by the app take priority, and `NEXT_CLOUD_RUN_CACHE=local` at build time opts out. Without `REDIS_URL` the handlers are Next.js' own file-system and in-memory caches, so the same build works with or without Memorystore. Set `REDIS_URL` at runtime and ISR and route responses, the `fetch` data cache and `'use cache'` entries are shared by all instances, and `revalidateTag`/`revalidatePath` reach every instance. Optimized images also go through Redis when there is no image cache bucket.

```bash
next build
REDIS_URL=redis://10.0.0.3:6379 VPC_NETWORK=default scripts/deploy.sh .
```

- Use Memorystore for Redis, or Memorystore for Valkey with cluster mode disabled. Reach it over Direct VPC egress (`VPC_NETWORK`/`VPC_SUBNET`). Use `rediss://` and `REDIS_CA_CERT` for in-transit encryption.
- Set `maxmemory-policy` to `allkeys-lru` so Redis evicts old entries under memory pressure. Entries also expire after their `expire` time, or `NEXT_REDIS_DEFAULT_TTL` (30 days) when they have none.
- Response, image and `'use cache'` entries are scoped to the build ID, so a new revision never reads another build's pages. `fetch` entries and tags are shared across builds.
- A miss falls back to the build's prerendered pages on local disk.
- When Redis is unreachable, requests are served as cache misses after at most a one-time 2s wait for the first connection, and tag invalidations apply only on the instance that received them.

### Load balancer, Cloud CDN and a dedicated image service

The service alone serves the whole app. For production traffic, put a global external Application Load Balancer in front of it and give image optimization its own service:

```bash
next build

SERVICE=shop REGION=europe-north1 \
  BUCKET=shop-static IMAGE_CACHE_BUCKET=shop-images-cache \
  IMAGE_SERVICE=1 \
  REDIS_URL=redis://10.0.0.3:6379 VPC_NETWORK=default \
  scripts/deploy.sh .

SERVICE=shop REGION=europe-north1 \
  BUCKET=shop-static IMAGE_CACHE_BUCKET=shop-images-cache \
  IMAGE_SERVICE=1 DOMAIN=shop.example.com ARMOR=1 \
  scripts/setup-lb.sh

# Once DNS points at the load balancer, close the run.app URLs:
INGRESS=internal-and-cloud-load-balancing ... scripts/deploy.sh .
```

`scripts/setup-lb.sh` creates the load balancer, or updates it when run again:

| Path              | Backend                                                 | Cloud CDN                |
| ----------------- | ------------------------------------------------------- | ------------------------ |
| `/_next/static/*` | Backend bucket on `BUCKET` (hashed assets, made public) | Yes                      |
| `/_next/image`    | Image service (`IMAGE_SERVICE=1`), otherwise the app    | Yes on the image service |
| everything else   | App service                                             | Only with `APP_CDN=1`    |

- **Image service.** With `IMAGE_SERVICE=1`, `deploy.sh` deploys the image Cloud Build just built a second time as `$SERVICE-images`, with more memory and CPU and a lower concurrency (`IMAGE_MEMORY`, `IMAGE_CPU`, `IMAGE_CONCURRENCY`, `IMAGE_MAX_INSTANCES`). Image bursts then scale on their own and never slow down page rendering. The service runs the same server, and local source images are inside the image.
- **Cloud CDN for images.** Optimized images are sent with `Cache-Control: public, max-age=…` (`images.minimumCacheTTL`, 4 hours by default, or a year for static imports) and `Vary: Accept`. Cloud CDN caches them per format, so most image requests never reach Cloud Run.
- **Cloud CDN for pages.** Next.js pages vary on router headers (`rsc`, `next-router-state-tree`, …), which Cloud CDN does not cache unless they are part of the cache key. `APP_CDN=1` is therefore safe but mainly helps public route handlers and metadata files. Pages cached at the CDN are not purged by `revalidateTag` yet.
- **Image cache bucket.** With `IMAGE_CACHE_BUCKET`, optimized images are stored in Cloud Storage and shared by every instance of both services, instead of instance memory or Memorystore. `setup-lb.sh` creates the bucket with a lifecycle rule that deletes objects after `IMAGE_CACHE_TTL_DAYS` (30), and grants the services' runtime service accounts object access. Requests use the service's own credentials from the metadata server. If the bucket errors, images are optimized as cache misses; after a timeout the bucket is skipped for 10 seconds, so a slow bucket costs at most one timeout per request.
- **Static assets.** `deploy.sh` uploads the hashed assets to `BUCKET` before deploying the new revision and never deletes old ones, so clients on the previous deployment keep working. Build with `NEXT_CLOUD_RUN_ASSET_PREFIX=https://cdn.example.com` only when the assets live on a different domain.
- **Cloud Armor.** `ARMOR=1` attaches a policy with preconfigured XSS and SQLi rules in preview mode: matches are logged but not blocked. Review the logs before enforcing them.
- `DOMAIN` provisions a Google-managed certificate for HTTPS. Without it the load balancer serves HTTP on port 80. Set `BASE_PATH` when the app uses `basePath`.

## Configuration

| Variable                      | When    | Description                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------------- |
| `NEXT_CLOUD_RUN_OUT_DIR`      | build   | Output directory, relative to the project (default `.cloud-run`) |
| `NEXT_CLOUD_RUN_ASSET_PREFIX` | build   | Sets `assetPrefix` when the config does not                      |
| `NEXT_CLOUD_RUN_CACHE`        | build   | `local` opts out of the adapter's cache handlers                 |
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

builds `test/fixture` with the adapter, starts the generated server and checks pages, route handlers, rewrites, redirects, middleware, RSC requests, static and `public/` files, image optimization, 404s and ISR revalidation. It then builds `test/fixture-redis` with the Redis handlers and runs two instances against a local `redis-server` (skipped when it is not installed) to check that cached values, tag invalidations, on-demand ISR and optimized images are shared, and that pages stay fast when Redis is down. Finally it runs two instances against a mock of the Cloud Storage API to check the shared image cache, stale regeneration, and fast fallback when the bucket errors or hangs.

### Next.js compatibility suite

`scripts/e2e-deploy.sh`, `scripts/e2e-logs.sh` and `scripts/e2e-cleanup.sh` implement the [adapter test harness contract](https://nextjs.org/docs/app/api-reference/adapters/testing-adapters). From a Next.js checkout:

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
- **Optimized images in Memorystore** count against its memory and keep the default TTL; prefer an image cache bucket.
- **PPR** works from the origin in one pass; the shell is not served from the CDN.
- Request bodies are buffered in memory when middleware runs on a request with a body.

## Roadmap

- Firestore and Cloud Storage cache handlers, and Memorystore cluster mode.
- Offload ISR revalidation to Cloud Tasks or Pub/Sub so instances can run with CPU throttling.
- Cloud CDN integration: cache tags and invalidation on revalidation, immutable assets (`supportsImmutableAssets`).
- PPR: serve the cached shell immediately and resume the dynamic parts with `next-resume`.
