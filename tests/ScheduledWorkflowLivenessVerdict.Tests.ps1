# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms proof for the t/4173 Build B scheduled-workflow-liveness predicate (Orca-side, driven
# by Orca's own scheduler so it stays independent of GitHub Actions cron): a missing or stale
# cadence must surface; a sustained healthy cadence must stay silent. Cadence-based per t/4173#6
# (not last-run age alone) — see the burst-then-stall regression test below.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'ScheduledWorkflowLivenessVerdict.ps1')
    $script:Now = [datetime]::new(2026, 10, 12, 12, 0, 0, [DateTimeKind]::Utc)
    $script:Decl = [pscustomobject]@{ file = 'main-ci-monitor.yml'; maxSilentHours = 12 }
}

Describe 'Get-ScheduledWorkflowLivenessVerdict' {
    It 'is quiet when consecutive runs maintain a healthy cadence within the threshold' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @(
            $script:Now.AddHours(-1), $script:Now.AddHours(-5), $script:Now.AddHours(-9)
        ) }
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
    It 'surfaces a live entry with zero timestamps as missing (never seen a schedule run)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @() }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'missing'
    }
    It 'surfaces a single lonely timestamp as missing — one run cannot evidence a cadence' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @($script:Now.AddHours(-1)) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'missing'
    }
    It 'surfaces a stale workflow (newest run older than maxSilentHours)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @(
            $script:Now.AddHours(-13), $script:Now.AddHours(-14)
        ) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'stale'
    }
    It 'REGRESSION (t/4173#6): a single fresh burst after a long stall still flags stale — age-only would have missed this' {
        # Exactly the real incident: health-monitor fired once at 02:53Z after ~10h silent, which
        # read as healthy under an age-only check (t/4173#5's premature "cron resumed"). The gap
        # BETWEEN the burst and the run before it is what must still trip the threshold.
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @(
            $script:Now.AddMinutes(-6),      # the burst — very fresh
            $script:Now.AddHours(-14)        # the run before the burst — ~14h gap to the burst, over the 12h threshold
        ) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'stale'
        $v.Violations[0].Message | Should -Match '13\.9h'
    }
    It 'stays exactly at the threshold without flagging (boundary is inclusive of the bound)' {
        $live = [pscustomobject]@{ file = 'main-ci-monitor.yml'; scheduleRunTimestamps = @(
            $script:Now.AddHours(-12), $script:Now.AddHours(-23)
        ) }
        $v = Get-ScheduledWorkflowLivenessVerdict -Declared @($script:Decl) -LiveByFile @($live) -Now $script:Now
        $v.ShouldAct | Should -BeFalse
    }
    It 'checks each declared entry independently in a mixed batch' {
        $healthy = [pscustomobject]@{ file = 'a.yml'; scheduleRunTimestamps = @($script:Now.AddHours(-1), $script:Now.AddHours(-5)) }
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
