#!/usr/bin/env bash
# Full deployment: infra + images + secrets.
# Usage: ./deploy.sh [image-tag]
# This is the single entry point for both local and CI deployments.
set -euo pipefail

IMAGE_TAG="${1:-latest}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RESOURCE_GROUP="patelr3-site-rg"
ACR_NAME="patelr3acr"

echo "╔══════════════════════════════════════╗"
echo "║  patelr3-site deployment             ║"
echo "║  Tag: ${IMAGE_TAG}                   "
echo "╚══════════════════════════════════════╝"
echo ""

# Step 1: Deploy infrastructure (ACR, Key Vault, Container Apps)
echo "── Step 1/3: Deploy infrastructure ────"
"${SCRIPT_DIR}/deploy-infra.sh" "${RESOURCE_GROUP}" "${IMAGE_TAG}"
echo ""

# Step 2: Build & push images to ACR
echo "── Step 2/3: Push images to ACR ───────"
"${SCRIPT_DIR}/push-images.sh" "${ACR_NAME}" "${IMAGE_TAG}"
echo ""

# Step 3: Seed secrets to Key Vault
echo "── Step 3/3: Seed secrets to Key Vault "
KV_NAME=$(az keyvault list --resource-group "${RESOURCE_GROUP}" --query '[0].name' -o tsv)
"${SCRIPT_DIR}/seed-secrets.sh" "${KV_NAME}"
echo ""

echo "==> Full deployment complete!"
echo "==> Update your Container Apps to use tag: ${IMAGE_TAG}"
