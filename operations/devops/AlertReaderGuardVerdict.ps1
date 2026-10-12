# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate shared by the three alert-reader bridges (t/4156, t/4096#37 move-day finding).
.DESCRIPTION
    After the org transfer, GraphQL `gh issue list` / `gh pr list` against the old `jpsnover/...`
    repo name returned 0 results with NO error, so Get-CiAlertEscalations.ps1,
    Get-DataComplianceWatchdog.ps1 and Get-StuckPRAlerts.ps1 all read a renamed/unresolvable repo
    as "nothing to report" instead of "can't tell". A silent zero looks identical to a genuine
    all-clear; this predicate turns that ambiguity into an explicit QueryError.

    Two independent checks, either one alone is enough to call the query blind:
      1. Canonical-name check: the REST `repos/<Repo>` call follows redirects, so its `full_name`
         differs from the queried `-Repo` exactly when the repo was renamed or transferred.
      2. Sanity floor: each reader filters by a label that has unquestionably been applied at
         least once, ever (main-ci-monitor-heartbeat / data-compliance / stuck-pr-alert-owner).
         An all-states count of 0 for that label means the query itself is blind, independent of
         whether the repo name resolved -- a belt-and-suspenders check for any other silent-zero
         path the name check doesn't cover.

    FAIL-SAFE: a failed/empty name resolution (the `gh api` call itself failed) is blind, not
    healthy -- absence of proof of a matching name is not a matching name.

    PURE: no I/O. The `gh api repos/<Repo> -q .full_name` and `gh issue/pr list --state all
    --label <FloorLabel> --limit 1` calls live in each Get-*.ps1 reader.
#>

Set-StrictMode -Version Latest

function Get-AlertReaderGuardVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Repo,
        # `full_name` from `gh api repos/<Repo> -q .full_name`, or $null/empty if that call failed.
        [AllowNull()][AllowEmptyString()] [string] $ResolvedFullName,
        [Parameter(Mandatory)] [string] $FloorLabel,
        # All-states count of PRs/issues ever carrying $FloorLabel.
        [int] $FloorLabelAllStatesCount = 0
    )

    if ([string]::IsNullOrWhiteSpace($ResolvedFullName)) {
        return [pscustomobject]@{
            IsBlind = $true
            Reason  = "repo unresolvable: gh api repos/$Repo returned no full_name"
        }
    }

    if ($ResolvedFullName.ToLowerInvariant() -ne $Repo.ToLowerInvariant()) {
        return [pscustomobject]@{
            IsBlind = $true
            Reason  = "repo renamed or transferred: $Repo is now $ResolvedFullName"
        }
    }

    if ($FloorLabelAllStatesCount -le 0) {
        return [pscustomobject]@{
            IsBlind = $true
            Reason  = "label history empty; query is blind (label=$FloorLabel)"
        }
    }

    [pscustomobject]@{ IsBlind = $false; Reason = $null }
}
