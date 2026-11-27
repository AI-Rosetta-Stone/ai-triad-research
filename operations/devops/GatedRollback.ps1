# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Gated manual rollback to a (possibly deactivated) previous revision (t/266 b, SO condition 1).

.DESCRIPTION
    Once retire-previous-revision deactivates the old revision, rolling back means activating it
    first. An immediate traffic shift onto a revision that is still provisioning, cold, or unable to
    provision would move 100% of prod onto it, which is an outage. So this refuses to shift until
    the revision is ready by the same standard the deploy uses before its own shift:

      1. activate the revision
      2. wait until provisioningState == Provisioned (a Failed/Degraded/Stopped/Deprovisioning state
         refuses at once; a timeout refuses)
      3. on the revision's OWN FQDN: /health healthy AND /readyz warm (Get-ReadyzGateAction ==
         'proceed', the deploy warm-gate's predicate; a definitive 'fail' refuses at once; a timeout
         refuses)
      4. only then shift traffic to it, and verify it serves (weight 100 + app /health)

    -MeasureOnly (the staging drill, SO condition 2) runs steps 1-3, records the timings and never
    shifts.

    Every Azure/HTTP call is an injected scriptblock, so both arms are unit-testable without live
    state (tests/GatedRollback.Tests.ps1). Invoke-GatedRollback.ps1 is the CLI wrapper that wires the
    real az/HTTP calls.

    t/513: a target that is ALREADY ACTIVE (staging keeps its rollback target active at weight 0, so
    `az containerapp revision activate` refuses with RevisionAlreadyInRequestedState) skips step 1 and
    runs every other gate unchanged. The optional -GetActive scriptblock reads the revision's active
    flag and weight; if it fails or returns nothing, step 1 runs as before (prod shape: the target was
    deactivated by retire-previous-revision, so it is activated). A target already at 100% traffic is
    'already-serving' (nothing shifted) only after the same health and readyz gates pass, with
    VerifyServing deciding Verified; an unhealthy target still refuses.

    Returns [pscustomobject]@{ Action = 'shifted' | 'refused' | 'measured' | 'already-serving'; Reason;
    Verified; AlreadyActive; ActivateToProvisionedSec; ActivateToWarmSec; Fqdn }.
#>

. (Join-Path $PSScriptRoot 'ReadyzWarmGatePredicate.ps1')

# Only a definitive failure refuses at once. Stopped / Deprovisioned / Deprovisioning / Degraded are
# what a just-activated revision can still read for a few polls (stale read, start-up), so they are
# treated as transient until -ProvisionTimeoutSec (DevOps Lead review, p/107#7): an emergency
# rollback must not be refused on a stale first read.
$script:GatedRollbackFailedStates = @('Failed')

<#
.SYNOPSIS
    PURE (t/513, Quality p/262#9). Whether the -DeactivateAfterMeasure drill may deactivate the revision
    it measured. Only a revision the drill ACTIVATED itself may be deactivated again. A revision that was
    already active before the drill (staging's weight-0 rollback standby) is left alone: deactivating it
    would remove staging's ready rollback target. The traffic-weight guard alone cannot tell, since the
    standby carries 0. Returns @{ Skip = bool; Reason = string }.
#>
function Get-DrillDeactivateDecision {
    param(
        [Parameter(Mandatory)] $Result,
        [switch] $DeactivateAfterMeasure
    )
    if (-not $DeactivateAfterMeasure) { return @{ Skip = $true; Reason = '-DeactivateAfterMeasure not given' } }
    if ($Result.Action -ne 'measured') { return @{ Skip = $true; Reason = "the run ended '$($Result.Action)', not 'measured'" } }
    if ($Result.AlreadyActive) {
        return @{ Skip = $true; Reason = 'it was already active before the drill (a standby rollback target); the drill only deactivates what it activated' }
    }
    @{ Skip = $false; Reason = 'the drill activated it, so it deactivates it again (subject to the traffic guard)' }
}

<#
.SYNOPSIS
    t/588: whether -DeactivatePrevious may act after a gated rollback, and on which revisions.
.DESCRIPTION
    After a VERIFIED shift, the revision rolled away from keeps answering on its own URL until someone deactivates it
    (prod: 77 s on 2026-11-24, t/501). -DeactivatePrevious deactivates it, but only when: the switch was given (default
    off, so nothing changes unless asked); the run ended 'shifted' or 'already-serving' AND verified; the previous
    revisions carrying traffic were READ before the shift (an unreadable read deactivates nothing). The target itself is
    never in the list. Each revision still goes through the traffic guard (Invoke-GuardedDeactivate). Returns
    @{ Skip = bool; Reason = string; Revisions = string[] }.
#>
function Get-DeactivatePreviousDecision {
    param(
        [Parameter(Mandatory)] $Result,
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]] $PreviousRevisions,
        [string] $TargetRevision,
        [switch] $ReadFailed,
        [switch] $DeactivatePrevious
    )
    if (-not $DeactivatePrevious) { return @{ Skip = $true; Reason = '-DeactivatePrevious not given'; Revisions = @() } }
    if ($Result.Action -notin @('shifted', 'already-serving') -or $Result.Verified -ne $true) {
        return @{ Skip = $true; Reason = "the run ended '$($Result.Action)' (verified: $($Result.Verified)), not a verified shift"; Revisions = @() }
    }
    if ($ReadFailed) { return @{ Skip = $true; Reason = 'the revisions carrying traffic before the shift could not be read, so nothing is deactivated'; Revisions = @() } }
    $list = @($PreviousRevisions | Where-Object { $_ -and $_ -ne $TargetRevision } | Select-Object -Unique)
    if ($list.Count -eq 0) { return @{ Skip = $true; Reason = 'no other revision carried traffic before the shift'; Revisions = @() } }
    @{ Skip = $false; Reason = 'a verified shift left these revisions without traffic (each is still checked by the traffic guard)'; Revisions = $list }
}

