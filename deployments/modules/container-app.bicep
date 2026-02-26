// Reusable Container App module
param name string
param location string
param tags object = {}
param envId string
param acrLoginServer string
param acrName string
param imageName string
param imageTag string = 'latest'
param targetPort int
param external bool = false
param env array = []
param secrets array = []
param minReplicas int = 0
param maxReplicas int = 1
param cpu string = '0.25'
param memory string = '0.5Gi'
param customDomains array = []
param enableSystemIdentity bool = false
param userAssignedIdentityId string = ''

var hasSystem = enableSystemIdentity
var hasUser = !empty(userAssignedIdentityId)
var identityType = hasSystem && hasUser ? 'SystemAssigned,UserAssigned' : hasSystem ? 'SystemAssigned' : hasUser ? 'UserAssigned' : 'None'
var userIdentities = hasUser ? { '${userAssignedIdentityId}': {} } : {}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: identityType == 'None' ? { type: 'None' } : identityType == 'SystemAssigned' ? { type: 'SystemAssigned' } : {
    type: identityType
    userAssignedIdentities: userIdentities
  }
  properties: {
    managedEnvironmentId: envId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: external
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        customDomains: customDomains
      }
      registries: [
        {
          server: acrLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: concat([
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ], secrets)
    }
    template: {
      containers: [
        {
          name: name
          image: '${acrLoginServer}/${imageName}:${imageTag}'
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: env
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output name string = app.name
output principalId string = enableSystemIdentity ? app.identity.principalId : ''
