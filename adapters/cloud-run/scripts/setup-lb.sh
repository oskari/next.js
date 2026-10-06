#!/usr/bin/env bash
# Creates or updates the global external Application Load Balancer in front
# of a Cloud Run deployment made with deploy.sh:
#
#   /_next/static/*  -> backend bucket (Cloud Storage, Cloud CDN)
#   /_next/image     -> image service (Cloud CDN), or the app service
#   everything else  -> app service (Cloud CDN optional)
#
# Run it after the first deploy.sh. It is safe to run again; existing
# resources are kept and the URL map is replaced.
#
# Environment:
#   SERVICE        Cloud Run app service (required)
#   REGION         Cloud Run region (default: us-central1)
#   NAME           Prefix for load balancer resources (default: $SERVICE)
#   BUCKET         Static asset bucket (the one deploy.sh uploads to). Created
#                  if missing and made publicly readable, since the CDN
#                  serves its objects to anyone.
#   IMAGE_SERVICE=1 / IMAGE_SERVICE_NAME
#                  Route /_next/image to the image service deploy.sh created
#                  (default name: $SERVICE-images)
#   IMAGE_CACHE_BUCKET
#                  Optimized-image cache bucket. Created if missing, with a
#                  lifecycle rule deleting objects after IMAGE_CACHE_TTL_DAYS
#                  (default 30), and writable by the services' runtime
#                  service accounts.
#   BASE_PATH      The app's basePath, if any (prefixes the routed paths)
#   DOMAIN         Domain for a Google-managed certificate (HTTPS on 443).
#                  Without it the load balancer serves HTTP on port 80.
#   APP_CDN=1      Enable Cloud CDN on the app backend too. Next.js pages
#                  vary on router headers, which Cloud CDN does not cache, so
#                  this mainly helps public route handlers and metadata.
#   ARMOR=1        Attach a Cloud Armor policy with preconfigured XSS and
#                  SQLi rules in preview mode (logged, not enforced)
set -euo pipefail

: "${SERVICE:?Set SERVICE to the Cloud Run app service}"
REGION="${REGION:-us-central1}"
NAME="${NAME:-$SERVICE}"
BASE_PATH="${BASE_PATH:-}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
: "${PROJECT:?Set a project with gcloud config set project}"
COMPUTE="https://www.googleapis.com/compute/v1/projects/$PROJECT"
IMAGE_SERVICE_NAME="${IMAGE_SERVICE_NAME:-$SERVICE-images}"

log() { echo "==> $*" >&2; }
exists() { "$@" >/dev/null 2>&1; }

runtime_service_account() {
  local account
  account="$(gcloud run services describe "$1" --region "$REGION" \
    --format 'value(spec.template.spec.serviceAccountName)')"
  if [ -z "$account" ]; then
    local number
    number="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
    account="$number-compute@developer.gserviceaccount.com"
  fi
  echo "$account"
}

# A serverless NEG and a global backend service for one Cloud Run service.
serverless_backend() {
  local service="$1" backend="$2" cdn="$3"
  if ! exists gcloud compute network-endpoint-groups describe "$backend-neg" \
    --region "$REGION"; then
    log "Creating serverless NEG $backend-neg -> $service"
    gcloud compute network-endpoint-groups create "$backend-neg" \
      --region "$REGION" --network-endpoint-type serverless \
      --cloud-run-service "$service" >&2
  fi
  if ! exists gcloud compute backend-services describe "$backend" --global; then
    log "Creating backend service $backend (cdn=$cdn)"
    local cdn_args=()
    if [ "$cdn" = "1" ]; then
      # Cache only what the origin marks cacheable via Cache-Control.
      cdn_args=(--enable-cdn --cache-mode USE_ORIGIN_HEADERS)
    fi
    gcloud compute backend-services create "$backend" --global \
      --load-balancing-scheme EXTERNAL_MANAGED ${cdn_args[@]+"${cdn_args[@]}"} >&2
    gcloud compute backend-services add-backend "$backend" --global \
      --network-endpoint-group "$backend-neg" \
      --network-endpoint-group-region "$REGION" >&2
  fi
}

# --- Buckets -----------------------------------------------------------------

if [ -n "${BUCKET:-}" ]; then
  if ! exists gcloud storage buckets describe "gs://$BUCKET"; then
    log "Creating static asset bucket gs://$BUCKET"
    gcloud storage buckets create "gs://$BUCKET" --location "$REGION" \
      --uniform-bucket-level-access >&2
  fi
  log "Making gs://$BUCKET publicly readable for Cloud CDN"
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
    --member allUsers --role roles/storage.objectViewer >/dev/null
  if ! exists gcloud compute backend-buckets describe "$NAME-static"; then
    log "Creating backend bucket $NAME-static"
    gcloud compute backend-buckets create "$NAME-static" \
      --gcs-bucket-name "$BUCKET" --enable-cdn \
      --cache-mode USE_ORIGIN_HEADERS >&2
  fi
fi

if [ -n "${IMAGE_CACHE_BUCKET:-}" ]; then
  if ! exists gcloud storage buckets describe "gs://$IMAGE_CACHE_BUCKET"; then
    log "Creating image cache bucket gs://$IMAGE_CACHE_BUCKET"
    gcloud storage buckets create "gs://$IMAGE_CACHE_BUCKET" \
      --location "$REGION" --uniform-bucket-level-access >&2
  fi
  # Cached images are regenerated on demand, so expiring them only bounds
  # storage; it never breaks a page.
  lifecycle="$(mktemp)"
  trap 'rm -f "$lifecycle"' EXIT
  cat > "$lifecycle" <<EOF
{"rule": [{"action": {"type": "Delete"},
           "condition": {"age": ${IMAGE_CACHE_TTL_DAYS:-30}}}]}
