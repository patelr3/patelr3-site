// Azure Storage Account with Azure Files share for persistent PostgreSQL data
param name string
param location string
param tags object = {}

@description('Name of the Azure Files share')
param shareName string = 'postgres-data'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  name: 'default'
  parent: storageAccount
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  name: shareName
  parent: fileService
  properties: {
    shareQuota: 10
    enabledProtocols: 'SMB'
  }
}

output storageAccountName string = storageAccount.name
@secure()
output storageAccountKey string = storageAccount.listKeys().keys[0].value
output shareName string = share.name
