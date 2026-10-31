# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    PURE predicate (no I/O) for t/4587 part (b): decide whether a GitHub App installation's
    remaining rate-limit quota, read from the running app's own /health, warrants a
    pre-traffic-shift warning.
.DESCRIPTION
    Called right before deploy-azure.yml / deploy-staging.yml shift traffic to a new revision.
    Reads /health's existing githubRateLimitRemaining / githubRateLimitResetsAt fields rather
    than minting a fresh installation token (e/406: the SO dissented against granting the
    deploy identity any new Key Vault secret-read access -- this needs no new secret access
    at all). Warn-only (T1, non-blocking) per the ticket's own tier call.

    Every failure arm is distinct and never silently reads as healthy (SO e/406#4 point 3):
    a failed query, a missing remaining field, and a stale reading each warn for their own
    reason, before the quota-low/healthy comparison is even reached.
.PARAMETER Remaining
    The /health response's githubRateLimitRemaining, or $null if absent/non-numeric.
.PARAMETER Ceiling
    The warning threshold. Default 1000 per t/4587's own ask.
.PARAMETER QueryError
    Set when the /health query itself failed (non-2xx, timeout, unparseable body). Takes
    precedence over Remaining -- a failed query must never be silently treated as "quota fine."
.PARAMETER ResetsAt
    /health's githubRateLimitResetsAt (nullable datetime). Not itself a staleness signal on
    its own, but used by the interim rule below until t/4699 (githubRateLimitObservedAt) lands.
.PARAMETER Now
    Wall-clock reference, in UTC. Defaults to the real UTC now; override in tests.
.PARAMETER StaleIfResetInPast
    TL ruling (e/406#5), interim until t/4699: if ResetsAt is in the past, the reading predates
    the current rate-limit window and must be treated as stale, not healthy -- GitHub's own
    rate_limit resets hourly, so a resetsAt that has already passed means nothing has refreshed
    this number since before the window rolled over.
#>
function Get-GitHubAppQuotaVerdict {
    [CmdletBinding()]
    param(
        [Nullable[int]] $Remaining = $null,
        [int] $Ceiling = 1000,
        [string] $QueryError = $null,
        [Nullable[datetime]] $ResetsAt = $null,
        [datetime] $Now = (Get-Date).ToUniversalTime(),
        [bool] $StaleIfResetInPast = $true
    )
    if ($QueryError) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'query-failed'
            Reason     = "could not read /health's rate-limit fields: $QueryError -- treat as UNKNOWN, not healthy"
        }
    }
    if ($null -eq $Remaining) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'field-missing'
            Reason     = "/health had no usable githubRateLimitRemaining value -- treat as UNKNOWN, not healthy"
        }
    }
    if ($StaleIfResetInPast -and $ResetsAt -and $ResetsAt -lt $Now) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'stale'
            Reason     = "githubRateLimitResetsAt ($ResetsAt) is in the past relative to Now ($Now) -- the reading predates the current rate-limit window, not a reliable signal (interim rule pending t/4699's observedAt field)"
        }
    }
    if ($Remaining -lt $Ceiling) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'quota-low'
            Reason     = "installation has $Remaining remaining, under the $Ceiling ceiling -- a cold boot or concurrent deploy could exhaust it mid-sync"
        }
    }
    [PSCustomObject]@{
        ShouldWarn = $false
        Kind       = 'healthy'
        Reason     = "installation has $Remaining remaining, at or above the $Ceiling ceiling"
    }
}
