locals {
  lb            = var.load_balancer.enabled
  domain        = local.lb ? var.load_balancer.domain : null
  https         = local.domain != null
  base_path     = var.load_balancer.base_path
  image_enabled = var.image_service.enabled
  image_name    = coalesce(var.image_service.name, "${var.name}-images")

  static_bucket_enabled = var.static_bucket.enabled
  static_bucket_name = coalesce(
    var.static_bucket.name,
    replace(substr(lower("${var.project_id}-${var.name}-static"), 0, 63), "/[-_.]+$/", ""),
  )
  image_cache_enabled = var.image_cache_bucket.enabled
  image_cache_name = coalesce(
    var.image_cache_bucket.name,
    replace(substr(lower("${var.project_id}-${var.name}-image-cache"), 0, 63), "/[-_.]+$/", ""),
  )

  memorystore = var.memorystore.enabled
  # With Memorystore, its network doubles as the services' VPC unless `vpc`
  # says otherwise; Memorystore's private IP is only reachable from there.
  vpc = var.vpc != null ? var.vpc : (local.memorystore ? {
    network    = var.memorystore.network
    subnetwork = var.memorystore.subnetwork
    egress     = "PRIVATE_RANGES_ONLY"
    tags       = null
  } : null)

  ingress = coalesce(
    var.ingress,
    local.lb ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL",
  )

  service_account_email = (
    var.service_account_email != null
    ? var.service_account_email
    : google_service_account.runtime[0].email
  )

  repository_id       = coalesce(var.artifact_registry.repository_id, var.name)
  artifact_repository = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repository_id}"

  # Release images replace this on every deploy; see the services' lifecycle.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"

  redis_url = local.memorystore ? format(
    "%s://%s:%s",
    var.memorystore.transit_encryption ? "rediss" : "redis",
    google_redis_instance.cache[0].host,
    google_redis_instance.cache[0].port,
  ) : var.redis_url
  redis_ca_cert = (
    local.memorystore && var.memorystore.transit_encryption
    ? join("\n", google_redis_instance.cache[0].server_ca_certs[*].cert)
    : var.redis_ca_cert
  )

  # Same environment on both services. Module-managed values win over `env`.
  env = merge(
    var.env,
    local.redis_url != null ? { REDIS_URL = local.redis_url } : {},
    local.redis_ca_cert != null ? { REDIS_CA_CERT = local.redis_ca_cert } : {},
    local.image_cache_enabled ? { NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET = local.image_cache_name } : {},
  )

  apis = toset(concat(
    [
      "artifactregistry.googleapis.com",
      "cloudbuild.googleapis.com",
      "iam.googleapis.com",
      "run.googleapis.com",
      "storage.googleapis.com",
    ],
    local.lb || local.vpc != null ? ["compute.googleapis.com"] : [],
    local.memorystore ? ["redis.googleapis.com"] : [],
  ))
}

resource "google_project_service" "this" {
  for_each = var.enable_apis ? local.apis : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Runtime service account --------------------------------------------------

resource "google_service_account" "runtime" {
  count = var.service_account_email == null ? 1 : 0

  project      = var.project_id
  account_id   = "${substr(var.name, 0, 22)}-runtime"
  display_name = "Next.js on Cloud Run (${var.name}) runtime"
  description  = "Runtime identity of the ${var.name} Cloud Run services."

  depends_on = [google_project_service.this]
}

# --- Artifact Registry --------------------------------------------------------

resource "google_artifact_registry_repository" "this" {
  project       = var.project_id
  location      = var.region
  repository_id = local.repository_id
  format        = "DOCKER"
  description   = "Next.js release images for ${var.name}."
  labels        = var.labels

  deletion_policy        = var.deletion_protection ? "PREVENT" : "DELETE"
  cleanup_policy_dry_run = false

  # KEEP policies take precedence over DELETE policies, so this deletes every
  # version except the most recent ones.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_registry.keep_versions
    }
  }

  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }

  depends_on = [google_project_service.this]
}

check "image_service_reachable" {
  assert {
    condition     = !(local.image_enabled && !local.lb)
    error_message = "image_service is enabled without the load balancer. Nothing routes /_next/image to it; disable it or enable load_balancer."
  }
}
