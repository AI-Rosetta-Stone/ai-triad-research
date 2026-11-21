# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Tag: powershell (t/4115)

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'StuckPRAlertFilter.ps1')
}

Describe 'Test-IsAwaitingPi (t/4115, TL p/702#59 noise-reduction)' -Tag 'powershell' {

    It 'is true when the labels array carries awaiting-pi' {
        $labels = @(
            [pscustomobject]@{ name = 'consult-hold' }
            [pscustomobject]@{ name = 'awaiting-pi' }
        )
        Test-IsAwaitingPi -Labels $labels | Should -BeTrue
    }

    It 'is false when awaiting-pi is absent, even with other labels present' {
        $labels = @(
            [pscustomobject]@{ name = 'consult-hold' }
            [pscustomobject]@{ name = 'stuck-pr-alert-owner' }
        )
        Test-IsAwaitingPi -Labels $labels | Should -BeFalse
    }

    It 'is false for an empty labels array' {
        Test-IsAwaitingPi -Labels @() | Should -BeFalse
    }

    It 'is false for a null labels value (never throws under strict mode)' {
        Test-IsAwaitingPi -Labels $null | Should -BeFalse
    }

    It 'matches the label name case-insensitively (PowerShell -eq default; GitHub label casing is not guaranteed to be preserved verbatim everywhere)' {
        $labels = @([pscustomobject]@{ name = 'Awaiting-PI' })
        Test-IsAwaitingPi -Labels $labels | Should -BeTrue
    }

    It 'is false for a label list containing an unrelated label whose name only partially overlaps' {
        $labels = @([pscustomobject]@{ name = 'awaiting-pi-review' })
        Test-IsAwaitingPi -Labels $labels | Should -BeFalse
    }
}

Describe 'Test-TicketHintTrustworthy (t/4972, second-ticket-series namespace clash)' -Tag 'powershell' {

    It 'distrusts a ticket number below the low-number floor, even if it reads as open' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/162' -TicketStatusCategory 'started' -TicketClosedAt $null -PrCreatedAt (Get-Date '2026-11-20')
        $r.Trustworthy | Should -BeFalse
        $r.Reason | Should -Match 'low-number floor'
    }

    It 'distrusts the real #5199 shape: a closed ticket that closed before the PR was opened' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/5500' -TicketStatusCategory 'completed' -TicketClosedAt (Get-Date '2026-05-25T19:27:37Z') -PrCreatedAt (Get-Date '2026-11-18T00:00:00Z') -LowNumberFloor 1000
        $r.Trustworthy | Should -BeFalse
        $r.Reason | Should -Match 'before the PR was opened'
    }

    It 'distrusts a ticket that could not be read at all (fail closed, never trusted on doubt)' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/9999' -TicketStatusCategory $null -TicketClosedAt $null -PrCreatedAt (Get-Date '2026-11-20')
        $r.Trustworthy | Should -BeFalse
        $r.Reason | Should -Match 'could not be read'
    }

    It 'trusts a normal, still-open, correctly-numbered ticketHint (no regression)' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/4958' -TicketStatusCategory 'started' -TicketClosedAt $null -PrCreatedAt (Get-Date '2026-11-20')
        $r.Trustworthy | Should -BeTrue
        $r.Reason | Should -BeNullOrEmpty
    }

    It 'trusts a closed ticket whose close postdates the PR (a real ticket that just happened to close after, e.g. same-day merge)' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/4970' -TicketStatusCategory 'completed' -TicketClosedAt (Get-Date '2026-11-21T13:00:00Z') -PrCreatedAt (Get-Date '2026-11-21T12:00:00Z')
        $r.Trustworthy | Should -BeTrue
    }

    It 'a non-numeric ticketHint shape skips the low-number check without throwing' {
        $r = Test-TicketHintTrustworthy -TicketHint 't/abc' -TicketStatusCategory 'started' -TicketClosedAt $null -PrCreatedAt (Get-Date '2026-11-20')
        $r.Trustworthy | Should -BeTrue
    }
}

Describe 'Test-IsDraft (t/4599, second-layer defense against a stale label on a now-draft PR)' -Tag 'powershell' {

    It 'is true when the PR object carries isDraft true' {
        Test-IsDraft -Pr ([pscustomobject]@{ isDraft = $true }) | Should -BeTrue
    }

    It 'is false when isDraft is false' {
        Test-IsDraft -Pr ([pscustomobject]@{ isDraft = $false }) | Should -BeFalse
    }

    It 'is false for a null PR value (never throws under strict mode)' {
        Test-IsDraft -Pr $null | Should -BeFalse
    }

    It 'still correctly identifies a draft PR that also carries a stuck-pr-alert label (the t/4007 shape)' {
        $pr = [pscustomobject]@{
            isDraft = $true
            labels  = @([pscustomobject]@{ name = 'stuck-pr-alert-tl' })
        }
        Test-IsDraft -Pr $pr | Should -BeTrue
    }
}
