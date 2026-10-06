variable "project_id" {
  description = "Google Cloud project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for every resource. Keep a US region covered by Cloud Storage's free tier (us-central1, us-east1 or us-west1)."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Cloud Run service name and resource prefix."
  type        = string
  default     = "nextjs"
}

variable "max_instances" {
  description = "Upper bound on app instances, which caps the bill if traffic spikes."
  type        = number
  default     = 3
}

variable "enable_load_balancer" {
  description = "Add the load balancer with Cloud CDN, Cloud Armor, the image service and the static bucket. These have no free tier, but a few hours of testing followed by `terraform destroy` costs cents; see current Google Cloud pricing."
  type        = bool
  default     = false
}
