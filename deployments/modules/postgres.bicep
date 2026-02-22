// Postgres Container App (uses Docker Hub image directly)
param name string
param location string
param tags object = {}
param envId string
param postgresUser string
@secure()
param postgresPassword string
param postgresDb string

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: envId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 5432
        transport: 'tcp'
      }
      secrets: [
        { name: 'postgres-password', value: postgresPassword }
      ]
    }
    template: {
      containers: [
        {
          name: 'postgres'
          image: 'docker.io/library/postgres:16-alpine'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'POSTGRES_USER', value: postgresUser }
            { name: 'POSTGRES_PASSWORD', secretRef: 'postgres-password' }
            { name: 'POSTGRES_DB', value: postgresDb }
            { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output name string = app.name
