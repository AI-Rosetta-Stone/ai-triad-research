# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Unit arms for ConvertFrom-PesterShardLog (per-file wall-clock durations from a CI shard log).
#>

Describe 'ConvertFrom-PesterShardLog' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/ShardDurationsFromLog.ps1"
        $esc = [char]27
        $root = '/home/runner/work/ai-triad-research/ai-triad-research'
        function Format-StartLine([string]$ts, [string]$file) {
            "$ts $esc[95mRunning tests from '$root/$file'$esc[0m"
        }
    }

    It 'measures each file as the gap to the next start, and the last file to "Tests completed in"' {
        $log = @(
            '2026-11-02T18:34:46.6870381Z Discovery found 3 tests in 9.46s.'
            (Format-StartLine '2026-11-02T18:34:56.0000000Z' 'tests/A.Tests.ps1')
            '2026-11-02T18:35:00.0000000Z [+] some test 1ms'
            (Format-StartLine '2026-11-02T18:35:23.5000000Z' 'tests/B.Tests.ps1')
            (Format-StartLine '2026-11-02T18:37:23.5000000Z' 'tests/sub/C.Tests.ps1')
            "2026-11-02T18:37:30.0000000Z $esc[97mTests completed in 154.0s$esc[0m"
        )
        $d = ConvertFrom-PesterShardLog -LogLine $log
        $d.Keys | Should -Be @('tests/A.Tests.ps1', 'tests/B.Tests.ps1', 'tests/sub/C.Tests.ps1')
        $d['tests/A.Tests.ps1'] | Should -Be 27.5
        $d['tests/B.Tests.ps1'] | Should -Be 120
        $d['tests/sub/C.Tests.ps1'] | Should -Be 6.5
    }

    It 'ignores the flake-rerun section after the first "Tests completed in"' {
        $log = @(
            (Format-StartLine '2026-11-02T10:00:00Z' 'tests/A.Tests.ps1')
            '2026-11-02T10:00:10Z Tests completed in 10s'
            (Format-StartLine '2026-11-02T10:00:20Z' 'tests/A.Tests.ps1')
            '2026-11-02T10:00:25Z Tests completed in 5s'
        )
        $d = ConvertFrom-PesterShardLog -LogLine $log
        $d.Count | Should -Be 1
        $d['tests/A.Tests.ps1'] | Should -Be 10
    }

    It 'normalises Windows-style paths to tests/... relative form' {
        $log = @(
            "2026-11-02T10:00:00Z Running tests from 'D:\a\ai-triad-research\tests\W.Tests.ps1'"
            '2026-11-02T10:00:04Z Tests completed in 4s'
        )
        (ConvertFrom-PesterShardLog -LogLine $log).Keys | Should -Be @('tests/W.Tests.ps1')
    }

    It 'fails with an actionable error when the run never completed' {
        $log = @((Format-StartLine '2026-11-02T10:00:00Z' 'tests/A.Tests.ps1'))
        { ConvertFrom-PesterShardLog -LogLine $log -Source 'shard 3' } |
            Should -Throw -ExpectedMessage "*shard 3 has no 'Tests completed in' line*Next steps:*"
    }

    It 'fails with an actionable error when the log has no test files' {
        { ConvertFrom-PesterShardLog -LogLine @('nothing here') } |
            Should -Throw -ExpectedMessage '*no test files found*Next steps:*'
    }
}

Describe 'Merge-ShardDurationSample' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/ShardDurationsFromLog.ps1"
    }

    It 'takes the per-file median, so one slow run does not move a file' {
        $m = Merge-ShardDurationSample -Sample @(
            @{ 'tests/A.Tests.ps1' = 100; 'tests/B.Tests.ps1' = 1 },
            @{ 'tests/A.Tests.ps1' = 170; 'tests/B.Tests.ps1' = 13 },
            @{ 'tests/A.Tests.ps1' = 110; 'tests/B.Tests.ps1' = 2 }
        )
        $m['tests/A.Tests.ps1'] | Should -Be 110
        $m['tests/B.Tests.ps1'] | Should -Be 2
    }

    It 'averages the middle two for an even number of samples' {
        (Merge-ShardDurationSample -Sample @(@{ a = 10 }, @{ a = 20 }, @{ a = 30 }, @{ a = 100 }))['a'] | Should -Be 25
    }

    It 'uses only the runs a file appears in' {
        $m = Merge-ShardDurationSample -Sample @(@{ a = 5; new = 9 }, @{ a = 7 })
        $m['new'] | Should -Be 9
        $m['a'] | Should -Be 6
    }
}
