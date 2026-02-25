#!/usr/bin/env bash
# Deploy Azure AI Foundry infrastructure and register the SunnieAI agent.
#
# Usage:
#   ./scripts/deploy-foundry.sh [--model gpt-4o] [--mcp-url URL]
#
# Prerequisites:
#   - az login (authenticated)
#   - pip install azure-ai-projects azure-ai-agents azure-identity
set -euo pipefail

RESOURCE_GROUP="${FOUNDRY_RESOURCE_GROUP:-patelr3-ai-rg}"
LOCATION="${FOUNDRY_LOCATION:-eastus2}"
MODEL="${1:-gpt-4o}"
MCP_URL="${MCP_SERVER_URL:-}"

echo "=== Deploy Azure AI Foundry ==="
echo "Resource Group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo ""

# 1. Ensure resource group exists
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none 2>/dev/null || true

# 2. Deploy Bicep (hub, project, AI services, model)
echo "Deploying Foundry infrastructure..."
OUTPUTS=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file deployments/foundry.bicep \
  --parameters deployments/foundry-parameters.json \
  --parameters location="$LOCATION" \
  --query 'properties.outputs' -o json)

PROJECT_ENDPOINT=$(echo "$OUTPUTS" | python3 -c "import sys,json; print(json.load(sys.stdin)['projectEndpoint']['value'])")
echo "✓ Infrastructure deployed"
echo "  Project endpoint: $PROJECT_ENDPOINT"
echo ""

# 3. Get MCP server URL from main site deployment if not set
if [ -z "$MCP_URL" ]; then
  MCP_FQDN=$(az containerapp show \
    --name patelr3-mcp-server \
    --resource-group patelr3-site-rg \
    --query 'properties.configuration.ingress.fqdn' -o tsv 2>/dev/null || true)
  if [ -n "$MCP_FQDN" ]; then
    MCP_URL="https://${MCP_FQDN}"
  else
    echo "Warning: MCP server not found. Set MCP_SERVER_URL env var."
    echo "  Skipping agent registration."
    exit 0
  fi
fi

# 4. Register/update agent
echo "Registering SunnieAI agent..."
export PROJECT_ENDPOINT
export MCP_SERVER_URL="$MCP_URL"
python3 scripts/setup-foundry-agent.py --model "$MODEL" --mcp-url "$MCP_URL"

echo ""
echo "=== Deployment complete ==="
echo "Set these in your .env or ACA config:"
echo "  FOUNDRY_PROJECT_ENDPOINT=$PROJECT_ENDPOINT"
