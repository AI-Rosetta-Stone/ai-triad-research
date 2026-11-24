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

function Test-TicketHintTrustworthy {
    <#
    .SYNOPSIS
        Should the calling agent trust a branch-derived ticketHint's get_ticket resolution as
        the owner, or fall back to file-ownership resolution (t/4972)?
    .DESCRIPTION
        DevOps Lead finding (p/648#406): low-numbered refs cited in PRs since ~2026-11-10
        (t/37, t/53, t/162, t/224, t/284...) come from a SECOND ticket series -- the PI's
        Interweave tooling -- not Orca. The numbers collide with old, closed Orca tickets, so
        get_ticket resolves them to the wrong thing entirely (a namespace clash, not bad token
        extraction). Confirmed live on r/27#560: every one of 11 sampled ticketHints resolved
        to an unrelated, already-closed May/June 2026 Orca ticket with no connection to the
        PR's actual content.

        Two independent signals, either one is enough to distrust the hint:
          - the ticket's number is below LowNumberFloor (default 1000) -- every confirmed
            second-series collision observed so far is in this range;
          - the ticket resolved as closed/done BEFORE the PR that cites it was even opened --
            an Orca ticket can't be the PR's real tracking ticket if it closed first.
        A ticket that can't be read at all (TicketStatusCategory is $null, e.g. get_ticket
        404'd) is ALSO untrustworthy -- never read an unresolvable ticket as a trusted owner
        source, same fail-closed discipline as the rest of this file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TicketHint,
        [Parameter()]
        [AllowNull()]
        [string]$TicketStatusCategory,
        [Parameter()]
        [AllowNull()]
        [Nullable[datetime]]$TicketClosedAt,
        [Parameter(Mandatory)]
        [datetime]$PrCreatedAt,
        [int]$LowNumberFloor = 1000
    )
    Set-StrictMode -Version Latest

    # A [string] parameter converts a passed $null to '' during binding even with
    # [AllowNull()] -- check both, or an unreadable ticket (the real caller shape) silently
    # passes as trustworthy instead of failing closed.
    if ([string]::IsNullOrEmpty($TicketStatusCategory)) {
        return [pscustomobject]@{ Trustworthy = $false; Reason = "ticket '$TicketHint' could not be read -- never trusted on doubt" }
    }

    if ($TicketHint -match '^t/(\d+)$') {
        $num = [int]$Matches[1]
        if ($num -lt $LowNumberFloor) {
            return [pscustomobject]@{ Trustworthy = $false; Reason = "ticket number $num is below the low-number floor ($LowNumberFloor) -- signature of the second (Interweave) ticket series, not Orca" }
        }
    }

    if ($TicketStatusCategory -eq 'completed' -and $null -ne $TicketClosedAt -and $TicketClosedAt -lt $PrCreatedAt) {
        return [pscustomobject]@{ Trustworthy = $false; Reason = "ticket '$TicketHint' closed at $($TicketClosedAt.ToString('o')), before the PR was opened at $($PrCreatedAt.ToString('o')) -- cannot be the PR's real tracking ticket" }
    }

    return [pscustomobject]@{ Trustworthy = $true; Reason = $null }
}

function Test-IsDraft {
    <#
    .SYNOPSIS
        True if the given PR object (as returned by `gh pr list --json ...,isDraft`) is a draft.
    .DESCRIPTION
        t/4599: a draft PR may still carry a `stuck-pr-alert-owner`/`-tl` label applied
        BEFORE it was converted to draft -- GitHub never removes a label on its own, and
        the classifier (stuck-pr-classifier.mjs) only guards against labelling a NEW
        finding for a draft going forward, not an already-labelled PR that later became
        one. This is the second-layer defense: skip a draft at read time regardless of
        what labels it still carries, same role as Test-IsAwaitingPi above.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Pr
    )
    Set-StrictMode -Version Latest
    # Guard $null the same way Test-IsAwaitingPi guards a $null labels element, before the
    # property access -- strict mode throws on a member access against $null.
    if ($null -eq $Pr) { return $false }
    return [bool]$Pr.isDraft
}
