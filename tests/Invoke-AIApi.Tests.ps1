# Tag: enrichment (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Invoke-AIApi response parsing — truncation detection (gap 1.1)
    and token usage tracking (gap 1.2).
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Ensure the model registry is loaded so backend lookup works
    $aiModelsPath = Join-Path $PSScriptRoot '..' 'ai-models.json'
    if (Test-Path $aiModelsPath) {
        $json = Get-Content -Raw $aiModelsPath | ConvertFrom-Json
        # Register-AIBackend is not needed — we mock the HTTP call entirely
    }
}

Describe 'Invoke-AIApi truncation detection (gap 1.1)' -Tag 'enrichment' {

    It 'Detects Claude max_tokens truncation' {
        $mockResponse = [PSCustomObject]@{
            content     = @([PSCustomObject]@{ type = 'text'; text = 'partial output' })
            stop_reason = 'max_tokens'
            usage       = [PSCustomObject]@{ input_tokens = 10; output_tokens = 100 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'claude-sonnet-4-5' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeTrue
    }

    It 'Returns Truncated=$false for normal Claude end_turn' {
        $mockResponse = [PSCustomObject]@{
            content     = @([PSCustomObject]@{ type = 'text'; text = 'full output' })
            stop_reason = 'end_turn'
            usage       = [PSCustomObject]@{ input_tokens = 10; output_tokens = 50 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'claude-sonnet-4-5' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeFalse
    }

    It 'Detects Groq length truncation' {
        $mockResponse = [PSCustomObject]@{
            choices = @([PSCustomObject]@{
                message       = [PSCustomObject]@{ content = 'partial' }
                finish_reason = 'length'
            })
            usage = [PSCustomObject]@{ prompt_tokens = 5; completion_tokens = 100; total_tokens = 105 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'groq-openai-gpt-oss-120b' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeTrue
    }

    It 'Returns Truncated=$false for normal Groq stop' {
        $mockResponse = [PSCustomObject]@{
            choices = @([PSCustomObject]@{
                message       = [PSCustomObject]@{ content = 'done' }
                finish_reason = 'stop'
            })
            usage = [PSCustomObject]@{ prompt_tokens = 5; completion_tokens = 20; total_tokens = 25 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'groq-openai-gpt-oss-120b' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeFalse
    }

    It 'Detects Gemini MAX_TOKENS truncation' {
        $mockResponse = [PSCustomObject]@{
            candidates = @([PSCustomObject]@{
                finishReason = 'MAX_TOKENS'
                content      = [PSCustomObject]@{
                    parts = @([PSCustomObject]@{ text = 'partial' })
                }
            })
            usageMetadata = [PSCustomObject]@{
                promptTokenCount     = 10
                candidatesTokenCount = 200
                totalTokenCount      = 210
            }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        # Model id must be a currently-registered gemini model (ai-models.json models[]).
        # A de-registered id resolves to a $null backend and short-circuits before the
        # gemini parser ever runs, silently masking parser coverage (t/1850).
        $result = Invoke-AIApi -Prompt 'test' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeTrue
    }

    It 'Detects OpenAI incomplete status truncation' {
        $mockResponse = [PSCustomObject]@{
            status = 'incomplete'
            output = @([PSCustomObject]@{
                type    = 'message'
                content = @([PSCustomObject]@{ type = 'output_text'; text = 'partial' })
            })
            usage = [PSCustomObject]@{ input_tokens = 10; output_tokens = 100; total_tokens = 110 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'openai-gpt-5.5' -ApiKey 'fake-key' 3>$null
        $result.Truncated | Should -BeTrue
    }
}

Describe 'Invoke-AIApi token usage tracking (gap 1.2)' -Tag 'enrichment' {

    It 'Parses Claude usage tokens' {
        $mockResponse = [PSCustomObject]@{
            content     = @([PSCustomObject]@{ type = 'text'; text = 'hello' })
            stop_reason = 'end_turn'
            usage       = [PSCustomObject]@{ input_tokens = 42; output_tokens = 17 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'claude-sonnet-4-5' -ApiKey 'fake-key' 3>$null
        $result.Usage | Should -Not -BeNullOrEmpty
        $result.Usage.InputTokens  | Should -Be 42
        $result.Usage.OutputTokens | Should -Be 17
        $result.Usage.TotalTokens  | Should -Be 59
    }

    It 'Parses Groq usage tokens' {
        $mockResponse = [PSCustomObject]@{
            choices = @([PSCustomObject]@{
                message       = [PSCustomObject]@{ content = 'hello' }
                finish_reason = 'stop'
            })
            usage = [PSCustomObject]@{ prompt_tokens = 30; completion_tokens = 25; total_tokens = 55 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'groq-openai-gpt-oss-120b' -ApiKey 'fake-key' 3>$null
        $result.Usage | Should -Not -BeNullOrEmpty
        $result.Usage.InputTokens  | Should -Be 30
        $result.Usage.OutputTokens | Should -Be 25
        $result.Usage.TotalTokens  | Should -Be 55
    }

    It 'Parses Gemini usage tokens' {
        $mockResponse = [PSCustomObject]@{
            candidates = @([PSCustomObject]@{
                finishReason = 'STOP'
                content      = [PSCustomObject]@{
                    parts = @([PSCustomObject]@{ text = 'hello' })
                }
            })
            usageMetadata = [PSCustomObject]@{
                promptTokenCount     = 15
                candidatesTokenCount = 35
                totalTokenCount      = 50
            }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        # Registered gemini model id — see the truncation test above (t/1850).
        $result = Invoke-AIApi -Prompt 'test' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake-key' 3>$null
        $result.Usage | Should -Not -BeNullOrEmpty
        $result.Usage.InputTokens  | Should -Be 15
        $result.Usage.OutputTokens | Should -Be 35
        $result.Usage.TotalTokens  | Should -Be 50
    }

    It 'Parses OpenAI usage tokens' {
        $mockResponse = [PSCustomObject]@{
            status = 'completed'
            output = @([PSCustomObject]@{
                type    = 'message'
                content = @([PSCustomObject]@{ type = 'output_text'; text = 'hello' })
            })
            usage = [PSCustomObject]@{ input_tokens = 20; output_tokens = 30; total_tokens = 50 }
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'openai-gpt-5.5' -ApiKey 'fake-key' 3>$null
        $result.Usage | Should -Not -BeNullOrEmpty
        $result.Usage.InputTokens  | Should -Be 20
        $result.Usage.OutputTokens | Should -Be 30
        $result.Usage.TotalTokens  | Should -Be 50
    }

    It 'Returns Usage=$null when backend omits usage data' {
        $mockResponse = [PSCustomObject]@{
            content     = @([PSCustomObject]@{ type = 'text'; text = 'hello' })
            stop_reason = 'end_turn'
        }

        Mock Invoke-RestMethod { $mockResponse } -ModuleName AIEnrich

        $result = Invoke-AIApi -Prompt 'test' -Model 'claude-sonnet-4-5' -ApiKey 'fake-key' 3>$null
        $result.Usage | Should -BeNullOrEmpty
    }
}
