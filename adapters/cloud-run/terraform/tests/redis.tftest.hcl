mock_provider "google" {
  source = "./tests/mocks"
}

variables {
  project_id = "test-project"
}

run "memorystore" {
  command = apply

  variables {
    memorystore = { enabled = true }
  }

  assert {
    condition = (
      google_redis_instance.cache[0].name == "nextjs-cache" &&
      google_redis_instance.cache[0].tier == "BASIC" &&
      google_redis_instance.cache[0].memory_size_gb == 1 &&
      google_redis_instance.cache[0].connect_mode == "DIRECT_PEERING" &&
      google_redis_instance.cache[0].authorized_network == "projects/test-project/global/networks/default" &&
      google_redis_instance.cache[0].redis_configs["maxmemory-policy"] == "allkeys-lru" &&
      google_redis_instance.cache[0].region == "us-central1"
    )
    error_message = "A BASIC 1 GB DIRECT_PEERING instance is created on the default network."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      { for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_URL"] == "redis://10.0.0.3:6379"
    ])
    error_message = "REDIS_URL points both services at the instance."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      s.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY" &&
      s.template[0].vpc_access[0].network_interfaces[0].network == "default" &&
      s.template[0].vpc_access[0].network_interfaces[0].subnetwork == "default"
    ])
    error_message = "Both services use Direct VPC egress on Memorystore's network."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "redis.googleapis.com") && contains(keys(google_project_service.this), "compute.googleapis.com")
    error_message = "The Memorystore and Compute Engine APIs are enabled."
  }

  assert {
    condition     = google_redis_instance.cache[0].deletion_protection
    error_message = "deletion_protection reaches the instance."
  }
}

run "memorystore_custom_network_and_tls" {
  command = apply

  variables {
    memorystore = {
      enabled            = true
      memory_size_gb     = 2
      network            = "shared"
      subnetwork         = "shared-us-central1"
      transit_encryption = true
    }
  }

  assert {
    condition = (
      google_redis_instance.cache[0].authorized_network == "projects/test-project/global/networks/shared" &&
      google_redis_instance.cache[0].memory_size_gb == 2 &&
      google_redis_instance.cache[0].transit_encryption_mode == "SERVER_AUTHENTICATION"
    )
    error_message = "Network, size and transit encryption are passed to the instance."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      s.template[0].vpc_access[0].network_interfaces[0].network == "shared" &&
      s.template[0].vpc_access[0].network_interfaces[0].subnetwork == "shared-us-central1"
    ])
    error_message = "Services egress on the custom network and subnetwork."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      startswith({ for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_URL"], "rediss://10.0.0.3:") &&
      strcontains({ for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_CA_CERT"], "BEGIN CERTIFICATE")
    ])
    error_message = "Transit encryption uses rediss:// and sets REDIS_CA_CERT from the instance's CA."
  }
}

run "existing_redis_url" {
  command = apply

  variables {
    redis_url     = "rediss://10.1.2.3:6378"
    redis_ca_cert = "-----BEGIN CERTIFICATE-----\nEXISTING\n-----END CERTIFICATE-----"
    vpc           = { network = "shared", subnetwork = "run-subnet" }
  }

  assert {
    condition     = length(google_redis_instance.cache) == 0
    error_message = "No instance is created for an existing redis_url."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      { for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_URL"] == "rediss://10.1.2.3:6378" &&
      strcontains({ for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_CA_CERT"], "EXISTING")
    ])
    error_message = "REDIS_URL and REDIS_CA_CERT are set on both services."
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      s.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY" &&
      s.template[0].vpc_access[0].network_interfaces[0].network == "shared" &&
      s.template[0].vpc_access[0].network_interfaces[0].subnetwork == "run-subnet"
    ])
    error_message = "vpc configures Direct VPC egress on both services."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "redis.googleapis.com")
    error_message = "The Memorystore API is not needed for an existing Redis."
  }
}

run "existing_redis_url_without_vpc" {
  command = apply

  variables {
    redis_url = "redis://redis.example.internal:6379"
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      { for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_URL"] == "redis://redis.example.internal:6379" &&
      length(s.template[0].vpc_access) == 0
    ])
    error_message = "redis_url alone sets the env var without VPC egress."
  }
}

run "env_passthrough" {
  command = apply

  variables {
    env = {
      NEXT_REDIS_KEY_PREFIX = "shop"
      REDIS_URL             = "redis://ignored:6379"
    }
    redis_url = "redis://10.0.0.9:6379"
  }

  assert {
    condition = alltrue([
      for s in google_cloud_run_v2_service.this :
      { for e in s.template[0].containers[0].env : e.name => e.value }["NEXT_REDIS_KEY_PREFIX"] == "shop" &&
      { for e in s.template[0].containers[0].env : e.name => e.value }["REDIS_URL"] == "redis://10.0.0.9:6379"
    ])
    error_message = "env reaches both services, and module-managed values take precedence."
  }
}
