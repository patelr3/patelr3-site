#!/usr/bin/env bash
# Build and push Docker images to ACR.
# Usage: ./push-images.sh <acr-name> [image-tag]
# Works locally and in GitHub Actions.
set -euo pipefail

ACR_NAME="${1:?Usage: $0 <acr-name> [image-tag]}"
IMAGE_TAG="${2:-latest}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Logging in to ACR: ${ACR_NAME}"
az acr login --name "${ACR_NAME}"

ACR_SERVER="${ACR_NAME}.azurecr.io"

SERVICES=("frontend" "auth-api" "hello-world")

for svc in "${SERVICES[@]}"; do
  IMAGE="${ACR_SERVER}/${svc}:${IMAGE_TAG}"
  echo "==> Building ${svc} → ${IMAGE}"
  docker build -t "${IMAGE}" "${REPO_ROOT}/${svc}"
  echo "==> Pushing ${IMAGE}"
  docker push "${IMAGE}"
done

echo "==> All images pushed to ${ACR_SERVER} with tag ${IMAGE_TAG}"
