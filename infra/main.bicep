// Azure infrastructure for Agent-Ready Check (https://github.com/vibeprogrammer/agent-ready-check).
//
//   - Azure Container Apps, consumption plan, scale to zero (min 0, max 2 replicas). The container is built from
//     the official Playwright image, so the browser checks (accessibility tree, axe, WebMCP, CLS) run too.
//   - Azure Container Registry, Basic: the image is built in the cloud with `az acr build` (no local Docker).
//     The app pulls it with a user-assigned managed identity (AcrPull), so no registry password exists anywhere.
//   - Storage account + Azure Files share mounted at /data: stored reports (kept 30 days) survive restarts and
//     scale-to-zero.
//   - Log Analytics with 30-day retention and a daily ingestion cap, for container logs.
//
// No secrets in this file: the storage key and the Log Analytics key are read with listKeys() at deployment time
// and go straight into the environment's configuration.
// Deployed by infra/deploy.sh or infra/deploy.ps1. Costs: DEPLOY.md.

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Base name for the resources (lowercase letters, digits and hyphens).')
@minLength(3)
@maxLength(20)
param appName string = 'agent-ready-check'

@description('Container image. Empty on the first deployment: a public placeholder runs until deploy.sh pushes the real image.')
param image string = ''

@description('Public origin of the service, for absolute links in llms.txt, the OpenAPI servers list and the MCP card. Empty: taken from each request.')
param baseUrl string = ''

@description('Scans per client per window.')
param rateLimit int = 10

@description('Rate-limit window in seconds.')
param rateWindowSeconds int = 600

@description('Maximum replicas (each one is 1 vCPU / 2 GiB while active).')
@minValue(1)
@maxValue(10)
param maxReplicas int = 2

@description('Log Analytics daily ingestion cap in GB (stops runaway log costs).')
param logDailyCapGb string = '0.5'

var suffix = uniqueString(resourceGroup().id)
var acrName = take('acr${replace(appName, '-', '')}${suffix}', 50)
var storageName = take('st${replace(appName, '-', '')}${suffix}', 24)
var shareName = 'reports'
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var useRealImage = !empty(image)
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var tags = { app: appName, source: 'https://github.com/vibeprogrammer/agent-ready-check' }

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json(logDailyCapGb) }
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}'
  location: location
  tags: tags
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    accessTier: 'Hot'
    shareQuota: 5
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: shareName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [ share ]
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: useRealImage ? 8080 : 80
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: acr.properties.loginServer, identity: identity.id }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: useRealImage ? image : placeholderImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'PORT', value: '8080' }
            { name: 'REPORTS_DIR', value: '/data' }
            { name: 'BROWSER', value: '1' }
            { name: 'TRUST_PROXY', value: '1' }
            { name: 'RATE_LIMIT', value: string(rateLimit) }
            { name: 'RATE_WINDOW', value: string(rateWindowSeconds) }
            { name: 'BASE_URL', value: baseUrl }
          ]
          volumeMounts: [ { volumeName: 'reports', mountPath: '/data' } ]
          probes: useRealImage ? [
            { type: 'Liveness', httpGet: { path: '/api/health', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/api/health', port: 8080 }, initialDelaySeconds: 2, periodSeconds: 10 }
          ] : []
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: maxReplicas
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '10' } } }
        ]
      }
      volumes: [
        { name: 'reports', storageType: 'AzureFile', storageName: envStorage.name }
      ]
    }
  }
  dependsOn: [ acrPull ]
}

output appName string = app.name
output fqdn string = app.properties.configuration.ingress.fqdn
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output environmentName string = env.name
output customDomainVerificationId string = env.properties.customDomainConfiguration.customDomainVerificationId
