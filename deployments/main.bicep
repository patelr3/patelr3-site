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

// Secrets – passed at deploy time (from Key Vault, .env, or CI secrets)
@secure()
param googleClientId string
@secure()
param googleClientSecret string
@secure()
param jwtSecret string
@secure()
param postgresPassword string
@secure()
param financeApiKey string

@description('Azure AI Foundry project endpoint (set after foundry.bicep deployment)')
param foundryProjectEndpoint string = ''
@description('Azure AI Foundry agent ID (set after agent registration)')
param foundryAgentId string = ''

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
    env: [
      { name: 'GOOGLE_CLIENT_ID', secretRef: 'google-client-id' }
      { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-client-secret' }
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'DATABASE_URL', secretRef: 'database-url' }
      { name: 'FRONTEND_URL', value: frontendUrl }
      { name: 'AUTH_API_URL', value: 'https://${projectName}-auth-api.${cae.outputs.defaultDomain}' }
      { name: 'FINANCE_API_URL', value: 'https://finance-api.${financeCaeDomain}' }
      { name: 'FINANCE_API_KEY', secretRef: 'finance-api-key' }
      { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
      { name: 'FOUNDRY_AGENT_ID', value: foundryAgentId }
    ]
    secrets: [
      { name: 'google-client-id', value: googleClientId }
      { name: 'google-client-secret', value: googleClientSecret }
      { name: 'jwt-secret', value: jwtSecret }
      { name: 'database-url', value: 'postgresql://${postgresUser}:${postgresPassword}@${projectName}-postgres:5432/${postgresDb}' }
      { name: 'finance-api-key', value: financeApiKey }
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
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FRONTEND_URL', value: frontendUrl }
    ]
    secrets: [
      { name: 'jwt-secret', value: jwtSecret }
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
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FRONTEND_URL', value: frontendUrl }
    ]
    secrets: [
      { name: 'jwt-secret', value: jwtSecret }
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
    env: [
      { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
      { name: 'FINANCE_API_URL', value: 'https://finance-api.${financeCaeDomain}' }
      { name: 'FINANCE_API_KEY', secretRef: 'finance-api-key' }
    ]
    secrets: [
      { name: 'jwt-secret', value: jwtSecret }
      { name: 'finance-api-key', value: financeApiKey }
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
