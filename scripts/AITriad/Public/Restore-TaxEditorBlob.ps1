# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Restore-TaxEditorBlob {
    <#
    .SYNOPSIS
        Undeletes a soft-deleted blob from the taxonomy editor storage.
    .DESCRIPTION
        Restores a specific soft-deleted blob in Azure Blob Storage.
        Requires Azure Blob soft-delete to be enabled (30-day retention).
        Supports -WhatIf/-Confirm.
    .PARAMETER Container
        Container name where the blob resides (e.g., 'user-content').
    .PARAMETER Path
        Blob path/name to restore.
    .PARAMETER StorageAccount
        Storage account name. Default: auto-detected from resource group.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .EXAMPLE
        Restore-TaxEditorBlob -Container 'user-content' -Path 'debates/abc123.json'
    .EXAMPLE
        Get-TaxEditorBlob -Deleted | Select-Object -First 1 | Restore-TaxEditorBlob
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [string]$Container,

        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [Alias('Name')]
        [string]$Path,

        [Parameter()]
        [string]$StorageAccount,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad'
    )

    begin {
        Set-StrictMode -Version Latest
        $CallerName = 'Restore-TaxEditorBlob'

        # ── Validate az CLI ──────────────────────────────────────────────
        $AzCmd = Get-Command az -ErrorAction SilentlyContinue
        if (-not $AzCmd) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Restore soft-deleted blob' `
                -Problem 'Azure CLI (az) not found on PATH' `
                -Location $CallerName `
                -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
        }

        $AccountJson = & az account show --output json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Restore soft-deleted blob' `
                -Problem 'Azure CLI is not logged in' `
                -Location $CallerName `
                -NextSteps @('Run: az login', 'Verify subscription: az account show'))
        }

        # ── Resolve storage account ──────────────────────────────────────
        if (-not $StorageAccount) {
            $AccountListJson = & az storage account list -g $ResourceGroup --query "[?starts_with(name,'staitriad')].name" -o json 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $AccountListJson) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Resolve storage account' `
                    -Problem "No storage accounts found in resource group '$ResourceGroup'" `
                    -Location $CallerName `
                    -NextSteps @('Pass -StorageAccount explicitly'))
            }
            $Accounts = $AccountListJson | ConvertFrom-Json
            if (@($Accounts).Count -eq 0) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Resolve storage account' `
                    -Problem "No 'staitriad*' storage accounts found in '$ResourceGroup'" `
                    -Location $CallerName `
                    -NextSteps @('Pass -StorageAccount explicitly'))
            }
            $StorageAccount = $Accounts[0]
        }

        # ── Check soft-delete is enabled ─────────────────────────────────
        $PropsJson = & az storage account blob-service-properties show --account-name $StorageAccount --query "deleteRetentionPolicy" -o json 2>$null
        if ($LASTEXITCODE -eq 0 -and $PropsJson) {
            $Props = $PropsJson | ConvertFrom-Json
            if ($Props.PSObject.Properties['enabled'] -and -not $Props.enabled) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Restore soft-deleted blob' `
                    -Problem "Blob soft-delete is not enabled on storage account '$StorageAccount'" `
                    -Location $CallerName `
                    -NextSteps @('Enable soft-delete in main.bicep (deleteRetentionPolicy.enabled = true)',
                                 'Redeploy infrastructure'))
            }
        }
    }

    process {
        # ── WhatIf / Confirm gate ────────────────────────────────────────
        if (-not $PSCmdlet.ShouldProcess("$Container/$Path", "Undelete soft-deleted blob on '$StorageAccount'")) {
            return
        }

        # ── Restore the blob ─────────────────────────────────────────────
        Write-Verbose "Restoring blob '$Path' in container '$Container'..."
        $RestoreOutput = & az storage blob undelete `
            --account-name $StorageAccount `
            --container-name $Container `
            --name $Path `
            --auth-mode login `
            --output json 2>$null

        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Restore blob '$Path'" `
                -Problem "az storage blob undelete failed (exit code $LASTEXITCODE)" `
                -Location $CallerName `
                -NextSteps @("Verify blob exists and is soft-deleted: Get-TaxEditorBlob -Container '$Container' -Deleted",
                             "Check storage account access permissions"))
        }

        Write-Verbose "Restored '$Container/$Path' successfully."

        [PSCustomObject]@{
            Action         = 'BlobRestore'
            Container      = $Container
            Path           = $Path
            StorageAccount = $StorageAccount
            Timestamp      = (Get-Date).ToString('o')
        }
    }
}