<#
.SYNOPSIS
    t/588: deactivate ONE revision only if a fresh, double-sourced traffic guard says so; a failure is a WARN, never a rollback of the rollback.
.DESCRIPTION
    GetVerdict (param($RevisionName)) returns the Get-RevisionDeactivationVerdict result from fresh reads (the revision's own weight AND
    the ingress traffic config, the t/4242 guard); Deactivate (param($RevisionName)) throws on failure. Neither a guard that cannot be read
    nor a failed deactivation throws out of here and neither touches traffic: the shift already verified, and this never undoes it.
#>
function Invoke-GuardedDeactivate {
    param(
        [Parameter(Mandatory)][string] $RevisionName,
        [Parameter(Mandatory)][scriptblock] $GetVerdict,
        [Parameter(Mandatory)][scriptblock] $Deactivate
    )
    $out = [pscustomobject]@{ RevisionName = $RevisionName; Deactivated = $false; Reason = ''; Warning = $null }
    try { $v = & $GetVerdict $RevisionName } catch {
        $out.Reason = "the traffic guard could not be read: $($_.Exception.Message)"; $out.Warning = $out.Reason
        return $out
    }
    if ($null -eq $v -or $v.Action -ne 'deactivate') {
        $out.Reason = if ($null -eq $v) { 'the traffic guard returned nothing' } else { "traffic guard: $($v.Reason)" }
        return $out
    }
    try { & $Deactivate $RevisionName; $out.Deactivated = $true; $out.Reason = 'deactivated after the verified shift' } catch {
        $out.Reason = "deactivation failed: $($_.Exception.Message)"; $out.Warning = $out.Reason
    }
    $out
}

<#
.SYNOPSIS
    t/588 (DeployAzure p/227#53): the record of a -DeactivatePrevious run, as lines the log, the step summary and the returned object keep.
.DESCRIPTION
    One line per revision: "deactivate-previous: deactivated '<rev>' (<reason>)" or "deactivate-previous: NOT deactivated '<rev>': <reason>",
    then one summary line naming both lists. Returns @{ Lines; Deactivated; NotDeactivated }. An empty input still gives the summary line, so
    a run that deactivated nothing says so.
#>
function Format-DeactivatePreviousRecord {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Results)
    $lines = @()
    $done = @()
    $not = @()
    foreach ($x in $Results) {
        if ($x.Deactivated) {
            $done += $x.RevisionName
            $lines += "deactivate-previous: deactivated '$($x.RevisionName)' ($($x.Reason))"
        } else {
            $not += $x.RevisionName
            $lines += "deactivate-previous: NOT deactivated '$($x.RevisionName)': $($x.Reason)"
        }
    }
    $fmt = { param($l) if ($l.Count -eq 0) { 'none' } else { ($l | ForEach-Object { "'$_'" }) -join ', ' } }
    $lines += "deactivate-previous: record: deactivated $($done.Count) ($(& $fmt $done)); not deactivated $($not.Count) ($(& $fmt $not))"
    @{ Lines = $lines; Deactivated = $done; NotDeactivated = $not }
}

