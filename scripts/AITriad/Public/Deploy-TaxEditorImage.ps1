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

    # The t/4242 guard predicate must be loadable BEFORE anything changes, so a missing predicate
    # fails the call up front instead of leaving a half-done deploy (t/4308).
    Import-RevisionDeactivationVerdict -CallerName $CallerName

    # ── Get current active revisions for rollback ────────────────────────
    $OldRevisions = @(Get-TaxEditorRevision -ResourceGroup $ResourceGroup -AppName $AppName)
    $OldActive = @($OldRevisions | Where-Object { $_.Active })
    $OldActiveNames = @($OldActive | ForEach-Object { $_.Name })
    # The previous serving revision (highest weight; the first listed on a tie) is the rollback
    # target. Like the deploy workflows (t/2050), a deploy never deactivates it (t/4384).
    $RollbackTarget = @($OldActive |
        Sort-Object -Stable -Descending -Property @{ Expression = { if ($_.PSObject.Properties['TrafficWeight']) { [int]$_.TrafficWeight } else { 0 } } } |
        Select-Object -First 1 | ForEach-Object { $_.Name })
    $RollbackTargetName = if ($RollbackTarget.Count -gt 0) { [string]$RollbackTarget[0] } else { $null }
    # Every deactivation the guard declined, with its reason, so callers can act on it (t/4384).
    $SkippedDeactivations = [System.Collections.Generic.List[object]]::new()

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
    $null = & az containerapp ingress traffic set -g $ResourceGroup -n $AppName `
        --revision-weight "${NewRevName}=100" 2>$null

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Shift traffic to new revision '$NewRevName'" `
            -Problem "az containerapp ingress traffic set failed (exit code $LASTEXITCODE)" `
            -Location $CallerName `
            -NextSteps @("Check revision status: az containerapp revision show -g $ResourceGroup -n $AppName --revision $NewRevName"))
    }

    # ── Deactivate old revisions ─────────────────────────────────────────
    # t/4308 (the t/4242 class): each deactivate goes through a FRESH re-check of both the revision's
    # trafficWeight and the ingress traffic config. A revision still holding weight (the traffic set
    # hasn't propagated, or someone changed the split) is re-polled a bounded number of times and
    # then skipped with a WARN, never deactivated. The rollback target is excluded by name first
    # and protected in the verdict as well (t/4384).
    foreach ($OldName in $OldActiveNames) {
        if ($OldName -ne $NewRevName -and $OldName -ne $RollbackTargetName) {
            $Verdict = Invoke-GuardedRevisionDeactivate -ResourceGroup $ResourceGroup -AppName $AppName `
                -RevisionName $OldName -ServingRevisionName $NewRevName -ProtectedNames @($RollbackTargetName | Where-Object { $_ }) `
                -CallerName $CallerName
            if (-not $Verdict.Deactivated) {
                $SkippedDeactivations.Add([PSCustomObject]@{ Revision = $OldName; Reason = $Verdict.Reason; Phase = 'deploy' })
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

            if ($RollbackTargetName) {
                $RollbackRev = $RollbackTargetName
                # Each rollback step is exit-checked (Azure review of #3620): a failed step throws, so
                # the operator is never told prod rolled back when it didn't. Nothing is deactivated
                # after a failed step; the failed new revision keeps serving until someone acts.
                $null = & az containerapp revision activate -g $ResourceGroup -n $AppName `
                    --revision $RollbackRev 2>$null
                if ($LASTEXITCODE -ne 0) {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal "Roll back '$AppName' to '$RollbackRev' after a failed health check" `
                        -Problem "az containerapp revision activate failed (exit code $LASTEXITCODE); prod was NOT rolled back and '$NewRevName' (unhealthy) still serves" `
                        -Location $CallerName `
                        -NextSteps @("Activate it manually: az containerapp revision activate -g $ResourceGroup -n $AppName --revision $RollbackRev",
                                     "Then shift traffic: az containerapp ingress traffic set -g $ResourceGroup -n $AppName --revision-weight ${RollbackRev}=100",
                                     'Or run Restore-TaxEditorKnownGood'))
                }
                $null = & az containerapp ingress traffic set -g $ResourceGroup -n $AppName `
                    --revision-weight "${RollbackRev}=100" 2>$null
                if ($LASTEXITCODE -ne 0) {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal "Roll back '$AppName' to '$RollbackRev' after a failed health check" `
                        -Problem "az containerapp ingress traffic set failed (exit code $LASTEXITCODE); '$RollbackRev' is active but traffic was NOT shifted, so '$NewRevName' (unhealthy) still serves" `
                        -Location $CallerName `
                        -NextSteps @("Shift traffic manually: az containerapp ingress traffic set -g $ResourceGroup -n $AppName --revision-weight ${RollbackRev}=100",
                                     "Check the split: az containerapp show -g $ResourceGroup -n $AppName --query properties.configuration.ingress.traffic",
                                     'Or run Restore-TaxEditorKnownGood'))
                }
                # The same guard on the rollback path: the failed new revision is deactivated only
                # once a fresh re-check confirms it no longer holds traffic (t/4308).
                $Verdict = Invoke-GuardedRevisionDeactivate -ResourceGroup $ResourceGroup -AppName $AppName `
                    -RevisionName $NewRevName -ServingRevisionName $RollbackRev -ProtectedNames @($RollbackRev) `
                    -CallerName $CallerName
                if (-not $Verdict.Deactivated) {
                    $SkippedDeactivations.Add([PSCustomObject]@{ Revision = $NewRevName; Reason = $Verdict.Reason; Phase = 'rollback' })
                }
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
        PreviousRevision = if ($RollbackTargetName) { $RollbackTargetName } else { '(none)' }
        HealthCheck      = $HealthResult
        SkippedDeactivations = @($SkippedDeactivations)
        AppName          = $AppName
        ResourceGroup    = $ResourceGroup
        Timestamp        = (Get-Date).ToString('o')
    }
}
