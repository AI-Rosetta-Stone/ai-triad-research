# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Reads staging's current active revision's `DEPLOY_SHA` and checks whether the built SHA is a
genuine forward descendant of it, via `git merge-base --is-ancestor` (t/4932).

.DESCRIPTION
Quality should-fix (#4679, p/780#29): the az/git calls were previously inlined directly in
`deploy-staging.yml`'s `compare` step, with no way to exercise the az-failure, missing-
DEPLOY_SHA, or merge-base-exit-128 arms without a live Azure subscription and a real git
history. This extracts the same logic into a function that takes the active-revision lookup,
the `az containerapp revision show` call, a git-object-existence check, and
`git merge-base --is-ancestor` as INJECTABLE scriptblocks, so Pester can fake all four and
exercise every arm -- plus real-git integration tests against this repo's own history.

PREDICATE (TL correction, p/916#12/#14, live incident after #4679's first real post-merge
run): "built is NOT an ancestor of current" was the ORIGINAL (wrong) direction -- it also
reads true for a DIVERGED build (a branch build off an older base), which would then PROCEED
and deploy a non-main image to staging. The correct check is the POSITIVE relation:
`git merge-base --is-ancestor <CurrentDeploySha> <BuiltSha>` --
  - exit 0: CurrentDeploySha IS an ancestor of BuiltSha -- BuiltSha genuinely contains
    staging's current history plus more commits -- a real forward deploy.
  - exit 1: CurrentDeploySha is NOT an ancestor of BuiltSha -- either a downgrade (BuiltSha is
    older) OR a diverged build (different branch) -- both must block, and both naturally fall
    into this same exit code, no special-casing needed.
  - anything else (typically 128): one of the two commits doesn't resolve in this checkout.
    Lead/TL (p/916#16/#17): WHICH one is missing matters and is checked explicitly, not
    inferred from merge-base's ambiguous 128:
      - BuiltSha missing: BLOCK. Proceeding would deploy an image this checkout can't even
        verify exists as a real commit -- never a safe default.
      - CurrentDeploySha missing (off-main deploy, force-push, shallow-history edge case):
        PROCEED with a WARN. A main build must always be able to recover staging from a
        deploy that's no longer verifiable against main's history, rather than being
        permanently blocked.

Returns `[PSCustomObject]@{ CurrentSha; ReadFailed; CurrentIsAncestorOfBuilt; BuiltMissing;
CurrentMissing }`:
- No active revision at all (true first deploy): `CurrentSha=''`, `ReadFailed=$false`, the
  three ancestry fields all `$null`/`$false` (nothing to compare -- the caller/verdict
  function treats an empty `CurrentSha` as "first deploy, proceed").
- An active revision exists but `az containerapp revision show` failed (non-zero exit), OR it
  succeeded but no `DEPLOY_SHA` env var was in the response, OR the JSON didn't parse:
  `ReadFailed=$true` (S1, #4679) -- distinct from the no-active-revision case.
- Otherwise: `CurrentSha` is set, `BuiltMissing`/`CurrentMissing` come from
  `GitCommitExistsFn`, and `CurrentIsAncestorOfBuilt` comes from `GitMergeBaseFn`'s exit code
  (only meaningful, i.e. non-null, when neither commit is missing).

.PARAMETER GetActiveRevisionFn
Scriptblock, no args, returning an array of active-revision objects with `Name` and
`TrafficWeight` properties (the live implementation wraps `Get-ContainerAppRevision -Mode Active`).

.PARAMETER AzRevisionShowFn
Scriptblock taking `($RevisionName)`, returning `@{ ExitCode = <int>; Output = <string> }` --
`Output` is the JSON text of `properties.template.containers[0].env` on success, or the error
text on failure. The live implementation must capture `$LASTEXITCODE` itself, immediately after
the native `az` call (S1, #4679: a native command does not throw under
`$ErrorActionPreference='Stop'`), reset `$global:LASTEXITCODE = 0` right after capturing it (a
LIVE INCIDENT after #4679 merged: a leaked native exit code becomes the WHOLE STEP's exit code
with no explicit `exit`, silently failing `gate` even when the script's own logic is correct),
and must filter stderr `[ErrorRecord]` lines out of a `2>&1` capture before returning `Output`
-- mixing them corrupts the JSON even on exit 0 (Quality review, #4679, the t/1500 trap
`Invoke-Az.ps1` documents).

.PARAMETER GitCommitExistsFn
Scriptblock taking `($Sha)`, returning `$true` if `$Sha` resolves to a real commit in this
checkout (the live implementation: `git cat-file -e "$Sha^{commit}"`, exit 0 = exists), `$false`
otherwise. Must also reset `$global:LASTEXITCODE = 0` after capturing its exit code, same
reason as `AzRevisionShowFn`.

.PARAMETER GitMergeBaseFn
Scriptblock taking `($Ancestor, $Descendant)`, returning the exit code (int) of
`git merge-base --is-ancestor $Ancestor $Descendant`. Called as
`& $GitMergeBaseFn $CurrentSha $BuiltSha` -- i.e. "is CurrentSha an ancestor of BuiltSha".
Must also reset `$global:LASTEXITCODE = 0` after capturing its exit code.
#>
function Get-StagingCurrentDeployComparison {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BuiltSha,
        [Parameter(Mandatory)] [scriptblock] $GetActiveRevisionFn,
        [Parameter(Mandatory)] [scriptblock] $AzRevisionShowFn,
        [Parameter(Mandatory)] [scriptblock] $GitCommitExistsFn,
        [Parameter(Mandatory)] [scriptblock] $GitMergeBaseFn
    )

    function _Blank {
        [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $false; CurrentIsAncestorOfBuilt = $null; BuiltMissing = $false; CurrentMissing = $false }
    }
    function _ReadFailed {
        [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $true; CurrentIsAncestorOfBuilt = $null; BuiltMissing = $false; CurrentMissing = $false }
    }

    $Active = @(& $GetActiveRevisionFn)
    if ($Active.Count -eq 0) {
        return _Blank
    }

    $Top = @($Active | Sort-Object -Property TrafficWeight -Descending)[0]
    $AzResult = & $AzRevisionShowFn $Top.Name
    if ($AzResult.ExitCode -ne 0) {
        return _ReadFailed
    }

    try {
        $EnvVars = $AzResult.Output | ConvertFrom-Json
    } catch {
        return _ReadFailed
    }
    $DeployShaVar = @($EnvVars | Where-Object { $_.name -eq 'DEPLOY_SHA' })
    if ($DeployShaVar.Count -eq 0) {
        return _ReadFailed
    }
    $CurrentSha = $DeployShaVar[0].value

    $BuiltExists = [bool](& $GitCommitExistsFn $BuiltSha)
    if (-not $BuiltExists) {
        return [PSCustomObject]@{ CurrentSha = $CurrentSha; ReadFailed = $false; CurrentIsAncestorOfBuilt = $null; BuiltMissing = $true; CurrentMissing = $false }
    }

    $MergeBaseExit = & $GitMergeBaseFn $CurrentSha $BuiltSha
    if ($MergeBaseExit -eq 0) {
        return [PSCustomObject]@{ CurrentSha = $CurrentSha; ReadFailed = $false; CurrentIsAncestorOfBuilt = $true; BuiltMissing = $false; CurrentMissing = $false }
    }
    if ($MergeBaseExit -eq 1) {
        return [PSCustomObject]@{ CurrentSha = $CurrentSha; ReadFailed = $false; CurrentIsAncestorOfBuilt = $false; BuiltMissing = $false; CurrentMissing = $false }
    }
    # Anything else (typically 128): BUILT was already confirmed to exist above, so CURRENT
    # must be the unresolvable one (off-main deploy, force-push, shallow-history edge case).
    return [PSCustomObject]@{ CurrentSha = $CurrentSha; ReadFailed = $false; CurrentIsAncestorOfBuilt = $null; BuiltMissing = $false; CurrentMissing = $true }
}
