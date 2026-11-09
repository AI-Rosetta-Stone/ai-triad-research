# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932, Quality should-fix (#4679, p/780#29): the az/git calls are injectable here so every
# arm (read success, az failure, missing DEPLOY_SHA, merge-base exit 128) is testable without a
# live Azure subscription or a real git history.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-StagingCurrentDeployComparison.ps1')
}

Describe 'Get-StagingCurrentDeployComparison (t/4932)' {
    It 'no active revision at all -> true first deploy, not a read failure' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @() } `
            -AzRevisionShowFn { throw 'must not be called when there is no active revision' } `
            -GitMergeBaseFn { throw 'must not be called when there is no active revision' }
        $r.CurrentSha | Should -Be ''
        $r.ReadFailed | Should -Be $false
        $r.IsAncestor | Should -BeNullOrEmpty
        $r.AncestorUnknown | Should -Be $false
    }

    It 'read success: an active revision with a DEPLOY_SHA, built SHA is a clean non-ancestor (exit 1)' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'new999' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"old111"}]' } } `
            -GitMergeBaseFn { param($Built, $Current) 1 }
        $r.CurrentSha | Should -Be 'old111'
        $r.ReadFailed | Should -Be $false
        $r.IsAncestor | Should -Be $false
        $r.AncestorUnknown | Should -Be $false
    }

    It 'az failure (non-zero exit): ReadFailed, git merge-base never called' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 1; Output = 'ERROR: some az failure' } } `
            -GitMergeBaseFn { throw 'must not be called when the az read failed' }
        $r.ReadFailed | Should -Be $true
        $r.CurrentSha | Should -Be ''
    }

    It 'az succeeds but DEPLOY_SHA is missing from the env list: ReadFailed, git merge-base never called' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"OTHER_VAR","value":"x"}]' } } `
            -GitMergeBaseFn { throw 'must not be called when DEPLOY_SHA is missing' }
        $r.ReadFailed | Should -Be $true
        $r.CurrentSha | Should -Be ''
    }

    It 'merge-base exit 0: built SHA IS an ancestor, not unknown' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'old111' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-new999'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"new999"}]' } } `
            -GitMergeBaseFn { param($Built, $Current) 0 }
        $r.IsAncestor | Should -Be $true
        $r.AncestorUnknown | Should -Be $false
    }

    It 'merge-base exit 128 (CurrentSha unreachable in this checkout): AncestorUnknown, not treated as ancestor' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-unreachable'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"unreachable999"}]' } } `
            -GitMergeBaseFn { param($Built, $Current) 128 }
        $r.IsAncestor | Should -Be $false
        $r.AncestorUnknown | Should -Be $true
    }

    It 'picks the highest-TrafficWeight revision when more than one is reported active' {
        $Captured = $null
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn {
                @(
                    [PSCustomObject]@{ Name = 'app--staging-low'; TrafficWeight = 10 },
                    [PSCustomObject]@{ Name = 'app--staging-high'; TrafficWeight = 90 }
                )
            } `
            -AzRevisionShowFn {
                param($RevisionName)
                $Script:Captured = $RevisionName
                @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"shahigh"}]' }
            } `
            -GitMergeBaseFn { param($Built, $Current) 1 }
        $Script:Captured | Should -Be 'app--staging-high'
        $r.CurrentSha | Should -Be 'shahigh'
    }
}
