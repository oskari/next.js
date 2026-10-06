# Free-tier example

Provisions Next.js on Cloud Run within the Google Cloud free tier as far as possible:

- One app service in `us-central1` with request-based billing (CPU only during requests) that scales to zero, capped at `max_instances`.
- A private Cloud Storage bucket that caches optimized images for all instances.
- An Artifact Registry repository that keeps only the 2 most recent release images.
- No load balancer, Cloud CDN, Cloud Armor, image service, static bucket or Memorystore, since these have no free tier.
- `deletion_protection = false`, so `terraform destroy` removes everything.

Free-tier quotas and prices change; check current Google Cloud pricing. With request-based billing, background work started after the response (ISR revalidation, `after()`) may be delayed until the next request reaches the instance.

## Usage

```bash
gcloud auth application-default login

terraform init
terraform plan -var project_id=my-project
terraform apply -var project_id=my-project
```

The services start with a placeholder image. Then build and deploy a release of your app. The deploy script reads this directory's outputs:

```bash
TF_DIR=path/to/this/example scripts/deploy.sh path/to/next-app
```

See the adapter README for the deploy script's details. Releases deployed this way are not reverted by later `terraform apply` runs.

To try the load balancer, Cloud CDN and Cloud Armor, pass `-var enable_load_balancer=true`. They have no free tier, but a few hours of testing followed by `terraform destroy` costs cents.

## Clean up

```bash
terraform destroy -var project_id=my-project
```
