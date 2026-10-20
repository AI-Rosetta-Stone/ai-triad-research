# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-AnalyticsBlobHealth {
    <#
    .SYNOPSIS
        Verify the analytics blob container exists, is accessible, and has recent data.
    .DESCRIPTION
        Remote diagnostics for the community analytics pipeline. Analytics events are
        written by the taxonomy-editor server as daily NDJSON append blobs named
        `YYYY-MM-DD.ndjson` in the `analytics` container (analyticsBlob.ts). This
        cmdlet confirms the container is reachable, lists the recent daily blobs,
        counts the events they hold (one NDJSON line per event), and flags a stale
        pipeline when the most recent write is older than a configurable threshold.

        Would have confirmed the t/2699 root cause in seconds rather than requiring
        server log triage. Pairs with Test-TaxEditorHealth. Requires the az CLI
        logged in with data-plane access to the storage account (--auth-mode login).

        No AI calls are made — this is a purely offline diagnostic against Azure.
    .PARAMETER StorageAccount
        Storage account name. Default: auto-detected from the resource group
        (first account matching `staitriad*`).
    .PARAMETER Container
        Analytics container name. Default: 'analytics'.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: 'ai-triad'.
    .PARAMETER Days
        Look-back window (days) for listing recent daily blobs. Default: 7.
    .PARAMETER StaleThresholdHours
        Flag the pipeline stale (and unhealthy) when the most recent write is older
        than this many hours. Default: 24.
    .OUTPUTS
        [PSCustomObject] with Healthy, ContainerExists, Accessible, RecentBlobs,
        TotalRecentEvents, LastWrite, HoursSinceLastWrite, Stale, and Checks.
    .EXAMPLE
        Test-AnalyticsBlobHealth
    .EXAMPLE
        Test-AnalyticsBlobHealth -Days 14 -StaleThresholdHours 6
    .EXAMPLE
        $h = Test-AnalyticsBlobHealth; $h.RecentBlobs | Format-Table Date, EventCount, LastModified
    .LINK
        Show-AITriadHelp
    .LINK
        Test-TaxEditorHealth
    .LINK
        Test-AzureHealth
    .LINK
        Get-TaxEditorBlob
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$StorageAccount,

        [Parameter()]
        [string]$Container = 'analytics',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [ValidateRange(1, 365)]
        [int]$Days = 7,

        [Parameter()]
        [ValidateRange(1, 8760)]
        [int]$StaleThresholdHours = 24
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Test-AnalyticsBlobHealth'

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Check analytics blob health' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Check analytics blob health' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Resolve storage account ──────────────────────────────────────────
    if (-not $StorageAccount) {
        $AccountListJson = & az storage account list -g $ResourceGroup --query "[?starts_with(name,'staitriad')].name" -o json 2>$null
        # Explicit array assign — `$x = if(){@()}` unwraps to a scalar under StrictMode.
        $Accounts = @()
        if ($LASTEXITCODE -eq 0 -and $AccountListJson) { $Accounts = @($AccountListJson | ConvertFrom-Json) }
        if ($Accounts.Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Resolve storage account' `
                -Problem "No 'staitriad*' storage accounts found in resource group '$ResourceGroup'" `
                -Location $CallerName `
                -NextSteps @('Pass -StorageAccount explicitly',
                             "Check resource group: az storage account list -g $ResourceGroup"))
        }
        $StorageAccount = $Accounts[0]
    }

    $Checks = [System.Collections.Generic.List[PSCustomObject]]::new()
    $AddCheck = {
        param($Name, $Pass, $Detail)
        $Checks.Add([PSCustomObject]@{ Name = $Name; Pass = [bool]$Pass; Detail = $Detail })
    }

    # ── Check 1: Container exists / accessible ───────────────────────────
    $ContainerExists = $false
    $Accessible      = $false
    $ExistsJson = & az storage container exists --account-name $StorageAccount --name $Container --auth-mode login -o json 2>$null
    if ($LASTEXITCODE -eq 0 -and $ExistsJson) {
        $Accessible = $true
        try {
            $Parsed = $ExistsJson | ConvertFrom-Json
            if ($Parsed.PSObject.Properties['exists']) { $ContainerExists = [bool]$Parsed.exists }
        } catch {
            $Accessible = $false
        }
    }
    & $AddCheck 'Container accessible' $Accessible $(if ($Accessible) { "Queried '$Container' on '$StorageAccount'" } else { "Could not query container '$Container' (auth/network/RBAC?)" })
    & $AddCheck 'Container exists' $ContainerExists $(if ($ContainerExists) { "'$Container' present" } else { "'$Container' not found on '$StorageAccount'" })

    # ── Check 2: List recent daily blobs + count events ──────────────────
    $CutoffDate = (Get-Date).ToUniversalTime().AddDays(-$Days).ToString('yyyy-MM-dd')
    $RecentBlobs = [System.Collections.Generic.List[PSCustomObject]]::new()
    $TotalEvents = 0

    if ($ContainerExists -and $Accessible) {
        $BlobJson = & az storage blob list --account-name $StorageAccount --container-name $Container --auth-mode login -o json 2>$null
        # Explicit array assign — `$x = if(){@()}` unwraps to a scalar under StrictMode.
        $Blobs = @()
        if ($LASTEXITCODE -eq 0 -and $BlobJson) { $Blobs = @($BlobJson | ConvertFrom-Json) }

        foreach ($Blob in $Blobs) {
            if (-not $Blob.PSObject.Properties['name']) { continue }
            # Daily analytics blobs are named YYYY-MM-DD.ndjson (analyticsBlob.ts).
            $M = [regex]::Match([string]$Blob.name, '^(\d{4}-\d{2}-\d{2})\.ndjson$')
            if (-not $M.Success) { continue }
            $BlobDate = $M.Groups[1].Value
            if ($BlobDate -lt $CutoffDate) { continue }

            $Size = 0
            $LastModified = ''
            if ($Blob.PSObject.Properties['properties']) {
                if ($Blob.properties.PSObject.Properties['contentLength']) { $Size = [long]$Blob.properties.contentLength }
                if ($Blob.properties.PSObject.Properties['lastModified']) {
                    $Raw = $Blob.properties.lastModified
                    $LastModified = if ($Raw -is [datetime]) { $Raw.ToUniversalTime().ToString('o') } else { [string]$Raw }
                }
            }

            # Event count = non-blank NDJSON lines. Download to a temp file and count;
            # $null when the download fails so we never report a false zero.
            $EventCount = $null
            $Tmp = [System.IO.Path]::GetTempFileName()
            try {
                & az storage blob download --account-name $StorageAccount --container-name $Container `
                    --name $Blob.name --file $Tmp --auth-mode login --no-progress --output none 2>$null
                if ($LASTEXITCODE -eq 0 -and (Test-Path $Tmp)) {
                    $EventCount = @(Get-Content -Path $Tmp | Where-Object { $_.Trim().Length -gt 0 }).Count
                    $TotalEvents += $EventCount
                }
            }
            finally {
                if (Test-Path $Tmp) { Remove-Item -Path $Tmp -Force -ErrorAction SilentlyContinue }
            }

            $RecentBlobs.Add([PSCustomObject]@{
                Date         = $BlobDate
                Name         = [string]$Blob.name
                SizeBytes    = $Size
                EventCount   = $EventCount
                LastModified = $LastModified
            })
        }
    }

    $SortedBlobs = @($RecentBlobs | Sort-Object Date)
    & $AddCheck 'Recent blobs present' ($SortedBlobs.Count -gt 0) "$($SortedBlobs.Count) daily blob(s) in the last $Days day(s), $TotalEvents event(s) total"

    # ── Check 3: Freshness (last write vs threshold) ─────────────────────
    $LastWrite = $null
    $HoursSince = $null
    $Stale = $true
    $WithMod = @($SortedBlobs | Where-Object { $_.LastModified })
    if ($WithMod.Count -gt 0) {
        $Latest = ($WithMod | Sort-Object LastModified)[-1]
        $LastWrite = $Latest.LastModified
        try {
            $LastDt = [datetimeoffset]::Parse($LastWrite).UtcDateTime
            $HoursSince = [math]::Round(((Get-Date).ToUniversalTime() - $LastDt).TotalHours, 2)
            $Stale = $HoursSince -gt $StaleThresholdHours
        } catch {
            $HoursSince = $null
            $Stale = $true
        }
    }
    $FreshDetail = if ($null -eq $HoursSince) {
        'No dated blob with a lastModified timestamp in the window'
    } else {
        "Last write ${HoursSince}h ago (threshold ${StaleThresholdHours}h)"
    }
    & $AddCheck 'Pipeline fresh' (-not $Stale) $FreshDetail

    # ── Overall verdict + report ─────────────────────────────────────────
    $Healthy = $ContainerExists -and $Accessible -and (-not $Stale)

    Write-Host "`nAnalytics Blob Health — $StorageAccount/$Container" -ForegroundColor Cyan
    foreach ($C in $Checks) {
        $Icon  = if ($C.Pass) { '[PASS]' } else { '[FAIL]' }
        $Color = if ($C.Pass) { 'Green' } else { 'Red' }
        Write-Host "  $Icon $($C.Name) — $($C.Detail)" -ForegroundColor $Color
    }
    Write-Host ''

    [PSCustomObject]@{
        StorageAccount      = $StorageAccount
        Container           = $Container
        ContainerExists     = $ContainerExists
        Accessible          = $Accessible
        RecentBlobs         = $SortedBlobs
        TotalRecentEvents   = $TotalEvents
        LastWrite           = $LastWrite
        HoursSinceLastWrite = $HoursSince
        StaleThresholdHours = $StaleThresholdHours
        Stale               = $Stale
        Healthy             = $Healthy
        Checks              = @($Checks)
        Timestamp           = (Get-Date).ToUniversalTime().ToString('o')
    }
}
