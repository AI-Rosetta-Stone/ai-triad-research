# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4242 "never deactivate a revision with weight > 0" guard.

.DESCRIPTION
    `Get-RevisionDeactivationVerdict` takes a single candidate revision (already queried from
    Azure) plus the names that must never be touched, and returns a verdict — it does not call
    Azure itself, so it's testable without any live state.

    Returns one of:
      - 'deactivate' — safe: Active, weight 0, not the serving revision, not explicitly protected.
      - 'skip'        — any of: weight > 0 (t/4242's own trigger condition), name matches
                        -ServingRevisionName, name is in -ProtectedNames, or not Active.

    Deliberately conservative: weight > 0 always wins over every other field, including a
    malformed/missing Active flag — t/4242's incident was exactly a revision that still held
    100% traffic. This function does not know whether its own TrafficWeight input is FRESH (the
    t/4242 root-cause candidate: Azure's read-after-write propagation lag) — the caller is
    responsible for re-querying the candidate with a fresh `revision show` immediately before the
    actual deactivate call and feeding that fresh TrafficWeight in, not an earlier cached one.
#>

function Get-RevisionDeactivationVerdict {
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName,

        [Parameter(Mandatory)]
        [int]$TrafficWeight,

        [bool]$Active = $true,

        [string]$ServingRevisionName,

        [string[]]$ProtectedNames = @()
    )

    if ($TrafficWeight -gt 0) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'nonzero-traffic-weight'; RevisionName = $RevisionName }
    }
    if (-not $Active) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'already-inactive'; RevisionName = $RevisionName }
    }
    if ($ServingRevisionName -and $RevisionName -eq $ServingRevisionName) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'is-serving-revision'; RevisionName = $RevisionName }
    }
    if ($ProtectedNames -contains $RevisionName) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'explicitly-protected'; RevisionName = $RevisionName }
    }
    return [PSCustomObject]@{ Action = 'deactivate'; Reason = 'stale-zero-weight-unprotected'; RevisionName = $RevisionName }
}
