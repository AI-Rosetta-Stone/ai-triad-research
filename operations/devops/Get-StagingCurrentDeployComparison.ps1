# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Reads staging's current active revision's `DEPLOY_SHA` and compares it against the built SHA
via `git merge-base --is-ancestor` (t/4932).

.DESCRIPTION
Quality should-fix (#4679, p/780#29): the az/git calls were previously inlined directly in
`deploy-staging.yml`'s `compare` step, with no way to exercise the az-failure, missing-
DEPLOY_SHA or merge-base-exit-128 arms without a live Azure subscription and a real git
history. This extracts the same logic into a function that takes the active-revision lookup,
the `az containerapp revision show` call, and `git merge-base --is-ancestor` as INJECTABLE
scriptblocks, so Pester can fake all three and exercise every arm.

Returns `[PSCustomObject]@{ CurrentSha; ReadFailed; IsAncestor; AncestorUnknown }`:
- No active revision at all (true first deploy): `CurrentSha=''`, `ReadFailed=$false`,
  `IsAncestor=$null`, `AncestorUnknown=$false`.
- An active revision exists but `az containerapp revision show` failed (non-zero exit), OR it
  succeeded but no `DEPLOY_SHA` env var was in the response: `ReadFailed=$true` (S1, #4679) --
  distinct from the no-active-revision case.
- Otherwise: `CurrentSha` is set, and `IsAncestor`/`AncestorUnknown` come from the git
  merge-base call's exit code (0=ancestor, 1=not an ancestor, anything else=`AncestorUnknown`,
  S2, #4679).

.PARAMETER GetActiveRevisionFn
Scriptblock, no args, returning an array of active-revision objects with `Name` and
`TrafficWeight` properties (the live implementation wraps `Get-ContainerAppRevision -Mode Active`).

.PARAMETER AzRevisionShowFn
Scriptblock taking `($RevisionName)`, returning `@{ ExitCode = <int>; Output = <string> }` --
`Output` is the JSON text of `properties.template.containers[0].env` on success, or the error
text on failure. The live implementation must capture `$LASTEXITCODE` itself, immediately after
the native `az` call (S1, #4679: a native command does not throw under
`$ErrorActionPreference='Stop'`), and must filter stderr `[ErrorRecord]` lines out of a `2>&1`
capture before returning `Output` -- mixing them corrupts the JSON even on exit 0 (Quality
review, #4679, the same t/1500 trap `Invoke-Az.ps1` documents: `az` can emit warnings to stderr
on an otherwise-successful call).

.PARAMETER GitMergeBaseFn
Scriptblock taking `($BuiltSha, $CurrentSha)`, returning the exit code (int) of
`git merge-base --is-ancestor $BuiltSha $CurrentSha`.
#>
function Get-StagingCurrentDeployComparison {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BuiltSha,
        [Parameter(Mandatory)] [scriptblock] $GetActiveRevisionFn,
        [Parameter(Mandatory)] [scriptblock] $AzRevisionShowFn,
        [Parameter(Mandatory)] [scriptblock] $GitMergeBaseFn
    )

    $Active = @(& $GetActiveRevisionFn)
    if ($Active.Count -eq 0) {
        return [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $false; IsAncestor = $null; AncestorUnknown = $false }
    }

    $Top = @($Active | Sort-Object -Property TrafficWeight -Descending)[0]
    $AzResult = & $AzRevisionShowFn $Top.Name
    if ($AzResult.ExitCode -ne 0) {
        return [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $true; IsAncestor = $null; AncestorUnknown = $false }
    }

    # Quality should-fix (#4679, p/780#29): exit 0 does not guarantee $AzResult.Output is valid
    # JSON -- a stderr warning the caller failed to filter out of a 2>&1 capture corrupts it
    # (the t/1500 trap Invoke-Az.ps1 documents). A parse failure is ReadFailed, same as an az
    # exit failure, never an uncaught exception.
    try {
        $EnvVars = $AzResult.Output | ConvertFrom-Json
    } catch {
        return [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $true; IsAncestor = $null; AncestorUnknown = $false }
    }
    $DeployShaVar = @($EnvVars | Where-Object { $_.name -eq 'DEPLOY_SHA' })
    if ($DeployShaVar.Count -eq 0) {
        return [PSCustomObject]@{ CurrentSha = ''; ReadFailed = $true; IsAncestor = $null; AncestorUnknown = $false }
    }

    $CurrentSha = $DeployShaVar[0].value
    $MergeBaseExit = & $GitMergeBaseFn $BuiltSha $CurrentSha
    $IsAncestor = ($MergeBaseExit -eq 0)
    $Unknown = ($MergeBaseExit -ne 0 -and $MergeBaseExit -ne 1)
    return [PSCustomObject]@{ CurrentSha = $CurrentSha; ReadFailed = $false; IsAncestor = $IsAncestor; AncestorUnknown = $Unknown }
}
