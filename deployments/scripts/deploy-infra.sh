#!/usr/bin/env bash
# Deploy Azure infrastructure using Bicep.
# Usage: ./deploy-infra.sh <resource-group> [image-tag]
# Reads secrets from .env file (local) or environment variables (CI).
set -euo pipefail

RESOURCE_GROUP="${1:?Usage: $0 <resource-group> [image-tag]}"
IMAGE_TAG="${2:-latest}"
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"

# Load secrets from .env if it exists (local dev), otherwise expect env vars
ENV_FILE="${REPO_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
  echo "==> Loading secrets from .env"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Validate required secrets
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID in .env or environment}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET in .env or environment}"
: "${JWT_SECRET:?Set JWT_SECRET in .env or environment}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env or environment}"

echo "==> Creating resource group ${RESOURCE_GROUP} (if needed)"
az group create --name "${RESOURCE_GROUP}" --location eastus --output none 2>/dev/null || true

echo "==> Deploying Bicep templates (tag: ${IMAGE_TAG})"
az deployment group create \
  --resource-group "${RESOURCE_GROUP}" \
  --template-file "${DEPLOY_DIR}/main.bicep" \
  --parameters "${DEPLOY_DIR}/parameters.json" \
  --parameters \
    imageTag="${IMAGE_TAG}" \
    googleClientId="${GOOGLE_CLIENT_ID}" \
    googleClientSecret="${GOOGLE_CLIENT_SECRET}" \
    jwtSecret="${JWT_SECRET}" \
    postgresPassword="${POSTGRES_PASSWORD}" \
  --output table

echo "==> Deployment complete"
echo ""
echo "Frontend URL:"
az deployment group show \
  --resource-group "${RESOURCE_GROUP}" \
  --name main \
  --query 'properties.outputs.frontendFqdn.value' \
  --output tsv 2>/dev/null || echo "(check Azure portal)"
