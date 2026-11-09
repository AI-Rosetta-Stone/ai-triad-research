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
        $r.Warn | Should -Be $false
    }

    It 'push=false is checked before the SHA comparison -- an ancestor AND push=false still reports the push reason' {
        $r = Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'old111' -CurrentDeploySha 'new999' -BuiltShaIsAncestorOfCurrent $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'did not push'
    }

    # S1 (Lead review, #4679): an active revision exists but DEPLOY_SHA couldn't be read --
    # fails closed with a WARN, distinct from a true first deploy (no active revision at all).
    It 'S1: CurrentDeployReadFailed=true fails closed with Warn, even though Pushed=true' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -CurrentDeployReadFailed $true
        $r.Proceed | Should -Be $false
        $r.Warn | Should -Be $true
        $r.Reason | Should -Match 'could not be read'
    }

    It 'S1: is checked before the SHA comparison -- read-failed takes priority over an incidental SHA match' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same123' -CurrentDeploySha 'same123' -CurrentDeployReadFailed $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'could not be read'
    }

    It 'S1: a TRUE first deploy (no active revision, CurrentDeployReadFailed=false) is NOT the S1 case -- proceeds' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -CurrentDeployReadFailed $false -BuiltShaIsAncestorOfCurrent $null
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    # S2 (Lead review, #4679): git merge-base exit 128 (CurrentDeploySha not in this checkout's
    # history) must WARN even though it still proceeds -- distinct from a clean exit 1 (false),
    # which proceeds silently.
    It 'S2: AncestorCheckUnknownCommit=true still proceeds, but warns' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha 'unreachable999' -BuiltShaIsAncestorOfCurrent $false -AncestorCheckUnknownCommit $true
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $true
        $r.Reason | Should -Match 'not found in this checkout'
    }

    It 'S2: a clean exit-1 (genuinely not an ancestor) proceeds WITHOUT warning' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'old111' -BuiltShaIsAncestorOfCurrent $false -AncestorCheckUnknownCommit $false
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    It 'every skip reason (push/read-failed/equal/ancestor) sets Warn=true' {
        (Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'a' -CurrentDeploySha 'b').Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'a' -CurrentDeploySha '' -CurrentDeployReadFailed $true).Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same' -CurrentDeploySha 'same').Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'old' -CurrentDeploySha 'new' -BuiltShaIsAncestorOfCurrent $true).Warn | Should -Be $true
    }
}
