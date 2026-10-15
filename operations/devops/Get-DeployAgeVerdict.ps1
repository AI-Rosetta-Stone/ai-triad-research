<#
.SYNOPSIS
    Pure predicate for the t/4194 "refuse to deploy a commit older than the one running in prod"
    guard. SO condition C3 (p/682#16): `git merge-base --is-ancestor` exits 1 when the requested SHA
    genuinely isn't an ancestor, but >1 (e.g. 128) on a git ERROR (bad ref, repo problem) — those are
    not the same thing, and conflating them would refuse a deploy on a git hiccup, not a real
    older-commit case.

.DESCRIPTION
    `Get-DeployAgeVerdict` takes the already-gathered facts (the prod revision's name, and the
    `git merge-base --is-ancestor` exit code, or $null if it was never run) and returns one of:
      - 'proceed'      — safe to deploy (no active prod revision, or confirmed ancestor).
      - 'refuse'       — the requested SHA is confirmed NOT an ancestor: a real older/diverged deploy.
      - 'warn-proceed' — could not determine (unparseable revision name, unresolvable SHA, or a git
                          ERROR exit code) — fail OPEN, never silently refuse on an inconclusive read.

    The workflow step (CLI wrapper, not duplicated here) does the actual `git rev-parse` /
    `git merge-base` calls and feeds their results into this function — kept out of this file so the
    decision logic is testable without a real git repo or Azure state.
#>

function Get-DeployAgeVerdict {
    param(
        [string]$ProdRevisionName,
        [Nullable[int]]$MergeBaseExitCode
    )
    if ([string]::IsNullOrWhiteSpace($ProdRevisionName)) {
        return [PSCustomObject]@{ Action = 'proceed'; Reason = 'no-active-prod-revision' }
    }
    if ($ProdRevisionName -notmatch '--deploy-([0-9a-f]{7,40})-') {
        return [PSCustomObject]@{ Action = 'warn-proceed'; Reason = 'unparseable-revision-name' }
    }
    $runningShort = $Matches[1]
    if ($null -eq $MergeBaseExitCode) {
        return [PSCustomObject]@{ Action = 'warn-proceed'; Reason = 'unresolvable-sha'; RunningShort = $runningShort }
    }
    if ($MergeBaseExitCode -eq 0) {
        return [PSCustomObject]@{ Action = 'proceed'; Reason = 'is-ancestor'; RunningShort = $runningShort }
    }
    if ($MergeBaseExitCode -eq 1) {
        return [PSCustomObject]@{ Action = 'refuse'; Reason = 'not-ancestor-older-deploy'; RunningShort = $runningShort }
    }
    # SO C3: exit code >1 (e.g. 128) is a git ERROR, not a definitive "not an ancestor" verdict.
    return [PSCustomObject]@{ Action = 'warn-proceed'; Reason = "git-error-exit-$MergeBaseExitCode"; RunningShort = $runningShort }
}
