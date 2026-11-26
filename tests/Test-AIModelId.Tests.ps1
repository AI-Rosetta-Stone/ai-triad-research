# Tag: error-handling (t/3867)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Test-AIModelId's fail-open-on-empty-config path warns loudly (t/3867).
.DESCRIPTION
    ai-models.json failing to load made Test-AIModelId accept ANY model id
    silently -- a deliberate availability-over-correctness trade, but taken with
    no record that it was taken. Fixed to keep the trade (fail open) but emit a
    real Write-Warning (not Write-Warn, the Write-Host wrapper established
    non-capturable on t/3853 -- using it here would have reproduced this exact
    defect while looking like the fix).

    Both arms matter per the ticket's own acceptance note: the happy path (config
    loaded) must stay silent, or the warning stops being a meaningful signal.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-AIModelId (t/3867)' -Tag 'error-handling' {

    It 'warns loudly and still accepts any model id when the config is empty/unloaded -- the arm that was silent' {
        InModuleScope AITriad {
            $Prev = $script:ValidModelIds
            try {
                $script:ValidModelIds = @()
                $WarnMsg = $null
                Test-AIModelId -ModelId 'totally-made-up-model' -WarningVariable WarnMsg -WarningAction SilentlyContinue | Should -Be $true
                $WarnMsg | Should -Not -BeNullOrEmpty
                "$WarnMsg" | Should -Match 'DISABLED'
                "$WarnMsg" | Should -Match 'totally-made-up-model'
            } finally {
                $script:ValidModelIds = $Prev
            }
        }
    }

    It 'stays silent on the happy path -- a populated config emits NO warning (keeps the warning meaningful)' {
        InModuleScope AITriad {
            $Prev = $script:ValidModelIds
            try {
                $script:ValidModelIds = @('gemini-3.5-flash-lite', 'claude-sonnet-4-6')
                $WarnMsg = $null
                Test-AIModelId -ModelId 'gemini-3.5-flash-lite' -WarningVariable WarnMsg -WarningAction SilentlyContinue | Should -Be $true
                $WarnMsg | Should -BeNullOrEmpty
            } finally {
                $script:ValidModelIds = $Prev
            }
        }
    }

    It 'still throws on an unrecognized id when the config IS populated -- the real validation path, unchanged' {
        InModuleScope AITriad {
            $Prev = $script:ValidModelIds
            try {
                $script:ValidModelIds = @('gemini-3.5-flash-lite')
                { Test-AIModelId -ModelId 'not-a-real-model' } | Should -Throw -ExpectedMessage '*Invalid model*'
            } finally {
                $script:ValidModelIds = $Prev
            }
        }
    }
}
