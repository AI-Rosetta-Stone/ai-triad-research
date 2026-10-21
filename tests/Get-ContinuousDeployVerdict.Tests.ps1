# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4414 (t/4091 Decision D), log-only phase: proves the decision logic a real continuous-deploy
# dispatch would later rely on, without any workflow wired to actually dispatch anything yet.
#
# Every datetime is bound to a variable before the call (never an inline `([datetime]'...')` cast
# alongside the `$Now` variable in the same parameter list) -- Pester v6.2.0 mis-parses that
# combination and corrupts the NEXT It block's scriptblock (CommandNotFoundException: '$' is not
# recognized). Reproduced down to a single `-ClWindowUntil ([datetime]'...') -Now $Now` call;
# confirmed not a bug in the predicate itself (direct non-Pester invocation is clean).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-ContinuousDeployVerdict.ps1')
    $script:Now = [datetime]'2026-10-22T00:00:00Z'
}

Describe 'Get-ContinuousDeployVerdict' {

    It 'kill switch unset (fail-safe default) -> hold-kill-switch, even for an otherwise-deployable commit' {
        $v = Get-ContinuousDeployVerdict -KillSwitch $null -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-kill-switch'
    }

    It "kill switch 'off' explicitly -> hold-kill-switch" {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'off' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-kill-switch'
    }

    It "kill switch some unexpected value (not exactly 'on') -> hold-kill-switch, fails safe" {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'ON' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-kill-switch'
    }

    It 'kill switch on, no deployable path touched (docs-only) -> skip-non-deployable' {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $false -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'skip-non-deployable'
    }

    It 'kill switch on, bicep-env touched (infra) -> hold-infra, even with no app-code touch' {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $false -TouchesBicepEnv $true -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-infra'
    }

    It 'bicep-resources touched (infra) -> hold-infra' {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $false -TouchesBicepEnv $false -TouchesBicepResources $true -Sha 'abc1234'
        $v.Action | Should -Be 'hold-infra'
    }

    It 'FIRE ARM: infra touched AND app code touched in the same commit -> still hold-infra, never dispatch' {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $true -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-infra'
    }

    It 'deployable, CL run-window active (now before until) -> hold-cl-window' {
        $clWindowUntil = [datetime]'2026-10-22T01:00:00Z'
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $clWindowUntil -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'hold-cl-window'
    }

    It 'deployable, CL run-window already expired (now >= until) -> not held, proceeds past that check' {
        $clWindowUntil = [datetime]'2026-10-21T23:00:00Z'
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $clWindowUntil -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'would-dispatch'
    }

    It 'deployable, no CL window, last dispatch 5 min ago (inside the 20-min batch window) -> skip-batch-window' {
        $lastDispatchAt = [datetime]'2026-10-21T23:55:00Z'
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $lastDispatchAt -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'skip-batch-window'
    }

    It 'deployable, last dispatch exactly 20 min ago (boundary) -> would-dispatch, not skipped' {
        $lastDispatchAt = [datetime]'2026-10-21T23:40:00Z'
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $lastDispatchAt -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'would-dispatch'
    }

    It 'FIRE ARM: deployable, every hold clears -> would-dispatch, naming the SHA' {
        $lastDispatchAt = [datetime]'2026-10-21T23:00:00Z'
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $lastDispatchAt -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'deadbee'
        $v.Action | Should -Be 'would-dispatch'
        $v.Sha | Should -Be 'deadbee'
    }

    It 'never dispatched before (LastDispatchAt null), deployable, no other hold -> would-dispatch' {
        $v = Get-ContinuousDeployVerdict -KillSwitch 'on' -ClWindowUntil $null -Now $Now `
            -LastDispatchAt $null -TouchesContainer $true -TouchesBicepEnv $false -TouchesBicepResources $false -Sha 'abc1234'
        $v.Action | Should -Be 'would-dispatch'
    }
}
