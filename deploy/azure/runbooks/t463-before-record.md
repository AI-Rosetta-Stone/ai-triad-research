# t/463 BEFORE-RECORD for staitriadkvwl3nywge4iw (taken 2026-11-23T17:45Z, read-only, before any pause)

## Role assignments (principal id | role | scope), sorted
1e65a4d7-3a4c-4c4e-9e7c-4250bebb16d3 | Storage Blob Data Contributor | <sub>/resourcegroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
1e65a4d7-3a4c-4c4e-9e7c-4250bebb16d3 | Storage Blob Data Contributor | <sub>/resourcegroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/blobServices/default/containers/staging-analytics
1e65a4d7-3a4c-4c4e-9e7c-4250bebb16d3 | Storage Blob Data Contributor | <sub>/resourcegroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/blobServices/default/containers/staging-community
1e65a4d7-3a4c-4c4e-9e7c-4250bebb16d3 | Storage Blob Data Contributor | <sub>/resourcegroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/blobServices/default/containers/staging-user-content
de5fcc3d-4804-42c7-9569-0b0f59b0439e | Storage Blob Data Contributor | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
de5fcc3d-4804-42c7-9569-0b0f59b0439e | Storage File Data Privileged Reader | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
01784833-070f-4ff8-bf9f-9e52e947b9e5 | Storage Blob Data Contributor | <sub>/resourcegroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
5abf01bc-a673-4d31-851e-86607dae5f01 | Storage Account Backup Contributor | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
5abf01bc-a673-4d31-851e-86607dae5f01 | Storage Blob Data Reader | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw
5abf01bc-a673-4d31-851e-86607dae5f01 | Storage File Data SMB Share Contributor | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/fileServices/default/fileshares/taxonomy-data-staging
5abf01bc-a673-4d31-851e-86607dae5f01 | Storage File Data SMB Share Reader | <sub>/resourceGroups/ai-triad/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw/fileServices/default/shares/taxonomy-data-staging

## Keys and network (az storage account show)
- allowSharedKeyAccess: returned null by the read (re-read and confirm before the run)
- networkRuleSet.defaultAction: Allow
- networkRuleSet.bypass: Logging, Metrics, AzureServices
- minimumTlsVersion: TLS1_2; allowBlobPublicAccess: false

## Expected change (the only allowed difference after the run)
- Storage File Data SMB Share Reader on the share taxonomy-data-staging, principal 5abf01bc-a673-4d31-851e-86607dae5f01, created 2026-11-23 15:43 UTC via ARM roleAssignments PUT (TL, t/463#103).
