// Main deployment orchestrator for patelr3-site
targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────
@description('Azure region for all resources')
param location string = 'westus2'

@description('Unique project prefix (lowercase, no dashes, max 10 chars)')
@minLength(3)
@maxLength(10)
param projectName string = 'patelr3'

@description('Docker image tag to deploy')
param imageTag string = 'latest'

@description('Frontend public URL (for OAuth redirects)')
param frontendUrl string = 'https://www.arayosun.com'

// Only postgresPassword is still needed as a param (for the postgres container
// which uses a Docker Hub image and can't use managed identity for init).
// All other secrets are read from Key Vault via AKV references.
@secure()
param postgresPassword string

param postgresUser string = 'patelr3'
param postgresDb string = 'patelr3_site'

@description('Finance CAE domain (from finance-infra deployment)')
param financeCaeDomain string = 'icytree-0e39e2f3.westus2.azurecontainerapps.io'

// ── Variables ──────────────────────────────────────────────────
var tags = {
  project: projectName
  managedBy: 'bicep'
}
var acrName = '${projectName}acr'
var kvName = '${projectName}kv${uniqueString(resourceGroup().id)}'
var envName = '${projectName}-cae'

// Key Vault secret URL base (no trailing slash)
var kvSecretsUrl = 'https://${kvName}${environment().suffixes.keyvaultDns}/secrets'

// ── ACR ────────────────────────────────────────────────────────
module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    name: acrName
    location: location
    tags: tags
  }
}

// ── Key Vault ──────────────────────────────────────────────────
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: kvName
    location: location
    tags: tags
  }
}

// ── User-Assigned Managed Identity for AKV access ──────────────
// Pre-created identity with Key Vault Secrets User role on the vault.
// All ACAs share this identity to read secrets directly from AKV.
resource kvReaderIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${projectName}-kv-reader'
}

// ── Container Apps Environment ─────────────────────────────────
module cae 'modules/container-apps-env.bicep' = {
  name: 'container-apps-env'
  params: {
    name: envName
    location: location
    tags: tags
  }
}

// ── Postgres Container App ─────────────────────────────────────
module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: '${projectName}-postgres'
    location: location
    tags: tags
    envId: cae.outputs.id
    postgresUser: postgresUser
    postgresPassword: postgresPassword
    postgresDb: postgresDb
  }
}

// ── Auth API Container App ─────────────────────────────────────
module authApi 'modules/container-app.bicep' = {
  name: 'auth-api'
  params: {
    name: '${projectName}-auth-api'
    location: location
    tags: tags
    envId: cae.outputs.id
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageName: 'auth-api'
    imageTag: imageTag
    targetPort: 8000
    external: true
    minReplicas: 1
    enableSystemIdentity: true
    userAssignedIdentityId: kvReaderIdentity.id
    env: [
      { name: 'GOOGLE_CLIENT_ID', secretRef: 'google-client-id' }
      { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-client-secret' }
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
      { name: 'FRONTEND_URL', value: frontendUrl }
      { name: 'AUTH_API_URL', value: 'https://${projectName}-auth-api.${cae.outputs.defaultDomain}' }
      { name: 'FINANCE_API_URL', value: 'https://finance-api.${financeCaeDomain}' }
      { name: 'FINANCE_API_KEY', secretRef: 'finance-api-key' }
      { name: 'FOUNDRY_PROJECT_ENDPOINT', secretRef: 'foundry-project-endpoint' }
      { name: 'FOUNDRY_AGENT_NAME', secretRef: 'foundry-agent-name' }
      { name: 'FOUNDRY_AGENT_ID', secretRef: 'foundry-agent-id' }
      { name: 'MCP_SERVER_URL', value: 'https://${projectName}-mcp-server.${cae.outputs.defaultDomain}' }
      { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
      { name: 'CHAT_ENCRYPTION_KEY', secretRef: 'chat-encryption-key' }
      { name: 'OIDC_FOUNDRY_CLIENT_SECRET', secretRef: 'oidc-foundry-client-secret' }
      { name: 'FOUNDRY_MCP_CONNECTION_ID', secretRef: 'foundry-mcp-connection-id' }
    ]
    secrets: [
      { name: 'google-client-id', keyVaultUrl: '${kvSecretsUrl}/google-client-id', identity: kvReaderIdentity.id }
      { name: 'google-client-secret', keyVaultUrl: '${kvSecretsUrl}/google-client-secret', identity: kvReaderIdentity.id }
      { name: 'jwt-secret', keyVaultUrl: '${kvSecretsUrl}/jwt-secret', identity: kvReaderIdentity.id }
      { name: 'database-url', keyVaultUrl: '${kvSecretsUrl}/database-url', identity: kvReaderIdentity.id }
      { name: 'finance-api-key', keyVaultUrl: '${kvSecretsUrl}/finance-api-key', identity: kvReaderIdentity.id }
      { name: 'foundry-project-endpoint', keyVaultUrl: '${kvSecretsUrl}/foundry-project-endpoint', identity: kvReaderIdentity.id }
      { name: 'foundry-agent-name', keyVaultUrl: '${kvSecretsUrl}/foundry-agent-name', identity: kvReaderIdentity.id }
      { name: 'foundry-agent-id', keyVaultUrl: '${kvSecretsUrl}/foundry-agent-id', identity: kvReaderIdentity.id }
      { name: 'appinsights-connection-string', keyVaultUrl: '${kvSecretsUrl}/appinsights-connection-string', identity: kvReaderIdentity.id }
      { name: 'chat-encryption-key', keyVaultUrl: '${kvSecretsUrl}/chat-encryption-key', identity: kvReaderIdentity.id }
      { name: 'oidc-foundry-client-secret', keyVaultUrl: '${kvSecretsUrl}/oidc-foundry-client-secret', identity: kvReaderIdentity.id }
      { name: 'foundry-mcp-connection-id', keyVaultUrl: '${kvSecretsUrl}/foundry-mcp-connection-id', identity: kvReaderIdentity.id }
    ]
  }
}

// ── Hello-World Container App ──────────────────────────────────
module helloWorld 'modules/container-app.bicep' = {
  name: 'hello-world'
  params: {
    name: '${projectName}-hello-world'
    location: location
    tags: tags
    envId: cae.outputs.id
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageName: 'hello-world'
    imageTag: imageTag
    targetPort: 5000
    external: true
    userAssignedIdentityId: kvReaderIdentity.id
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FRONTEND_URL', value: frontendUrl }
    ]
    secrets: [
      { name: 'jwt-secret', keyVaultUrl: '${kvSecretsUrl}/jwt-secret', identity: kvReaderIdentity.id }
    ]
  }
}

// ── Hello-World-Restricted Container App ───────────────────────
module helloWorldRestricted 'modules/container-app.bicep' = {
  name: 'hello-world-restricted'
  params: {
    name: '${projectName}-hello-world-restricted'
    location: location
    tags: tags
    envId: cae.outputs.id
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageName: 'hello-world-restricted'
    imageTag: imageTag
    targetPort: 5001
    external: true
    userAssignedIdentityId: kvReaderIdentity.id
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FRONTEND_URL', value: frontendUrl }
    ]
    secrets: [
      { name: 'jwt-secret', keyVaultUrl: '${kvSecretsUrl}/jwt-secret', identity: kvReaderIdentity.id }
    ]
  }
}

