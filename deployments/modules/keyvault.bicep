// Azure Key Vault
param name string
param location string
param tags object = {}
param principalId string = ''

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
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

// Grant the deployer Key Vault Secrets Officer role
resource secretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(kv.id, principalId, '00482a5a-887f-4fb3-b363-3b7fe8e74483')
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '00482a5a-887f-4fb3-b363-3b7fe8e74483')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output id string = kv.id
output name string = kv.name
output uri string = kv.properties.vaultUri
