locals {
  # The app and the optional image service run the same container image with
  # the same environment, identity, ingress and network; only sizing differs.
  services = merge(
    {
      app = {
        name              = var.name
        cpu               = var.app.cpu
        memory            = var.app.memory
        concurrency       = var.app.concurrency
        timeout_seconds   = var.app.timeout_seconds
        min_instances     = var.app.min_instances
        max_instances     = var.app.max_instances
        startup_cpu_boost = var.app.startup_cpu_boost
      }
    },
    local.image_enabled ? {
      image = {
        name              = local.image_name
        cpu               = var.image_service.cpu
        memory            = var.image_service.memory
        concurrency       = var.image_service.concurrency
        timeout_seconds   = var.image_service.timeout_seconds
        min_instances     = var.image_service.min_instances
        max_instances     = var.image_service.max_instances
        startup_cpu_boost = var.image_service.startup_cpu_boost
      }
    } : {},
  )
}

resource "google_cloud_run_v2_service" "this" {
  for_each = local.services

  project             = var.project_id
  location            = var.region
  name                = each.value.name
  ingress             = local.ingress
  labels              = var.labels
  deletion_protection = var.deletion_protection

  template {
    service_account                  = local.service_account_email
    timeout                          = "${each.value.timeout_seconds}s"
    max_instance_request_concurrency = each.value.concurrency

    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    containers {
      # Placeholder until the first release; the deploy script sets the image.
      image = local.placeholder_image

      # The server listens on PORT, which Cloud Run sets from this.
      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = each.value.cpu
          memory = each.value.memory
        }
        # false keeps CPU allocated after the response, so waitUntil work
        # (background ISR and image regeneration, after()) can finish.
        cpu_idle          = !var.cpu_always_allocated
        startup_cpu_boost = each.value.startup_cpu_boost
      }

      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }

    dynamic "vpc_access" {
      for_each = local.vpc != null ? [local.vpc] : []
      content {
        egress = vpc_access.value.egress
        network_interfaces {
          network    = vpc_access.value.network
          subnetwork = coalesce(vpc_access.value.subnetwork, vpc_access.value.network)
          tags       = vpc_access.value.tags
        }
      }
    }
  }

  lifecycle {
    # Releases are deployed outside Terraform with `gcloud run deploy --image`
    # (or `gcloud run services update --image`). These are the fields that
    # deploy changes and Terraform never sets, so a later `terraform apply`
    # keeps the running release instead of rolling back to the placeholder:
    # - the container image;
    # - client / client_version, which gcloud stamps with "gcloud" and its
    #   version;
    # - the revision name and the revision template's annotations and labels,
    #   where gcloud records the revision name or nonce and the deployed image
    #   (client.knative.dev/*).
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
      template[0].revision,
      template[0].annotations,
      template[0].labels,
    ]
  }

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = var.allow_unauthenticated ? local.services : {}

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
