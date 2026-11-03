# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

BeforeAll {
    . "$PSScriptRoot/../operations/devops/Get-TestPowerShellAbnormalEndVerdict.ps1"
}

Describe 'Get-TestPowerShellAbnormalEndVerdict' {

    It 'is NOT abnormal when the completion marker is present, regardless of Pester outcome (a real pass)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $true -PesterOutcome 'success'
        $v.AbnormalEnd | Should -Be $false
    }

    It 'is NOT abnormal when the marker is present even though Pester outcome is failure (t/4548 fail-safe arm: a REAL test failure, never auto-rerun)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $true -PesterOutcome 'failure'
        $v.AbnormalEnd | Should -Be $false
    }

    It 'is abnormal on a step timeout (marker absent, outcome=failure)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $false -PesterOutcome 'failure'
        $v.AbnormalEnd | Should -Be $true
        $v.Reason | Should -Be 'timed-out-after-25-minutes'
    }

    It 'is abnormal on a runner preemption / external cancel (marker absent, outcome=cancelled)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $false -PesterOutcome 'cancelled'
        $v.AbnormalEnd | Should -Be $true
        $v.Reason | Should -Be 'cancelled-mid-run'
    }

    It 'is abnormal on any other outcome with the marker absent (e.g. skipped -- the exact t/4548 incident shape: Install-Module Pester failed, so the Pester step never ran)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $false -PesterOutcome 'skipped'
        $v.AbnormalEnd | Should -Be $true
        $v.Reason | Should -Be 'ended-abnormally-outcome-skipped'
    }

    It 'is abnormal on a null/empty outcome with the marker absent (fail-safe: never silently "not abnormal" on an unreadable outcome)' {
        $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $false -PesterOutcome $null
        $v.AbnormalEnd | Should -Be $true
    }

    # ── Guard test (TL, t/4548#2): "fails if the classifier stops emitting the field" ──────────
    # Pins the OUTPUT SHAPE the rerun handler depends on. If a future edit renames AbnormalEnd,
    # drops it, or changes its type, this fails loudly here -- never silently, the way a renamed
    # ::error:: log string would have under the log-grep design the TL rejected.
    It 'GUARD: always emits an AbnormalEnd boolean property, on every input shape (never silently drops the field)' {
        $cases = @(
            @{ MarkerPresent = $true;  PesterOutcome = 'success' }
            @{ MarkerPresent = $true;  PesterOutcome = 'failure' }
            @{ MarkerPresent = $false; PesterOutcome = 'failure' }
            @{ MarkerPresent = $false; PesterOutcome = 'cancelled' }
            @{ MarkerPresent = $false; PesterOutcome = 'skipped' }
            @{ MarkerPresent = $false; PesterOutcome = $null }
        )
        foreach ($c in $cases) {
            $v = Get-TestPowerShellAbnormalEndVerdict -MarkerPresent $c.MarkerPresent -PesterOutcome $c.PesterOutcome
            $v.PSObject.Properties.Name | Should -Contain 'AbnormalEnd'
            $v.AbnormalEnd | Should -BeOfType [bool]
        }
    }
}
