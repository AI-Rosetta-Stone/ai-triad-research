#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4194 deploy-race wait-gate (t/4233): which "other" workflow runs
    count as EARLIER than this run.
.DESCRIPTION
    Dot-sourced by both deploy-azure.yml and deploy-staging.yml's wait-gate steps (previously
    duplicated inline in each workflow). Order is by `startedAt`, with ties on `startedAt`
    broken by `databaseId` (lower = earlier) — GitHub run IDs are monotonically increasing, so
    this gives a total order even when two runs start in the same second, which `startedAt`
    alone (second-precision) cannot.

    Without the tie-break, a same-second tie lets both runs see each other as "not earlier",
    and both proceed — defeating the ordering gate SO C1a relies on (exactly one of any two
    near-simultaneous runs must wait).

    Caller contract: each entry in -Others, and the run described by -OwnStartedAt/
    -OwnDatabaseId, is assumed to be a DIFFERENT run (never compare a run to itself) — so for
    two distinct same-second runs, the predicate is antisymmetric: given A and B with equal
    startedAt and different databaseId, exactly one of "A earlier-than B" / "B earlier-than A"
    is true.
.PARAMETER OwnStartedAt
    This run's own `run_started_at` (API) / `startedAt` (gh run list), as a [datetimeoffset].
.PARAMETER OwnDatabaseId
    This run's own GitHub Actions run ID (`$env:GITHUB_RUN_ID`), as an [int64].
.PARAMETER Others
    The other workflow's in-progress runs (e.g. `gh run list --json databaseId,startedAt`,
    already parsed via ConvertFrom-Json). Each entry must expose .startedAt and .databaseId.
.OUTPUTS
    object[] — the subset of -Others that is earlier than this run.
#>
function Get-DeployRaceEarlierRuns {
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)]
        [datetimeoffset] $OwnStartedAt,

        [Parameter(Mandatory)]
        [int64] $OwnDatabaseId,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]] $Others
    )

    # Caller MUST wrap the call in @() (`@(Get-DeployRaceEarlierRuns ...)`), same as every other
    # possibly-zero/possibly-one-element pipeline result in this repo (PreToolUse strict-mode
    # .Count guard). A function's own @() here only protects .Where-Object from $null on zero
    # matches — it does NOT protect an un-wrapped caller, since "return"-ing a 1-element array
    # unwraps to the bare element on the pipeline. (-NoEnumerate / a leading comma were tried to
    # make the function safe for an un-wrapped caller too, but both double-wrap the zero-match
    # case once the caller also wraps with @() — rejected; see t/4233 PR history.)
    return @($Others | Where-Object {
        $otherStartedAt  = [datetimeoffset]$_.startedAt
        $otherDatabaseId = [int64]$_.databaseId
        ($otherStartedAt -lt $OwnStartedAt) -or
        ($otherStartedAt -eq $OwnStartedAt -and $otherDatabaseId -lt $OwnDatabaseId)
    })
}
