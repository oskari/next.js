#!/usr/bin/env bash
# Deploys a Next.js app built with this adapter to Cloud Run.
#
# Usage: scripts/deploy.sh [project-dir]
#
# Environment:
#   SERVICE   Cloud Run service name (default: project directory name)
#   REGION    Cloud Run region (default: us-central1)
#   PUBLIC=1  Allow unauthenticated access
#   BUCKET    Optional Cloud Storage bucket for /_next/static assets. Pair it
#             with NEXT_CLOUD_RUN_ASSET_PREFIX at build time and a load
#             balancer backend bucket with Cloud CDN enabled.
#
# Prints the service URL on stdout; everything else goes to stderr.
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

args=(
  --source "$OUT"
  --region "$REGION"
  --timeout "$TIMEOUT"
  # Keep CPU allocated after the response so waitUntil work (background ISR
  # revalidation, after()) can finish.
  --no-cpu-throttling
)
if [ "${PUBLIC:-}" = "1" ]; then
  args+=(--allow-unauthenticated)
fi

gcloud run deploy "$SERVICE" "${args[@]}" >&2
gcloud run services describe "$SERVICE" --region "$REGION" \
  --format 'value(status.url)'
