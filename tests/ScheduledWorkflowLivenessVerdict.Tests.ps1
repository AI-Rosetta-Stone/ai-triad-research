# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms proof for the t/4173 Build B scheduled-workflow-liveness predicate (Orca-side, driven
# by Orca's own scheduler so it stays independent of GitHub Actions cron): a missing or stale
# schedule-triggered run must surface; a fresh one must stay silent.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'ScheduledWorkflowLivenessVerdict.ps1')
    $script:Now = [datetime]::new(2026, 10, 12, 12, 0, 0, [DateTimeKind]::Utc)
    $script:Decl = [pscustomobject]@{ file = 'main-ci-monitor.yml'; maxSilentHours = 12 }
}

Describe 'Get-ScheduledWorkflowLivenessVerdict' {
    It 'is quiet when the newest schedule run is within the threshold' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; lastScheduleRunAt = $script:Now.AddHours(-1) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeFalse
        @($v.Violations).Count | Should -Be 0
        $v.Checked | Should -Be 1
    }
    It 'surfaces a missing workflow (no live entry at all)' {
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @() -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Kind | Should -Be 'missing'
    }
    It 'surfaces a live entry with a null timestamp as missing (never seen a schedule run)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; lastScheduleRunAt = $null }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'missing'
    }
    It 'surfaces a stale workflow (older than maxSilentHours)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; lastScheduleRunAt = $script:Now.AddHours(-13) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'stale'
        $v.Violations[0].Message | Should -Match '13h ago'
    }
    It 'stays exactly at the threshold without flagging (boundary is inclusive of the bound)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; lastScheduleRunAt = $script:Now.AddHours(-12) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeFalse
    }
    It 'checks each declared entry independently in a mixed batch' {
        $healthy = [pscustomobject]@{ file = 'a.yml'; lastScheduleRunAt = $script:Now.AddHours(-1) }
        $declared = @(
            [pscustomobject]@{ file = 'a.yml'; maxSilentHours = 12 }
            [pscustomobject]@{ file = 'b.yml'; maxSilentHours = 12 }
        )
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared $declared -LiveByFile @($healthy) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Checked | Should -Be 2
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].File | Should -Be 'b.yml'
    }
}
