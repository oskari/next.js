# Production example

Provisions everything the adapter supports:

- The app service with CPU always allocated and one warm instance, and a dedicated image service.
- A global external Application Load Balancer with a Google-managed certificate for `domain`, HTTPS on 443 and a redirect from port 80.
- Cloud CDN on static assets (backend bucket), optimized images and cacheable app responses.
- Cloud Armor with the preconfigured XSS and SQLi rules in preview mode.
- Memorystore for Redis as the shared cache, reached over Direct VPC egress.
- The static asset and image cache buckets, and an Artifact Registry repository.
- `deletion_protection = true` on the services, Memorystore, buckets and registry.

The load balancer, Cloud CDN, Cloud Armor and Memorystore have no free tier; see current Google Cloud pricing.

## Usage

```bash
gcloud auth application-default login

terraform init
terraform plan -var project_id=my-project -var domain=shop.example.com
terraform apply -var project_id=my-project -var domain=shop.example.com
```

Point an A record for the domain at the `load_balancer_ip` output. The certificate becomes active once DNS resolves, which can take a while. The services' ingress only accepts traffic from the load balancer.

The services start with a placeholder image. Then build and deploy a release of your app. The deploy script reads this directory's outputs:

```bash
TF_DIR=path/to/this/example scripts/deploy.sh path/to/next-app
```

See the adapter README for the deploy script's details. Releases deployed this way are not reverted by later `terraform apply` runs.

For a shared environment, configure a remote backend (see the commented `backend "gcs"` block in `main.tf`).

## Clean up

`deletion_protection` blocks `terraform destroy`. Set it to `false` in `main.tf` and run `terraform apply` first, then:

```bash
terraform destroy -var project_id=my-project -var domain=shop.example.com
```
