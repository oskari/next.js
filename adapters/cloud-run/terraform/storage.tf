# --- Static assets ------------------------------------------------------------

resource "google_storage_bucket" "static" {
  count = local.static_bucket_enabled ? 1 : 0

  project                     = var.project_id
  name                        = local.static_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  # The CDN serves these objects to anyone, so allUsers must be allowed.
  public_access_prevention = "inherited"
  labels                   = var.labels

  force_destroy   = !var.deletion_protection
  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"

  depends_on = [google_project_service.this]
}

resource "google_storage_bucket_iam_member" "static_public" {
  count = local.static_bucket_enabled ? 1 : 0

  bucket = google_storage_bucket.static[0].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# --- Optimized image cache ----------------------------------------------------

resource "google_storage_bucket" "image_cache" {
  count = local.image_cache_enabled ? 1 : 0

  project                     = var.project_id
  name                        = local.image_cache_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = var.labels

  force_destroy   = !var.deletion_protection
  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"

  # Cached images are regenerated on demand, so expiring them only bounds
  # storage; it never breaks a page.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.image_cache_bucket.ttl_days
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_storage_bucket_iam_member" "image_cache_runtime" {
  count = local.image_cache_enabled ? 1 : 0

  bucket = google_storage_bucket.image_cache[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${local.service_account_email}"
}
