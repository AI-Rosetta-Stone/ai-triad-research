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

.PARAMETER DeactivatePrevious
    t/588. After a VERIFIED shift, deactivate the revision(s) that carried traffic before it, each behind the fresh,
    double-sourced traffic guard. Default OFF.
    USE IT for a drill or a PLANNED rollback.
    DO NOT USE IT after an INCIDENT rollback (DeployAzure, p/227#53): the revision rolled away from is the suspect one, and
    deactivating it ends its exec access and its live replica state, which forensics may need. (Its logs stay in Log Analytics,
    and its revision definition stays and can be reactivated, but the live replica does not come back.) After an incident, leave
    it active at weight 0 until the investigation says otherwise.
    Each deactivation is recorded: a 'deactivate-previous: deactivated ...' line, a summary line (also appended to the GitHub step
    summary when run in a workflow), and PreviousDeactivated / PreviousNotDeactivated on the returned object. A failure is a WARN
    and never undoes the shift or changes the exit code.

.EXAMPLE
    # Planned rollback on staging, then retire the revision it left (NOT for an incident):
    ./operations/devops/Invoke-GatedRollback.ps1 -AppName taxonomy-editor-staging -RevisionName <rev> -DeactivatePrevious

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
    # t/588: after a VERIFIED shift, deactivate the revision rolled away from (guarded; default OFF). For a drill or a PLANNED
    # rollback; NOT after an INCIDENT rollback: the revision rolled away from is the suspect one, and deactivating it ends its exec
    # and live replica state that forensics may need (see .PARAMETER DeactivatePrevious).
    [switch] $DeactivatePrevious,
    [int] $ProvisionTimeoutSec = 300,
    [int] $WarmTimeoutSec = 420,
    [int] $PollIntervalSec = 10
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'GatedRollback.ps1')
Import-Module (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force

$appUrl = 'https://' + (az containerapp show -n $AppName -g $ResourceGroup --query 'properties.configuration.ingress.fqdn' -o tsv)

# t/588: only when asked, read which revisions carry traffic BEFORE the shift (after it they would all read 0). An unreadable read
# deactivates nothing.
$previousRevisions = @()
$previousReadFailed = $false
# $ErrorActionPreference is 'Stop' here, so the read goes through Get-PreviousRevisionsSafely: nothing it throws can stop the rollback (SO p/136#135).
if ($DeactivatePrevious) {
    $pre = Get-PreviousRevisionsSafely -TargetRevision $RevisionName -Read {
        $names = az containerapp revision list -n $AppName -g $ResourceGroup --query '[?properties.trafficWeight > `0`].name' -o tsv 2>$null
        @{ ExitCode = $LASTEXITCODE; Names = $names }
    }
    $previousRevisions = @($pre.Revisions)
    $previousReadFailed = [bool]$pre.Failed
}

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

if ($r.Action -eq 'measured' -and $DeactivateAfterMeasure) {
    # t/513 (Quality p/262#9): the drill deactivates only a revision it activated itself; an already-active
    # standby (staging's weight-0 rollback target) is left alone.
    $drill = Get-DrillDeactivateDecision -Result $r -DeactivateAfterMeasure:$DeactivateAfterMeasure
    if ($drill.Skip) {
        Write-Host "  drill: NOT deactivating '$RevisionName': $($drill.Reason)"
    } else {
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
}

# t/588: after a VERIFIED shift, deactivate the revision(s) rolled away from. Default off. Each one goes through the same fresh,
# double-sourced traffic guard as the deploy's cleanup; a failure is a WARN and never undoes the shift (exit code unchanged).
# The WHOLE block runs inside Invoke-PostShiftStepSafely: with $ErrorActionPreference = 'Stop' an exception from the dot-source, the step summary
# append or Add-Member would otherwise fail the script after the shift (SO p/136#135). Any exception is a WARN with its message.
if ($DeactivatePrevious) {
  # The block is ONE function call (Invoke-DeactivatePreviousStep in GatedRollback.ps1), so the script and the tests run the same code. The rollback
  # target goes in as an ARGUMENT, evaluated here in the script's own scope: never read $RevisionName inside a scriptblock that runs under another
  # function, which declares its own $RevisionName (the t/588 scoping bug, DeployAzure's staging test: -DeactivatePrevious deactivated nothing).
  Invoke-PostShiftStepSafely -Name 'deactivate-previous' -Block {
    Invoke-DeactivatePreviousStep -Result $r -PreviousRevisions $previousRevisions -TargetRevision $RevisionName `
        -AppName $AppName -ResourceGroup $ResourceGroup -ReadFailed:$previousReadFailed -DeactivatePrevious:$DeactivatePrevious `
        -VerdictScriptPath (Join-Path $PSScriptRoot 'Get-RevisionDeactivationVerdict.ps1')
  }
}
$r
exit (Get-GatedRollbackExitCode -Result $r)
