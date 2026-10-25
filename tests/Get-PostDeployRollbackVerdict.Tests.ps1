# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4309: all 4 arms of Get-PostDeployRollbackVerdict (SO condition C1, e/360#2).
#>

Describe 'Get-PostDeployRollbackVerdict (t/4309)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Get-PostDeployRollbackVerdict.ps1"
    }

    It 'ARM 1 — AC2 passed: no action, regardless of the other inputs' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $false -EarlierRollbackFired $false -IsPostRollbackRecheck $false
        $v.Action | Should -Be 'none'
    }

    It 'ARM 1b — AC2 passed even with earlier-rollback/recheck flags set: still no action (AC2 result wins)' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $false -EarlierRollbackFired $true -IsPostRollbackRecheck $true
        $v.Action | Should -Be 'none'
    }

    It 'ARM 2 — AC2 failed, first check, no earlier rollback: rolls back' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $true -EarlierRollbackFired $false -IsPostRollbackRecheck $false
        $v.Action | Should -Be 'rollback'
    }

    It 'ARM 3 — AC2 failed on the post-rollback recheck: stop, sev-1, no second rollback' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $true -EarlierRollbackFired $false -IsPostRollbackRecheck $true
        $v.Action | Should -Be 'stop-alert-sev1'
        $v.Reason | Should -Match 'recheck'
    }

    It 'ARM 4 — AC2 failed, an EARLIER gate (health_check/acceptance/persona/warm_gate) already rolled back this run: stop, sev-1, NEVER a second rollback (SO key risk 1, the gap in the original proposal)' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $true -EarlierRollbackFired $true -IsPostRollbackRecheck $false
        $v.Action | Should -Be 'stop-alert-sev1'
        $v.Reason | Should -Match 'earlier gate'
    }

    It 'both EarlierRollbackFired and IsPostRollbackRecheck true: still exactly ONE outcome, never a crash or double-rollback' {
        $v = Get-PostDeployRollbackVerdict -Ac2Failed $true -EarlierRollbackFired $true -IsPostRollbackRecheck $true
        $v.Action | Should -Be 'stop-alert-sev1'
    }

    It 'C4 — the verdict never implies tag-known-good should run: Action is never "none" when Ac2Failed is true' {
        foreach ($earlier in @($true, $false)) {
            foreach ($recheck in @($true, $false)) {
                $v = Get-PostDeployRollbackVerdict -Ac2Failed $true -EarlierRollbackFired $earlier -IsPostRollbackRecheck $recheck
                $v.Action | Should -Not -Be 'none'
            }
        }
    }
}
