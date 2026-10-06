mock_provider "google" {
  source = "./tests/mocks"
}

variables {
  project_id = "test-project"
}

run "url_map_default_paths" {
  command = apply

  assert {
    condition     = google_compute_url_map.this[0].default_service == google_compute_backend_service.this["app"].id && google_compute_url_map.this[0].path_matcher[0].default_service == google_compute_backend_service.this["app"].id
    error_message = "The default route goes to the app backend."
  }

  assert {
    condition = (
      length(google_compute_url_map.this[0].path_matcher[0].path_rule) == 2 &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].paths == toset(["/_next/image"]) &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].service == google_compute_backend_service.this["image"].id &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[1].paths == toset(["/_next/static/*"]) &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[1].service == google_compute_backend_bucket.static[0].id
    )
    error_message = "/_next/image goes to the image service and /_next/static/* to the backend bucket."
  }

  assert {
    condition = toset([for t in google_compute_url_map.this[0].test : t.path]) == toset([
      "/", "/_next/image", "/_next/static/chunks/main.js",
    ])
    error_message = "The URL map carries route tests for the API to check."
  }
}

run "url_map_base_path" {
  command = apply

  variables {
    load_balancer = { base_path = "/docs" }
  }

  assert {
    condition = (
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].paths == toset(["/docs/_next/image"]) &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[1].paths == toset(["/docs/_next/static/*"])
    )
    error_message = "base_path prefixes the routed paths."
  }

  assert {
    condition = toset([for t in google_compute_url_map.this[0].test : t.path]) == toset([
      "/docs/", "/docs/_next/image", "/docs/_next/static/chunks/main.js",
    ])
    error_message = "base_path prefixes the URL map tests."
  }
}

run "invalid_base_path" {
  command = plan

  variables {
    load_balancer = { base_path = "docs/" }
  }

  expect_failures = [var.load_balancer]
}

run "image_route_falls_back_to_app" {
  command = apply

  variables {
    image_service = { enabled = false }
  }

  assert {
    condition = (
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].paths == toset(["/_next/image"]) &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].service == google_compute_backend_service.this["app"].id
    )
    error_message = "/_next/image goes to the app backend without the image service."
  }
}

run "static_route_falls_back_to_app" {
  command = apply

  variables {
    static_bucket = { enabled = false }
  }

  assert {
    condition = (
      length(google_compute_url_map.this[0].path_matcher[0].path_rule) == 1 &&
      google_compute_url_map.this[0].path_matcher[0].path_rule[0].paths == toset(["/_next/image"])
    )
    error_message = "Without the static bucket, /_next/static is served by the app (default route)."
  }
}

run "no_domain_serves_http" {
  command = apply

  assert {
    condition = (
      length(google_compute_managed_ssl_certificate.this) == 0 &&
      length(google_compute_target_https_proxy.this) == 0 &&
      length(google_compute_global_forwarding_rule.https) == 0 &&
      length(google_compute_url_map.https_redirect) == 0
    )
    error_message = "No certificate, HTTPS proxy or redirect without a domain."
  }

  assert {
    condition = (
      google_compute_target_http_proxy.this[0].url_map == google_compute_url_map.this[0].id &&
      google_compute_global_forwarding_rule.http[0].port_range == "80" &&
      google_compute_global_forwarding_rule.http[0].target == google_compute_target_http_proxy.this[0].id &&
      google_compute_global_forwarding_rule.http[0].ip_address == google_compute_global_address.this[0].id &&
      google_compute_global_forwarding_rule.http[0].load_balancing_scheme == "EXTERNAL_MANAGED"
    )
    error_message = "Port 80 serves the main URL map."
  }
}

run "domain_serves_https" {
  command = apply

  variables {
    load_balancer = { domain = "shop.example.com" }
  }

  assert {
    condition     = google_compute_managed_ssl_certificate.this[0].managed[0].domains == tolist(["shop.example.com"])
    error_message = "A managed certificate is created for the domain."
  }

  assert {
    condition = (
      google_compute_target_https_proxy.this[0].url_map == google_compute_url_map.this[0].id &&
      google_compute_target_https_proxy.this[0].ssl_certificates == tolist([google_compute_managed_ssl_certificate.this[0].id]) &&
      google_compute_global_forwarding_rule.https[0].port_range == "443" &&
      google_compute_global_forwarding_rule.https[0].target == google_compute_target_https_proxy.this[0].id &&
      google_compute_global_forwarding_rule.https[0].ip_address == google_compute_global_address.this[0].id
    )
    error_message = "HTTPS on 443 serves the main URL map with the certificate."
  }

  assert {
    condition = (
      google_compute_url_map.https_redirect[0].default_url_redirect[0].https_redirect &&
      google_compute_url_map.https_redirect[0].default_url_redirect[0].strip_query == false &&
      google_compute_target_http_proxy.this[0].url_map == google_compute_url_map.https_redirect[0].id &&
      google_compute_global_forwarding_rule.http[0].port_range == "80" &&
      google_compute_global_forwarding_rule.http[0].ip_address == google_compute_global_address.this[0].id
    )
    error_message = "Port 80 redirects to HTTPS on the same IP."
  }

  assert {
    condition     = output.url == "https://shop.example.com"
    error_message = "The URL uses the domain."
  }
}

run "domain_without_redirect" {
  command = apply

  variables {
    load_balancer = { domain = "shop.example.com", https_redirect = false }
  }

  assert {
    condition = (
      length(google_compute_global_forwarding_rule.https) == 1 &&
      length(google_compute_url_map.https_redirect) == 0 &&
      length(google_compute_target_http_proxy.this) == 0 &&
      length(google_compute_global_forwarding_rule.http) == 0
    )
    error_message = "https_redirect = false serves only HTTPS."
  }
}

run "invalid_domain" {
  command = plan

  variables {
    load_balancer = { domain = "https://shop.example.com/" }
  }

  expect_failures = [var.load_balancer]
}
