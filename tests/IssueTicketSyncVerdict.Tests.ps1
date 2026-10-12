# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms proof for the t/4150 issue <-> ticket sync predicate: a seeded mismatch (either
# direction) must surface (ShouldAct); a synced pair must stay silent.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'IssueTicketSyncVerdict.ps1')
}

Describe 'Get-IssueTicketSyncVerdict' {
    It 'is quiet when a Done ticket links a closed issue (synced)' {
        $r = [pscustomobject]@{ TicketKey = 't/1'; TicketDone = $true; IssueState = 'CLOSED'; IssueUrl = 'u1' }
        $v = Get-IssueTicketSyncVerdict -Records @($r)
        $v.ShouldAct | Should -BeFalse
        @($v.Mismatches).Count | Should -Be 0
        $v.Checked | Should -Be 1
    }
    It 'is quiet when a not-done ticket links an open issue (synced)' {
        $r = [pscustomobject]@{ TicketKey = 't/2'; TicketDone = $false; IssueState = 'OPEN'; IssueUrl = 'u2' }
        $v = Get-IssueTicketSyncVerdict -Records @($r)
        $v.ShouldAct | Should -BeFalse
        @($v.Mismatches).Count | Should -Be 0
    }
    It 'surfaces a Done ticket whose issue is still open' {
        $r = [pscustomobject]@{ TicketKey = 't/3'; TicketDone = $true; IssueState = 'OPEN'; IssueUrl = 'u3' }
        $v = Get-IssueTicketSyncVerdict -Records @($r)
        $v.ShouldAct | Should -BeTrue
        @($v.Mismatches).Count | Should -Be 1
        $v.Mismatches[0].Kind | Should -Be 'done-ticket-open-issue'
        $v.Mismatches[0].TicketKey | Should -Be 't/3'
    }
    It 'surfaces a not-done ticket whose issue is already closed' {
        $r = [pscustomobject]@{ TicketKey = 't/4'; TicketDone = $false; IssueState = 'CLOSED'; IssueUrl = 'u4' }
        $v = Get-IssueTicketSyncVerdict -Records @($r)
        $v.ShouldAct | Should -BeTrue
        @($v.Mismatches).Count | Should -Be 1
        $v.Mismatches[0].Kind | Should -Be 'open-ticket-closed-issue'
    }
    It 'is quiet on an empty record set' {
        $v = Get-IssueTicketSyncVerdict -Records @()
        $v.ShouldAct | Should -BeFalse
        $v.Checked | Should -Be 0
    }
    It 'reports one mismatch per offending record in a mixed batch, not a global flag' {
        $records = @(
            [pscustomobject]@{ TicketKey = 't/5'; TicketDone = $true; IssueState = 'CLOSED'; IssueUrl = 'u5' }   # synced
            [pscustomobject]@{ TicketKey = 't/6'; TicketDone = $true; IssueState = 'OPEN'; IssueUrl = 'u6' }     # mismatch
            [pscustomobject]@{ TicketKey = 't/7'; TicketDone = $false; IssueState = 'CLOSED'; IssueUrl = 'u7' }  # mismatch
        )
        $v = Get-IssueTicketSyncVerdict -Records $records
        $v.ShouldAct | Should -BeTrue
        $v.Checked | Should -Be 3
        @($v.Mismatches).Count | Should -Be 2
        ($v.Mismatches | ForEach-Object { $_.TicketKey }) | Should -Contain 't/6'
        ($v.Mismatches | ForEach-Object { $_.TicketKey }) | Should -Contain 't/7'
    }
}
