# Global external Application Load Balancer:
#
#   <base_path>/_next/static/*  -> backend bucket on the static bucket (Cloud CDN)
#   <base_path>/_next/image     -> image service (Cloud CDN), or the app
#   everything else             -> app service (Cloud CDN unless app_cdn = false)

locals {
  lb_static   = local.lb && local.static_bucket_enabled
  lb_image    = local.lb && local.image_enabled
  lb_redirect = local.https && var.load_balancer.https_redirect

  # Serverless backends, keyed like local.services.
  backends = local.lb ? {
    for key, service in local.services : key => {
      service = service.name
      # Optimized images send `Cache-Control: public, max-age=...` and
      # `Vary: Accept`, which Cloud CDN caches per format.
      cdn = key == "image" ? true : var.load_balancer.app_cdn
    }
  } : {}

  armor_rules = {
    1000 = "xss-v33-stable"
    1001 = "sqli-v33-stable"
  }
}

resource "google_compute_global_address" "this" {
  count = local.lb ? 1 : 0

  project = var.project_id
  name    = "${var.name}-ip"
  labels  = var.labels

  depends_on = [google_project_service.this]
}

# --- Backends -----------------------------------------------------------------

resource "google_compute_region_network_endpoint_group" "this" {
  for_each = local.backends

  project               = var.project_id
  region                = var.region
  name                  = "${var.name}-${each.key}-neg"
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.this[each.key].name
  }
}

resource "google_compute_security_policy" "this" {
  count = local.lb && var.load_balancer.armor ? 1 : 0

  project     = var.project_id
  name        = "${var.name}-armor"
  description = "Next.js on Cloud Run (${var.name})"
  type        = "CLOUD_ARMOR"

  dynamic "rule" {
    for_each = local.armor_rules
    content {
      action      = "deny(403)"
      priority    = rule.key
      description = "Preconfigured WAF rule ${rule.value}"
      # Preview logs matches without blocking them; review the logs before
      # enforcing.
      preview = !var.load_balancer.armor_enforce
      match {
        expr {
          expression = "evaluatePreconfiguredWaf('${rule.value}')"
        }
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default rule"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_compute_backend_service" "this" {
  for_each = local.backends

  project               = var.project_id
  name                  = "${var.name}-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  enable_cdn            = each.value.cdn
  security_policy       = one(google_compute_security_policy.this[*].id)

  dynamic "cdn_policy" {
    for_each = each.value.cdn ? [1] : []
    content {
      # Cache only what the origin marks cacheable via Cache-Control.
      cache_mode = "USE_ORIGIN_HEADERS"
      # The API's default cache key. The query string must stay in it:
      # /_next/image is keyed by url, w and q.
      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = true
      }
    }
  }

  backend {
    group = google_compute_region_network_endpoint_group.this[each.key].id
  }
}

resource "google_compute_backend_bucket" "static" {
  count = local.lb_static ? 1 : 0

  project     = var.project_id
  name        = "${var.name}-static"
  bucket_name = google_storage_bucket.static[0].name
  enable_cdn  = true

  cdn_policy {
    # The deploy script uploads hashed assets with an immutable Cache-Control.
    cache_mode = "USE_ORIGIN_HEADERS"
  }

  depends_on = [google_project_service.this]
}

# --- URL maps -----------------------------------------------------------------

resource "google_compute_url_map" "this" {
  count = local.lb ? 1 : 0

  project         = var.project_id
  name            = var.name
  default_service = google_compute_backend_service.this["app"].id

  host_rule {
    hosts        = ["*"]
    path_matcher = "next"
  }

  path_matcher {
    name            = "next"
    default_service = google_compute_backend_service.this["app"].id

    path_rule {
      paths   = ["${local.base_path}/_next/image"]
      service = google_compute_backend_service.this[local.lb_image ? "image" : "app"].id
    }

    dynamic "path_rule" {
      for_each = local.lb_static ? [1] : []
      content {
        paths   = ["${local.base_path}/_next/static/*"]
        service = google_compute_backend_bucket.static[0].id
      }
    }
  }

  # Checked by the API when the URL map is written.
  test {
    description = "Pages go to the app"
    host        = "example.com"
    path        = "${local.base_path}/"
    service     = google_compute_backend_service.this["app"].self_link
  }

  test {
    description = "Image optimization"
    host        = "example.com"
    path        = "${local.base_path}/_next/image"
    service     = google_compute_backend_service.this[local.lb_image ? "image" : "app"].self_link
  }

  dynamic "test" {
    for_each = local.lb_static ? [1] : []
    content {
      description = "Static assets go to the bucket"
      host        = "example.com"
      path        = "${local.base_path}/_next/static/chunks/main.js"
      service     = google_compute_backend_bucket.static[0].self_link
    }
  }
}

resource "google_compute_url_map" "https_redirect" {
  count = local.lb_redirect ? 1 : 0

  project = var.project_id
  name    = "${var.name}-https-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

# --- Frontend -----------------------------------------------------------------

resource "google_compute_managed_ssl_certificate" "this" {
  count = local.https ? 1 : 0

  project = var.project_id
  # A new name per domain, so a domain change creates the new certificate
  # before the proxy lets go of the old one.
  name = "${var.name}-cert-${substr(sha1(local.domain), 0, 8)}"

  managed {
    domains = [local.domain]
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_project_service.this]
}

resource "google_compute_target_https_proxy" "this" {
  count = local.https ? 1 : 0

  project          = var.project_id
  name             = "${var.name}-https"
  url_map          = google_compute_url_map.this[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.this[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count = local.https ? 1 : 0

  project               = var.project_id
  name                  = "${var.name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.this[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.this[0].id
  labels                = var.labels
}

# Port 80 serves the app without a domain, and redirects to HTTPS with one.
resource "google_compute_target_http_proxy" "this" {
  count = local.lb && (!local.https || local.lb_redirect) ? 1 : 0

  project = var.project_id
  name    = "${var.name}-http"
  url_map = local.https ? google_compute_url_map.https_redirect[0].id : google_compute_url_map.this[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count = local.lb && (!local.https || local.lb_redirect) ? 1 : 0

  project               = var.project_id
  name                  = "${var.name}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  ip_address            = google_compute_global_address.this[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.this[0].id
  labels                = var.labels
}
