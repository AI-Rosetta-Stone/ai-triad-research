# Tag: unit (t/107)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/107: optional token fields on the AI call log, and logging of every Invoke-AIApi caller.
.DESCRIPTION
    Before t/107 only Invoke-AIByUsage logged, and no record carried tokens, so t/106's budget stop
    had no spend source. Now AITriad registers a default logger with AIEnrich (Set-AIDefaultCallLogger)
    that Invoke-AIApi uses whenever its caller passes no -CallLogger (the summary pipeline's shape),
    and the hook carries the parsed usage. Proven here, both arms each:
      - a direct (summary-pipeline-shaped) call writes ONE entry with tokens;
      - a call whose provider reports no usage writes an entry WITHOUT token fields, plus a WARN;
      - a failed call writes its status, no tokens, no usage WARN;
      - the Invoke-AIByUsage path still writes exactly ONE entry (its logger replaces the default);
      - flag off writes nothing;
      - Get-AICallLog reads lines with and without the fields (token-fields.jsonl).
    HTTP is mocked at Invoke-RestMethod in AITriad's own AIEnrich instance; only AITriad is imported,
    so that instance (the one carrying the registered default) is the one exercised.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:TokenFixture = Join-Path $PSScriptRoot 'fixtures' 'ai-call-log' 'token-fields.jsonl'

    function script:New-GeminiEnvelope([switch]$NoUsage, [switch]$Cached, [int]$Thoughts = -1) {
        $env = [ordered]@{
            candidates = @([pscustomobject]@{
                    content      = [pscustomobject]@{ parts = @([pscustomobject]@{ text = '{"ok":true}' }) }
                    finishReason = 'STOP'
                })
        }
        if (-not $NoUsage) {
            $um = [ordered]@{ promptTokenCount = 1500; candidatesTokenCount = 250; totalTokenCount = 1750 }
            if ($Cached) { $um.cachedContentTokenCount = 1024 }
            if ($Thoughts -ge 0) { $um.thoughtsTokenCount = $Thoughts }
            $env.usageMetadata = [pscustomobject]$um
        }
        [pscustomobject]$env
    }
}

