#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export AZURE_CONFIG_DIR="${AZURE_CONFIG_DIR:-/tmp/azure}"
export HELM_CACHE_HOME="${HELM_CACHE_HOME:-/tmp/helm-cache}"
export HELM_CONFIG_HOME="${HELM_CONFIG_HOME:-/tmp/helm-config}"
export HELM_DATA_HOME="${HELM_DATA_HOME:-/tmp/helm-data}"
export KUBECONFIG="${KUBECONFIG:-/tmp/pmbetterdeal-kubeconfig}"

ACR_NAME="${ACR_NAME:-pmbetterdealacr}"
ACR_LOGIN_SERVER="${ACR_LOGIN_SERVER:-pmbetterdealacr.azurecr.io}"
AKS_RESOURCE_GROUP="${AKS_RESOURCE_GROUP:-pm-betterdeal-rg}"
AKS_CLUSTER_NAME="${AKS_CLUSTER_NAME:-pm-betterdeal-aks}"
ERP_NAMESPACE="${ERP_NAMESPACE:-erpnext}"
ERP_RELEASE_NAME="${ERP_RELEASE_NAME:-erpnext}"
ERP_HOST="${ERP_HOST:-pm.betterdeal.ai}"
ERP_IMAGE_REPO="${ERP_IMAGE_REPO:-${ACR_LOGIN_SERVER}/erpnext-propms}"
ERP_IMAGE_TAG="${ERP_IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
ERP_VALUES_FILE="${ERP_VALUES_FILE:-${ROOT_DIR}/deploy/erpnext/values-prod.yaml}"
ERP_DOCKERFILE="${ERP_DOCKERFILE:-${ROOT_DIR}/deploy/erpnext/Dockerfile}"
APP_BASE_URL="${APP_BASE_URL:-https://pm.betterdeal.ai}"
APP_LOGIN_EMAIL="${APP_LOGIN_EMAIL:-tamir@angeldiamond.com}"
APP_LOGIN_PASSWORD="${APP_LOGIN_PASSWORD:-}"
APP_TENANT_SLUG="${APP_TENANT_SLUG:-legacy-default}"
ERP_WEBHOOK_SECRET="${ERP_WEBHOOK_SECRET:-}"

if [[ -z "${APP_LOGIN_PASSWORD}" ]]; then
  echo "APP_LOGIN_PASSWORD is required" >&2
  exit 1
fi

if [[ -z "${ERP_WEBHOOK_SECRET}" ]]; then
  ERP_WEBHOOK_SECRET="$(kubectl get secret property-management-property-management-secrets -n production -o jsonpath='{.data.WEBHOOK_SECRET}' | base64 -d)"
fi

ERP_ADMIN_PASSWORD="${ERP_ADMIN_PASSWORD:-$(openssl rand -base64 24 | tr -d '\n' | tr '/+' 'AB')}"
MARIADB_ROOT_PASSWORD="${MARIADB_ROOT_PASSWORD:-$(openssl rand -hex 24)}"

echo "Using ERPNext image: ${ERP_IMAGE_REPO}:${ERP_IMAGE_TAG}"

az aks get-credentials \
  --resource-group "${AKS_RESOURCE_GROUP}" \
  --name "${AKS_CLUSTER_NAME}" \
  --overwrite-existing >/dev/null

helm repo add frappe https://helm.erpnext.com >/dev/null 2>&1 || true
helm repo update >/dev/null

az acr build \
  --registry "${ACR_NAME}" \
  --image "erpnext-propms:${ERP_IMAGE_TAG}" \
  --file "${ERP_DOCKERFILE}" \
  "${ROOT_DIR}"

