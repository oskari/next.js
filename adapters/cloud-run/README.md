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

### Deploy to Google Cloud

Infrastructure is a Terraform module in [`terraform/`](terraform); releases are shipped by `scripts/deploy.sh`.

1. **Provision once** (and whenever settings change) with one of the examples, or your own module call:

   ```bash
   cd terraform/examples/production   # or examples/free-tier
   terraform init
   terraform apply -var project_id=my-project -var domain=shop.example.com
   ```

   The module creates the Cloud Run services (with a placeholder image until the first release), an Artifact Registry repository, a runtime service account, the buckets, and, by default, the load balancer with Cloud CDN and Cloud Armor. See [Infrastructure](#infrastructure) for what it creates and how to turn parts off.

2. **Release** each build:

   ```bash
   next build
   TF_DIR=terraform/examples/production scripts/deploy.sh .
   ```

   `deploy.sh` reads the module outputs, builds the container image with Cloud Build into the module's registry, uploads `/_next/static` to the static bucket, then rolls the new image out to the app and image services. It changes only the image; Terraform owns every other setting and ignores the image field, so `terraform apply` never rolls a release back. Values can also come from the environment (`PROJECT`, `REGION`, `APP_SERVICE`, `IMAGE_SERVICE`, `STATIC_BUCKET`, `ARTIFACT_REPOSITORY`, `URL`) instead of `TF_DIR`. Whoever runs it needs permission to push to the registry and deploy the services.

**Quick start without Terraform:** `scripts/deploy.sh .` with no `TF_DIR` deploys a single public service from source (`gcloud run deploy --source`), named after the project directory or `SERVICE`, in `REGION` (default `us-central1`). `PUBLIC=0` keeps it private.

Build on Linux x64 (or in Cloud Build), so native dependencies match the container. This matters for `sharp`, which image optimization uses: the adapter keeps only the linux-x64-glibc `@img/sharp-*` binaries and warns at build time when they are missing. On another platform, run `npm install --os=linux --cpu=x64 --libc=glibc sharp` before building.

### Trying it within the free tier

[`terraform/examples/free-tier`](terraform/examples/free-tier) stays within the Google Cloud free tier as far as possible: one app service in `us-central1` that scales to zero and only uses CPU during requests, an image cache bucket, and a registry that keeps two image versions. It leaves out the load balancer, Cloud CDN, Cloud Armor and Memorystore, which have no free tier.

```bash
EXAMPLE=$PWD/terraform/examples/free-tier
terraform -chdir=$EXAMPLE init
terraform -chdir=$EXAMPLE apply -var project_id=my-project

# From your Next.js app, built with this adapter:
next build && TF_DIR=$EXAMPLE /path/to/next-adapter-cloud-run/scripts/deploy.sh .

# When done:
terraform -chdir=$EXAMPLE destroy -var project_id=my-project
```

- To try the load balancer, CDN and image service, apply with `-var enable_load_balancer=true` and destroy afterwards; a few hours costs little, but check current pricing.
- With CPU only during requests, background ISR revalidation and `after()` work may be delayed until the next request reaches the instance.
- Cloud Build keeps uploaded sources in a `<project>_cloudbuild` bucket, which counts towards the Cloud Storage allowance.
- Set a budget alert on the billing account before trying the paid parts.

### Image optimization

`/_next/image` is served with Next.js' own image optimizer and the same validation, headers and caching as `next start`. Local images are fetched through the server's in-process routing; remote images must match `images.remotePatterns`. Optimized images are cached in the [image cache bucket](#infrastructure) when one is configured, otherwise in Memorystore when the shared cache is enabled, otherwise on the instance's disk (which is memory on Cloud Run). With `images.unoptimized`, a custom `images.loader` or `output: 'export'`, `/_next/image` returns 404 as in `next start`. Without `sharp`, the original image is served and a warning is logged.

### Shared cache on Memorystore

Every build points `cacheHandler` and `cacheHandlers` (`default`, `remote`) at the adapter's handlers. Handlers configured by the app take priority, and `NEXT_CLOUD_RUN_CACHE=local` at build time opts out. Without `REDIS_URL` the handlers are Next.js' own file-system and in-memory caches, so the same build works with or without Memorystore. Set `REDIS_URL` at runtime and ISR and route responses, the `fetch` data cache and `'use cache'` entries are shared by all instances, and `revalidateTag`/`revalidatePath` reach every instance. Optimized images also go through Redis when there is no image cache bucket.

With the Terraform module, `memorystore = { enabled = true }` creates a Memorystore for Redis instance, sets `REDIS_URL` on both services and connects them over Direct VPC egress. To use an existing instance instead, pass `redis_url` (and `vpc` for the network).

- Memorystore for Redis, or Memorystore for Valkey with cluster mode disabled, both work. `memorystore.transit_encryption = true` switches to `rediss://` and sets `REDIS_CA_CERT`.
- Redis should evict old entries under memory pressure with `maxmemory-policy allkeys-lru`, which the module sets. Entries also expire after their `expire` time, or `NEXT_REDIS_DEFAULT_TTL` (30 days) when they have none.
- Response, image and `'use cache'` entries are scoped to the build ID, so a new revision never reads another build's pages. `fetch` entries and tags are shared across builds.
- A miss falls back to the build's prerendered pages on local disk.
- When Redis is unreachable, requests are served as cache misses after at most a one-time 2s wait for the first connection, and tag invalidations apply only on the instance that received them.

### Infrastructure

The Terraform module turns on everything that is safe by default; each part has an opt-out, and parts that need an input switch on when it is given:

| Part                                                                       | Default                                               | Turn off / configure                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| App service                                                                | on; CPU always allocated so `waitUntil` work finishes | `app = {...}`, `cpu_always_allocated = false`                         |
| Image service (`<name>-images`): same image, 2 vCPU, 2 GiB, concurrency 16 | on                                                    | `image_service = { enabled = false }`                                 |
| Static bucket for `/_next/static` (public)                                 | on                                                    | `static_bucket = { enabled = false }`                                 |
| Image cache bucket (private, objects deleted after 30 days)                | on                                                    | `image_cache_bucket = { enabled = false, ttl_days = … }`              |
| Global external Application Load Balancer                                  | on                                                    | `load_balancer = { enabled = false }`                                 |
| Cloud CDN on static, image and app backends                                | on                                                    | `load_balancer = { app_cdn = false }` (static and image always cache) |
| Cloud Armor XSS/SQLi rules, preview (log-only)                             | on                                                    | `load_balancer = { armor = false }` or `armor_enforce = true`         |
| HTTPS with a managed certificate, HTTP→HTTPS redirect                      | when `domain` is set                                  | `load_balancer = { domain = "…", https_redirect = false }`            |
| Ingress only through the load balancer                                     | with the load balancer                                | `ingress = "INGRESS_TRAFFIC_ALL"`                                     |
| Public invoker (`allUsers`)                                                | on                                                    | `allow_unauthenticated = false`                                       |
| Memorystore + Direct VPC egress                                            | off (no free tier)                                    | `memorystore = { enabled = true }`, or `redis_url`                    |
| Artifact Registry cleanup                                                  | keep 10 versions                                      | `artifact_registry = { keep_versions = … }`                           |

The load balancer routes requests like this:

| Path              | Backend                          | Cloud CDN                     |
| ----------------- | -------------------------------- | ----------------------------- |
| `/_next/static/*` | Static bucket (hashed assets)    | Yes                           |
| `/_next/image`    | Image service, otherwise the app | Yes                           |
| everything else   | App service                      | Yes, unless `app_cdn = false` |

- **Image service.** Image bursts scale on their own and never slow down page rendering. It runs the same server, and local source images are inside the image.
- **Cloud CDN for images.** Optimized images are sent with `Cache-Control: public, max-age=…` (`images.minimumCacheTTL`, 4 hours by default, or a year for static imports) and `Vary: Accept`, which Cloud CDN caches per format, so most image requests never reach Cloud Run.
- **Cloud CDN for pages.** Next.js pages vary on router headers (`rsc`, `next-router-state-tree`, …), which Cloud CDN does not cache unless they are part of the cache key, so the app backend mainly caches public route handlers and metadata files. Responses cached at the CDN are not purged by `revalidateTag` yet.
- **Image cache bucket.** Optimized images are stored in Cloud Storage and shared by every instance of both services, instead of instance memory or Memorystore. Requests use the service's own credentials from the metadata server. If the bucket errors, images are optimized as cache misses; after a timeout the bucket is skipped for 10 seconds, so a slow bucket costs at most one timeout per request.
- **Static assets.** `deploy.sh` uploads the hashed assets before the new revision goes live and never deletes old ones, so clients on the previous revision keep working. Build with `NEXT_CLOUD_RUN_ASSET_PREFIX=https://cdn.example.com` only when the assets live on a different domain.
- **Cloud Armor** starts in preview mode: matches are logged but not blocked. Review the logs before setting `armor_enforce = true`.
- Set `load_balancer.base_path` when the app uses `basePath`.

See [`terraform/variables.tf`](terraform/variables.tf) for every variable, and the example READMEs for complete setups.

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

builds `test/fixture` with the adapter, starts the generated server and checks pages, route handlers, rewrites, redirects, middleware, RSC requests, static and `public/` files, image optimization, 404s and ISR revalidation. It then builds `test/fixture-redis` with the Redis handlers and runs two instances against a local `redis-server` (skipped when it is not installed) to check that cached values, tag invalidations, on-demand ISR and optimized images are shared, and that pages stay fast when Redis is down. Finally it runs two instances against a mock of the Cloud Storage API to check the shared image cache, stale regeneration, and fast fallback when the bucket errors or hangs. `test/deploy.mjs` runs `scripts/deploy.sh` against fake `gcloud` and `terraform` binaries.

The Terraform module has its own tests, which run against a mocked Google provider:

```bash
cd terraform && terraform init -backend=false && terraform test
```

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
