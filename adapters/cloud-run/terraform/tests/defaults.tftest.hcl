mock_provider "google" {
  source = "./tests/mocks"
}

variables {
  project_id = "test-project"
}

run "defaults" {
  command = apply

  # Load balancer with CDN on all three backends.
  assert {
    condition     = length(google_compute_global_address.this) == 1
    error_message = "The load balancer is on by default."
  }

  assert {
    condition     = google_compute_backend_service.this["app"].enable_cdn && google_compute_backend_service.this["app"].cdn_policy[0].cache_mode == "USE_ORIGIN_HEADERS"
    error_message = "The app backend has Cloud CDN with USE_ORIGIN_HEADERS by default."
  }

  assert {
    condition     = google_compute_backend_service.this["image"].enable_cdn && google_compute_backend_service.this["image"].cdn_policy[0].cache_mode == "USE_ORIGIN_HEADERS"
    error_message = "The image backend has Cloud CDN with USE_ORIGIN_HEADERS."
  }

  assert {
    condition     = google_compute_backend_bucket.static[0].enable_cdn && google_compute_backend_bucket.static[0].cdn_policy[0].cache_mode == "USE_ORIGIN_HEADERS"
    error_message = "The static backend bucket has Cloud CDN with USE_ORIGIN_HEADERS."
  }

  assert {
    condition     = google_compute_backend_bucket.static[0].bucket_name == google_storage_bucket.static[0].name
    error_message = "The backend bucket serves the static bucket."
  }

  assert {
    condition = alltrue([
      for key, backend in google_compute_backend_service.this :
      backend.load_balancing_scheme == "EXTERNAL_MANAGED" &&
      one(backend.backend[*].group) == google_compute_region_network_endpoint_group.this[key].id
    ])
    error_message = "Each backend service is EXTERNAL_MANAGED and points at its serverless NEG."
  }

  assert {
    condition = alltrue([
      for key, neg in google_compute_region_network_endpoint_group.this :
      neg.network_endpoint_type == "SERVERLESS" && neg.cloud_run[0].service == google_cloud_run_v2_service.this[key].name
    ])
    error_message = "Serverless NEGs point at the matching Cloud Run services."
  }

  # Cloud Armor attached in preview.
  assert {
    condition     = length(google_compute_security_policy.this) == 1
    error_message = "Cloud Armor is on by default."
  }

  assert {
    condition = alltrue([
      for r in google_compute_security_policy.this[0].rule : r.preview if r.priority < 2147483647
    ]) && length(google_compute_security_policy.this[0].rule) == 3
    error_message = "The XSS and SQLi rules are in preview mode by default."
  }

  assert {
    condition = toset(flatten([
      for r in google_compute_security_policy.this[0].rule : [for e in r.match[0].expr : e.expression]
      ])) == toset([
      "evaluatePreconfiguredWaf('xss-v33-stable')",
      "evaluatePreconfiguredWaf('sqli-v33-stable')",
    ])
    error_message = "The policy uses the preconfigured xss-v33-stable and sqli-v33-stable rules."
  }

  assert {
    condition = alltrue([
      for backend in google_compute_backend_service.this :
      backend.security_policy == google_compute_security_policy.this[0].id
    ])
    error_message = "Cloud Armor is attached to both serverless backends."
  }

  # Services.
  assert {
    condition     = google_cloud_run_v2_service.this["app"].name == "nextjs" && google_cloud_run_v2_service.this["image"].name == "nextjs-images"
    error_message = "The app and image services are created with the default names."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    ])
    error_message = "With the load balancer, ingress defaults to internal-and-cloud-load-balancing."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.template[0].containers[0].image == "us-docker.pkg.dev/cloudrun/container/hello"
    ])
    error_message = "Services start with the placeholder image."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.template[0].containers[0].resources[0].cpu_idle == false
    ])
    error_message = "CPU is always allocated by default, so waitUntil work can finish."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.template[0].service_account == google_service_account.runtime[0].email
    ])
    error_message = "Both services run as the dedicated runtime service account."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.this["app"].template[0].timeout == "300s" &&
      google_cloud_run_v2_service.this["app"].template[0].containers[0].resources[0].limits == tomap({ cpu = "1", memory = "512Mi" })
    )
    error_message = "The app service defaults to a 300s timeout, 1 vCPU and 512Mi."
  }

  assert {
    condition = (
      google_cloud_run_v2_service.this["image"].template[0].timeout == "60s" &&
      google_cloud_run_v2_service.this["image"].template[0].max_instance_request_concurrency == 16 &&
      google_cloud_run_v2_service.this["image"].template[0].containers[0].resources[0].limits == tomap({ cpu = "2", memory = "2Gi" })
    )
    error_message = "The image service defaults to 2 vCPU, 2Gi, concurrency 16 and a 60s timeout."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : length(s.template[0].vpc_access) == 0
    ])
    error_message = "No VPC egress without Redis or vpc."
  }

  # Public invoker.
  assert {
    condition = alltrue([
      for key in ["app", "image"] :
      google_cloud_run_v2_service_iam_member.public[key].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.public[key].role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.public[key].name == google_cloud_run_v2_service.this[key].name
    ])
    error_message = "Both services allow unauthenticated invocations by default."
  }

  # Buckets.
  assert {
    condition     = google_storage_bucket.static[0].name == "test-project-nextjs-static" && google_storage_bucket.static[0].location == "us-central1"
    error_message = "The static bucket defaults to <project>-<name>-static in the region."
  }

  assert {
    condition     = google_storage_bucket.static[0].uniform_bucket_level_access && google_storage_bucket_iam_member.static_public[0].member == "allUsers" && google_storage_bucket_iam_member.static_public[0].role == "roles/storage.objectViewer"
    error_message = "The static bucket uses uniform access and is publicly readable."
  }

  assert {
    condition     = google_storage_bucket.image_cache[0].name == "test-project-nextjs-image-cache" && google_storage_bucket.image_cache[0].public_access_prevention == "enforced"
    error_message = "The image cache bucket defaults to <project>-<name>-image-cache and is private."
  }

  # No Memorystore, HTTP on 80 without a domain.
  assert {
    condition     = length(google_redis_instance.cache) == 0
    error_message = "Memorystore is off by default."
  }

  assert {
    condition     = length(google_compute_managed_ssl_certificate.this) == 0 && google_compute_global_forwarding_rule.http[0].port_range == "80"
    error_message = "Without a domain the load balancer serves HTTP on port 80."
  }

  # APIs.
  assert {
    condition = alltrue([
      for api in ["run.googleapis.com", "artifactregistry.googleapis.com", "compute.googleapis.com", "storage.googleapis.com", "iam.googleapis.com"] :
      contains(keys(google_project_service.this), api)
    ]) && !contains(keys(google_project_service.this), "redis.googleapis.com")
    error_message = "The required APIs are enabled, and Memorystore's is not."
  }

  assert {
    condition     = alltrue([for s in google_project_service.this : s.disable_on_destroy == false])
    error_message = "APIs are left enabled on destroy."
  }

  # Outputs.
  assert {
    condition = (
      output.project_id == "test-project" &&
      output.region == "us-central1" &&
      output.app_service == "nextjs" &&
      output.image_service == "nextjs-images" &&
      output.static_bucket == "test-project-nextjs-static" &&
      output.image_cache_bucket == "test-project-nextjs-image-cache" &&
      output.artifact_repository == "us-central1-docker.pkg.dev/test-project/nextjs" &&
      output.load_balancer_ip == "203.0.113.10" &&
      output.url == "http://203.0.113.10" &&
      output.app_service_uri == "https://nextjs-abc123-uc.a.run.app" &&
      output.image_service_uri == "https://nextjs-abc123-uc.a.run.app"
    )
    error_message = "Outputs match the defaults."
  }
}

run "apis_not_managed" {
  command = plan

  variables {
    enable_apis = false
  }

  assert {
    condition     = length(google_project_service.this) == 0
    error_message = "enable_apis = false leaves APIs alone."
  }
}

run "existing_service_account" {
  command = apply

  variables {
    service_account_email = "existing@test-project.iam.gserviceaccount.com"
  }

  assert {
    condition     = length(google_service_account.runtime) == 0
    error_message = "No service account is created when one is supplied."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this : s.template[0].service_account == "existing@test-project.iam.gserviceaccount.com"
    ])
    error_message = "Both services use the supplied service account."
  }

  assert {
    condition     = google_storage_bucket_iam_member.image_cache_runtime[0].member == "serviceAccount:existing@test-project.iam.gserviceaccount.com"
    error_message = "The supplied service account gets access to the image cache bucket."
  }
}
