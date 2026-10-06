# The deploy script reads these with `terraform output -json`.

output "project_id" {
  description = "Google Cloud project."
  value       = var.project_id
}

output "region" {
  description = "Region of the Cloud Run services, buckets and registry."
  value       = var.region
}

output "app_service" {
  description = "Name of the app's Cloud Run service."
  value       = google_cloud_run_v2_service.this["app"].name
}

output "image_service" {
  description = "Name of the image optimization service, or null."
  value       = local.image_enabled ? google_cloud_run_v2_service.this["image"].name : null
}

output "static_bucket" {
  description = "Bucket the deploy script uploads /_next/static to, or null."
  value       = one(google_storage_bucket.static[*].name)
}

output "image_cache_bucket" {
  description = "Optimized-image cache bucket, or null."
  value       = one(google_storage_bucket.image_cache[*].name)
}

output "artifact_repository" {
  description = "Docker repository for release images, e.g. us-central1-docker.pkg.dev/PROJECT/REPO."
  value       = local.artifact_repository
}

output "service_account_email" {
  description = "Runtime service account of both Cloud Run services."
  value       = local.service_account_email
}

output "load_balancer_ip" {
  description = "Load balancer IP address, or null. Point the domain's A record here."
  value       = one(google_compute_global_address.this[*].address)
}

output "url" {
  description = "Public URL: https://<domain>, http://<load balancer IP>, or the app service URI without a load balancer."
  value = (
    local.https ? "https://${local.domain}" :
    local.lb ? "http://${google_compute_global_address.this[0].address}" :
    google_cloud_run_v2_service.this["app"].uri
  )
}

output "app_service_uri" {
  description = "run.app URI of the app service (closed to the internet when ingress is internal-and-load-balancer)."
  value       = google_cloud_run_v2_service.this["app"].uri
}

output "image_service_uri" {
  description = "run.app URI of the image service, or null."
  value       = local.image_enabled ? google_cloud_run_v2_service.this["image"].uri : null
}
