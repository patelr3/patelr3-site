#!/usr/bin/env bash
# Generate an RSA-2048 key pair (JWK format) and store the private key in Azure Key Vault.
# This key is used by auth-api's OIDC provider to sign ID and access tokens.
# Run once; the key persists across deployments via AKV → env var.
#
# Usage: bash scripts/generate-oidc-key.sh [--vault-name NAME]
#
# Prerequisites: az CLI (logged in), Node.js with jose available

set -euo pipefail

VAULT_NAME="${1:-patelr3kvl3ytczhajsp7i}"
SECRET_NAME="oidc-signing-key-jwk"

echo "Generating RSA-2048 key pair..."

PRIVATE_JWK=$(cd auth-api && node -e "
  import('jose').then(async ({ generateKeyPair, exportJWK }) => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.privateKey);
    jwk.kid = 'oidc-signing-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    console.log(JSON.stringify(jwk));
  });
")

echo "Storing private JWK in AKV secret '${SECRET_NAME}'..."
az keyvault secret set \
  --vault-name "$VAULT_NAME" \
  --name "$SECRET_NAME" \
  --value "$PRIVATE_JWK" \
  --content-type "application/json" \
  --output none

echo "✅ Key stored in AKV. Verify with:"
echo "   az keyvault secret show --vault-name $VAULT_NAME --name $SECRET_NAME --query value -o tsv | node -e \"process.stdin.on('data',d=>console.log(JSON.parse(d)))\""
