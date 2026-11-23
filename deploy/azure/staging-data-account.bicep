// Staging-only data account for the staging state share (t/463, PI option a; TL p/9#354).
// Deployed as its OWN staging deploy, BEFORE the prod template (which only references this account).
// Not part of the prod deploy. Shared-key access stays ON (the managed-env mount uses the account key).
// Identity: Entra Kerberos (AADKERB), on THIS account only. Consent owner: Jeffrey (TL, t/463).
//
// Name is staitriadstg19 (globally available, checked 2026-11-23 with az storage account check-name).

targetScope = 'resourceGroup'

@description('Staging data account name (globally unique).')
param accountName string = 'staitriadstg19'
param location string = resourceGroup().location
param tags object = {}

resource stagingDataAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      // Same as the prod template: consumption-tier ACA SNAT ranges cannot be allowlisted.
      defaultAction: 'Allow'
      bypass: 'AzureServices, Logging, Metrics'
    }
    azureFilesIdentityBasedAuthentication: {
      directoryServiceOptions: 'AADKERB'
    }
  }
}

resource stagingStateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  name: '${stagingDataAccount.name}/default/taxonomy-data-staging'
  properties: { shareQuota: 100 }
}

output accountId string = stagingDataAccount.id
