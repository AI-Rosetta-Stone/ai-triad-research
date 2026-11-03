# Tag: enrichment (t/1938)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    DeepSeek dispatch regression tests (t/1938).
.DESCRIPTION
    PS/TS stack-parity cleanup: the TS stack supports the `deepseek` backend but
    the PS adapter (AIEnrich.psm1) did not. These pure-PS assertions (parameter
    surface, EnvVarMap wiring, context window, Resolve-AIApiKey resolution) always
    run. Live round-trip tests self-skip with an ALARMING reason when
    $env:DEEPSEEK_API_KEY isn't set — mirroring the t/1437 z.ai / t/1409 Ollama
    pattern so a CI regression can't quietly pass-by-skip.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
    $EnrichPath = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
    Import-Module $EnrichPath -Force -WarningAction SilentlyContinue

    $script:HasDeepSeekKey = -not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)
    $script:SkipReason     = 'DEEPSEEK_API_KEY not set — DEEPSEEK LIVE GUARD NOT RUN (CI regression? owner-provisioned key needed)'
}

Describe 'DeepSeek wiring — pure-PS shape checks (t/1938)' -Tag 'enrichment' {

    It 'Test-AIApiKey ValidateSet includes deepseek' {
        $cmd = Get-Command Test-AIApiKey -Module AITriad
        $vs = $cmd.Parameters['Backend'].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] }
        $vs.ValidValues | Should -Contain 'deepseek'
    }

    It 'AIEnrich ContextWindows registers deepseek at 65,536 tokens' {
        InModuleScope AIEnrich {
            $script:ContextWindows.ContainsKey('deepseek') | Should -Be $true
            $script:ContextWindows['deepseek']            | Should -Be 65536
        }
    }

    It 'Resolve-AIApiKey -Backend deepseek reads $env:DEEPSEEK_API_KEY (or falls back to $env:AI_API_KEY)' {
        InModuleScope AIEnrich {
            $saved = @{
                DS = $env:DEEPSEEK_API_KEY
                AI = $env:AI_API_KEY
            }
            try {
                $env:DEEPSEEK_API_KEY = 'ds-test-key-marker-t1938'
                $env:AI_API_KEY       = $null
                $r = Resolve-AIApiKey -Backend 'deepseek'
                $r | Should -Be 'ds-test-key-marker-t1938'
                $script:LastApiKeySource | Should -Be '$env:DEEPSEEK_API_KEY'
            } finally {
                $env:DEEPSEEK_API_KEY = $saved.DS
                $env:AI_API_KEY       = $saved.AI
            }
        }
    }

    It 'Resolve-AIApiKey -Backend deepseek returns $null when neither DEEPSEEK_API_KEY nor AI_API_KEY set' {
        InModuleScope AIEnrich {
            $saved = @{
                DS = $env:DEEPSEEK_API_KEY
                AI = $env:AI_API_KEY
            }
            try {
                $env:DEEPSEEK_API_KEY = $null
                $env:AI_API_KEY       = $null
                $r = Resolve-AIApiKey -Backend 'deepseek'
                $r | Should -BeNullOrEmpty
            } finally {
                $env:DEEPSEEK_API_KEY = $saved.DS
                $env:AI_API_KEY       = $saved.AI
            }
        }
    }
}

Describe 'DeepSeek live round-trip — requires DEEPSEEK_API_KEY (t/1938)' -Tag 'enrichment' {

    It 'Test-AIApiKey -Backend deepseek returns Functional=$true when the key authenticates' {
        if (-not $script:HasDeepSeekKey) {
            Set-ItResult -Skipped -Because $script:SkipReason
            return
        }
        $r = Test-AIApiKey -Backend deepseek -TimeoutSec 15
        $r.Backend    | Should -Be 'deepseek'
        $r.Functional | Should -Be $true
        $r.StatusCode | Should -Be 200
        $r.KeySource  | Should -Match 'DEEPSEEK_API_KEY|AI_API_KEY'
    }

    It 'Invoke-AIApi -Model deepseek-deepseek-v4.1-flash -Prompt returns non-empty Text + usage counters' {
        if (-not $script:HasDeepSeekKey) {
            Set-ItResult -Skipped -Because $script:SkipReason
            return
        }
        $r = Invoke-AIApi -Model 'deepseek-deepseek-v4.1-flash' -Prompt 'Say hi in one short word.' -MaxTokens 200 -Temperature 0.1
        $r                    | Should -Not -BeNullOrEmpty
        $r.Backend            | Should -Be 'deepseek'
        $r.Text               | Should -Not -BeNullOrEmpty
        $r.Text.Trim().Length | Should -BeGreaterThan 0
        $r.Usage              | Should -Not -BeNullOrEmpty
        $r.Usage.InputTokens  | Should -BeGreaterThan 0
        $r.Usage.OutputTokens | Should -BeGreaterThan 0
        $r.Usage.TotalTokens  | Should -Be ($r.Usage.InputTokens + $r.Usage.OutputTokens)
    }
}
