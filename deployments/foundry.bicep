// Azure AI Foundry infrastructure: AI Services account, project, and model deployments.
// Uses the CognitiveServices resource provider (newer architecture).
// The AI Services account and project were initially created manually via the
// Azure AI Foundry portal; this Bicep manages them idempotently going forward.
//
// Usage:
//   az deployment group create \
//     --resource-group patelr3-ai-rg \
//     --template-file deployments/foundry.bicep \
//     --parameters deployments/foundry-parameters.json
targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────
@description('Azure region')
param location string = 'westus'

@description('AI Services account name')
param aiServicesName string = 'patelr3-openai-1'

@description('AI Foundry project name')
param projectName string = 'patelr3-prod-1'

@description('Model deployments to create')
param modelDeployments array = [
  {
    name: 'gpt-4o'
    model: 'gpt-4o'
    format: 'OpenAI'
    version: '2024-08-06'
    skuName: 'Standard'
    capacity: 10
  }
]

@description('Principal ID of auth-api managed identity (for RBAC grant)')
param authApiPrincipalId string = ''

// ── Variables ──────────────────────────────────────────────────
var tags = {
  project: 'patelr3'
  managedBy: 'bicep'
}

// ── AI Services (Azure OpenAI) ─────────────────────────────────
resource aiServices 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aiServicesName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: aiServicesName
    publicNetworkAccess: 'Enabled'
  }
}

// ── Model Deployments ──────────────────────────────────────────
@batchSize(1)
resource modelDeploy 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [
  for deployment in modelDeployments: {
    name: deployment.name
    parent: aiServices
    sku: {
      name: deployment.skuName
      capacity: deployment.capacity
    }
    properties: {
      model: {
        name: deployment.model
        format: deployment.format
        version: deployment.version
      }
      versionUpgradeOption: 'OnceCurrentVersionExpired'
    }
  }
]

// ── AI Foundry Project ─────────────────────────────────────────
resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  name: projectName
  parent: aiServices
  location: location
  tags: tags
  kind: 'AIServices'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'SunnieAI - Personal finance AI assistant'
  }
}

// ── RBAC: Cognitive Services User for auth-api ─────────────────
// Allows auth-api ACA to call the Foundry Agent API via managed identity.
// Cognitive Services User role ID: a97b65f3-24c7-4388-baec-2e87135dc908
resource authApiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(authApiPrincipalId)) {
  name: guid(aiServices.id, authApiPrincipalId, 'a97b65f3-24c7-4388-baec-2e87135dc908')
  scope: aiServices
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
    principalId: authApiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Outputs ────────────────────────────────────────────────────
output aiServicesEndpoint string = aiServices.properties.endpoint
output aiServicesName string = aiServices.name
output projectName string = aiProject.name
output projectEndpoint string = 'https://${aiServicesName}.services.ai.azure.com/api/projects/${projectName}'
