#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Post-deploy gate (warn-only): verify the Azure Files share is seeded with data current
    to the data-repo canonical. Catches silent seed-lag (t/3090 pattern).
.DESCRIPTION
    Reads seed-manifest.json from the share root (written by deploy.ps1 -SeedData).
    Uses the GitHub Git Trees API to fetch the current canonical blob sha for each asserted
    file — no 1 MB content limit, just metadata. Compares canonical sha vs seeded sha to
    detect seed-lag (data repo advanced since seed). Also checks share file size vs seeded
    size for upload truncation (independent failure class).

    seeded_at is kept as diagnostic metadata in the warning message; it is NOT a gate condition
    (age is the wrong signal — sha divergence is). (t/3091 design: e/126#4)

    WARN-ONLY phase: wired with continue-on-error: true in deploy-azure.yml until ≥1 green
    cycle confirmed against the real share. Flip-to-blocking is a separate Gate-Promotion PR.

    GV FIRE arm:  data repo advances past seed (sha mismatch) OR share file undersized → warns.
    GV CLEAN arm: seed current, share full-size → passes silently, zero output.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $StorageAccount,
    [Parameter(Mandatory)] [string] $GitHubToken,
    [string] $ShareName    = 'taxonomy-data',
    [string] $DataRepo     = 'AI-Rosetta-Stone/ai-triad-data',
    [string] $StorageKey   = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load pure predicate (dot-sourceable; no I/O)
. (Join-Path $PSScriptRoot 'ShareFreshnessPredicate.ps1')

$authArgs = if ($StorageKey) { @('--account-key', $StorageKey) }
            else             { @('--auth-mode', 'login', '--enable-file-backup-request-intent') }

# ── Download seed-manifest.json ──────────────────────────────────────────────
$tmp = [IO.Path]::GetTempFileName()
try {
    $dlOut = az storage file download `
        --account-name $StorageAccount `
        --share-name   $ShareName `
        --path         'seed-manifest.json' `
        --dest         $tmp `
        @authArgs `
        --output none 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errText = ($dlOut | Out-String).Trim()
        if ($errText -match 'ResourceNotFound|does not exist|The specified resource does not exist') {
            Write-Host ("::warning::Share freshness: seed-manifest.json not found on share '$ShareName' " +
                "(account=$StorageAccount). Run deploy.ps1 -SeedData to seed the share and write the manifest. (t/3091)")
        } else {
            Write-Host "::warning::Share freshness: could not read seed-manifest.json — $errText (t/3091)"
        }
        return  # warn-only: do not exit 1
    }

    $manifest  = Get-Content $tmp -Raw | ConvertFrom-Json
    $seededAt  = $manifest.seeded_at

    # ── Fetch canonical tree from GitHub Git Trees API ───────────────────────
    $headers   = @{
        Authorization        = "Bearer $GitHubToken"
        'X-GitHub-Api-Version' = '2022-11-28'
        Accept               = 'application/vnd.github+json'
    }
    $treeUrl   = "https://api.github.com/repos/$DataRepo/git/trees/HEAD?recursive=1"
    $treeResp  = Invoke-RestMethod -Uri $treeUrl -Headers $headers -ErrorAction Stop
    $treeEntries = @($treeResp.tree)

    # ── Collect share file sizes ─────────────────────────────────────────────
    $shareFileSizes = @{}
    foreach ($prop in $manifest.files.PSObject.Properties) {
        $filePath = $prop.Name
        $showRaw  = az storage file show `
            --account-name $StorageAccount `
            --share-name   $ShareName `
            --path         $filePath `
            @authArgs `
            --output json 2>&1
        if ($LASTEXITCODE -eq 0) {
            $info        = ($showRaw | Out-String) | ConvertFrom-Json
            $props2      = $info.properties
            $actualBytes = if ($null -ne $info.contentLength)         { [long]$info.contentLength }
                           elseif ($null -ne $props2 -and
                                   $null -ne $props2.contentLength)   { [long]$props2.contentLength }
                           else                                       { 0L }
            $shareFileSizes[$filePath] = $actualBytes
        }
        # If show fails (file missing), leave it absent from hashtable — predicate handles it
    }

    # ── Run pure predicate ───────────────────────────────────────────────────
    $result = Test-ShareManifestPredicate `
        -Manifest       $manifest `
        -CanonicalTree  $treeEntries `
        -ShareFileSizes $shareFileSizes

    if (-not $result.Pass) {
        foreach ($reason in $result.Reasons) {
            Write-Host ("::warning::Share freshness [seeded=$seededAt, account=$StorageAccount]: $reason (t/3091)")
        }
        Write-Host ("::warning::Share data may be stale — re-run deploy.ps1 -SeedData if the above is unexpected. " +
            "This gate is warn-only pending promotion GV. (t/3091)")
    } else {
        # CLEAN: silent pass — zero noise per GV requirement
        $fileCount = @($manifest.files.PSObject.Properties).Count
        Write-Host "Share freshness gate passed: $fileCount file(s) current to canonical. (t/3091)"
    }

} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
