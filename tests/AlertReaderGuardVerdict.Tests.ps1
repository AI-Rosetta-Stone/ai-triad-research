# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms + fail-safe proof for the t/4156 shared alert-reader guard: a renamed/unresolvable
# repo or an empty label history must read as blind (QueryError), never as a clean zero; a
# matching name with real label history must behave as before (not blind).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'AlertReaderGuardVerdict.ps1')
}

Describe 'Get-AlertReaderGuardVerdict' {
    It 'is NOT blind when the name matches and the floor label has history' {
        $v = Get-AlertReaderGuardVerdict -Repo 'AI-Rosetta-Stone/ai-triad-research' `
            -ResolvedFullName 'AI-Rosetta-Stone/ai-triad-research' -FloorLabel 'stuck-pr-alert-owner' `
            -FloorLabelAllStatesCount 3
        $v.IsBlind | Should -BeFalse
        $v.Reason | Should -BeNullOrEmpty
    }
    It 'matches the name case-insensitively (gh may normalize casing)' {
        $v = Get-AlertReaderGuardVerdict -Repo 'ai-rosetta-stone/AI-Triad-Research' `
            -ResolvedFullName 'AI-Rosetta-Stone/ai-triad-research' -FloorLabel 'data-compliance' `
            -FloorLabelAllStatesCount 1
        $v.IsBlind | Should -BeFalse
    }
    It 'is blind when the resolved name differs (renamed or transferred repo)' {
        $v = Get-AlertReaderGuardVerdict -Repo 'jpsnover/ai-triad-research' `
            -ResolvedFullName 'AI-Rosetta-Stone/ai-triad-research' -FloorLabel 'stuck-pr-alert-owner' `
            -FloorLabelAllStatesCount 3
        $v.IsBlind | Should -BeTrue
        $v.Reason | Should -Match 'renamed or transferred'
    }
    It 'fails SAFE: an unresolvable repo (empty full_name, the gh api call itself failed) is blind, not healthy' {
        $v = Get-AlertReaderGuardVerdict -Repo 'AI-Rosetta-Stone/ai-triad-research' `
            -ResolvedFullName $null -FloorLabel 'main-ci-monitor-heartbeat' -FloorLabelAllStatesCount 5
        $v.IsBlind | Should -BeTrue
        $v.Reason | Should -Match 'unresolvable'
    }
    It 'fails SAFE: an empty string full_name is also blind' {
        $v = Get-AlertReaderGuardVerdict -Repo 'AI-Rosetta-Stone/ai-triad-research' `
            -ResolvedFullName '' -FloorLabel 'main-ci-monitor-heartbeat' -FloorLabelAllStatesCount 5
        $v.IsBlind | Should -BeTrue
    }
    It 'is blind when the name resolves but the floor label has zero history (all-states sanity floor)' {
        $v = Get-AlertReaderGuardVerdict -Repo 'AI-Rosetta-Stone/ai-triad-research' `
            -ResolvedFullName 'AI-Rosetta-Stone/ai-triad-research' -FloorLabel 'stuck-pr-alert-owner' `
            -FloorLabelAllStatesCount 0
        $v.IsBlind | Should -BeTrue
        $v.Reason | Should -Match 'label history empty'
    }
    It 'checks the name BEFORE the floor -- a renamed repo reports the name reason, not the floor one' {
        $v = Get-AlertReaderGuardVerdict -Repo 'jpsnover/ai-triad-data' `
            -ResolvedFullName 'AI-Rosetta-Stone/ai-triad-data' -FloorLabel 'data-compliance' `
            -FloorLabelAllStatesCount 0
        $v.Reason | Should -Match 'renamed or transferred'
    }
}
