# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DebateSession {
    <#
    .SYNOPSIS
        Tests whether a debate blob exists in Azure Blob Storage.
    .DESCRIPTION
        Checks Azure Blob Storage for a debate JSON at
        users/{userId}/debates/debate-{debateId}.json in the 'user-content' container.

        When -UserId is supplied the check is a direct blob show (fast).
        Without -UserId the command scans all user prefixes and returns the first match.

        Returns a result object regardless of existence; only unrecoverable errors throw.
        Requires az CLI logged in with storage account access.
    .PARAMETER DebateId
        The debate UUID (with or without the 'debate-' prefix, e.g. 'd1c7f7b6-...' or
        'debate-d1c7f7b6-...').
    .PARAMETER UserId
        Azure AD user GUID that owns the debate. When omitted the command scans all
        'users/' prefixes — slower and requires list permissions.
    .PARAMETER StorageAccount
        Storage account name. Default: auto-detected from resource group.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .OUTPUTS
        PSCustomObject with: Exists, StoragePath, OwnerId, SizeBytes.
    .EXAMPLE
        Test-DebateSession -DebateId d1c7f7b6-a170-45bb-9f14-37baf9a8ea2b -UserId abc-123
    .EXAMPLE
        Test-DebateSession d1c7f7b6-a170-45bb-9f14-37baf9a8ea2b
    .LINK
        Show-AITriadHelp
    .LINK
        Get-DebateSessionState
    .LINK
        Get-TaxEditorBlob
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateNotNullOrEmpty()]
        [string]$DebateId,

        [Parameter()]
        [string]$UserId,

        [Parameter()]
        [string]$StorageAccount,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Test-DebateSession'
    $Container  = 'user-content'

    # ── Validate az CLI ──────────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Check debate blob existence' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Check debate blob existence' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Resolve storage account ──────────────────────────────────────────────
    if (-not $StorageAccount) {
        $AccountListJson = & az storage account list -g $ResourceGroup `
            --query "[?starts_with(name,'staitriad')].name" -o json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $AccountListJson) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal    'Resolve storage account' `
                -Problem "No storage accounts found in resource group '$ResourceGroup'" `
                -Location $CallerName `
                -NextSteps @('Pass -StorageAccount explicitly',
                             "Check: az storage account list -g $ResourceGroup"))
        }
        $Accounts = @($AccountListJson | ConvertFrom-Json)
        if ($Accounts.Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal    'Resolve storage account' `
                -Problem "No 'staitriad*' storage accounts found in '$ResourceGroup'" `
                -Location $CallerName `
                -NextSteps @('Pass -StorageAccount explicitly'))
        }
        $StorageAccount = [string]$Accounts[0]
    }

    # Strip optional 'debate-' prefix
    $CleanId = $DebateId -replace '^debate-', ''

    # ── Direct lookup (UserId known) ─────────────────────────────────────────
    if ($UserId) {
        $BlobName  = "users/$UserId/debates/debate-$CleanId.json"
        $ShowJson  = & az storage blob show `
            --account-name  $StorageAccount `
            --container-name $Container `
            --name          $BlobName `
            --auth-mode     login `
            --output        json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $ShowJson) {
            return [PSCustomObject]@{ Exists = $false; StoragePath = $null; OwnerId = $null; SizeBytes = 0L }
        }
        $Blob      = $ShowJson | ConvertFrom-Json
        $SizeBytes = 0L
        if ($Blob.PSObject.Properties['properties'] -and
            $Blob.properties.PSObject.Properties['contentLength']) {
            $SizeBytes = [long]$Blob.properties.contentLength
        }
        return [PSCustomObject]@{
            Exists      = $true
            StoragePath = $BlobName
            OwnerId     = $UserId
            SizeBytes   = $SizeBytes
        }
    }

    # ── Scan (no UserId) ─────────────────────────────────────────────────────
    $ListJson = & az storage blob list `
        --account-name   $StorageAccount `
        --container-name $Container `
        --prefix         'users/' `
        --auth-mode      login `
        --output         json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $ListJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    "Scan for debate '$CleanId' across all users" `
            -Problem "Failed to list blobs in container '$Container'" `
            -Location $CallerName `
            -NextSteps @(
                "Verify storage access: az storage blob list --account-name $StorageAccount --container-name $Container --auth-mode login",
                'Pass -UserId to use a targeted blob show instead'))
    }

    $EscapedId = [regex]::Escape($CleanId)
    $Pattern   = "^users/([^/]+)/debates/debate-$EscapedId\.json$"
    $Match     = @($ListJson | ConvertFrom-Json) | Where-Object {
        $_.PSObject.Properties['name'] -and $_.name -match $Pattern
    } | Select-Object -First 1

    if (-not $Match) {
        return [PSCustomObject]@{ Exists = $false; StoragePath = $null; OwnerId = $null; SizeBytes = 0L }
    }

    $ExtractedOwnerId = $null
    if ($Match.name -match '^users/([^/]+)/') { $ExtractedOwnerId = $Matches[1] }

    $SizeBytes = 0L
    if ($Match.PSObject.Properties['properties'] -and
        $Match.properties.PSObject.Properties['contentLength']) {
        $SizeBytes = [long]$Match.properties.contentLength
    }

    return [PSCustomObject]@{
        Exists      = $true
        StoragePath = $Match.name
        OwnerId     = $ExtractedOwnerId
        SizeBytes   = $SizeBytes
    }
}
