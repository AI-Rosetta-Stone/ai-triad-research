#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pre-revision gate for staging (t/77 condition 4, t/404). Runs in deploy-staging.yml BEFORE the env sync.
.DESCRIPTION
    Checks the staging config that Sync-StagingEnv.ps1 is about to write. The values come from the
    same resolver and the same input as the sync: Get-BicepBaseEnv.ps1 -ForStaging -RequireStagingAppId,
    which takes the staging App id from SYNC_GITHUB_APP_ID_STAGING. The workflow defines that variable
    once at job level, so the gate and the sync cannot drift (SO t/404#10).

    Fails closed (exit 1) on:
      - PROD_REPO or PROD_APP_ID unset (no prod reference to compare against);
      - the resolver failing, which includes SYNC_GITHUB_APP_ID_STAGING unset (RequireStagingAppId);
      - GITHUB_REPO, GITHUB_APP_ID or GITHUB_BRANCH missing from the resolved config;
      - GITHUB_REPO equal to the prod repo;
      - GITHUB_APP_ID equal to the prod App id;
      - GITHUB_BRANCH equal to 'main'.
    Each refusal prints one '::error::' line that names its cause. Tests assert those lines.
.PARAMETER BicepPath
    Path to main.bicep. The workflow passes deploy/azure/main.bicep; tests pass fixtures.
.PARAMETER ProdRepo
    The prod data repo (vars.SYNC_GITHUB_REPO). Defaults to $env:PROD_REPO.
.PARAMETER ProdAppId
    The prod GitHub App id (vars.SYNC_GITHUB_APP_ID). Defaults to $env:PROD_APP_ID.
#>
[CmdletBinding()]
param(
    [string] $BicepPath = "$PSScriptRoot/../../deploy/azure/main.bicep",
    [string] $ProdRepo = $env:PROD_REPO,
    [string] $ProdAppId = $env:PROD_APP_ID
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-GateRefusal ([string] $Message) {
    Write-Host "::error::t/77 pre-revision gate: $Message NOT deploying (fail-closed)."
    exit 1
}

if ([string]::IsNullOrWhiteSpace($ProdRepo) -or [string]::IsNullOrWhiteSpace($ProdAppId)) {
    Write-GateRefusal 'vars.SYNC_GITHUB_REPO or SYNC_GITHUB_APP_ID is unset, so the prod identity cannot be compared.'
}

# Same resolver and input as Sync-StagingEnv.ps1. Throws (fail closed) when the staging App id is unset.
$resolved = $null
try {
    $resolved = & (Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1') -BicepPath $BicepPath -ForStaging -RequireStagingAppId
} catch {
    Write-GateRefusal "could not resolve the staging config from ${BicepPath}: $($_.Exception.Message)"
}

$Repo   = $resolved['GITHUB_REPO']
$AppId  = $resolved['GITHUB_APP_ID']
$Branch = $resolved['GITHUB_BRANCH']

$missing = @()
if ([string]::IsNullOrWhiteSpace($Repo))   { $missing += 'GITHUB_REPO' }
if ([string]::IsNullOrWhiteSpace($AppId))  { $missing += 'GITHUB_APP_ID' }
if ([string]::IsNullOrWhiteSpace($Branch)) { $missing += 'GITHUB_BRANCH' }
if ($missing.Count -gt 0) {
    Write-GateRefusal "the staging config has no value for $($missing -join ', ')."
}

if ($Repo -eq $ProdRepo) {
    Write-GateRefusal "staging config GITHUB_REPO is the prod repo '$Repo'. The sync would write prod data to staging."
}
if ($AppId -eq $ProdAppId) {
    Write-GateRefusal "staging config GITHUB_APP_ID is the prod App ($AppId). The sync would use prod's credential on staging."
}
if ($Branch -eq 'main') {
    Write-GateRefusal "staging config GITHUB_BRANCH is 'main'. The sync would point staging at prod main."
}

Write-Host "t/77 pre-revision gate PASSED: staging repo '$Repo', branch '$Branch', App id $AppId differs from prod."
