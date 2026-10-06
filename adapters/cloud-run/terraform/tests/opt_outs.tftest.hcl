mock_provider "google" {
  source = "./tests/mocks"
}

variables {
  project_id = "test-project"
}

run "no_load_balancer" {
  command = apply

  variables {
    load_balancer = { enabled = false }
    image_service = { enabled = false }
  }

  assert {
    condition = (
      length(google_compute_global_address.this) == 0 &&
      length(google_compute_region_network_endpoint_group.this) == 0 &&
      length(google_compute_backend_service.this) == 0 &&
      length(google_compute_backend_bucket.static) == 0 &&
      length(google_compute_security_policy.this) == 0 &&
      length(google_compute_url_map.this) == 0 &&
      length(google_compute_target_http_proxy.this) == 0 &&
      length(google_compute_global_forwarding_rule.http) == 0
    )
    error_message = "No load balancer resources without the load balancer."
  }

  assert {
    condition     = google_cloud_run_v2_service.this["app"].ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "Without the load balancer, ingress defaults to all."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "compute.googleapis.com")
    error_message = "Compute Engine is not enabled without the load balancer or a VPC."
  }

  assert {
    condition     = output.load_balancer_ip == null && output.url == "https://nextjs-abc123-uc.a.run.app" && output.image_service == null && output.image_service_uri == null
    error_message = "Without the load balancer the URL is the app service URI."
  }
}

run "image_service_without_load_balancer_warns" {
  command = plan

  variables {
    load_balancer = { enabled = false }
  }

  # Image service on but unreachable: the check block reports it.
  expect_failures = [check.image_service_reachable]
}

run "ingress_override" {
  command = plan

  variables {
    ingress = "INGRESS_TRAFFIC_ALL"
  }

  assert {
    condition     = alltrue([for s in google_cloud_run_v2_service.this : s.ingress == "INGRESS_TRAFFIC_ALL"])
    error_message = "The ingress variable overrides the default on both services."
  }
}

run "invalid_ingress" {
  command = plan

  variables {
    ingress = "all"
  }

  expect_failures = [var.ingress]
}

run "no_app_cdn" {
  command = apply

  variables {
    load_balancer = { app_cdn = false }
  }

  assert {
    condition     = google_compute_backend_service.this["app"].enable_cdn == false && length(google_compute_backend_service.this["app"].cdn_policy) == 0
    error_message = "app_cdn = false disables Cloud CDN on the app backend."
  }

  assert {
    condition     = google_compute_backend_service.this["image"].enable_cdn && google_compute_backend_bucket.static[0].enable_cdn
    error_message = "The image and static backends keep Cloud CDN."
  }
}

run "no_armor" {
  command = apply

  variables {
    load_balancer = { armor = false }
  }

  assert {
    condition     = length(google_compute_security_policy.this) == 0
    error_message = "armor = false removes the policy."
  }

  assert {
    condition     = alltrue([for b in google_compute_backend_service.this : b.security_policy == null])
    error_message = "armor = false detaches the policy from the backends."
  }
}

run "armor_enforced" {
  command = apply

  variables {
    load_balancer = { armor_enforce = true }
  }

  assert {
    condition     = alltrue([for r in google_compute_security_policy.this[0].rule : r.preview == false])
    error_message = "armor_enforce = true turns preview off."
  }

  assert {
    condition = alltrue([
      for r in google_compute_security_policy.this[0].rule : r.action == "deny(403)" if r.priority < 2147483647
    ])
    error_message = "WAF rules deny with 403."
  }
}

run "no_image_service" {
  command = apply

  variables {
    image_service = { enabled = false }
  }

  assert {
    condition     = keys(google_cloud_run_v2_service.this) == ["app"] && keys(google_compute_backend_service.this) == ["app"] && keys(google_compute_region_network_endpoint_group.this) == ["app"]
    error_message = "image_service.enabled = false removes the service, its NEG and its backend."
  }

  assert {
    condition     = keys(google_cloud_run_v2_service_iam_member.public) == ["app"]
    error_message = "Only the app service gets the public invoker binding."
  }
}

run "no_buckets" {
  command = apply

  variables {
    static_bucket      = { enabled = false }
    image_cache_bucket = { enabled = false }
  }

  assert {
    condition = (
      length(google_storage_bucket.static) == 0 &&
      length(google_storage_bucket_iam_member.static_public) == 0 &&
      length(google_compute_backend_bucket.static) == 0 &&
      length(google_storage_bucket.image_cache) == 0 &&
      length(google_storage_bucket_iam_member.image_cache_runtime) == 0
    )
    error_message = "Disabled buckets, their IAM and the backend bucket are not created."
  }

  assert {
    condition = alltrue([
      for e in google_cloud_run_v2_service.this["app"].template[0].containers[0].env : e.name != "NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET"
    ])
    error_message = "No image cache env var without the bucket."
  }

  assert {
    condition     = output.static_bucket == null && output.image_cache_bucket == null
    error_message = "Bucket outputs are null when disabled."
  }
}

run "private_services" {
  command = plan

  variables {
    allow_unauthenticated = false
  }

  assert {
    condition     = length(google_cloud_run_v2_service_iam_member.public) == 0
    error_message = "allow_unauthenticated = false removes the allUsers invoker bindings."
  }
}

run "request_based_billing" {
  command = plan

  variables {
    cpu_always_allocated = false
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.template[0].containers[0].resources[0].cpu_idle
    ])
    error_message = "cpu_always_allocated = false throttles CPU outside requests on both services."
  }
}
