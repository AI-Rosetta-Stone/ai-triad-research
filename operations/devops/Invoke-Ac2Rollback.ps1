# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    The AC2-triggered rollback body (t/4309): target lookup, active check + reactivation,
    traffic shift, disable, and recheck -- extracted from deploy-azure.yml into a standalone,
    independently-testable script (SO review, e/361#2, C3a).
.DESCRIPTION
    deploy-azure.yml's "Rollback for AC2 failure" / "AC2 recheck after rollback" steps now call
    this script, keeping the workflow steps to the `if:`-wiring already covered by
    tests/DeployAzureAc2RollbackWiring.Tests.ps1. This script carries the actual Azure calls, so
    the SAME code that runs in prod can also be exercised live:
      - C3b: `-DryRun` runs every READ call for real (revision show, /health) and only LOGS what
        the mutating calls (activate, traffic shift, disable) would be -- proving the JSON
        shapes, query paths, and empty-target handling against a real app without touching it.
      - C3c: a separate, manual live-fire proves the one new mutating primitive this path adds
        over the existing rollback step (`az containerapp revision activate`) on a real but
        inactive revision. See t/4309#7 / e/361#2 for that proof's own record.
.PARAMETER AppName
    Container App name. Default: 'taxonomy-editor'.
.PARAMETER ResourceGroup
    Azure resource group. Default: 'ai-triad'.
.PARAMETER TargetRevision
    The revision to roll back TO (steps.current_revision.outputs.revision -- the captured prior
    revision, SO C2, never re-derived as "latest minus one").
.PARAMETER NewRevisionToDisable
    The failed revision to disable after the traffic shift. Optional -- skipped (same
    belt-and-suspenders behavior as the pre-existing rollback step) when empty.
.PARAMETER AppUrl
    Base URL for the post-shift /health recheck.
.PARAMETER DryRun
    Runs every read call (revision show, /health) for real against the live app, but only logs
    what each mutating call (activate / traffic set / disable) WOULD do -- never calls it.
.OUTPUTS
    [PSCustomObject] { TargetUnrecoverable; RolledBack; RecheckFailed; RecheckReason }
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $TargetRevision,
    [string] $NewRevisionToDisable = '',
    [Parameter(Mandatory)] [string] $AppUrl,
    [string] $AppName = 'taxonomy-editor',
    [string] $ResourceGroup = 'ai-triad',
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function script:Get-RevisionActive([string]$Revision, [string]$App, [string]$RG) {
    $info = az containerapp revision show --name $App -g $RG --revision $Revision `
        --query '{active:properties.active,weight:properties.trafficWeight}' -o json | ConvertFrom-Json
    return $info
}

# Tracks whether the traffic shift itself succeeded, independent of what happens after it (TL
# review of #3807) -- an exception in Disable-ContainerAppRevision, which runs AFTER the shift,
# must not be reported as "rollback never happened" when it did.
$script:trafficShifted = $false

try {
    Write-Host "$(if ($DryRun) { '[DRY RUN] ' })Rolling back to '$TargetRevision'$(if ($NewRevisionToDisable) { " (disabling '$NewRevisionToDisable')" })"

    $targetInfo = Get-RevisionActive -Revision $TargetRevision -App $AppName -RG $ResourceGroup
    if (-not [bool]$targetInfo.active) {
        if ($DryRun) {
            Write-Host "[DRY RUN] Target '$TargetRevision' is inactive -- would run: az containerapp revision activate --revision $TargetRevision"
        } else {
            Write-Host "::warning::Rollback target '$TargetRevision' is inactive — attempting reactivation before shifting traffic."
            az containerapp revision activate --name $AppName -g $ResourceGroup --revision $TargetRevision
            $recheckActive = Get-RevisionActive -Revision $TargetRevision -App $AppName -RG $ResourceGroup
            if (-not [bool]$recheckActive.active) {
                Write-Host "::error::Rollback target '$TargetRevision' could not be reactivated — not shifting traffic to it."
                return [PSCustomObject]@{ TargetUnrecoverable = $true; RolledBack = $false; RecheckFailed = $null; RecheckReason = $null }
            }
        }
    }

    if ($DryRun) {
        Write-Host "[DRY RUN] Would run: Set-ContainerAppTraffic -RevisionName '$TargetRevision' -Weight 100"
        if ($NewRevisionToDisable) {
            Write-Host "[DRY RUN] Would run: Disable-ContainerAppRevision -RevisionName '$NewRevisionToDisable'"
        }
    } else {
        Import-Module ./scripts/AITriad/AITriad.psm1 -Force
        # TL note 4 (same pattern as the pre-existing rollback step): traffic-shift BEFORE
        # deactivate -- shift failure is recoverable; deactivate-then-shift is not.
        Set-ContainerAppTraffic -RevisionName $TargetRevision -AppName $AppName -ResourceGroup $ResourceGroup `
            -MaxAttempts 3 -RetryIntervalSec 10
        $script:trafficShifted = $true
        if ($NewRevisionToDisable) {
            Disable-ContainerAppRevision -RevisionName $NewRevisionToDisable -AppName $AppName -ResourceGroup $ResourceGroup
        }
    }

    if ($DryRun) {
        Write-Host "[DRY RUN] Skipping the post-shift recheck -- no traffic was actually moved."
        return [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $null; RecheckReason = '(dry run — not checked)' }
    }

    # Recheck: same active/weight/health shape as AC2 itself, against the restored revision.
    $recheck = Get-RevisionActive -Revision $TargetRevision -App $AppName -RG $ResourceGroup
    $reason = $null
    if (-not [bool]$recheck.active) {
        $reason = "rollback target '$TargetRevision' is NOT active after the rollback shift"
    } elseif ([int]$recheck.weight -ne 100) {
        $reason = "rollback target '$TargetRevision' traffic weight is $($recheck.weight), not 100"
    } else {
        Import-Module ./scripts/AITriad/AITriad.psm1 -Force
        $health = Test-TaxEditorHealth -BaseUrl $AppUrl -TimeoutSec 15 -MaxAttempts 3 -RetryIntervalSec 10
        if (-not $health.Healthy) {
            $reason = "/health did not return a healthy 200 against the rolled-back revision. Detail: $($health | ConvertTo-Json -Depth 3 -Compress)"
        }
    }

    if ($reason) {
        Write-Host "::error::t/4309 post-rollback recheck FAILED: $reason"
        return [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $true; RecheckReason = $reason }
    }
    Write-Host "t/4309 post-rollback recheck verified: '$TargetRevision' active at weight 100, /health 200. Prod is healthy again."
    return [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $false; RecheckReason = $null }
}
catch {
    Write-Host "::error::AC2 rollback threw an exception attempting to restore '$TargetRevision': $($_.Exception.Message)"
    if ($script:trafficShifted) {
        # Traffic already moved to $TargetRevision before this exception (e.g. Disable-
        # ContainerAppRevision failing after a successful shift) -- the rollback itself
        # happened, so TargetUnrecoverable would mislead a triager into thinking it didn't.
        # RecheckFailed=$true still routes to the louder sev-1 alert; it just carries the
        # right label (TL review, #3807).
        return [PSCustomObject]@{ TargetUnrecoverable = $false; RolledBack = $true; RecheckFailed = $true; RecheckReason = $_.Exception.Message }
    }
    return [PSCustomObject]@{ TargetUnrecoverable = $true; RolledBack = $false; RecheckFailed = $null; RecheckReason = $_.Exception.Message }
}
