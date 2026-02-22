#!/usr/bin/env bash
# Bind custom domains to the frontend Container App and provision TLS certs.
# Usage: ./bind-domains.sh
# Prerequisites: DNS records must already be configured in Cloudflare (see docs/cloudflare-setup.md)
set -euo pipefail

RG="patelr3-site-rg"
APP="patelr3-frontend"
ENV="patelr3-cae"

# www subdomain uses CNAME validation; apex domain uses HTTP validation
declare -A DOMAINS
DOMAINS["www.arayosun.com"]="CNAME"
DOMAINS["arayosun.com"]="HTTP"

for domain in "${!DOMAINS[@]}"; do
  method="${DOMAINS[$domain]}"
  echo "==> Adding hostname: ${domain}"
  az containerapp hostname add \
    --name "${APP}" --resource-group "${RG}" \
    --hostname "${domain}" -o none 2>&1 && \
  echo "==> Binding TLS certificate for: ${domain} (validation: ${method})" && \
  az containerapp hostname bind \
    --name "${APP}" --resource-group "${RG}" \
    --hostname "${domain}" \
    --environment "${ENV}" \
    --validation-method "${method}" -o none 2>&1 && \
  echo "    ✅ ${domain} bound with managed cert" || \
  echo "    ❌ ${domain} failed — check DNS records (see docs/cloudflare-setup.md)"
done

echo ""
echo "==> Current hostnames:"
az containerapp hostname list --name "${APP}" --resource-group "${RG}" -o table

echo ""
echo "Next steps:"
echo "  1. Wait for certificate status to show 'Succeeded'"
echo "  2. In Cloudflare, toggle both CNAME records to Proxied (orange cloud)"
echo "  3. In Cloudflare SSL/TLS, set mode to Full (strict)"
