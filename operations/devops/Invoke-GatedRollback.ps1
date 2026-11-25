#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Gated rollback to a previous revision: activate, wait until Provisioned + healthy + warm on its
    own FQDN, and only then shift 100% traffic and verify (t/266 b, SO condition 1).

.EXAMPLE
    # Prod rollback (the revision name is in every deploy run's job summary):
    ./operations/devops/Invoke-GatedRollback.ps1 -RevisionName taxonomy-editor--deploy-abc1234-12345

.EXAMPLE
    # Staging drill: measure activate-to-warm without shifting traffic, then deactivate again.
    ./operations/devops/Invoke-GatedRollback.ps1 -AppName taxonomy-editor-staging -RevisionName <rev> -MeasureOnly -DeactivateAfterMeasure

.NOTES
    Exits 0 only on 'shifted' + verified, 'already-serving' + verified (t/513: the target already had
    100% and passed every gate), or 'measured'. A refusal exits 1 and changes no traffic.
    t/513: an already-active target (staging keeps its rollback target active at weight 0) skips the
    activate step; every other gate is unchanged.
    The decision logic is GatedRollback.ps1 (unit-tested); this file only wires az/HTTP.
#>
param(
    [Parameter(Mandatory)][string] $RevisionName,
    [string] $AppName = 'taxonomy-editor',
    [string] $ResourceGroup = 'ai-triad',
    [switch] $MeasureOnly,
    [switch] $DeactivateAfterMeasure,
    [int] $ProvisionTimeoutSec = 300,
    [int] $WarmTimeoutSec = 420,
    [int] $PollIntervalSec = 10
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'GatedRollback.ps1')
Import-Module (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force

$appUrl = 'https://' + (az containerapp show -n $AppName -g $ResourceGroup --query 'properties.configuration.ingress.fqdn' -o tsv)

$r = Invoke-GatedRollbackCore -RevisionName $RevisionName -MeasureOnly:$MeasureOnly `
    -ProvisionTimeoutSec $ProvisionTimeoutSec -WarmTimeoutSec $WarmTimeoutSec -PollIntervalSec $PollIntervalSec `
    -GetActive {
        # t/513: staging keeps the rollback target active at weight 0; activating it again is refused
        # (RevisionAlreadyInRequestedState). A failed read returns $null, and the core then activates.
        $s = az containerapp revision show -n $AppName -g $ResourceGroup --revision $RevisionName `
            --query '{a:properties.active,w:properties.trafficWeight}' -o json 2>$null | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $s) { @{ Active = [bool]$s.a; Weight = $s.w } }
    } `
    -Activate {
        az containerapp revision activate -n $AppName -g $ResourceGroup --revision $RevisionName -o none
        if ($LASTEXITCODE -ne 0) { throw "az containerapp revision activate exited $LASTEXITCODE" }
    } `
    -GetState {
        $s = az containerapp revision show -n $AppName -g $ResourceGroup --revision $RevisionName `
            --query '{p:properties.provisioningState,r:properties.runningState,f:properties.fqdn}' -o json 2>$null | ConvertFrom-Json
        if ($s) { @{ Provisioning = $s.p; Running = $s.r; Fqdn = $s.f } }
    } `
    -ProbeHealth { param($BaseUrl) (Test-TaxEditorHealth -BaseUrl $BaseUrl -TimeoutSec 15 -MaxAttempts 1).Healthy } `
    -ProbeReadyz {
        param($BaseUrl)
        $resp = Invoke-WebRequest -Uri "$BaseUrl/readyz" -Method Get -SkipHttpErrorCheck -TimeoutSec 15
        @{ StatusCode = [int]$resp.StatusCode; Body = ($resp.Content | Out-String).Trim() }
    } `
    -ShiftTraffic {
        az containerapp ingress traffic set -n $AppName -g $ResourceGroup --revision-weight "$RevisionName=100" -o none
        if ($LASTEXITCODE -ne 0) { throw "az containerapp ingress traffic set exited $LASTEXITCODE" }
    } `
    -VerifyServing {
        $w = az containerapp revision show -n $AppName -g $ResourceGroup --revision $RevisionName --query 'properties.trafficWeight' -o tsv
        ([int]$w -eq 100) -and (Test-TaxEditorHealth -BaseUrl $appUrl -TimeoutSec 15 -MaxAttempts 3 -RetryIntervalSec 10).Healthy
    }

Write-Host "Gated rollback: $($r.Action) - $($r.Reason)"
if ($r.AlreadyActive) { Write-Host "  target was already active: the activate step was skipped (t/513); every gate still ran" }
Write-Host ("  activate->provisioned: {0}s   activate->healthy+warm: {1}s   fqdn: {2}" -f $r.ActivateToProvisionedSec, $r.ActivateToWarmSec, $r.Fqdn)

$drill = Get-DrillDeactivateDecision -Result $r -DeactivateAfterMeasure:$DeactivateAfterMeasure
if ($drill.Skip -and $DeactivateAfterMeasure) { Write-Host "  drill: NOT deactivating '$RevisionName': $($drill.Reason)" }
if (-not $drill.Skip) {
    # SO round 2: never deactivate a revision that carries traffic. Same double-sourced t/4242 guard
    # as the deploy's cleanup (the revision's own weight AND the ingress traffic config, read fresh).
    . (Join-Path $PSScriptRoot 'Get-RevisionDeactivationVerdict.ps1')
    $raw = az containerapp revision show -n $AppName -g $ResourceGroup --revision $RevisionName -o json | ConvertFrom-Json
    $app = az containerapp show -n $AppName -g $ResourceGroup -o json | ConvertFrom-Json
    $entries = if ($app.properties.configuration.ingress.PSObject.Properties['traffic']) { @($app.properties.configuration.ingress.traffic) } else { $null }
    $ingress = Get-IngressTrafficWeightForRevision -RevisionName $RevisionName -TrafficEntries $entries -LatestRevisionName $app.properties.latestRevisionName
    $weight = if ($raw.properties.PSObject.Properties['trafficWeight']) { $raw.properties.trafficWeight } else { $null }
    $guard = Get-RevisionDeactivationVerdict -RevisionName $RevisionName -TrafficWeight $weight -Active ([bool]$raw.properties.active) `
        -IngressWeight $ingress.IngressWeight -IsLatestRevisionWithTraffic $ingress.IsLatestRevisionWithTraffic
    if ($guard.Action -eq 'deactivate') {
        az containerapp revision deactivate -n $AppName -g $ResourceGroup --revision $RevisionName -o none
        Write-Host "  drill: deactivated '$RevisionName' again (exit $LASTEXITCODE)"
    } else {
        Write-Host "  drill: NOT deactivating '$RevisionName': $($guard.Reason)"
    }
}

$r
if ($r.Action -eq 'measured' -or ($r.Action -in @('shifted', 'already-serving') -and $r.Verified)) { exit 0 }
exit 1
