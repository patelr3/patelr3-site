// Azure AI Foundry infrastructure: Hub, Project, AI Services, model deployments.
// Deployed separately from the main site infra since it lives in its own resource group.
//
// Usage:
//   az deployment group create \
//     --resource-group patelr3-ai-rg \
//     --template-file deployments/foundry.bicep \
//     --parameters deployments/foundry-parameters.json
targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────
@description('Azure region')
param location string = 'eastus2'

@description('Project prefix')
param projectName string = 'patelr3'

@description('Model deployments to create')
param modelDeployments array = [
  {
    name: 'gpt-4o'
    model: 'gpt-4o'
    format: 'OpenAI'
    version: '2024-08-06'
    skuName: 'GlobalStandard'
    capacity: 10
  }
]

// ── Variables ──────────────────────────────────────────────────
var tags = {
  project: projectName
  managedBy: 'bicep'
}
var uniqueSuffix = uniqueString(resourceGroup().id, projectName)
var aiServicesName = '${projectName}-ai-${uniqueSuffix}'
var hubName = '${projectName}-ai-hub'
var projectResourceName = '${projectName}-ai-project'
var storageName = '${projectName}aist${uniqueSuffix}'
var kvName = '${projectName}aikv${uniqueSuffix}'

// ── Storage Account (required by AI Hub) ───────────────────────
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(storageName, 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// ── Key Vault (required by AI Hub) ─────────────────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take(kvName, 24)
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
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

// ── AI Foundry Hub ─────────────────────────────────────────────
resource aiHub 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: hubName
  location: location
  tags: tags
  kind: 'Hub'
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    friendlyName: '${projectName} AI Hub'
    storageAccount: storage.id
    keyVault: keyVault.id
    publicNetworkAccess: 'Enabled'
  }

  // Connect AI Services to the Hub
  resource aiServicesConnection 'connections@2024-10-01' = {
    name: '${aiServicesName}-connection'
    properties: {
      category: 'AIServices'
      target: aiServices.properties.endpoint
      authType: 'AAD'
      isSharedToAll: true
      metadata: {
        ApiType: 'Azure'
        ResourceId: aiServices.id
      }
    }
  }
}

// ── AI Foundry Project ─────────────────────────────────────────
resource aiProject 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: projectResourceName
  location: location
  tags: tags
  kind: 'Project'
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    friendlyName: 'SunnieAI'
    hubResourceId: aiHub.id
    publicNetworkAccess: 'Enabled'
  }
}

// ── Outputs ────────────────────────────────────────────────────
output aiServicesEndpoint string = aiServices.properties.endpoint
output aiServicesName string = aiServices.name
output hubName string = aiHub.name
output projectName string = aiProject.name
output projectId string = aiProject.id
output projectEndpoint string = 'https://${location}.api.azureml.ms/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.MachineLearningServices/workspaces/${aiProject.name}'
