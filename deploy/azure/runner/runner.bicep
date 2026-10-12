// Ephemeral GitHub Actions Runner — Azure Function + ACI
//
// An Azure Function receives GitHub workflow_job webhooks and creates
// short-lived ACI container groups that register as --ephemeral runners.
// After the job completes, the webhook deletes the container group.
// Cost: ~$0 idle, ~$0.05/build.
//
// Security (t/707, t/710):
// - Runner secrets (PAT, webhook HMAC) stored in Key Vault, referenced via KV URIs
// - Function App has custom ACI Operator role (not Contributor on RG)
// - Storage uses managed-identity connection for runtime (AzureWebJobsStorage)
// - Runner image pinned to digest (not :latest)

@description('Azure region')
param location string = resourceGroup().location

@description('Unique suffix for globally unique names')
param uniqueSuffix string = uniqueString(resourceGroup().id)

@description('GitHub PAT with admin:org or repo scope for runner registration tokens')
@secure()
param githubRunnerPat string = ''

@description('HMAC secret for verifying GitHub webhook signatures')
@secure()
param githubRunnerWebhookSecret string = ''

@description('GitHub repository owner')
param githubOwner string = 'AI-Rosetta-Stone'

@description('GitHub repository name')
param githubRepo string = 'ai-triad-research'

@description('Runner container image — pinned to digest, never use :latest')
param runnerImage string = 'myoung34/github-runner@sha256:0d9b486199e5e9d6eab1d066f20a0f76afb410a6d6d18f4e5883fa2167b68c41'

@description('Runner CPU cores')
param runnerCpu string = '2'

@description('Runner memory in GB')
param runnerMemory string = '4'

@description('Runner labels (comma-separated)')
param runnerLabels string = 'self-hosted,aci'

@description('Enable the ephemeral runner infrastructure')
param enabled bool = false

@description('Log Analytics workspace ID for diagnostics')
param logAnalyticsWorkspaceId string = ''

@description('Name of the shared Key Vault for storing runner secrets')
param keyVaultName string

// ── Resource Tags ──
var tags = {
  project: 'ai-triad-research'
  component: 'ephemeral-runner'
  'managed-by': 'bicep'
}

// ── Key Vault (reference existing shared vault from main.bicep) ──
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// ── Key Vault secrets for runner credentials ──
resource patSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enabled) {
  parent: keyVault
  name: 'github-runner-pat'
  properties: {
    value: !empty(githubRunnerPat) ? githubRunnerPat : 'not-configured'
  }
}

resource webhookSecretKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enabled) {
  parent: keyVault
  name: 'github-runner-webhook-secret'
  properties: {
    value: !empty(githubRunnerWebhookSecret) ? githubRunnerWebhookSecret : 'not-configured'
  }
}

// ── Storage Account (required by Azure Functions) ──
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (enabled) {
  name: 'strunner${uniqueSuffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // allowSharedKeyAccess left enabled — Consumption plan content share requires it
  }
}

// ── App Service Plan (Consumption / Serverless) ──
resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = if (enabled) {
  name: 'plan-runner-${uniqueSuffix}'
  location: location
  tags: tags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true // Linux
  }
}

// ── Function App ──
resource functionApp 'Microsoft.Web/sites@2023-12-01' = if (enabled) {
  name: 'func-runner-${uniqueSuffix}'
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      appSettings: [
        // Managed-identity storage for runtime (C3) — replaces connection string
        { name: 'AzureWebJobsStorage__accountName', value: storageAccount.name }
        // Content share still needs connection string (Consumption plan limitation)
        { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}' }
        { name: 'WEBSITE_CONTENTSHARE', value: 'runner-func-${uniqueSuffix}' }
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
        { name: 'RUNNER_RESOURCE_GROUP', value: resourceGroup().name }
        { name: 'RUNNER_LOCATION', value: location }
        { name: 'RUNNER_IMAGE', value: runnerImage }
        { name: 'RUNNER_CPU', value: runnerCpu }
        { name: 'RUNNER_MEMORY', value: runnerMemory }
        { name: 'RUNNER_LABELS', value: runnerLabels }
        { name: 'GITHUB_OWNER', value: githubOwner }
        { name: 'GITHUB_REPO', value: githubRepo }
        // Secrets via Key Vault references (C2) — no plain-text credentials in app settings
        { name: 'GITHUB_RUNNER_PAT', value: '@Microsoft.KeyVault(SecretUri=${patSecret.properties.secretUri})' }
        { name: 'GITHUB_RUNNER_WEBHOOK_SECRET', value: '@Microsoft.KeyVault(SecretUri=${webhookSecretKv.properties.secretUri})' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: !empty(logAnalyticsWorkspaceId) ? '' : '' }
      ]
    }
  }
}

// ── Custom Role: ACI Operator (C1) ──
// Replaces the over-broad Contributor role that granted full RG access.
// Scoped to ACI container group operations only.

resource aciOperatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (enabled) {
  name: guid(resourceGroup().id, 'aci-operator')
  properties: {
    roleName: 'ACI Operator - ${resourceGroup().name}'
    description: 'Create, read, and delete ACI container groups for ephemeral runners'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: [
          'Microsoft.ContainerInstance/containerGroups/read'
          'Microsoft.ContainerInstance/containerGroups/write'
          'Microsoft.ContainerInstance/containerGroups/delete'
          'Microsoft.ContainerInstance/containerGroups/start/action'
          'Microsoft.ContainerInstance/containerGroups/stop/action'
          'Microsoft.ContainerInstance/containerGroups/restart/action'
        ]
        notActions: []
      }
    ]
  }
}

resource aciRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enabled) {
  name: guid(resourceGroup().id, functionApp.id, 'aci-operator')
  properties: {
    roleDefinitionId: aciOperatorRole.id
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── RBAC: Function → Key Vault Secrets User (read KV references) ──
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enabled) {
  scope: keyVault
  name: guid(keyVault.id, functionApp.id, kvSecretsUserRoleId)
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

// ── RBAC: Function → Storage (managed-identity access for runtime) ──
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enabled) {
  scope: storageAccount
  name: guid(storageAccount.id, functionApp.id, storageBlobDataContributorRoleId)
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
  }
}

resource storageQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enabled) {
  scope: storageAccount
  name: guid(storageAccount.id, functionApp.id, storageQueueDataContributorRoleId)
  properties: {
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
  }
}

// ── Outputs ──
output functionAppName string = enabled ? functionApp.name : ''
output functionAppUrl string = enabled ? 'https://${functionApp.properties.defaultHostName}' : ''
output webhookUrl string = enabled ? 'https://${functionApp.properties.defaultHostName}/api/github-webhook' : ''
