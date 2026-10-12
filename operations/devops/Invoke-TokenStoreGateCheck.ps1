#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pre-deploy gate: fail if tokenStore.enabled with no azureBlobStorage backing.
.DESCRIPTION
    Called by deploy-azure.yml before the Bicep apply step. Checks both prod and
    staging authConfigs via live Azure query (catches ad-hoc CLI drift, not just
    template regressions). Fails with exit 1 if any app has tokenStore.enabled=true
    without azureBlobStorage.sasUrlSettingName — a misconfiguration that causes
    HTTP 500 for all signed-in users on replica recycle or platform roll (t/4132).

    Currently warn-only in the workflow (continue-on-error: true). Gate-promotion
    to blocking requires a separate T2 PR per DevOps gate-promotion discipline.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ContainerAppName,
    [Parameter(Mandatory)] [string] $ResourceGroup
)

$ErrorActionPreference = 'Stop'

$Apps = @(
    @{ Name = $ContainerAppName;           Label = 'prod'    },
    @{ Name = "$ContainerAppName-staging"; Label = 'staging' }
)

$Failed = @()
foreach ($App in $Apps) {
    $authJson = az containerapp auth show `
        --name $App.Name `
        --resource-group $ResourceGroup `
        --query 'properties.login.tokenStore' `
        --only-show-errors `
        -o json 2>$null

    if ([string]::IsNullOrWhiteSpace($authJson) -or $authJson.Trim() -eq 'null') {
        Write-Host "t/4133 $($App.Label): auth not configured or app not found — skip"
        continue
    }

    $tokenStore = $authJson | ConvertFrom-Json
    $enabled    = $tokenStore.enabled -eq $true
    $sasUrl     = if ($tokenStore.PSObject.Properties['azureBlobStorage']) {
        $tokenStore.azureBlobStorage.sasUrlSettingName
    } else {
        $null
    }
    $backed = -not [string]::IsNullOrWhiteSpace($sasUrl)

    if ($enabled -and -not $backed) {
        $msg = "$($App.Label): tokenStore.enabled=true with no azureBlobStorage.sasUrlSettingName — sessions lost on replica recycle (t/4132)"
        $Failed += $msg
        Write-Warning "t/4133 $msg"
    } else {
        Write-Host "t/4133 $($App.Label): tokenStore OK (enabled=$enabled backed=$backed)"
    }
}

if ($Failed.Count -gt 0) {
    $summary = "t/4133 tokenStore safety check FAILED ($($Failed.Count) app(s)): $($Failed -join '; ')"
    Write-Error $summary
    exit 1
}

Write-Host "t/4133 tokenStore safety check passed"
