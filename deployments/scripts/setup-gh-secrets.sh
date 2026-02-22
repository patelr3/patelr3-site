#!/usr/bin/env bash
# Set required GitHub repository secrets for the deploy workflow.
# Usage: ./setup-gh-secrets.sh
# Prerequisites: gh auth login
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET}"
: "${JWT_SECRET:?Set JWT_SECRET}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}"

echo "==> Setting GitHub repository secrets..."
gh secret set GOOGLE_CLIENT_ID --body "${GOOGLE_CLIENT_ID}"
gh secret set GOOGLE_CLIENT_SECRET --body "${GOOGLE_CLIENT_SECRET}"
gh secret set JWT_SECRET --body "${JWT_SECRET}"
gh secret set POSTGRES_PASSWORD --body "${POSTGRES_PASSWORD}"

echo "==> Done. Secrets set:"
gh secret list
