# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TaxEditorBlob {
    <#
    .SYNOPSIS
        Lists blobs in the taxonomy editor storage account.
    .DESCRIPTION
        Queries Azure Blob Storage for blobs in user content containers.
        With -Deleted, shows only soft-deleted blobs available for recovery.
        Requires az CLI logged in with storage account access.
    .PARAMETER StorageAccount
        Storage account name. Default: auto-detected from resource group.
    .PARAMETER Container
        Filter by container name (e.g., 'user-content', 'community', 'analytics').
    .PARAMETER Deleted
        Show only soft-deleted blobs available for recovery.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .EXAMPLE
        Get-TaxEditorBlob
    .EXAMPLE
        Get-TaxEditorBlob -Container 'user-content' -Deleted
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$StorageAccount,

        [Parameter()]
        [string]$Container,

        [Parameter()]
        [switch]$Deleted,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Get-TaxEditorBlob'

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'List storage blobs' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'List storage blobs' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Resolve storage account ──────────────────────────────────────────
    if (-not $StorageAccount) {
        $AccountListJson = & az storage account list -g $ResourceGroup --query "[?starts_with(name,'staitriad')].name" -o json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $AccountListJson) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Resolve storage account' `
                -Problem "No storage accounts found in resource group '$ResourceGroup'" `
                -Location $CallerName `
                -NextSteps @('Pass -StorageAccount explicitly',
                             "Check resource group: az storage account list -g $ResourceGroup"))
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

    # ── Determine containers to query ────────────────────────────────────
    $Containers = @()
    if ($Container) {
        $Containers = @($Container)
    }
    else {
        $ContainerListJson = & az storage container list --account-name $StorageAccount --auth-mode login --query "[].name" -o json 2>$null
        if ($LASTEXITCODE -eq 0 -and $ContainerListJson) {
            $Containers = @($ContainerListJson | ConvertFrom-Json)
        }
        if (@($Containers).Count -eq 0) {
            $Containers = @('user-content', 'community', 'analytics')
        }
    }

    # ── Query blobs ──────────────────────────────────────────────────────
    foreach ($ContainerName in $Containers) {
        $AzArgs = @(
            'storage', 'blob', 'list'
            '--account-name', $StorageAccount
            '--container-name', $ContainerName
            '--auth-mode', 'login'
            '--output', 'json'
        )

        if ($Deleted) {
            $AzArgs += '--include'
            $AzArgs += 'd'
        }

        $BlobJson = & az @AzArgs 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $BlobJson) {
            Write-Verbose "No blobs or access denied for container '$ContainerName'."
            continue
        }

        $Blobs = $BlobJson | ConvertFrom-Json

        foreach ($Blob in $Blobs) {
            $IsDeleted = $false
            $DeletedAt = $null
            if ($Blob.PSObject.Properties['deleted']) {
                $IsDeleted = [bool]$Blob.deleted
            }
            if ($Blob.PSObject.Properties['properties'] -and
                $Blob.properties.PSObject.Properties['deletedTime']) {
                $RawVal = $Blob.properties.deletedTime
                $DeletedAt = if ($RawVal -is [datetime]) { $RawVal.ToString('o') } else { [string]$RawVal }
            }

            if ($Deleted -and -not $IsDeleted) { continue }

            $Size = 0
            $LastModified = ''
            if ($Blob.PSObject.Properties['properties']) {
                if ($Blob.properties.PSObject.Properties['contentLength']) {
                    $Size = [long]$Blob.properties.contentLength
                }
                if ($Blob.properties.PSObject.Properties['lastModified']) {
                    $LastModified = $Blob.properties.lastModified
                }
            }

            $Obj = [BlobInfo]::new()
            $Obj.Name         = $Blob.name
            $Obj.Container    = $ContainerName
            $Obj.Size         = $Size
            $Obj.LastModified = $LastModified
            $Obj.Deleted      = $IsDeleted
            $Obj.DeletedAt    = $DeletedAt
            $Obj
        }
    }
}
