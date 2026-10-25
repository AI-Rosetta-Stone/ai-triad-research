# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Gate-Verification arms for the shared DATA-checkout drift predicate (t/4005).
.DESCRIPTION
    Detection-only — this predicate never commits, deletes, or syncs anything. These tests
    prove: a fresh untracked file under the age threshold stays quiet; an old one alarms; a
    tracked-WIP intersection alarms; an untracked/incoming-add collision alarms; a diverged
    checkout alarms; behind-only with no intersection stays quiet (info-only); and a missing
    mtime fails safe (reads as old, not as fresh).
#>

Describe 'Get-DataCheckoutDriftVerdict (t/4005)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/DataCheckoutDriftVerdict.ps1"
        $script:Now = Get-Date '2026-10-06T12:00:00Z'
    }

    It 'QUIET: a fresh untracked file under the threshold' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Untracked @('new-source.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-1)) -Now $script:Now
        $v.Alarm | Should -BeFalse
        $v.AgeHours | Should -BeLessThan 24
        @($v.Reasons).Count | Should -Be 0
    }

    It 'ALARM: a 25h-old uncommitted file' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Untracked @('stale-source.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-25)) -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.AgeHours | Should -BeGreaterThan 24
        $v.Reasons -join ' ' | Should -Match 'stale-source\.json'
        $v.Reasons -join ' ' | Should -Match 'older than'
    }

    It 'ALARM: names the specific oldest file separately from a fresher file in the same list (t/4005, p/210#152)' {
        # One genuinely 97h-old file plus one 3h-old file in the same dirty set -- the message
        # must not read as if the 3h-old file shares the 97h-old file's age.
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -Untracked @('cache/stale-cache.json', 'taxonomy/Origin/fresh.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-97)) -OldestUncommittedPath 'cache/stale-cache.json' `
            -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.Reasons -join ' ' | Should -Match 'oldest: cache/stale-cache\.json'
        $v.Reasons -join ' ' | Should -Match 'ages vary'
    }

    It 'ALARM: falls back to the old wording when OldestUncommittedPath is not supplied (back-compat)' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Untracked @('stale-source.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-25)) -Now $script:Now
        $v.Reasons -join ' ' | Should -Not -Match 'ages vary'
        $v.Reasons -join ' ' | Should -Match '\(oldest age:'
    }

    It 'QUIET: exactly at the threshold boundary does not alarm (strictly greater-than)' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Untracked @('boundary.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-24)) -Now $script:Now
        $v.Alarm | Should -BeFalse
    }

    It 'ALARM: tracked-modified intersects the incoming change-set' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -TrackedModified @('taxonomy/Origin/accelerationist.json') `
            -Untracked @() -OldestUncommittedMtime ($script:Now.AddHours(-1)) `
            -Behind 3 -IncomingPaths @('taxonomy/Origin/accelerationist.json', 'other.json') -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.Intersects | Should -BeTrue
        $v.Reasons -join ' ' | Should -Match 'tracked-modified intersects'
        $v.Reasons -join ' ' | Should -Match 'accelerationist\.json'
    }

    It 'ALARM: an untracked file collides with an incoming add' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-sources' `
            -Untracked @('newly-ingested.json') -OldestUncommittedMtime ($script:Now.AddHours(-1)) `
            -Behind 2 -IncomingPaths @('newly-ingested.json') -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.Intersects | Should -BeTrue
        $v.Reasons -join ' ' | Should -Match 'collide with an incoming add'
        $v.Reasons -join ' ' | Should -Match 'newly-ingested\.json'
    }

    It 'ALARM: a diverged checkout (ahead > 0 AND behind > 0)' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Ahead 2 -Behind 5 -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.Diverged | Should -BeTrue
        $v.Reasons -join ' ' | Should -Match 'DIVERGED'
    }

    It 'QUIET: behind-only with no intersection is info, not an alarm' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Ahead 0 -Behind 7 `
            -IncomingPaths @('unrelated-file.json') -Now $script:Now
        $v.Alarm | Should -BeFalse
        $v.Diverged | Should -BeFalse
        $v.Intersects | Should -BeFalse
        $v.Reasons -join ' ' | Should -Match '\(info\).*behind origin by 7'
    }

    It 'FAIL-SAFE: uncommitted work with an unreadable (null) mtime reads as OLD, not fresh' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-sources' -Untracked @('unreadable-mtime.json') `
            -OldestUncommittedMtime $null -Now $script:Now
        $v.Alarm | Should -BeTrue
        [double]::IsPositiveInfinity($v.AgeHours) | Should -BeTrue
        $v.Reasons -join ' ' | Should -Match 'mtime unreadable'
    }

    It 'QUIET: nothing uncommitted, nothing behind, not ahead — fully clean' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Now $script:Now
        $v.Alarm | Should -BeFalse
        @($v.Reasons).Count | Should -Be 0
        $v.AgeHours | Should -Be 0
    }

    It 'intersection and divergence can fire TOGETHER, independently reported' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -TrackedModified @('a.json') -OldestUncommittedMtime ($script:Now.AddHours(-1)) `
            -Ahead 1 -Behind 3 -IncomingPaths @('a.json') -Now $script:Now
        $v.Alarm | Should -BeTrue
        $v.Intersects | Should -BeTrue
        $v.Diverged | Should -BeTrue
        @($v.Reasons).Count | Should -Be 2
    }

    It 'Reasons caps the listed file names at 20' {
        $many = 1..25 | ForEach-Object { "file-$_.json" }
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Untracked $many `
            -OldestUncommittedMtime ($script:Now.AddHours(-30)) -Now $script:Now
        $v.Alarm | Should -BeTrue
        ($v.Reasons -join ' ' | Select-String -Pattern 'file-\d+\.json' -AllMatches).Matches.Count | Should -Be 20
    }

    # t/4056, SO e/270#2: a dirty taxonomy/Origin/pov-tag-proposals.json is reviewer
    # work-in-progress a sync/restore must never discard. Protected WIP must block the sync
    # REGARDLESS of the ordinary intersection/staleness/divergence result -- these arms use a
    # FRESH, non-intersecting, non-diverged tree specifically so the only possible alarm
    # source is the protected-WIP check itself, not an incidental other reason.
    It 'ALARM (PROTECTED WIP): a dirty protected path blocks sync even on an otherwise-clean, ff-able tree' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -TrackedModified @('taxonomy/Origin/pov-tag-proposals.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-1)) -Ahead 0 -Behind 2 `
            -IncomingPaths @('unrelated.json') -Now $script:Now
        $v.Alarm | Should -BeTrue
        @($v.ProtectedWip).Count | Should -Be 1
        $v.ProtectedWip[0].Path | Should -Be 'taxonomy/Origin/pov-tag-proposals.json'
        $v.ProtectedWip[0].Owner | Should -Be 'Computational Linguist'
        $v.SyncReason | Should -Match 'protected WIP'
        $v.SyncReason | Should -Match 'Computational Linguist'
        $v.SyncReason | Should -Match 'do not sync/restore'
        $v.Intersects | Should -BeFalse
        $v.Diverged | Should -BeFalse
        $v.Reasons -join ' ' | Should -Match 'protected WIP'
    }

    It 'QUIET: the same path clean (not in TrackedModified/Untracked) behaves as today -- no ProtectedWip, no SyncReason' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' -Ahead 0 -Behind 2 `
            -IncomingPaths @('taxonomy/Origin/pov-tag-proposals.json') -Now $script:Now
        $v.Alarm | Should -BeFalse
        @($v.ProtectedWip).Count | Should -Be 0
        $v.SyncReason | Should -BeNullOrEmpty
    }

    It 'ALARM (PROTECTED WIP): an UNTRACKED protected path also blocks sync' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -Untracked @('taxonomy/Origin/pov-tag-proposals.json') `
            -OldestUncommittedMtime ($script:Now.AddHours(-1)) -Now $script:Now
        $v.Alarm | Should -BeTrue
        @($v.ProtectedWip).Count | Should -Be 1
        $v.ProtectedWip[0].Path | Should -Be 'taxonomy/Origin/pov-tag-proposals.json'
        $v.SyncReason | Should -Match 'protected WIP'
    }

    It 'ProtectedWip is DATA, not hardcoded: a custom -ProtectedPaths map is honoured and the default is NOT also checked' {
        $v = Get-DataCheckoutDriftVerdict -Name 'ai-triad-data' `
            -Untracked @('some/other/file.json') -OldestUncommittedMtime ($script:Now.AddHours(-1)) `
            -ProtectedPaths @{ 'some/other/file.json' = 'Someone Else' } -Now $script:Now
        $v.Alarm | Should -BeTrue
        @($v.ProtectedWip).Count | Should -Be 1
        $v.ProtectedWip[0].Owner | Should -Be 'Someone Else'
    }
}
