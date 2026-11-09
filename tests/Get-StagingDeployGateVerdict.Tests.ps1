# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932: 2026-11-06 staging downgrade incident. The three required arms (ticket AC):
# (a) push=false -> skip; (b) ancestor SHA -> skip; (c) pushed descendant SHA -> deploy.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-StagingDeployGateVerdict.ps1')
}

Describe 'Get-StagingDeployGateVerdict (t/4932)' {
    It 'AC(a): push=false -> skip, whatever the SHA comparison' {
        $r = Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'abc1234' -CurrentDeploySha 'def5678' -BuiltShaIsAncestorOfCurrent $false
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'did not push'
    }

    It 'AC(b): the built SHA is an ancestor of the current deploy -> skip (downgrade)' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'old111' -CurrentDeploySha 'new999' -BuiltShaIsAncestorOfCurrent $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'ANCESTOR'
        $r.Reason | Should -Match 'downgrade'
    }

    It 'AC(c): pushed and a genuine descendant SHA -> deploy' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'old111' -BuiltShaIsAncestorOfCurrent $false
        $r.Proceed | Should -Be $true
    }

    It 'the built SHA equals the current deploy SHA -> skip (nothing to redeploy), even if Pushed=true' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same123' -CurrentDeploySha 'same123' -BuiltShaIsAncestorOfCurrent $false
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'nothing to redeploy'
    }

    It 'a first deploy (no CurrentDeploySha, no ancestor comparison possible) proceeds when pushed' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -BuiltShaIsAncestorOfCurrent $null
        $r.Proceed | Should -Be $true
    }

    It 'push=false is checked before the SHA comparison -- an ancestor AND push=false still reports the push reason' {
        $r = Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'old111' -CurrentDeploySha 'new999' -BuiltShaIsAncestorOfCurrent $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'did not push'
    }
}
