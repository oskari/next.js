terraform {
  # 1.7 adds mock providers to `terraform test`, which tests/ relies on.
  required_version = ">= 1.7.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 8.0.0, < 9.0.0"
    }
  }
}
