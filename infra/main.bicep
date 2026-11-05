// Agent-Ready Check on Azure: Static Web Apps (site + managed Azure Functions API), Blob Storage for reports,
// and an optional browser runner on Container Apps (scales to zero).
//
//   az deployment group create -g <rg> -f infra/main.bicep -p customDomain=agent.isainative.dev ...
// infra/deploy.sh and infra/deploy.ps1 wrap this (plus the one-time GitHub OIDC setup); docs/PUBLISHING.md has
// the click-by-click version and the costs.
targetScope = 'resourceGroup'

@description('Name prefix for the resources.')
@minLength(3)
@maxLength(24)
param appName string = 'agent-ready-check'

@description('Region for the storage account and the browser runner.')
param location string = resourceGroup().location

@description('Region of the Static Web App resource. The site itself is served from the global edge; this only places the managed functions and the metadata.')
@allowed([
  'westeurope'
  'eastus2'
  'centralus'
  'westus2'
  'eastasia'
])
param swaLocation string = 'westeurope'

@description('Free is enough: managed functions, 2 custom domains, 100 GB bandwidth. Standard (about 9 USD per app per month) is only needed for a linked Function App, private endpoints or the SLA.')
@allowed([
  'Free'
  'Standard'
])
param swaSku string = 'Free'

@description('Custom domain, for example agent.isainative.dev. Bind it only after its CNAME points at the default host name (the deploy scripts check that first).')
param customDomain string = ''

@description('Public origin used in links, robots.txt, llms.txt, the API catalog and the MCP card. Empty means the custom domain when set, else the default host name.')
param baseUrl string = ''

@description('Deploy the browser runner (axe rules, accessibility tree, WebMCP, CLS run in Chromium there).')
param deployBrowserRunner bool = true

@description('Browser runner image, for example ghcr.io/<owner>/agent-ready-check-runner:latest (public package, built by the deploy workflow).')
param runnerImage string = ''

@description('Bearer token shared by the function and the runner. A new random value on every deployment unless given.')
@secure()
param runnerToken string = newGuid()

@description('vCPU for the runner (Container Apps consumption pairs 1.0 with 2Gi).')
param runnerCpu string = '1.0'

@description('Memory for the runner.')
param runnerMemory string = '2Gi'

@description('Seconds the runner stays up after its last request before it scales to zero.')
@minValue(0)
param runnerCooldownSeconds int = 120

@description('Scans per client per window (per function instance).')
param rateLimit int = 10

@description('Rate-limit window in seconds.')
param rateWindowSeconds int = 600

@description('Object id of the GitHub Actions service principal (Entra app). When set, it gets Contributor on this resource group so the workflows can deploy. Needs Owner or User Access Administrator to assign.')
param deployerPrincipalId string = ''

var suffix = uniqueString(resourceGroup().id, appName)
var storageName = toLower('arc${take(suffix, 13)}')
var runnerOn = deployBrowserRunner && !empty(runnerImage)
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource reportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'reports'
  properties: {
    publicAccess: 'None'
  }
}

// Reports are kept 30 days: the lifecycle rule deletes blobs 30 days after their last write (no cleanup job).
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-reports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'reports/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 30
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: appName
  location: swaLocation
  sku: {
    name: swaSku
    tier: swaSku
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

resource caEnv 'Microsoft.App/managedEnvironments@2025-01-01' = if (runnerOn) {
  name: '${appName}-env'
  location: location
  properties: {
    zoneRedundant: false
  }
}

resource runner 'Microsoft.App/containerApps@2025-01-01' = if (runnerOn) {
  name: '${take(appName, 25)}-runner'
  location: location
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'runner-token'
          value: runnerToken
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          resources: {
            cpu: json(runnerCpu)
            memory: runnerMemory
          }
          env: [
            {
              name: 'RUNNER_TOKEN'
              secretRef: 'runner-token'
            }
            {
              name: 'RUNNER_JOB_TIMEOUT_MS'
              value: '30000'
            }
            {
              // Changes whenever the token changes, so the app gets a new revision and running replicas never keep
              // an old token (a secret update alone does not restart them). Not the token itself.
              name: 'RUNNER_TOKEN_VERSION'
              value: uniqueString(runnerToken)
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        cooldownPeriod: runnerCooldownSeconds
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '2'
              }
            }
          }
        ]
      }
    }
  }
}

var publicOrigin = !empty(baseUrl) ? baseUrl : (!empty(customDomain) ? 'https://${customDomain}' : 'https://${swa.properties.defaultHostname}')
var runnerUrl = runnerOn ? 'https://${runner!.properties.configuration.ingress.fqdn}/collect' : ''

resource appSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    BASE_URL: publicOrigin
    REPORTS_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    REPORTS_CONTAINER: reportsContainer.name
    BROWSER_RUNNER_URL: runnerUrl
    RUNNER_TOKEN: runnerOn ? runnerToken : ''
    RATE_LIMIT: string(rateLimit)
    RATE_WINDOW: string(rateWindowSeconds)
    SCAN_TIMEOUT_MS: '30000'
  }
}

// Bind the custom domain. Static Web Apps validates a subdomain by its CNAME to the default host name, so the
// DNS record must exist before this runs.
resource domain 'Microsoft.Web/staticSites/customDomains@2024-04-01' = if (!empty(customDomain)) {
  parent: swa
  name: empty(customDomain) ? 'unused.invalid' : customDomain
  properties: {
    validationMethod: 'cname-delegation'
  }
  dependsOn: [
    appSettings
  ]
}

resource deployerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  name: guid(resourceGroup().id, deployerPrincipalId, contributorRoleId)
  properties: {
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

output staticWebAppName string = swa.name
output defaultHostname string = swa.properties.defaultHostname
output publicOrigin string = publicOrigin
output storageAccountName string = storage.name
output runnerAppName string = runnerOn ? runner.name : ''
output runnerFqdn string = runnerOn ? runner!.properties.configuration.ingress.fqdn : ''
output dnsRecord string = empty(customDomain) ? '' : 'CNAME ${customDomain} -> ${swa.properties.defaultHostname}'
