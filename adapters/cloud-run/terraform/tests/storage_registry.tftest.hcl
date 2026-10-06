mock_provider "google" {
  source = "./tests/mocks"
}

variables {
  project_id = "test-project"
}

run "image_cache_bucket" {
  command = apply

  variables {
    image_cache_bucket = { ttl_days = 7 }
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      { for e in s.template[0].containers[0].env : e.name => e.value }["NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET"] == "test-project-nextjs-image-cache"
    ])
    error_message = "Both services get NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET."
  }

  assert {
    condition = (
      length(google_storage_bucket.image_cache[0].lifecycle_rule) == 1 &&
      one(google_storage_bucket.image_cache[0].lifecycle_rule[0].action).type == "Delete" &&
      one(google_storage_bucket.image_cache[0].lifecycle_rule[0].condition).age == 7
    )
    error_message = "The lifecycle rule deletes cached images after ttl_days."
  }

  assert {
    condition = (
      google_storage_bucket_iam_member.image_cache_runtime[0].bucket == google_storage_bucket.image_cache[0].name &&
      google_storage_bucket_iam_member.image_cache_runtime[0].role == "roles/storage.objectUser" &&
      google_storage_bucket_iam_member.image_cache_runtime[0].member == "serviceAccount:${google_service_account.runtime[0].email}"
    )
    error_message = "The runtime service account gets roles/storage.objectUser on the bucket."
  }

  assert {
    condition     = google_storage_bucket.image_cache[0].uniform_bucket_level_access && google_storage_bucket.image_cache[0].location == "us-central1"
    error_message = "The image cache bucket uses uniform access in the region."
  }
}

run "image_cache_ttl_default" {
  command = plan

  assert {
    condition     = one(google_storage_bucket.image_cache[0].lifecycle_rule[0].condition).age == 30
    error_message = "Cached images expire after 30 days by default."
  }
}

run "bucket_name_overrides" {
  command = plan

  variables {
    static_bucket      = { name = "shop-static" }
    image_cache_bucket = { name = "shop-images-cache" }
  }

  assert {
    condition     = google_storage_bucket.static[0].name == "shop-static" && google_storage_bucket.image_cache[0].name == "shop-images-cache"
    error_message = "Bucket names can be overridden."
  }
}

run "bucket_names_truncated" {
  command = plan

  variables {
    project_id = "a-really-long-project-identifier-30"
    name       = "storefront-with-a-long-service-name"
  }

  assert {
    condition = (
      length(google_storage_bucket.static[0].name) <= 63 &&
      length(google_storage_bucket.image_cache[0].name) <= 63 &&
      can(regex("[a-z0-9]$", google_storage_bucket.image_cache[0].name))
    )
    error_message = "Default bucket names are truncated to 63 characters and end with a letter or digit."
  }
}

run "invalid_bucket_name" {
  command = plan

  variables {
    static_bucket = { name = "No_Such-Bucket-" }
  }

  expect_failures = [var.static_bucket]
}

run "invalid_name" {
  command = plan

  variables {
    name = "My-App"
  }

  expect_failures = [var.name]
}

run "artifact_registry" {
  command = apply

  assert {
    condition = (
      google_artifact_registry_repository.this.format == "DOCKER" &&
      google_artifact_registry_repository.this.repository_id == "nextjs" &&
      google_artifact_registry_repository.this.location == "us-central1" &&
      google_artifact_registry_repository.this.cleanup_policy_dry_run == false
    )
    error_message = "A Docker repository named after the app is created in the region."
  }

  assert {
    condition = (
      length(google_artifact_registry_repository.this.cleanup_policies) == 2 &&
      one([for p in google_artifact_registry_repository.this.cleanup_policies : p.most_recent_versions[0].keep_count if p.action == "KEEP"]) == 10 &&
      one([for p in google_artifact_registry_repository.this.cleanup_policies : p.condition[0].tag_state if p.action == "DELETE"]) == "ANY"
    )
    error_message = "The cleanup policy keeps the 10 most recent versions and deletes the rest."
  }
}

run "artifact_registry_custom" {
  command = apply

  variables {
    artifact_registry = { repository_id = "releases", keep_versions = 3 }
  }

  assert {
    condition = (
      one([for p in google_artifact_registry_repository.this.cleanup_policies : p.most_recent_versions[0].keep_count if p.action == "KEEP"]) == 3 &&
      output.artifact_repository == "us-central1-docker.pkg.dev/test-project/releases"
    )
    error_message = "keep_versions and repository_id are configurable."
  }
}

run "artifact_registry_keep_zero" {
  command = plan

  variables {
    artifact_registry = { keep_versions = 0 }
  }

  expect_failures = [var.artifact_registry]
}

run "deletion_protection_default" {
  command = apply

  variables {
    memorystore = { enabled = true }
  }

  assert {
    condition = (
      alltrue([for s in google_cloud_run_v2_service.this : s.deletion_protection]) &&
      google_redis_instance.cache[0].deletion_protection &&
      google_storage_bucket.static[0].force_destroy == false &&
      google_storage_bucket.static[0].deletion_policy == "PREVENT" &&
      google_storage_bucket.image_cache[0].force_destroy == false &&
      google_storage_bucket.image_cache[0].deletion_policy == "PREVENT" &&
      google_artifact_registry_repository.this.deletion_policy == "PREVENT"
    )
    error_message = "deletion_protection = true protects services, Redis, buckets and the registry."
  }
}

run "deletion_protection_off" {
  command = apply

  variables {
    deletion_protection = false
    memorystore         = { enabled = true }
  }

  assert {
    condition = (
      alltrue([for s in google_cloud_run_v2_service.this : s.deletion_protection == false]) &&
      google_redis_instance.cache[0].deletion_protection == false &&
      google_storage_bucket.static[0].force_destroy &&
      google_storage_bucket.static[0].deletion_policy == "DELETE" &&
      google_storage_bucket.image_cache[0].force_destroy &&
      google_storage_bucket.image_cache[0].deletion_policy == "DELETE" &&
      google_artifact_registry_repository.this.deletion_policy == "DELETE"
    )
    error_message = "deletion_protection = false lets terraform destroy remove everything."
  }
}
