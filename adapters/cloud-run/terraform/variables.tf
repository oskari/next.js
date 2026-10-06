# --- Project ------------------------------------------------------------------

variable "project_id" {
  description = "Google Cloud project to deploy into."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Region for Cloud Run, the buckets, the registry and Memorystore. Cloud Storage's free tier only covers us-east1, us-west1 and us-central1."
  type        = string
  default     = "us-central1"
  nullable    = false
}

variable "name" {
  description = "Name of the app's Cloud Run service. Also the prefix of every other resource this module creates (image service, load balancer, buckets, service account, registry)."
  type        = string
  default     = "nextjs"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$", var.name))
    error_message = "name must be 1-40 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen."
  }
}

variable "labels" {
  description = "Labels added to every resource that supports them."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "enable_apis" {
  description = "Enable the Google Cloud APIs the module needs (Cloud Run, Artifact Registry, Cloud Build, IAM, Cloud Storage, and Compute Engine or Memorystore when used). APIs are left enabled on destroy."
  type        = bool
  default     = true
  nullable    = false
}

variable "deletion_protection" {
  description = "Protect stateful resources from `terraform destroy`: Cloud Run services and the Memorystore instance get deletion_protection, the buckets and the registry get deletion_policy = PREVENT, and non-empty buckets are not force-destroyed. Set to false for throwaway environments."
  type        = bool
  default     = true
  nullable    = false
}

# --- Runtime ------------------------------------------------------------------

variable "service_account_email" {
  description = "Existing service account for both Cloud Run services. When null, the module creates a dedicated runtime service account."
  type        = string
  default     = null
}

variable "env" {
  description = "Extra environment variables for both Cloud Run services, e.g. NEXT_REDIS_KEY_PREFIX or NEXT_REDIS_DEFAULT_TTL. REDIS_URL, REDIS_CA_CERT and NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET are set by the module and take precedence."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "cpu_always_allocated" {
  description = <<-EOT
    Keep CPU allocated outside requests (instance-based billing, `--no-cpu-throttling`).
    The adapter finishes `waitUntil` work after the response is sent: background ISR
    revalidation, stale image regeneration and `after()` callbacks. With request-based
    billing (false), Cloud Run throttles the CPU as soon as the response ends, so that
    work may stall until the next request reaches the instance or never finish. Request-based
    billing is what Cloud Run's free tier covers best (idle instances cost nothing), so
    false suits hobby projects that accept late revalidation; keep true for production.
  EOT
  type        = bool
  default     = true
  nullable    = false
}

variable "app" {
  description = "App service sizing. timeout_seconds should cover the longest maxDuration of any route."
  type = object({
    cpu               = optional(string, "1")
    memory            = optional(string, "512Mi")
    concurrency       = optional(number, 80)
    timeout_seconds   = optional(number, 300)
    min_instances     = optional(number, 0)
    max_instances     = optional(number)
    startup_cpu_boost = optional(bool, true)
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.app.timeout_seconds >= 1 && var.app.timeout_seconds <= 3600
    error_message = "app.timeout_seconds must be between 1 and 3600."
  }
}

variable "image_service" {
  description = "Dedicated Cloud Run service for /_next/image. It runs the same container image as the app with more memory and CPU and a lower concurrency, so image bursts scale on their own. Only the load balancer routes to it."
  type = object({
    enabled           = optional(bool, true)
    name              = optional(string)
    cpu               = optional(string, "2")
    memory            = optional(string, "2Gi")
    concurrency       = optional(number, 16)
    timeout_seconds   = optional(number, 60)
    min_instances     = optional(number, 0)
    max_instances     = optional(number)
    startup_cpu_boost = optional(bool, true)
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.image_service.name == null ? true : can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", var.image_service.name))
    error_message = "image_service.name must be 1-49 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "ingress" {
  description = "Cloud Run ingress for both services: INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_ONLY or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER. Defaults to INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER (internal and Cloud Load Balancing) with the load balancer, so the run.app URLs are closed, and INGRESS_TRAFFIC_ALL without it."
  type        = string
  default     = null

  validation {
    condition     = var.ingress == null ? true : contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.ingress)
    error_message = "ingress must be INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_ONLY or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER."
  }
}

variable "allow_unauthenticated" {
  description = "Grant allUsers roles/run.invoker on both services. A public website needs it, and so does the load balancer's serverless NEG (it forwards requests without credentials). Turn off for private apps fronted by IAP or another authenticating proxy. Organization policies restricting allUsers bindings must allow it."
  type        = bool
  default     = true
  nullable    = false
}

# --- Artifact Registry --------------------------------------------------------

variable "artifact_registry" {
  description = "Docker repository the deploy script pushes release images to. A cleanup policy keeps the keep_versions most recent versions and deletes older ones, so storage stays small (Artifact Registry's free tier is 0.5 GB). Revisions whose image was deleted cannot be rolled back to or scaled up again."
  type = object({
    repository_id = optional(string)
    keep_versions = optional(number, 10)
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.artifact_registry.keep_versions >= 1
    error_message = "artifact_registry.keep_versions must be at least 1, or the running release could be deleted."
  }

  validation {
    condition     = var.artifact_registry.repository_id == null ? true : can(regex("^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$", var.artifact_registry.repository_id))
    error_message = "artifact_registry.repository_id must be 1-63 lowercase letters, digits or hyphens and start with a letter."
  }
}

# --- Cloud Storage ------------------------------------------------------------

variable "static_bucket" {
  description = "Public bucket for /_next/static, served by the load balancer's backend bucket with Cloud CDN. The deploy script uploads hashed assets with immutable cache headers. Unused without the load balancer. Default name: <project_id>-<name>-static."
  type = object({
    enabled = optional(bool, true)
    name    = optional(string)
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.static_bucket.name == null ? true : can(regex("^[a-z0-9][-a-z0-9_.]{1,61}[a-z0-9]$", var.static_bucket.name))
    error_message = "static_bucket.name must be a valid bucket name: 3-63 lowercase letters, digits, hyphens, underscores or dots."
  }
}

variable "image_cache_bucket" {
  description = "Private bucket that caches optimized images for every instance of both services (NEXT_CLOUD_RUN_IMAGE_CACHE_BUCKET). Objects are deleted after ttl_days; cached images are regenerated on demand, so expiry only bounds storage. Default name: <project_id>-<name>-image-cache."
  type = object({
    enabled  = optional(bool, true)
    name     = optional(string)
    ttl_days = optional(number, 30)
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.image_cache_bucket.name == null ? true : can(regex("^[a-z0-9][-a-z0-9_.]{1,61}[a-z0-9]$", var.image_cache_bucket.name))
    error_message = "image_cache_bucket.name must be a valid bucket name: 3-63 lowercase letters, digits, hyphens, underscores or dots."
  }

  validation {
    condition     = var.image_cache_bucket.ttl_days >= 1
    error_message = "image_cache_bucket.ttl_days must be at least 1."
  }
}

# --- Load balancer ------------------------------------------------------------

variable "load_balancer" {
  description = <<-EOT
    Global external Application Load Balancer in front of the services:
    `<base_path>/_next/static/*` goes to the static bucket (Cloud CDN), `<base_path>/_next/image`
    to the image service (Cloud CDN), or to the app without one, and everything else to the app.
    - domain: provisions a Google-managed certificate and serves HTTPS on 443. Point an A record
      at load_balancer_ip; the certificate becomes active once DNS resolves. Without a domain the
      load balancer serves HTTP on port 80.
    - https_redirect: with a domain, also listen on port 80 and redirect to HTTPS.
    - app_cdn: Cloud CDN on the app backend. Only responses with a public Cache-Control are cached;
      pages vary on router headers, so this mainly helps public route handlers and metadata files.
    - armor / armor_enforce: Cloud Armor policy with the preconfigured xss-v33-stable and
      sqli-v33-stable rules on the Cloud Run backends, in preview mode (logged, not blocked)
      unless armor_enforce is true.
    - base_path: the app's basePath, e.g. "/docs".
    The load balancer is the production path but has no free tier: forwarding rules, Cloud CDN
    and Cloud Armor are billed hourly and per request. See current Google Cloud pricing.
  EOT
  type = object({
    enabled        = optional(bool, true)
    domain         = optional(string)
    https_redirect = optional(bool, true)
    app_cdn        = optional(bool, true)
    armor          = optional(bool, true)
    armor_enforce  = optional(bool, false)
    base_path      = optional(string, "")
  })
  default  = {}
  nullable = false

  validation {
    condition     = var.load_balancer.base_path == "" || can(regex("^/[^*?#]*[^/*?#]$", var.load_balancer.base_path))
    error_message = "load_balancer.base_path must be empty or start with \"/\" and not end with \"/\", e.g. \"/docs\"."
  }

  validation {
    condition     = var.load_balancer.domain == null ? true : can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?\\.)+[a-z]{2,}$", var.load_balancer.domain))
    error_message = "load_balancer.domain must be a lowercase hostname such as shop.example.com, without a scheme or path."
  }
}

# --- Shared cache (Memorystore) -----------------------------------------------

variable "memorystore" {
  description = <<-EOT
    Create a Memorystore for Redis instance (BASIC tier, DIRECT_PEERING) for the shared cache and
    point REDIS_URL at it. Both services reach it over Direct VPC egress on `network`/`subnetwork`
    (or `vpc`, when set). Off by default: Memorystore has no free tier and is billed per GB-hour.
    transit_encryption switches to rediss:// with SERVER_AUTHENTICATION and sets REDIS_CA_CERT.
  EOT
  type = object({
    enabled            = optional(bool, false)
    name               = optional(string)
    tier               = optional(string, "BASIC")
    memory_size_gb     = optional(number, 1)
    redis_version      = optional(string)
    network            = optional(string, "default")
    subnetwork         = optional(string)
    transit_encryption = optional(bool, false)
    redis_configs = optional(map(string), {
      # The cache relies on Redis evicting old entries under memory pressure.
      "maxmemory-policy" = "allkeys-lru"
    })
  })
  default  = {}
  nullable = false

  validation {
    condition     = contains(["BASIC", "STANDARD_HA"], var.memorystore.tier)
    error_message = "memorystore.tier must be BASIC or STANDARD_HA."
  }
}

variable "redis_url" {
  description = "Existing Redis endpoint (redis:// or rediss://) for the shared cache, instead of creating a Memorystore instance. Pair it with `vpc` when it is only reachable on a private network. Ignored when memorystore.enabled is true."
  type        = string
  default     = null
  sensitive   = true
}

variable "redis_ca_cert" {
  description = "PEM CA certificate for a rediss:// redis_url (REDIS_CA_CERT)."
  type        = string
  default     = null
}

variable "vpc" {
  description = "Direct VPC egress for both services, e.g. to reach an existing Redis on a private IP. subnetwork defaults to network. Defaults to Memorystore's network when memorystore.enabled is true."
  type = object({
    network    = string
    subnetwork = optional(string)
    egress     = optional(string, "PRIVATE_RANGES_ONLY")
    tags       = optional(list(string))
  })
  default = null

  validation {
    condition     = var.vpc == null ? true : contains(["PRIVATE_RANGES_ONLY", "ALL_TRAFFIC"], var.vpc.egress)
    error_message = "vpc.egress must be PRIVATE_RANGES_ONLY or ALL_TRAFFIC."
  }
}
