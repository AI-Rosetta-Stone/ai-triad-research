# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    PURE predicate (no I/O) for t/4587 part (b): decide whether a GitHub App installation's
    remaining rate-limit quota warrants a pre-traffic-shift warning.
.DESCRIPTION
    Called by check-github-app-quota.ps1 (the impure script that mints a token and queries
    GET /rate_limit) right before deploy-azure.yml / deploy-staging.yml shift traffic to a
    new revision. Warn-only (T1, non-blocking) per the ticket's own tier call.
.PARAMETER Remaining
    The installation token's remaining rate-limit count from GET /rate_limit, or $null if the
    query itself failed (never read a query failure as "healthy" -- that is its own warning).
.PARAMETER Ceiling
    The warning threshold. Default 1000 per t/4587's own ask.
.PARAMETER QueryError
    Set when the rate_limit query (or the token mint before it) failed. Takes precedence over
    Remaining -- a failed query must never be silently treated as "quota fine."
#>
function Get-GitHubAppQuotaVerdict {
    [CmdletBinding()]
    param(
        [Nullable[int]] $Remaining = $null,
        [int] $Ceiling = 1000,
        [string] $QueryError = $null
    )
    if ($QueryError) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'query-failed'
            Reason     = "could not read installation rate-limit quota: $QueryError -- treat as UNKNOWN, not healthy"
        }
    }
    if ($null -eq $Remaining) {
        return [PSCustomObject]@{
            ShouldWarn = $true
            Kind       = 'field-missing'
            Reason     = 'rate_limit response had no usable remaining count -- treat as UNKNOWN, not healthy'
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
