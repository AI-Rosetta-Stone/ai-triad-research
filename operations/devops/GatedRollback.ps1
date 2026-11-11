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

    Returns [pscustomobject]@{ Action = 'shifted' | 'refused' | 'measured'; Reason; Verified;
    ActivateToProvisionedSec; ActivateToWarmSec; Fqdn }.
#>

. (Join-Path $PSScriptRoot 'ReadyzWarmGatePredicate.ps1')

$script:GatedRollbackFailedStates = @('Failed', 'Degraded', 'Stopped', 'Deprovisioning', 'Deprovisioned')

function Invoke-GatedRollbackCore {
    param(
        [Parameter(Mandatory)][string] $RevisionName,
        [Parameter(Mandatory)][scriptblock] $Activate,       # activates the revision (throws on failure)
        [Parameter(Mandatory)][scriptblock] $GetState,       # -> @{ Provisioning; Running; Fqdn } or $null
        [Parameter(Mandatory)][scriptblock] $ProbeHealth,    # param($BaseUrl) -> $true/$false
        [Parameter(Mandatory)][scriptblock] $ProbeReadyz,    # param($BaseUrl) -> @{ StatusCode; Body }
        [Parameter(Mandatory)][scriptblock] $ShiftTraffic,   # shifts 100% to the revision (throws on failure)
        [Parameter(Mandatory)][scriptblock] $VerifyServing,  # -> $true/$false after the shift
        [switch] $MeasureOnly,
        [ValidateRange(1, 3600)][int] $ProvisionTimeoutSec = 300,
        [ValidateRange(1, 3600)][int] $WarmTimeoutSec = 420,
        [ValidateRange(0, 120)][int] $PollIntervalSec = 10
    )

    $result = [pscustomobject]@{
        Action = 'refused'; Reason = ''; Verified = $false
        ActivateToProvisionedSec = $null; ActivateToWarmSec = $null; Fqdn = $null
    }
    function Refuse([string]$why) { $result.Action = 'refused'; $result.Reason = $why; $result }

    $start = [DateTime]::UtcNow
    try { & $Activate } catch { return Refuse "activate failed: $($_.Exception.Message)" }

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
        if ($state -and $state.Provisioning -eq 'Provisioned' -and -not [string]::IsNullOrWhiteSpace($state.Fqdn)) { break }
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

    # 4. Shift, then verify.
    try { & $ShiftTraffic } catch { return Refuse "traffic shift failed: $($_.Exception.Message)" }
    $result.Action = 'shifted'
    $result.Verified = try { [bool](& $VerifyServing) } catch { $false }
    $result.Reason = if ($result.Verified) { "shifted to '$RevisionName' and verified serving" } else { "shifted to '$RevisionName' but post-shift verification FAILED; check weight and /health now" }
    $result
}
