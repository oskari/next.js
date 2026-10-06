# Next.js on Cloud Run, kept within the Google Cloud free tier as far as
# possible: one app service with request-based billing that scales to zero,
# an image cache bucket and a small registry. No load balancer, CDN, Cloud
# Armor or Memorystore, which have no free tier.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.0.0, < 9.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "cloud_run" {
  source = "../.."

  project_id = var.project_id
  # Cloud Storage's free tier only covers some US regions; us-central1 is one.
  region = var.region
  name   = var.name

  # Request-based billing: CPU only during requests, and idle instances cost
  # nothing. Background ISR revalidation and after() may then be delayed until
  # the next request reaches the instance.
  cpu_always_allocated = false

  app = {
    min_instances = 0
    max_instances = var.max_instances
  }

  # The load balancer, Cloud CDN and Cloud Armor have no free tier. Testing
  # them for a few hours and destroying them afterwards costs cents; see
  # current Google Cloud pricing. Without the load balancer nothing routes to
  # the image service or serves the static bucket, so they follow it.
  load_balancer = {
    enabled = var.enable_load_balancer
  }
  image_service = {
    enabled = var.enable_load_balancer
  }
  static_bucket = {
    enabled = var.enable_load_balancer
  }

  # Optimized images are cached in Cloud Storage, shared by every instance.
  image_cache_bucket = {
    enabled = true
  }

  # Memorystore has no free tier.
  memorystore = {
    enabled = false
  }

  # Artifact Registry's free tier is 0.5 GB of storage.
  artifact_registry = {
    keep_versions = 2
  }

  # So that `terraform destroy` removes everything, including non-empty
  # buckets.
  deletion_protection = false
}