kubectl create namespace "${ERP_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic erpnext-admin -n "${ERP_NAMESPACE}" \
  --from-literal=password="${ERP_ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install "${ERP_RELEASE_NAME}" frappe/erpnext \
  --namespace "${ERP_NAMESPACE}" \
  -f "${ERP_VALUES_FILE}" \
  --set image.repository="${ERP_IMAGE_REPO}" \
  --set image.tag="${ERP_IMAGE_TAG}" \
  --set mariadb-sts.rootPassword="${MARIADB_ROOT_PASSWORD}"

kubectl rollout status deployment/"${ERP_RELEASE_NAME}"-nginx -n "${ERP_NAMESPACE}" --timeout=20m
kubectl rollout status deployment/"${ERP_RELEASE_NAME}"-gunicorn -n "${ERP_NAMESPACE}" --timeout=20m

helm template "${ERP_RELEASE_NAME}" frappe/erpnext \
  --namespace "${ERP_NAMESPACE}" \
  -f "${ERP_VALUES_FILE}" \
  --set image.repository="${ERP_IMAGE_REPO}" \
  --set image.tag="${ERP_IMAGE_TAG}" \
  --set mariadb-sts.rootPassword="${MARIADB_ROOT_PASSWORD}" \
  --set jobs.createSite.enabled=true \
  --set jobs.createSite.siteName="${ERP_HOST}" \
  --set jobs.createSite.adminExistingSecret=erpnext-admin \
  --set jobs.createSite.adminExistingSecretKey=password \
  -s templates/job-create-site.yaml | kubectl apply -f -

kubectl wait --for=condition=complete "job/$(kubectl get jobs -n "${ERP_NAMESPACE}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep "${ERP_RELEASE_NAME}-new-site" | tail -n 1)" -n "${ERP_NAMESPACE}" --timeout=30m

ERP_POD="$(kubectl get pods -n "${ERP_NAMESPACE}" -l app.kubernetes.io/name=erpnext,app.kubernetes.io/instance="${ERP_RELEASE_NAME}",app.kubernetes.io/component=gunicorn -o jsonpath='{.items[0].metadata.name}')"

kubectl exec -n "${ERP_NAMESPACE}" "${ERP_POD}" -- \
  bench --site "${ERP_HOST}" set-config host_name "https://${ERP_HOST}"

KEY_OUTPUT="$(kubectl exec -n "${ERP_NAMESPACE}" "${ERP_POD}" -- \
  bench --site "${ERP_HOST}" execute frappe.core.doctype.user.user.generate_keys --args '["Administrator"]')"

ERP_API_KEY="$(printf '%s\n' "${KEY_OUTPUT}" | tail -n 1 | sed -E "s/.*'api_key': '([^']+)'.*/\1/")"
ERP_API_SECRET="$(printf '%s\n' "${KEY_OUTPUT}" | tail -n 1 | sed -E "s/.*'api_secret': '([^']+)'.*/\1/")"

if [[ -z "${ERP_API_KEY}" || -z "${ERP_API_SECRET}" ]]; then
  echo "Could not parse generated ERPNext API credentials" >&2
  printf '%s\n' "${KEY_OUTPUT}" >&2
  exit 1
fi

APP_TOKEN="$(curl -fsS -X POST "${APP_BASE_URL}/api/v2/auth/login" \
  -H 'content-type: application/json' \
  --data "{\"email\":\"${APP_LOGIN_EMAIL}\",\"password\":\"${APP_LOGIN_PASSWORD}\",\"tenantSlug\":\"${APP_TENANT_SLUG}\"}" | node -pe 'JSON.parse(fs.readFileSync(0, "utf8")).token')"

TENANT_ID="$(curl -fsS "${APP_BASE_URL}/api/v2/me" -H "Authorization: Bearer ${APP_TOKEN}" | node -pe 'JSON.parse(fs.readFileSync(0, "utf8")).tenant.id')"

curl -fsS -X PUT "${APP_BASE_URL}/api/v2/tenants/${TENANT_ID}/integrations/erpnext" \
  -H "Authorization: Bearer ${APP_TOKEN}" \
  -H 'content-type: application/json' \
  --data "{\"baseUrl\":\"https://${ERP_HOST}\",\"apiKey\":\"${ERP_API_KEY}\",\"apiSecret\":\"${ERP_API_SECRET}\",\"webhookSecret\":\"${ERP_WEBHOOK_SECRET}\"}" >/dev/null

BOOTSTRAP_OUTPUT="$(curl -fsS -X POST "${APP_BASE_URL}/api/v2/tenants/${TENANT_ID}/integrations/erpnext/bootstrap" \
  -H "Authorization: Bearer ${APP_TOKEN}" \
  -H 'content-type: application/json')"

echo "ERPNext deployed."
echo "ERPNext Desk: https://${ERP_HOST}/app"
echo "ERPNext Login: https://${ERP_HOST}/login"
echo "Tenant Portal: https://${ERP_HOST}/my-invoices"
echo "Application Form: https://${ERP_HOST}/apply"
echo "ERP Admin Password: ${ERP_ADMIN_PASSWORD}"
echo "ERP API Key: ${ERP_API_KEY}"
echo "ERP API Secret: ${ERP_API_SECRET}"
echo "Bootstrap output:"
printf '%s\n' "${BOOTSTRAP_OUTPUT}"
