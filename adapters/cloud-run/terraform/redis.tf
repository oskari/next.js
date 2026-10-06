resource "google_redis_instance" "cache" {
  count = local.memorystore ? 1 : 0

  project        = var.project_id
  region         = var.region
  name           = coalesce(var.memorystore.name, "${var.name}-cache")
  display_name   = "Next.js cache (${var.name})"
  tier           = var.memorystore.tier
  memory_size_gb = var.memorystore.memory_size_gb
  redis_version  = var.memorystore.redis_version
  redis_configs  = var.memorystore.redis_configs
  connect_mode   = "DIRECT_PEERING"
  authorized_network = (
    strcontains(var.memorystore.network, "/")
    ? var.memorystore.network
    : "projects/${var.project_id}/global/networks/${var.memorystore.network}"
  )
  transit_encryption_mode = var.memorystore.transit_encryption ? "SERVER_AUTHENTICATION" : "DISABLED"
  labels                  = var.labels
  deletion_protection     = var.deletion_protection

  depends_on = [google_project_service.this]
}
