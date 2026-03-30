# Azure AKS CI/CD

This repository now includes:
- Terraform in `infra/terraform`
- Helm chart in `deploy/helm`
- GitHub Actions workflows in `.github/workflows`

## 1. Provision infrastructure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

## 2. Configure GitHub secrets/variables

### Repository secrets
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

### Environment secrets (`dev`, `stage`, `prod`)
- `DATABASE_URL`
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `GRAFANA_ADMIN_PASSWORD` (prod, for observability workflow)

### Environment variables (`prod`)
- `AKS_RESOURCE_GROUP` (optional; defaults to `pm-betterdeal-rg`)
- `AKS_CLUSTER_NAME` (optional; defaults to `pm-betterdeal-aks`)
- `ACR_LOGIN_SERVER` (optional; defaults to `pmbetterdealacr.azurecr.io`)
- `ACR_NAME` (optional; defaults to `pmbetterdealacr`)
- `KEY_VAULT_NAME` (optional; defaults to `pmbetterdeal-kv`)
- `WORKLOAD_IDENTITY_CLIENT_ID` (optional; defaults to the provisioned workload identity client ID)
- `K8S_NAMESPACE` (optional; defaults to `production`)
- `K8S_SERVICE_ACCOUNT_NAME` (optional; defaults to `property-management-sa`)
- `APP_BASE_URL` (optional; defaults to `https://pm.betterdeal.ai`)
- `CERT_MANAGER_EMAIL` (for `cluster-bootstrap.yml`)

## 3. Add Key Vault secrets

Create all runtime secrets listed in `deploy/helm/values.yaml` under `keyVault.objects`.

## 4. Deployment flow

- PRs: `ci.yml` + `infra.yml` plan
- Pushes: `ci.yml`
- Push to the repository default branch or manual dispatch:
  - `cd.yml` build and deploy to the dedicated production AKS cluster

Run `cluster-bootstrap.yml` once per cluster to install `ingress-nginx` and `cert-manager`.
Run `observability.yml` to deploy `kube-prometheus-stack` (Prometheus + Grafana).

## 5. Scheduler in Kubernetes

Scheduler tasks run as Kubernetes CronJobs (`APP_MODE=job` + `JOB_ID`) and no longer depend on scaling-sensitive in-process cron in production.
