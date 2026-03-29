# Terraform Infrastructure

This stack provisions:
- Dedicated AKS cluster (OIDC + workload identity enabled)
- Azure Container Registry
- Azure Key Vault
- GitHub OIDC deploy identity
- Runtime workload identity for AKS pods
- PostgreSQL Flexible Server for `dev`, `stage`, `prod`

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```
