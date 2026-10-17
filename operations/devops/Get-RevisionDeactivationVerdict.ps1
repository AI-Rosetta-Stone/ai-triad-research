# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicates for the t/4242 "never deactivate a revision with weight > 0" guard.

.DESCRIPTION
    `Get-RevisionDeactivationVerdict` takes a single candidate revision (already queried from
    Azure) plus the names that must never be touched, and returns a verdict — it does not call
    Azure itself, so it's testable without any live state.

    Returns one of:
      - 'deactivate' — safe: known-zero on BOTH the revision's own trafficWeight AND the ingress
                        traffic config, not the latest-revision traffic target, Active, not the
                        serving revision, not explicitly protected.
      - 'skip'        — any of: unknown weight on either source (SO C3: unknown is never read as
                        0), weight > 0 on either source (SO C1), is the latest-revision traffic
                        target (SO C1), not Active, name matches -ServingRevisionName, or name is
                        in -ProtectedNames.

    SO review (p/682#33, PR #3367): the first version of this predicate re-checked only
    `properties.trafficWeight` immediately before each deactivate call. That closes "the earlier
    LIST read was cached", but `trafficWeight` is itself a value Azure DERIVES from the app's
    ingress traffic config (`properties.configuration.ingress.traffic`) — if the read-after-write
    lag (t/4242's leading root-cause hypothesis) is in that derivation, a second read of the same
    derived field a few hundred ms later can still be stale. This predicate now requires BOTH
    independently-sourced weights to agree the candidate is safe, and separately checks whether
    the candidate is the target of a `latestRevision: true` ingress-traffic entry — such an entry
    carries traffic with NO `revisionName` at all, invisible to any name-based guard.

    The caller is responsible for querying BOTH sources fresh, immediately before the actual
    deactivate call — not reusing an earlier list read for either input.

.NOTES
    `weight -eq 100` elsewhere in this fix's post-deploy check assumes there is never a canary
    traffic split (two revisions both > 0% at once) — true today. If canary deploys are
    introduced, that assumption, and this predicate's "weight > 0 always skips" rule, both need
    revisiting (SO C4).
#>

function Get-IngressTrafficWeightForRevision {
    <#
    .SYNOPSIS
        Computes a candidate revision's weight per the app's INGRESS TRAFFIC CONFIG (the routing
        source), separately from whatever `revision show`'s own `trafficWeight` field reports —
        SO C1's "check the routing source too", kept pure and testable on its own.
    .PARAMETER TrafficEntries
        The app's `properties.configuration.ingress.traffic` array (each entry has an optional
        `revisionName`, a `weight`, and an optional `latestRevision` bool) — or $null if the query
        that would have produced it failed/returned nothing. $null is NOT the same as an empty
        array: an empty array is a validly-queried "no entries", $null means "couldn't tell".
    .PARAMETER LatestRevisionName
        The app's `properties.latestRevisionName` — needed to tell whether THIS candidate is the
        one a `latestRevision: true` entry would actually route to.
    #>
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName,

        [AllowNull()]
        $TrafficEntries,

        [string]$LatestRevisionName
    )

    if ($null -eq $TrafficEntries) {
        return [PSCustomObject]@{ IngressWeight = $null; IsLatestRevisionWithTraffic = $false }
    }

    $named = @($TrafficEntries | Where-Object {
        $_.PSObject.Properties['revisionName'] -and $_.revisionName -eq $RevisionName
    })
    $namedWeight = 0
    foreach ($e in $named) {
        if ($e.PSObject.Properties['weight']) { $namedWeight += [int]$e.weight }
    }

    $latestEntries = @($TrafficEntries | Where-Object {
        $_.PSObject.Properties['latestRevision'] -and [bool]$_.latestRevision
    })
    $latestWeight = 0
    foreach ($e in $latestEntries) {
        if ($e.PSObject.Properties['weight']) { $latestWeight += [int]$e.weight }
    }
    # SO C1b (p/682#36): a latestRevision:true entry WITH traffic, but an unknown LatestRevisionName
    # (couldn't be read), must NOT fall through to "not protected" — we cannot rule out that THIS
    # candidate is the one it targets, so conservatively flag it as protected too.
    $isLatestWithTraffic = $false
    if ($latestWeight -gt 0) {
        $isLatestWithTraffic = if ([string]::IsNullOrWhiteSpace($LatestRevisionName)) { $true } else { $RevisionName -eq $LatestRevisionName }
    }

    return [PSCustomObject]@{ IngressWeight = $namedWeight; IsLatestRevisionWithTraffic = $isLatestWithTraffic }
}

function Get-RevisionDeactivationVerdict {
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName,

        [Parameter(Mandatory)]
        [AllowNull()]
        [Nullable[int]]$TrafficWeight,

        [bool]$Active = $true,

        [Parameter(Mandatory)]
        [AllowNull()]
        [Nullable[int]]$IngressWeight,

        [bool]$IsLatestRevisionWithTraffic = $false,

        [string]$ServingRevisionName,

        [string[]]$ProtectedNames = @()
    )

    # SO C3: an unknown weight is never read as 0 — skip, don't deactivate, on either source.
    if ($null -eq $TrafficWeight) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'unknown-traffic-weight'; RevisionName = $RevisionName }
    }
    if ($TrafficWeight -gt 0) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'nonzero-traffic-weight'; RevisionName = $RevisionName }
    }
    # SO C1: the routing source must independently agree — a stale-but-matching revision-show
    # read is not enough on its own.
    if ($null -eq $IngressWeight) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'unknown-ingress-weight'; RevisionName = $RevisionName }
    }
    if ($IngressWeight -gt 0) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'nonzero-ingress-weight'; RevisionName = $RevisionName }
    }
    if ($IsLatestRevisionWithTraffic) {
        return [PSCustomObject]@{ Action = 'skip'; Reason = 'latest-revision-with-traffic'; RevisionName = $RevisionName }
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
