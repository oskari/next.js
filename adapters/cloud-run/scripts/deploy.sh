#!/usr/bin/env bash
# Deploys a Next.js app built with this adapter to Cloud Run.
#
# Usage: scripts/deploy.sh [project-dir]
#
# Environment:
#   SERVICE   Cloud Run service name (default: project directory name)
#   REGION    Cloud Run region (default: us-central1)
#   PUBLIC=1  Allow unauthenticated access
#   INGRESS   Cloud Run ingress, e.g. internal-and-cloud-load-balancing to
#             only accept traffic through the load balancer (default: all)
#   REDIS_URL Memorystore endpoint for the Redis cache handlers (build with
#             NEXT_CLOUD_RUN_CACHE=redis), e.g. redis://10.0.0.3:6379
#   VPC_NETWORK / VPC_SUBNET
#             Direct VPC egress so the service can reach Memorystore's
#             private IP (VPC_SUBNET defaults to VPC_NETWORK)
#   BUCKET    Optional Cloud Storage bucket for /_next/static assets. Pair it
#             with NEXT_CLOUD_RUN_ASSET_PREFIX at build time and a load
#             balancer backend bucket with Cloud CDN enabled.
#   IMAGE_CACHE_BUCKET
#             Cloud Storage bucket for optimized images, shared by all
#             instances instead of instance memory or Memorystore
#
# Dedicated image service (route /_next/image to it with setup-lb.sh):
#   IMAGE_SERVICE=1     Also deploy the same container image as a second
#                       service tuned for image optimization
#   IMAGE_SERVICE_NAME  default: $SERVICE-images
#   IMAGE_MEMORY        default: 2Gi
#   IMAGE_CPU           default: 2
#   IMAGE_CONCURRENCY   default: 16
#   IMAGE_MAX_INSTANCES default: unset (Cloud Run default)
#
# Prints the app service URL on stdout; everything else goes to stderr.
set -euo pipefail

PROJECT_DIR="$(cd "${1:-.}" && pwd)"
OUT="$PROJECT_DIR/.cloud-run"
if [ ! -f "$OUT/Dockerfile" ]; then
  echo "No $OUT/Dockerfile; run next build with NEXT_ADAPTER_PATH set first" >&2
  exit 1
fi

SERVICE="${SERVICE:-$(basename "$PROJECT_DIR")}"
REGION="${REGION:-us-central1}"

# Use the longest maxDuration of any route as the request timeout.
TIMEOUT="$(node -e '
const m = require(process.argv[1])
const d = Object.values(m.functions).map((f) => f.maxDuration || 0)
console.log(Math.max(300, ...d))
' "$OUT/app/cloud-run-manifest.json")"

if [ -n "${BUCKET:-}" ]; then
  # Upload before deploying so new HTML never references missing assets.
  # Hashed assets are immutable and are never deleted by this script, so
  # clients on the previous deployment keep working.
  gcloud storage rsync --recursive "$OUT/static/_next/static" \
    "gs://$BUCKET/_next/static" \
    --cache-control="public, max-age=31536000, immutable" >&2
fi

# Settings shared by the app and image services.
common=(
  --region "$REGION"
  # Keep CPU allocated after the response so waitUntil work (background ISR
  # and image revalidation, after()) can finish.
  --no-cpu-throttling
)
if [ "${PUBLIC:-}" = "1" ]; then
  common+=(--allow-unauthenticated)
fi
if [ -n "${INGRESS:-}" ]; then
  common+=(--ingress "$INGRESS")
fi
env_vars=()
if [ -n "${REDIS_URL:-}" ]; then
  env_vars+=("REDIS_URL=$REDIS_URL")
fi
if [ -n "${IMAGE_CACHE_BUCKET:-}" ]; then
  env_vars+=("NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET=$IMAGE_CACHE_BUCKET")
fi
if [ ${#env_vars[@]} -gt 0 ]; then
  # gcloud's ^|^ prefix sets "|" as the delimiter, so values may contain
  # commas or "@" (e.g. a Redis URL with credentials).
  common+=(--update-env-vars "^|^$(IFS='|'; echo "${env_vars[*]}")")
fi
if [ -n "${VPC_NETWORK:-}" ]; then
  common+=(
    --network "$VPC_NETWORK"
    --subnet "${VPC_SUBNET:-$VPC_NETWORK}"
    --vpc-egress private-ranges-only
  )
fi

gcloud run deploy "$SERVICE" --source "$OUT" --timeout "$TIMEOUT" \
  "${common[@]}" >&2

if [ "${IMAGE_SERVICE:-}" = "1" ]; then
  # Reuse the image Cloud Build just produced instead of building it twice.
  # The same server handles /_next/image; local source images are inside
  # the image, so this service needs nothing else.
  image="$(gcloud run services describe "$SERVICE" --region "$REGION" \
    --format 'value(spec.template.spec.containers[0].image)')"
  image_args=(
    --image "$image"
    --memory "${IMAGE_MEMORY:-2Gi}"
    --cpu "${IMAGE_CPU:-2}"
    # Decoding and encoding are CPU- and memory-heavy; fewer concurrent
    # requests per instance keeps memory bounded and scales out earlier.
    --concurrency "${IMAGE_CONCURRENCY:-16}"
    --timeout 60
  )
  if [ -n "${IMAGE_MAX_INSTANCES:-}" ]; then
    image_args+=(--max-instances "$IMAGE_MAX_INSTANCES")
  fi
  image_service="${IMAGE_SERVICE_NAME:-$SERVICE-images}"
  gcloud run deploy "$image_service" "${image_args[@]}" "${common[@]}" >&2
  echo "Image service: $(gcloud run services describe "$image_service" \
    --region "$REGION" --format 'value(status.url)')" >&2
fi

gcloud run services describe "$SERVICE" --region "$REGION" \
  --format 'value(status.url)'