// ── MCP Server Container App ───────────────────────────────────
module mcpServer 'modules/container-app.bicep' = {
  name: 'mcp-server'
  params: {
    name: '${projectName}-mcp-server'
    location: location
    tags: tags
    envId: cae.outputs.id
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageName: 'mcp-server'
    imageTag: imageTag
    targetPort: 8090
    external: true
    minReplicas: 1
    userAssignedIdentityId: kvReaderIdentity.id
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FINANCE_API_URL', value: 'https://finance-api.${financeCaeDomain}' }
      { name: 'FINANCE_API_KEY', secretRef: 'finance-api-key' }
      { name: 'OIDC_JWKS_URL', value: 'https://www.arayosun.com/api/auth/oidc/jwks' }
    ]
    secrets: [
      { name: 'jwt-secret', keyVaultUrl: '${kvSecretsUrl}/jwt-secret', identity: kvReaderIdentity.id }
      { name: 'finance-api-key', keyVaultUrl: '${kvSecretsUrl}/finance-api-key', identity: kvReaderIdentity.id }
    ]
  }
}

// ── Existing managed certificates (created by bind-domains.sh) ──
resource caeRef 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: envName
}

resource certWww 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' existing = {
  name: 'mc-patelr3-cae-www-arayosun-com-7175'
  parent: caeRef
}

resource certApex 'Microsoft.App/managedEnvironments/managedCertificates@2024-03-01' existing = {
  name: 'mc-patelr3-cae-arayosun-com-4571'
  parent: caeRef
}

// ── Frontend Container App ─────────────────────────────────────
module frontend 'modules/container-app.bicep' = {
  name: 'frontend'
  params: {
    name: '${projectName}-frontend'
    location: location
    tags: tags
    envId: cae.outputs.id
    acrLoginServer: acr.outputs.loginServer
    acrName: acr.outputs.name
    imageName: 'frontend'
    imageTag: imageTag
    targetPort: 3000
    external: true
    minReplicas: 1
    env: [
      { name: 'AUTH_API_UPSTREAM', value: 'http://${projectName}-auth-api' }
      { name: 'HELLO_API_UPSTREAM', value: 'http://${projectName}-hello-world' }
      { name: 'HELLO_RESTRICTED_API_UPSTREAM', value: 'http://${projectName}-hello-world-restricted' }
    ]
    secrets: []
    customDomains: [
      {
        name: 'www.arayosun.com'
        certificateId: certWww.id
        bindingType: 'SniEnabled'
      }
      {
        name: 'arayosun.com'
        certificateId: certApex.id
        bindingType: 'SniEnabled'
      }
    ]
  }
}

// ── Outputs ────────────────────────────────────────────────────
output acrLoginServer string = acr.outputs.loginServer
output kvUri string = keyVault.outputs.uri
output frontendFqdn string = frontend.outputs.fqdn
output authApiFqdn string = authApi.outputs.fqdn
output helloWorldFqdn string = helloWorld.outputs.fqdn
output helloWorldRestrictedFqdn string = helloWorldRestricted.outputs.fqdn
output mcpServerFqdn string = mcpServer.outputs.fqdn
output environmentDomain string = cae.outputs.defaultDomain
