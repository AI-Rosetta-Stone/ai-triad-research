# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Tag: powershell (t/4115)

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'StuckPRAlertFilter.ps1')
}

Describe 'Test-IsAwaitingPi (t/4115, TL p/702#59 noise-reduction)' -Tag 'powershell' {

    It 'is true when the labels array carries awaiting-pi' {
        $labels = @(
            [pscustomobject]@{ name = 'consult-hold' }
            [pscustomobject]@{ name = 'awaiting-pi' }
        )
        Test-IsAwaitingPi -Labels $labels | Should -BeTrue
    }

    It 'is false when awaiting-pi is absent, even with other labels present' {
        $labels = @(
            [pscustomobject]@{ name = 'consult-hold' }
            [pscustomobject]@{ name = 'stuck-pr-alert-owner' }
        )
        Test-IsAwaitingPi -Labels $labels | Should -BeFalse
    }

    It 'is false for an empty labels array' {
        Test-IsAwaitingPi -Labels @() | Should -BeFalse
    }

    It 'is false for a null labels value (never throws under strict mode)' {
        Test-IsAwaitingPi -Labels $null | Should -BeFalse
    }

    It 'matches the label name case-insensitively (PowerShell -eq default; GitHub label casing is not guaranteed to be preserved verbatim everywhere)' {
        $labels = @([pscustomobject]@{ name = 'Awaiting-PI' })
        Test-IsAwaitingPi -Labels $labels | Should -BeTrue
    }

    It 'is false for a label list containing an unrelated label whose name only partially overlaps' {
        $labels = @([pscustomobject]@{ name = 'awaiting-pi-review' })
        Test-IsAwaitingPi -Labels $labels | Should -BeFalse
    }
}
