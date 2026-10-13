#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pre/post-deploy gate: fail if tokenStore.enabled with no azureBlobStorage backing.
.DESCRIPTION
    Called by deploy-azure.yml before AND after the Bicep apply step. Checks both prod
    and staging authConfigs via live Azure query (catches ad-hoc CLI drift, not just
    template regressions). Fails with exit 1 if any app has tokenStore.enabled=true
    without azureBlobStorage.sasUrlSettingName or blobContainerUri backing — a
    misconfiguration that causes HTTP 500 for all signed-in users on replica recycle or
    platform roll (t/4132 incident).

    An az query failure is treated as CANNOT EVALUATE (not a skip). Stderr is printed
    to aid diagnosis.

    Currently warn-only in the workflow (continue-on-error: true). Gate-promotion to
    blocking requires a separate T2 PR per DevOps gate-promotion discipline.

    CO-LOCATION (t/3010 pattern): the deploy-azure.yml gate steps AND
    tests/Invoke-TokenStoreGateCheck.Tests.ps1 both use the Invoke-TokenStoreCheck
    predicate defined here — single source of truth so the gate and its proof cannot
    diverge. Dot-source this file to import the predicate.
#>
[CmdletBinding()]
param(
    [string] $ContainerAppName = '',
    [string] $ResourceGroup    = ''
)

# ── Pure predicate (exported for dot-source testing) ──────────────────────────
function Invoke-TokenStoreCheck {
    <#
    .SYNOPSIS
        Evaluate one app's tokenStore JSON (from az containerapp auth show
        --query 'login.tokenStore' -o json). Pure function — no az calls.
        Accepts sasUrlSettingName OR blobContainerUri as backing (both are valid
        per the @2024-10-02-preview ACA API).
    .OUTPUTS
        PSObject  Safe, Skipped, Reason
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]       $AppLabel,
        [Parameter(Mandatory)] [AllowNull()]  [object] $TokenStore  # $null = skip
    )

    if ($null -eq $TokenStore) {
        return [PSCustomObject]@{ Safe = $true; Skipped = $true;  Reason = 'not configured or app not found' }
    }

    $enabled = $TokenStore.enabled -eq $true
    $blob    = if ($TokenStore.PSObject.Properties['azureBlobStorage']) { $TokenStore.azureBlobStorage } else { $null }
    $sasUrl  = if ($blob) { $blob.sasUrlSettingName } else { $null }
    $blobUri = if ($blob) { $blob.blobContainerUri  } else { $null }
    $backed  = (-not [string]::IsNullOrWhiteSpace($sasUrl)) -or (-not [string]::IsNullOrWhiteSpace($blobUri))

    if ($enabled -and -not $backed) {
        $reason = "${AppLabel}: tokenStore.enabled=true with no azureBlobStorage backing (sasUrlSettingName or blobContainerUri) — sessions lost on replica recycle (t/4132)"
        return [PSCustomObject]@{ Safe = $false; Skipped = $false; Reason = $reason }
    }
    return [PSCustomObject]@{ Safe = $true; Skipped = $false; Reason = "enabled=$enabled backed=$backed" }
}

# ── Main body (only when run as a script, not dot-sourced for tests) ──────────
if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($ContainerAppName) -or [string]::IsNullOrWhiteSpace($ResourceGroup)) {
        Write-Error 't/4133: -ContainerAppName and -ResourceGroup are required when running as a script.'
        exit 1
    }

    $ErrorActionPreference = 'Stop'

    $Apps = @(
        @{ Name = $ContainerAppName;           Label = 'prod'    },
        @{ Name = "$ContainerAppName-staging"; Label = 'staging' }
    )

    $Failed  = @()
    $Summary = @()

    foreach ($App in $Apps) {
        # Capture stderr to a temp file so it can be printed on failure (C2 — not 2>$null)
        $stderrFile = [System.IO.Path]::GetTempFileName()
        $authJson   = az containerapp auth show `
            --name $App.Name `
            --resource-group $ResourceGroup `
            --query 'login.tokenStore' `
            --only-show-errors `
            -o json 2>$stderrFile
        $azExit   = $LASTEXITCODE
        $azStderr = if (Test-Path $stderrFile) {
            $s = Get-Content $stderrFile -Raw
            Remove-Item $stderrFile -ErrorAction SilentlyContinue
            $s
        } else { '' }

        if ($azExit -ne 0) {
            $msg = "$($App.Label): az containerapp auth show failed (exit $azExit) — cannot evaluate tokenStore safety"
            if (-not [string]::IsNullOrWhiteSpace($azStderr)) {
                Write-Host "t/4133 az stderr ($($App.Label)): $($azStderr.Trim())"
            }
            $Failed  += $msg
            $Summary += "| $($App.Label) | ❌ cannot evaluate (az exit $azExit) |"
            Write-Host "::warning title=t/4133::$msg"
            continue
        }

        $tokenStore = if ([string]::IsNullOrWhiteSpace($authJson) -or $authJson.Trim() -eq 'null') {
            $null
        } else {
            $authJson | ConvertFrom-Json
        }

        $result = Invoke-TokenStoreCheck -AppLabel $App.Label -TokenStore $tokenStore
        if ($result.Skipped) {
            Write-Host "t/4133 $($App.Label): $($result.Reason) — skip"
        } elseif ($result.Safe) {
            Write-Host "t/4133 $($App.Label): tokenStore OK — $($result.Reason)"
        } else {
            $Failed  += $result.Reason
            $Summary += "| $($App.Label) | ⚠️ $($result.Reason) |"
            # C1: emit an Actions annotation visible on the run page even with continue-on-error: true
            Write-Host "::warning title=t/4133::$($result.Reason)"
        }
    }

    if ($Failed.Count -gt 0) {
        # C1: write to step summary so warn-only firing is visible without opening the log
        if ($env:GITHUB_STEP_SUMMARY) {
            $rows = $Summary -join "`n"
            Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"

## ⚠️ t/4133 tokenStore safety check — $($Failed.Count) issue(s)

| App | Detail |
|-----|--------|
$rows

Set ``tokenStore: { enabled: false }`` or add ``azureBlobStorage.sasUrlSettingName`` / ``blobContainerUri``.
"@
        }
        Write-Error "t/4133 tokenStore safety check FAILED ($($Failed.Count) app(s)): $($Failed -join '; ')"
        exit 1
    }

    Write-Host "t/4133 tokenStore safety check passed"
}
