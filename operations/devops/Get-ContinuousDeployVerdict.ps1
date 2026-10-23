<#
.SYNOPSIS
    Pure predicate for continuous deploy (t/4414, t/4091 Decision D). Log-only phase: this
    function decides what the real workflow WOULD do, but nothing here dispatches anything.

.DESCRIPTION
    `Get-ContinuousDeployVerdict` takes the already-gathered facts for one green `main` commit and
    returns one of:
      - 'would-dispatch'         — this commit would be deployed to production.
      - 'hold-kill-switch'       — CONTINUOUS_DEPLOY is off or unset (fail-safe default: unset = off).
      - 'skip-non-deployable'    — the commit touches no deployable path (docs/lessons/research-only).
      - 'hold-infra'             — the commit touches deploy/azure/** (Bicep); always a manual go.
      - 'hold-no-pr-association' — a commit since the last dispatch has no associated merged PR
                                    (e.g. pushed straight to main) — it never ran joint-gv-guard or
                                    consult-hold-guard, which only trigger on pull_request (t/4285,
                                    TL ruling p/331#2106, ported into t/4414 per e/358#2).
      - 'hold-gate-not-green'    — ci-gate isn't success, or CodeQL ran on this SHA and isn't
                                    success (CodeQL is path-filtered; absent means it legitimately
                                    didn't run and is NOT a hold — same t/4285 ruling).
      - 'hold-cl-window'         — a declared CL run-window is active; the dispatch is HELD (re-checked
                                    on the next green run), not dropped.
      - 'skip-batch-window'      — a would-be dispatch happened less than BatchMinutes ago; the batching
                                    window naturally collapses to the newest green SHA on its own re-check.

    Priority order matters and is fixed: kill switch, then non-deployable, then infra-hold, then
    no-pr-association, then gate-not-green, then CL-window-hold, then batch-window, then dispatch.
    An infra-touching commit is held even if it ALSO touches deployable app code — infra changes
    are never auto-deployed, full stop (t/4414 ask 4, the TL's documented lean). PR-association and
    gate-greenness are evidence-of-safety checks on the commit itself, so they run before the
    timing-oriented CL-window/batch-window checks.

    All I/O (reading the kill-switch variable, the CL-window file/variable, the path-filter
    outputs, check-run conclusions, commit-PR association, "now", and the last-dispatch timestamp)
    is the workflow step's job, not this file's — kept out so the decision logic is testable
    without GitHub Actions, Azure or a real clock.
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
        # Commits since the last dispatch with no associated merged PR. Empty = all clear (t/4285).
        [string[]]$CommitsWithoutMergedPR = @(),
        [string]$CiGateConclusion = 'success',
        # $null/empty means CodeQL did not run on this SHA (path-filtered) — treated as fine, same
        # convention as t/4285's Get-AutoDeployAdvisoryVerdict.ps1.
        [string]$CodeQlConclusion = $null,
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

    if (@($CommitsWithoutMergedPR).Count -gt 0) {
        return [PSCustomObject]@{
            Action = 'hold-no-pr-association'
            Reason = "commit(s) with no associated merged PR (never ran joint-gv-guard/consult-hold-guard): $($CommitsWithoutMergedPR -join ', ')"
            Sha    = $Sha
        }
    }

    if ($CiGateConclusion -ne 'success') {
        return [PSCustomObject]@{ Action = 'hold-gate-not-green'; Reason = "ci-gate is not success: $CiGateConclusion"; Sha = $Sha }
    }

    if ($CodeQlConclusion -and $CodeQlConclusion -ne 'success') {
        return [PSCustomObject]@{ Action = 'hold-gate-not-green'; Reason = "CodeQL ran on this SHA and is not success: $CodeQlConclusion"; Sha = $Sha }
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