function Invoke-GatedRollbackCore {
    param(
        [Parameter(Mandatory)][string] $RevisionName,
        [Parameter(Mandatory)][scriptblock] $Activate,       # activates the revision (throws on failure)
        [Parameter(Mandatory)][scriptblock] $GetState,       # -> @{ Provisioning; Running; Fqdn } or $null
        [Parameter(Mandatory)][scriptblock] $ProbeHealth,    # param($BaseUrl) -> $true/$false
        [Parameter(Mandatory)][scriptblock] $ProbeReadyz,    # param($BaseUrl) -> @{ StatusCode; Body }
        [Parameter(Mandatory)][scriptblock] $ShiftTraffic,   # shifts 100% to the revision (throws on failure)
        [Parameter(Mandatory)][scriptblock] $VerifyServing,  # -> $true/$false after the shift
        [scriptblock] $GetActive,                            # t/513, optional: -> @{ Active = bool; Weight = int } or $null
        [switch] $MeasureOnly,
        [ValidateRange(1, 3600)][int] $ProvisionTimeoutSec = 300,
        [ValidateRange(1, 3600)][int] $WarmTimeoutSec = 420,
        [ValidateRange(0, 120)][int] $PollIntervalSec = 10
    )

    $result = [pscustomobject]@{
        Action = 'refused'; Reason = ''; Verified = $false; AlreadyActive = $false
        ActivateToProvisionedSec = $null; ActivateToWarmSec = $null; Fqdn = $null
    }
    function Refuse([string]$why) { $result.Action = 'refused'; $result.Reason = $why; $result }

    $start = [DateTime]::UtcNow
    # 1. Activate, unless it is already active (t/513). An unreadable state falls back to activating.
    $current = $null
    if ($GetActive) { $current = try { & $GetActive } catch { $null } }
    if ($current -and $current.Active -eq $true) {
        $result.AlreadyActive = $true
    } else {
        try { & $Activate } catch { return Refuse "activate failed: $($_.Exception.Message)" }
    }

    # 2. Provisioned (and not in a failed state), with an FQDN to probe.
    $deadline = $start.AddSeconds($ProvisionTimeoutSec)
    $state = $null
    while ($true) {
        $state = try { & $GetState } catch { $null }
        if ($state -and $state.Running -in $script:GatedRollbackFailedStates) {
            return Refuse "revision '$RevisionName' is in state '$($state.Running)' (provisioning '$($state.Provisioning)'); not shifting"
        }
        if ($state -and $state.Provisioning -eq 'Failed') {
            return Refuse "revision '$RevisionName' failed to provision; not shifting"
        }
        $transient = $state -and $state.Running -in @('Stopped', 'Deprovisioned', 'Deprovisioning', 'Degraded')
        if ($state -and -not $transient -and $state.Provisioning -eq 'Provisioned' -and -not [string]::IsNullOrWhiteSpace($state.Fqdn)) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            return Refuse "revision '$RevisionName' not Provisioned with an FQDN within ${ProvisionTimeoutSec}s (last: provisioning '$($state.Provisioning)', running '$($state.Running)'); not shifting"
        }
        Start-Sleep -Seconds $PollIntervalSec
    }
    $result.ActivateToProvisionedSec = [math]::Round(([DateTime]::UtcNow - $start).TotalSeconds, 1)
    $result.Fqdn = $state.Fqdn
    $baseUrl = "https://$($state.Fqdn)"

    # 3. /health AND /readyz warm on the revision's own FQDN.
    $deadline = [DateTime]::UtcNow.AddSeconds($WarmTimeoutSec)
    while ($true) {
        $healthy = try { [bool](& $ProbeHealth $baseUrl) } catch { $false }
        $readyz = try { & $ProbeReadyz $baseUrl } catch { @{ StatusCode = 0; Body = '' } }
        $action = Get-ReadyzGateAction -StatusCode ([int]$readyz.StatusCode) -Body ([string]$readyz.Body)
        if ($action -eq 'fail') {
            return Refuse "revision '$RevisionName' /readyz reports a definitive failure (status $($readyz.StatusCode)); not shifting"
        }
        if ($healthy -and $action -eq 'proceed') { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            return Refuse "revision '$RevisionName' not healthy+warm on its FQDN within ${WarmTimeoutSec}s (health=$healthy, readyz=$action/$($readyz.StatusCode)); not shifting"
        }
        Start-Sleep -Seconds $PollIntervalSec
    }
    $result.ActivateToWarmSec = [math]::Round(([DateTime]::UtcNow - $start).TotalSeconds, 1)

    if ($MeasureOnly) {
        $result.Action = 'measured'
        $result.Reason = "ready: provisioned at $($result.ActivateToProvisionedSec)s, healthy+warm at $($result.ActivateToWarmSec)s; -MeasureOnly, traffic NOT shifted"
        return $result
    }

    # t/513 (Lead t/513#4 a): already at 100% and the gates above passed -> nothing to shift. Success
    # only if it also verifies as serving; an unhealthy target never reaches here (it refused above).
    if ($result.AlreadyActive -and $null -ne $current.Weight -and [int]$current.Weight -eq 100) {
        $result.Action = 'already-serving'
        $result.Verified = try { [bool](& $VerifyServing) } catch { $false }
        $result.Reason = if ($result.Verified) { "already serving 100%; nothing shifted ('$RevisionName' passed the health and readyz gates)" } else { "already at 100% but verification FAILED; check weight and /health now" }
        return $result
    }

    # 4. Shift, then verify.
    try { & $ShiftTraffic } catch { return Refuse "traffic shift failed: $($_.Exception.Message)" }
    $result.Action = 'shifted'
    $result.Verified = try { [bool](& $VerifyServing) } catch { $false }
    $result.Reason = if ($result.Verified) { "shifted to '$RevisionName' and verified serving" } else { "shifted to '$RevisionName' but post-shift verification FAILED; check weight and /health now" }
    $result
}
