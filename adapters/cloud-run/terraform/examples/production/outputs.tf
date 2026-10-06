# Pass-through of the module outputs, read by the deploy script with
# `terraform output -json`.

output "project_id" {
  value = module.cloud_run.project_id
}

output "region" {
  value = module.cloud_run.region
}

output "app_service" {
  value = module.cloud_run.app_service
}

output "image_service" {
  value = module.cloud_run.image_service
}

output "static_bucket" {
  value = module.cloud_run.static_bucket
}

output "image_cache_bucket" {
  value = module.cloud_run.image_cache_bucket
}

output "artifact_repository" {
  value = module.cloud_run.artifact_repository
}

output "service_account_email" {
  value = module.cloud_run.service_account_email
}

output "load_balancer_ip" {
  value = module.cloud_run.load_balancer_ip
}

output "url" {
  value = module.cloud_run.url
}

output "app_service_uri" {
  value = module.cloud_run.app_service_uri
}

output "image_service_uri" {
  value = module.cloud_run.image_service_uri
}
