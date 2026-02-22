#!/usr/bin/env bash
# Upload secrets from .env to Azure Key Vault.
# Usage: ./seed-secrets.sh <keyvault-name>
# Reads from .env file (local) or environment variables (CI).
set -euo pipefail

KV_NAME="${1:?Usage: $0 <keyvault-name>}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

ENV_FILE="${REPO_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
  echo "==> Loading secrets from .env"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID in .env or environment}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET in .env or environment}"
: "${JWT_SECRET:?Set JWT_SECRET in .env or environment}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env or environment}"

SECRETS=(
  "google-client-id:${GOOGLE_CLIENT_ID}"
  "google-client-secret:${GOOGLE_CLIENT_SECRET}"
  "jwt-secret:${JWT_SECRET}"
  "postgres-password:${POSTGRES_PASSWORD}"
)

for entry in "${SECRETS[@]}"; do
  name="${entry%%:*}"
  value="${entry#*:}"
  echo "==> Setting secret: ${name}"
  az keyvault secret set \
    --vault-name "${KV_NAME}" \
    --name "${name}" \
    --value "${value}" \
    --output none
done

echo "==> All secrets uploaded to Key Vault: ${KV_NAME}"
