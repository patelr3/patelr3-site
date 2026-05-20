// Container Apps Environment (shared by all apps)
param name string
param location string
param tags object = {}

@description('Azure Storage account name for linking Azure Files to the environment')
param storageAccountName string = ''
@secure()
@description('Azure Storage account key for the linked Azure Files share')
param storageAccountKey string = ''
@description('Azure Files share name to link for persistent postgres data')
param storageShareName string = ''
@description('Logical storage name used to reference the linked share in container volume configs')
param storageName string = 'postgres-data'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Link the Azure Files share to the environment so container apps can mount it as a volume.
// Only created when a storage account is provided.
resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (!empty(storageAccountName)) {
  name: storageName
  parent: env
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storageAccountKey
      shareName: storageShareName
      accessMode: 'ReadWriteMany'
    }
  }
}

output id string = env.id
output name string = env.name
output defaultDomain string = env.properties.defaultDomain
output storageName string = storageName
