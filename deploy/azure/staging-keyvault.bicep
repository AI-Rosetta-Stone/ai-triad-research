// Staging-only Key Vault (t/92, PI decisions 2026-11-25; TL p/12#225, p/12#227; Security t/626).
// Deployed by its OWN dispatch-only workflow (.github/workflows/staging-keyvault.yml), never by the
// prod template, so applying it never reconciles prod. Same precedent as staging-data-account.bicep.
//
// Why: staging's identity held Key Vault Secrets User on the SHARED vault, so it could read prod's
// GitHub App private key and mint tokens as the prod data App. Staging moves to this vault; its role
// on the shared vault is removed in a later step (t/92 change B), after staging is verified here.
//
// Contents, exactly: this vault, its audit diagnostics, and ONE role assignment (staging's identity,
// Key Vault Secrets Officer, on THIS vault only -- PI yes, t/92#11; users re-enter saved keys).
// The staging App key (github-app-private-key-staging) is put here by the PI, never by this template
// or by DevOps (t/92#20).
//
// Name kv-ait-stg-kvwl3nywge4iw: 24 chars (the Key Vault maximum), available, checked 2026-11-25.

targetScope = 'resourceGroup'

@description('Staging Key Vault name (globally unique, 3-24 chars).')
param vaultName string = 'kv-ait-stg-kvwl3nywge4iw'
@description('The staging container app whose system-assigned identity gets Secrets Officer on this vault.')
param stagingAppName string = 'taxonomy-editor-staging'
@description('Log Analytics workspace that receives the vault audit events (the same one the shared vault uses).')
param logAnalyticsName string = 'log-aitriad-kvwl3nywge4iw'
param location string = resourceGroup().location
param tags object = {}

resource stagingApp 'Microsoft.App/containerApps@2025-01-01' existing = {
  name: stagingAppName
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource stagingKeyVault 'Microsoft.KeyVault/vaults@2026-02-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      // Same as the shared vault: consumption-tier ACA uses unpredictable SNAT IPs that can't be
      // allowlisted, and ACA isn't a Key Vault trusted service. RBAC is the control.
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Audit events (secret reads, writes, deletes) to Log Analytics, as for the shared vault. This is how
// change A is verified: staging's SecretGet calls appear here and stop on the shared vault.
resource stagingKvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: stagingKeyVault
  name: 'kv-audit-logs'
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
        retentionPolicy: { enabled: false, days: 0 }
      }
    ]
  }
}

var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource stagingKvOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: stagingKeyVault
  name: guid(stagingKeyVault.id, stagingApp.id, kvSecretsOfficerRoleId)
  properties: {
    principalId: stagingApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
  }
}

output vaultUri string = stagingKeyVault.properties.vaultUri
