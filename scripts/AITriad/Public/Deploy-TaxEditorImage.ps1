# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Deploy-TaxEditorImage {
    <#
    .SYNOPSIS
        Deploys a specific GHCR image tag or digest via blue-green flow.
    .DESCRIPTION
        Creates a new ACA revision with the target image, shifts traffic,
        then runs a health check. If the health check fails, automatically
        rolls back to the previous revision. Supports -WhatIf/-Confirm.
    .PARAMETER Tag
        Image tag to deploy (e.g., '0.8.0', 'latest').
    .PARAMETER Digest
        Exact image digest to deploy (e.g., 'sha256:abc123...').
    .PARAMETER Registry
        Container registry + image path. Default: ghcr.io/ai-rosetta-stone/taxonomy-editor.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER AppName
        Container App name. Default: taxonomy-editor.
    .PARAMETER BaseUrl
        URL for post-deploy health check. Default: production.
    .PARAMETER SkipHealthCheck
        Skip the post-deploy health check (no auto-rollback).
    .EXAMPLE
        Deploy-TaxEditorImage -Tag '0.8.0'
    .EXAMPLE
        Deploy-TaxEditorImage -Digest 'sha256:abc123...'
    .EXAMPLE
        Deploy-TaxEditorImage -Tag '0.8.0' -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Deploy-TaxEditorInfra
    .LINK
        Get-TaxEditorImage
    .LINK
        Get-TaxEditorRevision
    .LINK
        Switch-TaxEditorRevision
    .LINK
        Test-TaxEditorInfra
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High',
                   DefaultParameterSetName = 'ByTag')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'ByTag', Position = 0)]
        [string]$Tag,

        [Parameter(Mandatory, ParameterSetName = 'ByDigest')]
        [string]$Digest,

        [Parameter()]
        [string]$Registry = 'ghcr.io/ai-rosetta-stone/taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [switch]$SkipHealthCheck
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Deploy-TaxEditorImage'

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Deploy container image' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location $CallerName `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Deploy container image' `
            -Problem 'Azure CLI is not logged in' `
            -Location $CallerName `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Construct image reference ────────────────────────────────────────
    $ImageRef = if ($Tag) { "${Registry}:${Tag}" } else { "${Registry}@${Digest}" }

    # ── WhatIf / Confirm gate ────────────────────────────────────────────
    if (-not $PSCmdlet.ShouldProcess($AppName, "Deploy image '$ImageRef' (blue-green)")) {
        return
    }

    # ── Get current active revisions for rollback ────────────────────────
    $OldRevisions = @(Get-TaxEditorRevision -ResourceGroup $ResourceGroup -AppName $AppName)
    $OldActive = @($OldRevisions | Where-Object { $_.Active })
    $OldActiveNames = @($OldActive | ForEach-Object { $_.Name })

    # ── Deploy new image ─────────────────────────────────────────────────
    Write-Verbose "Deploying image '$ImageRef'..."
    $RawJson = & az containerapp update -g $ResourceGroup -n $AppName `
        --image $ImageRef --output json 2>$null

    if ($LASTEXITCODE -ne 0 -or -not $RawJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Deploy image '$ImageRef'" `
            -Problem "az containerapp update failed (exit code $LASTEXITCODE)" `
            -Location $CallerName `
            -NextSteps @("Verify image exists: docker manifest inspect $ImageRef",
                         "Check app status: az containerapp show -g $ResourceGroup -n $AppName"))
    }

    $UpdateResult = $RawJson | ConvertFrom-Json
    $NewRevName = $UpdateResult.properties.latestRevisionName

    if (-not $NewRevName) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Deploy image '$ImageRef'" `
            -Problem 'Could not determine new revision name from update result' `
            -Location $CallerName `
            -NextSteps @('Run Get-TaxEditorRevision to inspect current state'))
    }

    Write-Verbose "New revision created: $NewRevName"

    # ── Shift traffic to new revision ────────────────────────────────────
    Write-Verbose "Shifting 100% traffic to '$NewRevName'..."
    & az containerapp ingress traffic set -g $ResourceGroup -n $AppName `
        --revision-weight "${NewRevName}=100" 2>$null

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Shift traffic to new revision '$NewRevName'" `
            -Problem "az containerapp ingress traffic set failed (exit code $LASTEXITCODE)" `
            -Location $CallerName `
            -NextSteps @("Check revision status: az containerapp revision show -g $ResourceGroup -n $AppName --revision $NewRevName"))
    }

    # ── Deactivate old revisions ─────────────────────────────────────────
    foreach ($OldName in $OldActiveNames) {
        if ($OldName -ne $NewRevName) {
            Write-Verbose "Deactivating previous revision '$OldName'..."
            & az containerapp revision deactivate -g $ResourceGroup -n $AppName `
                --revision $OldName 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Failed to deactivate revision '$OldName' — manual cleanup may be needed."
            }
        }
    }

    # ── Post-deploy health check ─────────────────────────────────────────
    $HealthResult = 'Skipped'
    if (-not $SkipHealthCheck) {
        Write-Verbose 'Running post-deploy health check...'
        $Health = Test-TaxEditorHealth -BaseUrl $BaseUrl

        if ($Health.Healthy) {
            $HealthResult = 'Passed'
            Write-Verbose "Health check passed (avg $($Health.AverageMs)ms)."
        }
        else {
            $HealthResult = 'Failed'
            Write-Warning 'Post-deploy health check FAILED — rolling back...'

            if (@($OldActiveNames).Count -gt 0) {
                $RollbackRev = $OldActiveNames[0]
                & az containerapp revision activate -g $ResourceGroup -n $AppName `
                    --revision $RollbackRev 2>$null
                & az containerapp ingress traffic set -g $ResourceGroup -n $AppName `
                    --revision-weight "${RollbackRev}=100" 2>$null
                & az containerapp revision deactivate -g $ResourceGroup -n $AppName `
                    --revision $NewRevName 2>$null
                Write-Warning "Rolled back to '$RollbackRev'. Run Test-TaxEditorHealth to verify."
            }
            else {
                Write-Warning 'No previous revision to roll back to — manual intervention required.'
            }
        }
    }

    # ── Return result ────────────────────────────────────────────────────
    [PSCustomObject]@{
        Action           = 'ImageDeploy'
        Image            = $ImageRef
        NewRevision      = $NewRevName
        PreviousRevision = if (@($OldActiveNames).Count -gt 0) { $OldActiveNames[0] } else { '(none)' }
        HealthCheck      = $HealthResult
        AppName          = $AppName
        ResourceGroup    = $ResourceGroup
        Timestamp        = (Get-Date).ToString('o')
    }
}
