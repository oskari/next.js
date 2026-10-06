# Deterministic values for computed attributes the module reads.

mock_resource "google_cloud_run_v2_service" {
  defaults = {
    uri = "https://nextjs-abc123-uc.a.run.app"
  }
}

mock_resource "google_compute_global_address" {
  defaults = {
    address = "203.0.113.10"
  }
}

mock_resource "google_service_account" {
  defaults = {
    email = "nextjs-runtime@test-project.iam.gserviceaccount.com"
  }
}

mock_resource "google_redis_instance" {
  defaults = {
    host = "10.0.0.3"
    port = 6379
    server_ca_certs = [{
      cert             = "-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----"
      create_time      = "2026-01-01T00:00:00Z"
      expire_time      = "2036-01-01T00:00:00Z"
      serial_number    = "1"
      sha1_fingerprint = "00"
    }]
  }
}
