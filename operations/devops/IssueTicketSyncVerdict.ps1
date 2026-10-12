# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4150 issue <-> ticket sync report (TL #4).
.DESCRIPTION
    A ticket's `external_url` can point at a GitHub issue, but ticket state lives in Orca and
    issue state lives in GitHub -- nothing keeps the two in sync automatically. The TL's audit
    found 5 of 8 such tickets stale, so this is a real, recurring drift, not a hypothetical.

    Two mismatch classes:
      - A Done ticket (status_category completed/verified) whose linked issue is still OPEN --
        the work finished but the tracking issue was never closed.
      - A NOT-done ticket (backlog/unstarted/started) whose linked issue is already CLOSED --
        the issue was closed (by hand, or by an unrelated PR) while Orca still shows it active.

    A Done ticket with a closed issue, or a not-done ticket with an open issue, is NOT a mismatch
    -- that's the synced, silent case.

    PURE: no I/O. Ticket listing (list_tickets) and issue state (`gh issue view`) are gathered by
    the calling reminder prompt, since Orca ticket state isn't readable from a standalone script.
#>

Set-StrictMode -Version Latest

function Get-IssueTicketSyncVerdict {
    [CmdletBinding()]
    param(
        # Objects with: TicketKey (string), TicketDone (bool), IssueState ('OPEN'|'CLOSED'), IssueUrl (string).
        [AllowEmptyCollection()] [object[]] $Records = @()
    )

    $mismatches = @(
        foreach ($r in $Records) {
            if ($r.TicketDone -and $r.IssueState -eq 'OPEN') {
                [pscustomobject]@{
                    TicketKey = $r.TicketKey
                    IssueUrl  = $r.IssueUrl
                    Kind      = 'done-ticket-open-issue'
                    Message   = "$($r.TicketKey) is Done but its linked issue is still open: $($r.IssueUrl)"
                }
            } elseif (-not $r.TicketDone -and $r.IssueState -eq 'CLOSED') {
                [pscustomobject]@{
                    TicketKey = $r.TicketKey
                    IssueUrl  = $r.IssueUrl
                    Kind      = 'open-ticket-closed-issue'
                    Message   = "$($r.TicketKey) is not Done but its linked issue is closed: $($r.IssueUrl)"
                }
            }
        }
    )

    [pscustomobject]@{
        Mismatches = $mismatches
        Checked    = @($Records).Count
        ShouldAct  = $mismatches.Count -gt 0
    }
}