Describe 'AI call log tokens + default logger (t/107)' -Tag 'unit' {

    BeforeEach {
        $script:LogFile = Join-Path $TestDrive 'ai-call-log.jsonl'
        Remove-Item -LiteralPath $script:LogFile -Force -ErrorAction SilentlyContinue
        $env:AI_CALL_LOG_ENABLED = '1'
        Mock Get-AICallLogPath -ModuleName AITriad -MockWith { $script:LogFile }
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { }
        Mock Resolve-AIApiKey -ModuleName AIEnrich -MockWith { 'fake-key' }
    }
    AfterEach {
        Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue
    }

    function script:Read-Log {
        if (-not (Test-Path -LiteralPath $script:LogFile)) { return @() }
        @(Get-Content -LiteralPath $script:LogFile | ForEach-Object { $_ | ConvertFrom-Json })
    }

    It 'AITriad registers a default logger with its AIEnrich instance at import' {
        $has = InModuleScope AITriad { & (Get-Command Invoke-AIApi).Module { $null -ne $script:AIDefaultCallLogger } }
        $has | Should -BeTrue
    }

    It 'a summary-pipeline-shaped call (Invoke-AIApi, no -CallLogger) writes ONE entry with tokens' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope -Cached }
        InModuleScope AITriad {
            Invoke-AIApi -Prompt 'Summarize this document' -Model 'gemini-3.5-flash-lite' -FallbackModels @() `
                -JsonMode -SkipTokenCheck -WarningAction SilentlyContinue | Out-Null
        }
        $recs = Read-Log
        $recs.Count | Should -Be 1
        $recs[0].Status            | Should -Be '200'
        $recs[0].Model             | Should -Be 'gemini-3.5-flash-lite'
        $recs[0].Backend           | Should -Be 'gemini'
        $recs[0].PromptStart       | Should -Be 'Summarize this document'
        $recs[0].InputTokens       | Should -Be 1500
        $recs[0].OutputTokens      | Should -Be 250
        $recs[0].CachedInputTokens | Should -Be 1024
        @($recs[0].PSObject.Properties.Name) -join ',' |
            Should -Be 'ID,Datetime,Scenario,PromptID,PromptStart,RetryCount,Status,Model,Backend,KeySource,InputTokens,OutputTokens,CachedInputTokens'
    }

    It 'Gemini with no cache hit logs CachedInputTokens 0 (its parser reports an absent count as 0)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope }
        InModuleScope AITriad {
            Invoke-AIApi -Prompt 'p' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -SkipTokenCheck -WarningAction SilentlyContinue | Out-Null
        }
        $rec = (Read-Log)[0]
        $rec.InputTokens       | Should -Be 1500
        $rec.CachedInputTokens | Should -Be 0
    }

    It 'Gemini thinking tokens are billed output: OutputTokens = candidates + thoughts (Quality, t/107)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope -Thoughts 900 }
        InModuleScope AITriad {
            Invoke-AIApi -Prompt 'p' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -SkipTokenCheck -WarningAction SilentlyContinue | Out-Null
        }
        $rec = (Read-Log)[0]
        $rec.OutputTokens | Should -Be 1150 -Because '250 candidates + 900 thoughts; dropping thoughts under-reads spend (fail-open)'
        $rec.InputTokens  | Should -Be 1500
    }

    It 'Claude cache reads/writes: InputTokens includes both; each subset logged (TL p/37#10)' {
        $ctx = InModuleScope AIEnrich {
            $u = (ConvertFrom-AIClaudeEnvelope -Response ([pscustomobject]@{
                        content = @([pscustomobject]@{ type = 'text'; text = 'ok' }); stop_reason = 'end_turn'
                        usage   = [pscustomobject]@{ input_tokens = 1000; output_tokens = 500; cache_read_input_tokens = 6000; cache_creation_input_tokens = 2000 }
                    })).Usage
            $script:Got = $null
            Invoke-AICallLogHook -CallLogger { param($rc, $st, $c) $script:Got = $c } -Response 'r' -LastError $null -Attempt 0 `
                -Model 'claude-opus-5' -Backend 'claude' -Prompt 'p' -Usage $u -WarningAction SilentlyContinue
            $script:Got
        }
        $ctx.InputTokens              | Should -Be 9000 -Because 'input_tokens excludes cache reads and writes; the log convention includes them'
        $ctx.OutputTokens             | Should -Be 500
        $ctx.CachedInputTokens        | Should -Be 6000
        $ctx.CacheCreationInputTokens | Should -Be 2000
    }

    It 'the hook adds CachedInputTokens only when the usage carries a cached count (Claude/OpenAI shape)' {
        $ctx = InModuleScope AIEnrich {
            $script:Got = $null
            $logger = { param($rc, $st, $c) $script:Got = $c }
            Invoke-AICallLogHook -CallLogger $logger -Response 'r' -LastError $null -Attempt 0 -Model 'claude-opus-5' -Backend 'claude' `
                -Prompt 'p' -Usage ([pscustomobject]@{ InputTokens = 7; OutputTokens = 3; TotalTokens = 10 }) -WarningAction SilentlyContinue
            $script:Got
        }
        $ctx.InputTokens  | Should -Be 7
        $ctx.OutputTokens | Should -Be 3
        $ctx.PSObject.Properties['CachedInputTokens'] | Should -BeNullOrEmpty
        $ctx.PSObject.Properties['CacheCreationInputTokens'] | Should -BeNullOrEmpty
    }

    It 'no usage from the provider → entry WITHOUT token fields (never 0) and a WARN' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope -NoUsage }
        $w = InModuleScope AITriad {
            Invoke-AIApi -Prompt 'p' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -SkipTokenCheck `
                -WarningVariable wv -WarningAction SilentlyContinue | Out-Null
            $wv
        }
        $recs = Read-Log
        $recs.Count | Should -Be 1
        $recs[0].Status | Should -Be '200'
        foreach ($f in 'InputTokens', 'OutputTokens', 'CachedInputTokens') {
            $recs[0].PSObject.Properties[$f] | Should -BeNullOrEmpty -Because "$f must be absent, not 0"
        }
        @($w | Where-Object { "$_" -match 'reported no token usage' }).Count | Should -Be 1
    }

    It 'a failed call logs its status with no tokens and no usage WARN' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]400)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Bad Request', $r)
        }
        $w = InModuleScope AITriad {
            Invoke-AIApi -Prompt 'p' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -MaxRetries 1 -SkipTokenCheck `
                -WarningVariable wv -WarningAction SilentlyContinue | Out-Null
            $wv
        }
        $recs = Read-Log
        $recs.Count | Should -Be 1
        $recs[0].Status | Should -Be '400'
        $recs[0].PSObject.Properties['InputTokens'] | Should -BeNullOrEmpty
        @($w | Where-Object { "$_" -match 'reported no token usage' }).Count | Should -Be 0
    }

    It 'Invoke-AIByUsage still writes exactly ONE entry (its logger replaces the default), now with tokens' {
        Mock Get-UsageConfig -ModuleName AITriad -MockWith { @{ message = 'Say hi'; model = 'gemini-3.5-flash-lite' } }
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope }
        Invoke-AIByUsage -UsageId 'enrichment.demo-scenario' -Values @{} -WarningAction SilentlyContinue | Out-Null
        $recs = Read-Log
        $recs.Count | Should -Be 1 -Because 'the default logger must not ALSO fire on the Invoke-AIByUsage path'
        $recs[0].PromptID     | Should -Be 'enrichment.demo-scenario'
        $recs[0].PromptStart  | Should -Be 'Say hi'
        $recs[0].InputTokens  | Should -Be 1500
        $recs[0].OutputTokens | Should -Be 250
    }

    It 'flag OFF: a direct call writes nothing' {
        Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { New-GeminiEnvelope }
        InModuleScope AITriad {
            Invoke-AIApi -Prompt 'p' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -SkipTokenCheck -WarningAction SilentlyContinue | Out-Null
        }
        Test-Path -LiteralPath $script:LogFile | Should -BeFalse
    }
}

Describe 'Write-AICallLogEntry token fields (t/107)' -Tag 'unit' {
    BeforeEach { $env:AI_CALL_LOG_ENABLED = '1' }
    AfterEach  { Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue }

    It 'appends Input/Output (and Cached) after KeySource, only when both counts are given' {
        InModuleScope AITriad -Parameters @{ P = (Join-Path $TestDrive 'w.jsonl') } {
            param($P)
            Remove-Item -LiteralPath $P -ErrorAction SilentlyContinue
            Write-AICallLogEntry -Status '200' -Model 'gemini-3.5-flash-lite' -Backend 'gemini' -InputTokens 10 -OutputTokens 2 -CachedInputTokens 4 -Path $P
            Write-AICallLogEntry -Status '200' -Model 'gemini-3.5-flash-lite' -Backend 'gemini' -InputTokens 10 -Path $P -WarningAction SilentlyContinue
            $l = @(Get-Content -LiteralPath $P | ForEach-Object { $_ | ConvertFrom-Json })
            @($l[0].PSObject.Properties.Name)[-3..-1] -join ',' | Should -Be 'InputTokens,OutputTokens,CachedInputTokens'
            $l[1].PSObject.Properties['InputTokens'] | Should -BeNullOrEmpty -Because 'Input without Output is not a usable spend record'
        }
    }
}

Describe 'Get-AICallLog reads lines with and without token fields (t/107)' -Tag 'unit' {
    It 'token-fields.jsonl: tokens where present, $null (not 0) where absent' {
        $e = @(Get-AICallLog -Path $script:TokenFixture)
        $e.Count | Should -Be 5
        $e[4].CachedInputTokens | Should -Be 6000; $e[4].CacheCreationInputTokens | Should -Be 2000
        $e[0].InputTokens | Should -Be 1200; $e[0].OutputTokens | Should -Be 340; $e[0].CachedInputTokens | Should -BeNullOrEmpty
        $e[1].CachedInputTokens | Should -Be 4096
        foreach ($i in 2, 3) {
            $e[$i].InputTokens  | Should -BeNullOrEmpty
            $e[$i].OutputTokens | Should -BeNullOrEmpty
        }
    }

    It 'conformance.jsonl (no token fields) still reads, all tokens $null' {
        $e = @(Get-AICallLog -Path (Join-Path $PSScriptRoot 'fixtures' 'ai-call-log' 'conformance.jsonl'))
        $e.Count | Should -Be 10
        @($e | Where-Object { $null -ne $_.InputTokens }).Count | Should -Be 0
    }
}
