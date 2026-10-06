# Next.js on Cloud Run for production traffic: a global external Application
# Load Balancer with a managed certificate, Cloud CDN for static assets,
# optimized images and cacheable responses, Cloud Armor, a dedicated image
# service, and a shared cache on Memorystore. Several of these are billed
# hourly; see current Google Cloud pricing.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.0.0, < 9.0.0"
    }
  }

  # Keep state in a bucket for a shared environment, e.g.:
  # backend "gcs" {
  #   bucket = "my-terraform-state"
  #   prefix = "nextjs"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "cloud_run" {
  source = "../.."

  project_id = var.project_id
  region     = var.region
  name       = var.name

  # CPU stays allocated so background ISR, image regeneration and after()
  # finish after the response (the default).
  cpu_always_allocated = true

  app = {
    # One warm instance avoids cold starts on the first request.
    min_instances   = var.min_instances
    max_instances   = var.max_instances
    timeout_seconds = var.timeout_seconds
  }

  image_service = {
    enabled       = true
    max_instances = var.image_max_instances
  }

  load_balancer = {
    enabled = true
    domain  = var.domain
    # Cloud Armor's XSS and SQLi rules log matches until enforced. Review the
    # logs, then set armor_enforce = true.
    armor         = true
    armor_enforce = var.armor_enforce
    app_cdn       = true
    base_path     = var.base_path
  }

  static_bucket      = { enabled = true }
  image_cache_bucket = { enabled = true }

  memorystore = {
    enabled        = true
    memory_size_gb = var.redis_memory_size_gb
    network        = var.network
    subnetwork     = var.subnetwork
  }

  env = var.env

  deletion_protection = true
}
