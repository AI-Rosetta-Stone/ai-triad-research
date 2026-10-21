<#
.SYNOPSIS
    Pure predicate for continuous deploy (t/4414, t/4091 Decision D). Log-only phase: this
    function decides what the real workflow WOULD do, but nothing here dispatches anything.

.DESCRIPTION
    `Get-ContinuousDeployVerdict` takes the already-gathered facts for one green `main` commit and
    returns one of:
      - 'would-dispatch'      — this commit would be deployed to production.
      - 'hold-kill-switch'    — CONTINUOUS_DEPLOY is off or unset (fail-safe default: unset = off).
      - 'skip-non-deployable' — the commit touches no deployable path (docs/lessons/research-only).
      - 'hold-infra'          — the commit touches deploy/azure/** (Bicep); always a manual go.
      - 'hold-cl-window'      — a declared CL run-window is active; the dispatch is HELD (re-checked
                                 on the next green run), not dropped.
      - 'skip-batch-window'   — a would-be dispatch happened less than BatchMinutes ago; the batching
                                 window naturally collapses to the newest green SHA on its own re-check.

    Priority order matters and is fixed: kill switch, then non-deployable, then infra-hold, then
    CL-window-hold, then batch-window, then dispatch. An infra-touching commit is held even if it
    ALSO touches deployable app code — infra changes are never auto-deployed, full stop (t/4414 ask
    4, the TL's documented lean).

    All I/O (reading the kill-switch variable, the CL-window file/variable, the path-filter
    outputs, "now", and the last-dispatch timestamp) is the workflow step's job, not this file's —
    kept out so the decision logic is testable without GitHub Actions, Azure or a real clock.
#>

function Get-ContinuousDeployVerdict {
    param(
        [string]$KillSwitch,                 # 'on' | 'off' | '' | $null (unset)
        [Nullable[datetime]]$ClWindowUntil,   # $null if no CL run-window declared
        [datetime]$Now,
        [Nullable[datetime]]$LastDispatchAt,  # $null if continuous deploy has never dispatched
        [int]$BatchMinutes = 20,
        [bool]$TouchesContainer,
        [bool]$TouchesBicepEnv,
        [bool]$TouchesBicepResources,
        [string]$Sha
    )

    # Fail-safe default: a missing/empty/anything-other-than-exactly-'on' kill switch means OFF. A
    # missing repo variable must never silently enable auto-deploy (t/4414 ask 3's own
    # requirement) -- case-SENSITIVE compare, so 'ON'/'On' fail safe too, not just 'off'/unset.
    if ($KillSwitch -cne 'on') {
        return [PSCustomObject]@{ Action = 'hold-kill-switch'; Reason = 'CONTINUOUS_DEPLOY is not on'; Sha = $Sha }
    }

    $touchesInfra = $TouchesBicepEnv -or $TouchesBicepResources
    if (-not $TouchesContainer -and -not $touchesInfra) {
        return [PSCustomObject]@{ Action = 'skip-non-deployable'; Reason = 'no deployable path touched'; Sha = $Sha }
    }

    # Infra holds take priority over an otherwise-deployable app-code touch in the same commit —
    # never auto-deploy Bicep, regardless of what else the commit changed.
    if ($touchesInfra) {
        return [PSCustomObject]@{ Action = 'hold-infra'; Reason = 'touches deploy/azure/** (Bicep)'; Sha = $Sha }
    }

    if ($null -ne $ClWindowUntil -and $Now -lt $ClWindowUntil) {
        return [PSCustomObject]@{
            Action = 'hold-cl-window'
            Reason = "CL run-window active until $($ClWindowUntil.ToString('o'))"
            Sha    = $Sha
        }
    }

    if ($null -ne $LastDispatchAt) {
        $elapsed = $Now - $LastDispatchAt
        if ($elapsed.TotalMinutes -lt $BatchMinutes) {
            return [PSCustomObject]@{
                Action = 'skip-batch-window'
                Reason = "last dispatch $([math]::Round($elapsed.TotalMinutes, 1))min ago, window is ${BatchMinutes}min"
                Sha    = $Sha
            }
        }
    }

    return [PSCustomObject]@{ Action = 'would-dispatch'; Reason = 'deployable, no hold, batch window elapsed'; Sha = $Sha }
}
