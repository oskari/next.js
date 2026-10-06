variable "project_id" {
  description = "Google Cloud project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, the buckets, the registry and Memorystore."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Cloud Run app service name and resource prefix."
  type        = string
  default     = "nextjs"
}

variable "domain" {
  description = "Domain served over HTTPS with a Google-managed certificate. Point its A record at the load_balancer_ip output."
  type        = string
}

variable "base_path" {
  description = "The app's basePath, if any, e.g. \"/docs\"."
  type        = string
  default     = ""
}

variable "min_instances" {
  description = "Minimum app instances kept warm."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum app instances, or null for the Cloud Run default."
  type        = number
  default     = null
}

variable "image_max_instances" {
  description = "Maximum image service instances, or null for the Cloud Run default."
  type        = number
  default     = null
}

variable "timeout_seconds" {
  description = "App request timeout; cover the longest maxDuration of any route."
  type        = number
  default     = 300
}

variable "armor_enforce" {
  description = "Block requests matching the Cloud Armor rules instead of only logging them."
  type        = bool
  default     = false
}

variable "redis_memory_size_gb" {
  description = "Memorystore capacity in GB."
  type        = number
  default     = 1
}

variable "network" {
  description = "VPC network for Memorystore and the services' Direct VPC egress."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnetwork for Direct VPC egress in the region. Defaults to a subnet named like the network, which the default auto-mode network has."
  type        = string
  default     = null
}

variable "env" {
  description = "Extra environment variables for both services."
  type        = map(string)
  default     = {}
}
