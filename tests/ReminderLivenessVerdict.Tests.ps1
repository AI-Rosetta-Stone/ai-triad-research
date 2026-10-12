# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms proof for the t/4139 reminder-liveness predicate: a missing, disabled or stale
# reminder must surface; a healthy, fresh, enabled reminder must stay silent.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'ReminderLivenessVerdict.ps1')
    $script:Now = [datetime]::new(2026, 10, 12, 12, 0, 0, [DateTimeKind]::Utc)
    $script:Decl = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; ref = 'r/23'; max_age_hours = 6; why = 'x' }
}

Describe 'Get-ReminderLivenessVerdict' {
    It 'is quiet when the reminder is enabled and fresh' {
        $live = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; enabled = $true; last_run_at = $script:Now.AddHours(-1) }
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @($live) -Now $script:Now
        $v.ShouldAct | Should -BeFalse
        @($v.Violations).Count | Should -Be 0
        $v.Checked | Should -Be 1
    }
    It 'surfaces a missing reminder (no matching name at all)' {
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @() -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Kind | Should -Be 'missing'
    }
    It 'surfaces a disabled reminder' {
        $live = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; enabled = $false; last_run_at = $script:Now.AddHours(-1) }
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'disabled'
    }
    It 'surfaces a stale reminder (last_run_at older than max_age_hours)' {
        $live = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; enabled = $true; last_run_at = $script:Now.AddHours(-7) }
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'stale'
        $v.Violations[0].Message | Should -Match '7h ago'
    }
    It 'treats a reminder that has NEVER run as stale, not healthy' {
        $live = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; enabled = $true; last_run_at = $null }
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @($live) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Violations[0].Kind | Should -Be 'stale'
        $v.Violations[0].Message | Should -Match 'never run'
    }
    It 'stays exactly at the threshold without flagging (boundary is inclusive of the bound)' {
        $live = [pscustomobject]@{ name = 'ci-alert-escalation-bridge'; enabled = $true; last_run_at = $script:Now.AddHours(-6) }
        $v = Get-ReminderLivenessVerdict -Declared @($script:Decl) -LiveByName @($live) -Now $script:Now
        $v.ShouldAct | Should -BeFalse
    }
    It 'checks each declared entry independently in a mixed batch' {
        $healthy = [pscustomobject]@{ name = 'a'; enabled = $true; last_run_at = $script:Now.AddHours(-1) }
        $declared = @(
            [pscustomobject]@{ name = 'a'; ref = 'r/1'; max_age_hours = 6; why = 'x' }
            [pscustomobject]@{ name = 'b'; ref = 'r/2'; max_age_hours = 6; why = 'x' }
        )
        $v = Get-ReminderLivenessVerdict -Declared $declared -LiveByName @($healthy) -Now $script:Now
        $v.ShouldAct | Should -BeTrue
        $v.Checked | Should -Be 2
        @($v.Violations).Count | Should -Be 1
        $v.Violations[0].Name | Should -Be 'b'
    }
}
