# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for Get-StuckPRAlerts.ps1 (t/4115): should a PR be skipped as a known,
    non-stuck wait rather than surfaced as an alert?
.DESCRIPTION
    TL correction (p/702#59): once a T2 PR's Second Opinion clears, its `consult-hold` label
    comes off, but the PR still waits in the PI's own approval queue -- a KNOWN wait, not a
    stuck PR, and the sweep was escalating it anyway (owner at 2h, TL at 6h) purely from
    idle time. The TL names that state explicitly with an `awaiting-pi` label. Skip any PR
    carrying it, regardless of alert tier (owner/TL/sweep) -- an explicit, human-applied
    label is the precise signal; this does NOT also pattern-match PR body/comment text for
    phrases like "SO clearing", which would risk skipping a genuinely stuck PR whose body
    happens to mention that phrase in an unrelated context (e.g. a past episode's history).
#>

function Test-IsAwaitingPi {
    <#
    .SYNOPSIS
        True if the given labels array (as returned by `gh pr list --json labels`) carries
        the `awaiting-pi` label.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowNull()]
        [object[]]$Labels
    )
    Set-StrictMode -Version Latest
    # A $null -Labels pipes through as ONE null element (not zero), and $null.name throws
    # under strict mode -- filter nulls out explicitly before the name check.
    return @($Labels | Where-Object { $null -ne $_ } | Where-Object { $_.name -eq 'awaiting-pi' }).Count -gt 0
}
