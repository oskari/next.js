#!/usr/bin/env bash
# Releases a Next.js app built with this adapter to Cloud Run.
#
# Usage: TF_DIR=path/to/terraform scripts/deploy.sh [project-dir]
#
# With TF_DIR, infrastructure and service settings come from the Terraform
# module in ../terraform; this script only ships a release:
#   1. builds the container image with Cloud Build and pushes it to the
#      module's Artifact Registry repository,
#   2. uploads /_next/static to the static bucket (before the new revision
#      goes live, so its HTML never references missing assets),
#   3. rolls the new image out to the app service and the image service.
# Each value can also be passed directly instead of TF_DIR: PROJECT, REGION,
# APP_SERVICE, IMAGE_SERVICE, STATIC_BUCKET, ARTIFACT_REPOSITORY, URL.
#
# Without TF_DIR or ARTIFACT_REPOSITORY it is a quick start: one service
# deployed with `gcloud run deploy --source`, public unless PUBLIC=0, named
# after the project directory or SERVICE, in REGION (default us-central1).
#
# Prints the app URL on stdout; everything else goes to stderr.
set -euo pipefail

PROJECT_DIR="$(cd "${1:-.}" && pwd)"
OUT="$PROJECT_DIR/.cloud-run"
if [ ! -f "$OUT/Dockerfile" ]; then
  echo "No $OUT/Dockerfile; run next build with NEXT_ADAPTER_PATH set first" >&2
  exit 1
fi

if [ -n "${TF_DIR:-}" ]; then
  # Read the module outputs; values already set in the environment win.
  eval "$(terraform -chdir="$TF_DIR" output -json | node -e '
    const outputs = JSON.parse(require("fs").readFileSync(0, "utf8"))
    const names = {
      project_id: "PROJECT", region: "REGION", app_service: "APP_SERVICE",
      image_service: "IMAGE_SERVICE", static_bucket: "STATIC_BUCKET",
      artifact_repository: "ARTIFACT_REPOSITORY", url: "URL",
    }
    for (const [output, name] of Object.entries(names)) {
      const value = outputs[output]?.value
      if (value == null || value === "") continue
      const quoted = "\x27" + String(value).replace(/\x27/g, "\x27\\\x27\x27") + "\x27"
      console.log(`[ -n "\${${name}:-}" ] || ${name}=${quoted}`)
    }
  ')"
fi

REGION="${REGION:-us-central1}"
project_args=()
if [ -n "${PROJECT:-}" ]; then project_args=(--project "$PROJECT"); fi

if [ -z "${ARTIFACT_REPOSITORY:-}" ]; then
  # Quick start without Terraform.
  service="${APP_SERVICE:-${SERVICE:-$(basename "$PROJECT_DIR")}}"
  auth=(--allow-unauthenticated)
  if [ "${PUBLIC:-}" = "0" ]; then auth=(--no-allow-unauthenticated); fi
  gcloud run deploy "$service" --source "$OUT" --region "$REGION" \
    ${project_args[@]+"${project_args[@]}"} "${auth[@]}" >&2
  gcloud run services describe "$service" --region "$REGION" \
    ${project_args[@]+"${project_args[@]}"} --format 'value(status.url)'
  exit 0
fi

: "${APP_SERVICE:?Set TF_DIR or APP_SERVICE}"
build_id="$(cat "$PROJECT_DIR/.next/BUILD_ID" 2>/dev/null || date +%s)"
image="$ARTIFACT_REPOSITORY/$APP_SERVICE:$(echo "$build_id" | tr -c 'A-Za-z0-9_.\n-' '-')"

gcloud builds submit "$OUT" --tag "$image" \
  ${project_args[@]+"${project_args[@]}"} >&2

if [ -n "${STATIC_BUCKET:-}" ]; then
  # Hashed assets are immutable and never deleted here, so clients still on
  # the previous revision keep working.
  gcloud storage rsync --recursive "$OUT/static/_next/static" \
    "gs://$STATIC_BUCKET/_next/static" \
    --cache-control="public, max-age=31536000, immutable" \
    ${project_args[@]+"${project_args[@]}"} >&2
fi

for service in "$APP_SERVICE" ${IMAGE_SERVICE:+"$IMAGE_SERVICE"}; do
  # Only the image changes; Terraform owns every other setting and ignores
  # the image field, so the two never fight.
  gcloud run deploy "$service" --image "$image" --region "$REGION" \
    ${project_args[@]+"${project_args[@]}"} >&2
done

if [ -n "${URL:-}" ]; then
  echo "$URL"
else
  gcloud run services describe "$APP_SERVICE" --region "$REGION" \
    ${project_args[@]+"${project_args[@]}"} --format 'value(status.url)'
fi
