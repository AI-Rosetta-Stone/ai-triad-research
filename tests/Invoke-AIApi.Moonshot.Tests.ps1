# Tag: enrichment (t/1936)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Moonshot (Kimi) dispatch regression tests (t/1936).
.DESCRIPTION
    Pure-PS assertions (parameter surface, EnvVarMap wiring, context window,
    Resolve-AIApiKey resolution) always run. Live round-trip tests self-skip
    with an ALARMING reason when $env:MOONSHOT_API_KEY isn't set — mirroring the
    t/1437 z.ai / t/1409 Ollama pattern so a CI regression can't quietly
    pass-by-skip.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
    $EnrichPath = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
    Import-Module $EnrichPath -Force -WarningAction SilentlyContinue

    $script:HasMoonshotKey = -not [string]::IsNullOrWhiteSpace($env:MOONSHOT_API_KEY)
    $script:SkipReason     = 'MOONSHOT_API_KEY not set — MOONSHOT LIVE GUARD NOT RUN (CI regression? owner-provisioned key needed)'
}

Describe 'Moonshot wiring — pure-PS shape checks (t/1936)' -Tag 'enrichment' {

    It 'Test-AIApiKey ValidateSet includes moonshot' {
        $cmd = Get-Command Test-AIApiKey -Module AITriad
        $vs = $cmd.Parameters['Backend'].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] }
        $vs.ValidValues | Should -Contain 'moonshot'
    }

    It 'AIEnrich ContextWindows registers moonshot at 1,000,000 tokens' {
        InModuleScope AIEnrich {
            $script:ContextWindows.ContainsKey('moonshot') | Should -Be $true
            $script:ContextWindows['moonshot']            | Should -Be 1000000
        }
    }

    It 'Resolve-AIApiKey -Backend moonshot reads $env:MOONSHOT_API_KEY (or falls back to $env:AI_API_KEY)' {
        InModuleScope AIEnrich {
            $saved = @{
                MOON = $env:MOONSHOT_API_KEY
                AI   = $env:AI_API_KEY
            }
            try {
                $env:MOONSHOT_API_KEY = 'moon-test-key-marker-t1936'
                $env:AI_API_KEY       = $null
                $r = Resolve-AIApiKey -Backend 'moonshot'
                $r | Should -Be 'moon-test-key-marker-t1936'
                $script:LastApiKeySource | Should -Be '$env:MOONSHOT_API_KEY'
            } finally {
                $env:MOONSHOT_API_KEY = $saved.MOON
                $env:AI_API_KEY       = $saved.AI
            }
        }
    }

    It 'Resolve-AIApiKey -Backend moonshot returns $null when neither MOONSHOT_API_KEY nor AI_API_KEY set' {
        InModuleScope AIEnrich {
            $saved = @{
                MOON = $env:MOONSHOT_API_KEY
                AI   = $env:AI_API_KEY
            }
            try {
                $env:MOONSHOT_API_KEY = $null
                $env:AI_API_KEY       = $null
                $r = Resolve-AIApiKey -Backend 'moonshot'
                $r | Should -BeNullOrEmpty
            } finally {
                $env:MOONSHOT_API_KEY = $saved.MOON
                $env:AI_API_KEY       = $saved.AI
            }
        }
    }

    It 'moonshot-kimi-k3.1-pro resolves to the moonshot backend in the model registry (t/4613)' {
        InModuleScope AIEnrich {
            $script:ModelRegistry.ContainsKey('moonshot-kimi-k3.1-pro') | Should -Be $true
            $script:ModelRegistry['moonshot-kimi-k3.1-pro'].Backend    | Should -Be 'moonshot'
        }
    }
}

Describe 'Moonshot live round-trip — requires MOONSHOT_API_KEY (t/1936 AC)' -Tag 'enrichment' {

    It 'Test-AIApiKey -Backend moonshot returns Functional=$true when the key authenticates' {
        if (-not $script:HasMoonshotKey) {
            Set-ItResult -Skipped -Because $script:SkipReason
            return
        }
        $r = Test-AIApiKey -Backend moonshot -TimeoutSec 15
        $r.Backend    | Should -Be 'moonshot'
        $r.Functional | Should -Be $true
        $r.StatusCode | Should -Be 200
        $r.KeySource  | Should -Match 'MOONSHOT_API_KEY|AI_API_KEY'
    }

    It 'Invoke-AIApi -Model moonshot-kimi-k3.1-pro -Prompt returns non-empty Text + usage counters' {
        if (-not $script:HasMoonshotKey) {
            Set-ItResult -Skipped -Because $script:SkipReason
            return
        }
        $r = Invoke-AIApi -Model 'moonshot-kimi-k3.1-pro' -Prompt 'Say hi in one short word.' -MaxTokens 200 -Temperature 0.1
        $r                    | Should -Not -BeNullOrEmpty
        $r.Backend            | Should -Be 'moonshot'
        $r.Text               | Should -Not -BeNullOrEmpty
        $r.Text.Trim().Length | Should -BeGreaterThan 0
        $r.Usage              | Should -Not -BeNullOrEmpty
        $r.Usage.InputTokens  | Should -BeGreaterThan 0
        $r.Usage.OutputTokens | Should -BeGreaterThan 0
        $r.Usage.TotalTokens  | Should -Be ($r.Usage.InputTokens + $r.Usage.OutputTokens)
    }

    It 'Invoke-AIApi -Model moonshot-kimi-k3.1-pro-highspeed -Prompt returns non-empty Text + usage counters (t/4613)' {
        if (-not $script:HasMoonshotKey) {
            Set-ItResult -Skipped -Because $script:SkipReason
            return
        }
        $r = Invoke-AIApi -Model 'moonshot-kimi-k3.1-pro-highspeed' -Prompt 'Say hi in one short word.' -MaxTokens 200 -Temperature 0.1
        $r                    | Should -Not -BeNullOrEmpty
        $r.Backend            | Should -Be 'moonshot'
        $r.Text               | Should -Not -BeNullOrEmpty
        $r.Text.Trim().Length | Should -BeGreaterThan 0
        $r.Usage              | Should -Not -BeNullOrEmpty
        $r.Usage.InputTokens  | Should -BeGreaterThan 0
        $r.Usage.OutputTokens | Should -BeGreaterThan 0
        $r.Usage.TotalTokens  | Should -Be ($r.Usage.InputTokens + $r.Usage.OutputTokens)
    }
}