EOF
  gcloud storage buckets update "gs://$IMAGE_CACHE_BUCKET" \
    --lifecycle-file "$lifecycle" >&2
  services=("$SERVICE")
  if [ "${IMAGE_SERVICE:-}" = "1" ]; then services+=("$IMAGE_SERVICE_NAME"); fi
  for service in "${services[@]}"; do
    account="$(runtime_service_account "$service")"
    log "Granting $account object access on gs://$IMAGE_CACHE_BUCKET"
    gcloud storage buckets add-iam-policy-binding "gs://$IMAGE_CACHE_BUCKET" \
      --member "serviceAccount:$account" --role roles/storage.objectUser \
      >/dev/null
  done
fi

# --- Backends ----------------------------------------------------------------

serverless_backend "$SERVICE" "$NAME-app" "${APP_CDN:-0}"
image_backend="$NAME-app"
if [ "${IMAGE_SERVICE:-}" = "1" ]; then
  # Optimized images send `Cache-Control: public, max-age=...` and
  # `Vary: Accept`, which Cloud CDN caches per format.
  serverless_backend "$IMAGE_SERVICE_NAME" "$NAME-images" 1
  image_backend="$NAME-images"
fi

if [ "${ARMOR:-}" = "1" ]; then
  if ! exists gcloud compute security-policies describe "$NAME-armor"; then
    log "Creating Cloud Armor policy $NAME-armor (rules in preview mode)"
    gcloud compute security-policies create "$NAME-armor" \
      --description "Next.js on Cloud Run" >&2
    gcloud compute security-policies rules create 1000 \
      --security-policy "$NAME-armor" --action deny-403 --preview \
      --expression "evaluatePreconfiguredWaf('xss-v33-stable')" >&2
    gcloud compute security-policies rules create 1001 \
      --security-policy "$NAME-armor" --action deny-403 --preview \
      --expression "evaluatePreconfiguredWaf('sqli-v33-stable')" >&2
  fi
  for backend in $(printf '%s\n' "$NAME-app" "$image_backend" | sort -u); do
    gcloud compute backend-services update "$backend" --global \
      --security-policy "$NAME-armor" >&2
  done
fi

# --- URL map -----------------------------------------------------------------

url_map="$(mktemp)"
trap 'rm -f "$url_map" "${lifecycle:-}"' EXIT
{
  echo "name: $NAME"
  echo "defaultService: $COMPUTE/global/backendServices/$NAME-app"
  echo "hostRules:"
  echo "- hosts: ['*']"
  echo "  pathMatcher: next"
  echo "pathMatchers:"
  echo "- name: next"
  echo "  defaultService: $COMPUTE/global/backendServices/$NAME-app"
  echo "  pathRules:"
  echo "  - paths: ['$BASE_PATH/_next/image']"
  echo "    service: $COMPUTE/global/backendServices/$image_backend"
  if [ -n "${BUCKET:-}" ]; then
    echo "  - paths: ['$BASE_PATH/_next/static/*']"
    echo "    service: $COMPUTE/global/backendBuckets/$NAME-static"
  fi
} > "$url_map"
if ! exists gcloud compute url-maps describe "$NAME" --global; then
  gcloud compute url-maps create "$NAME" --global \
    --default-service "$NAME-app" >&2
fi
log "Writing URL map $NAME"
gcloud compute url-maps import "$NAME" --global --source "$url_map" --quiet >&2

# --- Frontend ----------------------------------------------------------------

if ! exists gcloud compute addresses describe "$NAME-ip" --global; then
  log "Reserving global IP $NAME-ip"
  gcloud compute addresses create "$NAME-ip" --global >&2
fi

if [ -n "${DOMAIN:-}" ]; then
  if ! exists gcloud compute ssl-certificates describe "$NAME-cert" --global; then
    log "Creating managed certificate for $DOMAIN"
    gcloud compute ssl-certificates create "$NAME-cert" --global \
      --domains "$DOMAIN" >&2
  fi
  if ! exists gcloud compute target-https-proxies describe "$NAME-https"; then
    gcloud compute target-https-proxies create "$NAME-https" \
      --url-map "$NAME" --ssl-certificates "$NAME-cert" >&2
  fi
  if ! exists gcloud compute forwarding-rules describe "$NAME-https" --global; then
    gcloud compute forwarding-rules create "$NAME-https" --global \
      --load-balancing-scheme EXTERNAL_MANAGED --address "$NAME-ip" \
      --target-https-proxy "$NAME-https" --ports 443 >&2
  fi
else
  if ! exists gcloud compute target-http-proxies describe "$NAME-http"; then
    gcloud compute target-http-proxies create "$NAME-http" --url-map "$NAME" >&2
  fi
  if ! exists gcloud compute forwarding-rules describe "$NAME-http" --global; then
    gcloud compute forwarding-rules create "$NAME-http" --global \
      --load-balancing-scheme EXTERNAL_MANAGED --address "$NAME-ip" \
      --target-http-proxy "$NAME-http" --ports 80 >&2
  fi
fi

ip="$(gcloud compute addresses describe "$NAME-ip" --global --format 'value(address)')"
log "Load balancer IP: $ip"
if [ -n "${DOMAIN:-}" ]; then
  log "Point an A record for $DOMAIN at $ip; the certificate provisions after DNS resolves."
fi
log "Lock the services to the load balancer with INGRESS=internal-and-cloud-load-balancing scripts/deploy.sh"
echo "$ip"
