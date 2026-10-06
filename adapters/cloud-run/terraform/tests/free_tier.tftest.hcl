mock_provider "google" {
  source = "./tests/mocks"
}

# Mirrors the module call in examples/free-tier.
run "free_tier_settings" {
  command = apply

  variables {
    project_id           = "test-project"
    region               = "us-central1"
    cpu_always_allocated = false
    app                  = { min_instances = 0, max_instances = 3 }
    load_balancer        = { enabled = false }
    image_service        = { enabled = false }
    static_bucket        = { enabled = false }
    image_cache_bucket   = { enabled = true }
    memorystore          = { enabled = false }
    artifact_registry    = { keep_versions = 2 }
    deletion_protection  = false
  }

  assert {
    condition = (
      length(google_compute_global_address.this) == 0 &&
      length(google_compute_region_network_endpoint_group.this) == 0 &&
      length(google_compute_backend_service.this) == 0 &&
      length(google_compute_backend_bucket.static) == 0 &&
      length(google_compute_security_policy.this) == 0 &&
      length(google_compute_url_map.this) == 0 &&
      length(google_compute_url_map.https_redirect) == 0 &&
      length(google_compute_managed_ssl_certificate.this) == 0 &&
      length(google_compute_target_http_proxy.this) == 0 &&
      length(google_compute_target_https_proxy.this) == 0 &&
      length(google_compute_global_forwarding_rule.http) == 0 &&
      length(google_compute_global_forwarding_rule.https) == 0
    )
    error_message = "No load balancer resources are planned."
  }

  assert {
    condition     = length(google_redis_instance.cache) == 0 && length(google_storage_bucket.static) == 0
    error_message = "No Memorystore instance or static bucket."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "compute.googleapis.com") && !contains(keys(google_project_service.this), "redis.googleapis.com")
    error_message = "Compute Engine and Memorystore APIs are not enabled."
  }

  assert {
    condition     = keys(google_cloud_run_v2_service.this) == ["app"]
    error_message = "Only the app service runs."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.this["app"].template[0].containers[0].resources[0].cpu_idle &&
      google_cloud_run_v2_service.this["app"].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.this["app"].template[0].scaling[0].max_instance_count == 3
    )
    error_message = "CPU is throttled outside requests and the service scales to zero."
  }

  assert {
    condition     = google_cloud_run_v2_service.this["app"].ingress == "INGRESS_TRAFFIC_ALL" && length(google_cloud_run_v2_service_iam_member.public) == 1
    error_message = "The app is publicly reachable on its run.app URL."
  }

  assert {
    condition     = google_storage_bucket.image_cache[0].location == "us-central1" && google_storage_bucket.image_cache[0].force_destroy
    error_message = "The image cache bucket is in us-central1 and destroyable."
  }

  assert {
    condition     = one([for p in google_artifact_registry_repository.this.cleanup_policies : p.most_recent_versions[0].keep_count if p.action == "KEEP"]) == 2
    error_message = "The registry keeps 2 versions."
  }

  assert {
    condition     = google_cloud_run_v2_service.this["app"].deletion_protection == false
    error_message = "deletion_protection is off so terraform destroy works."
  }
}

# The example itself, through its pass-through outputs.
run "free_tier_example" {
  command = apply

  module {
    source = "./examples/free-tier"
  }

  variables {
    project_id = "test-project"
  }

  assert {
    condition = (
      output.load_balancer_ip == null &&
      output.image_service == null &&
      output.image_service_uri == null &&
      output.static_bucket == null &&
      output.image_cache_bucket == "test-project-nextjs-image-cache" &&
      output.region == "us-central1" &&
      output.url == output.app_service_uri
    )
    error_message = "The free-tier example has no load balancer, image service or static bucket."
  }
}

run "free_tier_example_with_load_balancer" {
  command = apply

  module {
    source = "./examples/free-tier"
  }

  variables {
    project_id           = "test-project"
    enable_load_balancer = true
  }

  assert {
    condition = (
      output.load_balancer_ip == "203.0.113.10" &&
      output.url == "http://203.0.113.10" &&
      output.image_service == "nextjs-images" &&
      output.static_bucket == "test-project-nextjs-static"
    )
    error_message = "enable_load_balancer adds the load balancer, image service and static bucket."
  }
}

run "production_example" {
  command = apply

  module {
    source = "./examples/production"
  }

  variables {
    project_id = "test-project"
    domain     = "shop.example.com"
  }

  assert {
    condition = (
      output.url == "https://shop.example.com" &&
      output.load_balancer_ip == "203.0.113.10" &&
      output.image_service == "nextjs-images" &&
      output.static_bucket == "test-project-nextjs-static" &&
      output.image_cache_bucket == "test-project-nextjs-image-cache" &&
      output.artifact_repository == "us-central1-docker.pkg.dev/test-project/nextjs"
    )
    error_message = "The production example enables everything with HTTPS on the domain."
  }
}
