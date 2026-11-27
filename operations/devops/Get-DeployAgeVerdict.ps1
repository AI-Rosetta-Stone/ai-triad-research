<#
.SYNOPSIS
    Pure predicate for the t/4194 "refuse to deploy a commit older than the one running in prod"
    guard. SO condition C3 (p/682#16): `git merge-base --is-ancestor` exits 1 when the requested SHA
    genuinely isn't an ancestor, but >1 (e.g. 128) on a git ERROR (bad ref, repo problem) — those are
    not the same thing, and conflating them would refuse a deploy on a git hiccup, not a real
    older-commit case.

.DESCRIPTION
    `Get-DeployAgeVerdict` takes the already-gathered facts (the prod revision's name, the
    `git merge-base --is-ancestor` exit code or $null if it was never run, and, when that exit code
    is 1, the containment result from Test-DeployChangesContained) and returns one of:
      - 'proceed'      — safe to deploy (no active prod revision, confirmed ancestor, or every change
                          the running commit made since the merge-base is present in the requested one).
      - 'refuse'       — the requested SHA is NOT a descendant and the running commit's changes are
                          not all present (or that could not be verified): a real older/diverged deploy.
      - 'warn-proceed' — could not determine ancestry (unparseable revision name, unresolvable SHA, or
                          a git ERROR exit code) — fail OPEN, never silently refuse on an inconclusive read.

    t/670 (t/579, TL p/9#660, DeployAzure p/227#27): prod can run a hotfix built off a side branch
    whose changes reached main as separately squashed PRs, so it never becomes an ancestor of main.
    When the requested SHA is not a descendant, the deploy still proceeds if
    `git diff <merge-base> <running>` reverse-applies cleanly onto the requested tree, i.e. every
    change the running commit made is already present. Anything else (a missing change, a later change
    to the same lines, an empty merge-base, or any git error in the containment check) REFUSES, naming
    the files, so a human decides. Fail closed: the old exit-1 refusal now only relaxes on proof.

    The workflow step does the `git rev-parse` / `git merge-base` calls and runs
    Test-DeployChangesContained; Get-DeployAgeVerdict stays pure.
#>

function Get-DeployAgeVerdict {
    param(
        [string]$ProdRevisionName,
        [Nullable[int]]$MergeBaseExitCode,
        # t/670: Test-DeployChangesContained's result, consulted only when $MergeBaseExitCode is 1.
        $Containment = $null
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
        if ($null -ne $Containment -and $Containment.Contained -eq $true) {
            return [PSCustomObject]@{ Action = 'proceed'; Reason = 'not-ancestor-but-changes-contained'; RunningShort = $runningShort; Containment = $Containment }
        }
        $why = if ($null -eq $Containment) { 'containment not checked' } elseif ($Containment.Error) { "containment unverifiable: $($Containment.Error)" } else { 'running changes missing from the requested commit' }
        return [PSCustomObject]@{ Action = 'refuse'; Reason = 'not-ancestor-older-deploy'; Detail = $why; RunningShort = $runningShort; Containment = $Containment }
    }
    # SO C3: exit code >1 (e.g. 128) is a git ERROR, not a definitive "not an ancestor" verdict.
    return [PSCustomObject]@{ Action = 'warn-proceed'; Reason = "git-error-exit-$MergeBaseExitCode"; RunningShort = $runningShort }
}

function Get-DeployApplyFailure {
    <#
    .SYNOPSIS
        t/674 item 2: read a failed `git apply --cached --check -R` output. Pure.
    .OUTPUTS
        [pscustomobject] { Error [string]; Files [string[]] }. A `fatal:` line means git could not
        run the check at all (for example a lazy blob fetch failed), so Error is set and the caller
        reports 'unverifiable'. Otherwise Files names the files whose changes are not all present.
    #>
    param([AllowNull()][object[]]$Output)
    $lines = @($Output | ForEach-Object { "$_" })
    $fatal = @($lines | Where-Object { $_ -match '^fatal:' })
    if ($fatal.Count) {
        return [PSCustomObject]@{ Error = "git apply could not run the check ($($fatal[0].Trim()))"; Files = @() }
    }
    $bad = @($lines | ForEach-Object { if ($_ -match '^error: (?:patch failed|while searching for):?\s*([^:]+)') { $Matches[1].Trim() } elseif ($_ -match '^error: ([^:]+): patch does not apply') { $Matches[1].Trim() } } | Where-Object { $_ } | Select-Object -Unique)
    return [PSCustomObject]@{ Error = $null; Files = $bad }
}

function Test-DeployChangesContained {
    <#
    .SYNOPSIS
        t/670: whether every change the running commit made since its merge-base with the requested
        commit is already present in the requested commit. Never throws.
    .OUTPUTS
        [pscustomobject] { Contained [bool]; MergeBase; UniqueCommits [string[]]; Files [string[]];
        Error [string] }. Contained is $true only when the reverse-apply check passed; any git error,
        an empty merge-base or an unreadable diff gives Contained = $false with Error set.
    #>
    param(
        [Parameter(Mandatory)][string]$Running,
        [Parameter(Mandatory)][string]$Requested,
        [string]$RepoPath = '.'
    )
    $result = [PSCustomObject]@{ Contained = $false; MergeBase = $null; UniqueCommits = @(); Files = @(); Error = $null }
    $patch = $null
    $index = $null
    try {
        # t/674 item 1: say so when the running commit itself is not in this clone (its branch may
        # be gone), instead of the misleading 'no merge-base' the next call would report.
        & git -C $RepoPath cat-file -e "$Running^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) { $result.Error = "running commit $Running not fetchable (its branch may have been deleted while prod still runs it)"; return $result }
        $mb = (& git -C $RepoPath merge-base $Running $Requested 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($mb)) { $result.Error = "no merge-base of $Running and $Requested (exit code $LASTEXITCODE)"; return $result }
        $result.MergeBase = $mb.Trim()
        $result.UniqueCommits = @(& git -C $RepoPath log --no-merges --format='%h %s' "$Requested..$Running" 2>$null)
        $result.Files = @(& git -C $RepoPath diff --name-only $result.MergeBase $Running 2>$null)
        $patch = [System.IO.Path]::GetTempFileName()
        # git writes the patch itself (--output): bytes stay exact, no PowerShell line handling.
        & git -C $RepoPath diff --binary "--output=$patch" $result.MergeBase $Running 2>$null
        if ($LASTEXITCODE -ne 0) { $result.Error = "git diff $($result.MergeBase) $Running failed (exit $LASTEXITCODE)"; return $result }
        if ((Get-Item -LiteralPath $patch).Length -eq 0) { $result.Contained = $true; return $result }  # the running commit changed nothing since the merge-base
        # Check against the requested TREE through a throwaway index: no worktree, no checkout.
        $index = [System.IO.Path]::GetTempFileName()
        Remove-Item -LiteralPath $index -Force
        $env:GIT_INDEX_FILE = $index
        & git -C $RepoPath read-tree $Requested 2>$null
        if ($LASTEXITCODE -ne 0) { $result.Error = "git read-tree $Requested failed (exit $LASTEXITCODE)"; return $result }
        $out = & git -C $RepoPath apply --cached --check -R $patch 2>&1
        if ($LASTEXITCODE -eq 0) { $result.Contained = $true; return $result }
        $failure = Get-DeployApplyFailure -Output $out
        if ($failure.Error) { $result.Error = $failure.Error; return $result }
        if (@($failure.Files).Count) { $result.Files = @($failure.Files) }
        return $result
    } catch {
        $result.Contained = $false
        $result.Error = "containment check threw: $($_.Exception.Message)"
        return $result
    } finally {
        Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
        foreach ($f in @($patch, $index)) { if ($f -and (Test-Path -LiteralPath $f)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
    }
}
