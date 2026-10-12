# Tag: security (t/4088)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4088: every AI call-log entry records the Model and Backend actually called and WHERE the key
    came from (KeySource, a closed vocabulary), never the key.
.DESCRIPTION
    Contract artifact: tests/fixtures/ai-call-log/README.md + conformance.jsonl (TL t/4088#3).
    - Invoke-AIApi level: a capturing 3-argument logger asserts the context per call: the model actually
      called (each cascade link its own), the registry backend (never a prefix guess) and the
      normalized key source. A 2-argument logger still works.
    - Writer level: 10 fields in contract order, closed vocabulary enforced ('' + WARN otherwise), the
      conformance fixture round-trips, and no key material (not even a 4-character fragment) reaches
      the file.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    $script:KeyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
        'AZURE_OPENAI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'AI_API_KEY',
        'AI_CALL_LOG_ENABLED')
    # Distinct sentinels with no shared 4-character fragment, so a fragment match is unambiguous.
    $script:Sentinel = @{
        GEMINI_API_KEY    = 'q7Zk-gemini-Wp3x'
        ANTHROPIC_API_KEY = 'h2Vn-anthro-Lb8c'
        GROQ_API_KEY      = 'm5Rt-groqky-Ys1d'
        AI_API_KEY        = 'u9Ej-fallbk-Kc4f'
        Explicit          = 'x3Pa-explct-Nd6g'
    }
    $global:AclmGeminiOk = [pscustomobject]@{
        candidates    = @([pscustomobject]@{
                content      = [pscustomobject]@{ parts = @([pscustomobject]@{ text = 'ok' }) }
                finishReason = 'STOP'
            })
        usageMetadata = [pscustomobject]@{ promptTokenCount = 1; candidatesTokenCount = 1; totalTokenCount = 2 }
    }
    $script:Fixture = Join-Path $PSScriptRoot 'fixtures' 'ai-call-log' 'conformance.jsonl'
    $script:FieldOrder = @('ID', 'Datetime', 'Scenario', 'PromptID', 'PromptStart', 'RetryCount', 'Status', 'Model', 'Backend', 'KeySource')

    function Get-FirstRegisteredId([string]$Backend) {
        $m = (Get-Content -Raw (Join-Path $PSScriptRoot '..' 'ai-models.json') | ConvertFrom-Json).models
        [string]@($m | Where-Object { $_.backend -eq $Backend })[0].id
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name AclmGeminiOk, AclmCap -ErrorAction SilentlyContinue
}

Describe 'AI call log: Model, Backend, KeySource (t/4088)' -Tag 'security' {

    BeforeEach {
        $script:Saved = @{}
        foreach ($v in $script:KeyVars) {
            $script:Saved[$v] = [Environment]::GetEnvironmentVariable($v)
            [Environment]::SetEnvironmentVariable($v, $null)
        }
        $global:AclmCap = [System.Collections.Generic.List[object]]::new()
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { }
        InModuleScope AIEnrich { $script:AIApiKeyFallbackWarned = @{} }
    }
    AfterEach {
        foreach ($v in $script:KeyVars) { [Environment]::SetEnvironmentVariable($v, $script:Saved[$v]) }
    }

    Context 'KeySource normalization (closed vocabulary)' {

        It '<Label> for <Backend> maps to <Expected>' -ForEach @(
            @{ Label = '$env:GEMINI_API_KEY';         Backend = 'gemini'; Expected = 'env:GEMINI_API_KEY' }
            @{ Label = '$env:ANTHROPIC_API_KEY';      Backend = 'claude'; Expected = 'env:ANTHROPIC_API_KEY' }
            @{ Label = '$env:AI_API_KEY (fallback)';  Backend = 'gemini'; Expected = 'fallback:AI_API_KEY' }
            @{ Label = '(keyless — local Ollama)';    Backend = 'ollama'; Expected = 'none' }
        ) {
            InModuleScope AIEnrich -Parameters @{ L = $Label; B = $Backend } { param($L, $B) ConvertTo-AICallLogKeySource -SourceLabel $L -Backend $B -Key 'k' } |
                Should -Be $Expected
        }

        It 'an explicit key equal to the backend''s own variable is env:VAR (how the cascade passes fallback keys)' {
            $env:GROQ_API_KEY = $script:Sentinel.GROQ_API_KEY
            InModuleScope AIEnrich -Parameters @{ K = $script:Sentinel.GROQ_API_KEY } { param($K) ConvertTo-AICallLogKeySource -SourceLabel 'explicit parameter' -Backend 'groq' -Key $K } |
                Should -Be 'env:GROQ_API_KEY'
        }

        It 'an explicit gemini key equal to AI_API_KEY is fallback:AI_API_KEY; any other explicit key is explicit' {
            $env:AI_API_KEY = $script:Sentinel.AI_API_KEY
            InModuleScope AIEnrich -Parameters @{ K = $script:Sentinel.AI_API_KEY } { param($K) ConvertTo-AICallLogKeySource -SourceLabel 'explicit parameter' -Backend 'gemini' -Key $K } |
                Should -Be 'fallback:AI_API_KEY'
            InModuleScope AIEnrich -Parameters @{ K = $script:Sentinel.Explicit } { param($K) ConvertTo-AICallLogKeySource -SourceLabel 'explicit parameter' -Backend 'gemini' -Key $K } |
                Should -Be 'explicit'
        }

        It 'an unmappable label (<Label>) gives '''' with a WARN, never free text' -ForEach @(
            @{ Label = '$env:NOT_A_KEY_VAR' }
            @{ Label = 'something unexpected' }
            @{ Label = '' }
        ) {
            $r = InModuleScope AIEnrich -Parameters @{ L = $Label } {
                param($L)
                $v = ConvertTo-AICallLogKeySource -SourceLabel $L -Backend 'gemini' -Key 'k' -WarningVariable w -WarningAction SilentlyContinue
                [pscustomobject]@{ Value = $v; Warn = @($w).Count }
            }
            $r.Value | Should -Be ''
            $r.Warn | Should -Be 1
        }

        It 'the writer''s known key variables are exactly AIEnrich''s key-variable map (no drift)' {
            $writer = InModuleScope AITriad { @($script:AICallLogKeyVars) }
            $enrich = InModuleScope AIEnrich { @($script:AIApiKeyEnvVarMap.Values | ForEach-Object { $_ }) }
            (@($writer | Sort-Object -Unique) -join ',') | Should -Be (@($enrich | Sort-Object -Unique) -join ',')
        }
    }

    Context 'Invoke-AIApi passes the context of the call actually made' {

        It 'success: Model, registry Backend and env KeySource reach a 3-argument logger' {
            $env:GEMINI_API_KEY = $script:Sentinel.GEMINI_API_KEY
            $model = Get-FirstRegisteredId 'gemini'
            Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { $global:AclmGeminiOk }
            $logger = { param($rc, $st, $ctx) $global:AclmCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st; Ctx = $ctx }) }
            Invoke-AIApi -Prompt 'hi' -Model $model -FallbackModels @() -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
            $global:AclmCap.Count | Should -Be 1
            $global:AclmCap[0].Ctx.Model | Should -Be $model
            $global:AclmCap[0].Ctx.Backend | Should -Be 'gemini'
            $global:AclmCap[0].Ctx.KeySource | Should -Be 'env:GEMINI_API_KEY'
        }

        It 'cascade: each link logs its OWN model, backend and key source (fallback key is env:VAR, not explicit)' {
            $env:ANTHROPIC_API_KEY = $script:Sentinel.ANTHROPIC_API_KEY
            $env:GEMINI_API_KEY = $script:Sentinel.GEMINI_API_KEY
            $claude = Get-FirstRegisteredId 'claude'; $gemini = Get-FirstRegisteredId 'gemini'
            Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
                if ($Uri -match 'anthropic') { throw [System.Net.Http.HttpRequestException]::new('simulated transient claude failure') }
                $global:AclmGeminiOk
            }
            $logger = { param($rc, $st, $ctx) $global:AclmCap.Add([pscustomobject]@{ Status = $st; Ctx = $ctx }) }
            $r = Invoke-AIApi -Prompt 'hi' -Model $claude -FallbackModels @($gemini) -MaxRetries 1 -RetryDelays @(0) -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue
            $r.Text | Should -Be 'ok'
            $global:AclmCap.Count | Should -Be 2
            $global:AclmCap[0].Ctx.Model | Should -Be $claude
            $global:AclmCap[0].Ctx.Backend | Should -Be 'claude'
            $global:AclmCap[0].Ctx.KeySource | Should -Be 'env:ANTHROPIC_API_KEY'
            $global:AclmCap[1].Ctx.Model | Should -Be $gemini -Because 'the fallback link logs the model it actually called, not the requested one'
            $global:AclmCap[1].Ctx.Backend | Should -Be 'gemini'
            $global:AclmCap[1].Ctx.KeySource | Should -Be 'env:GEMINI_API_KEY'
        }

        It 'Backend is the registry value, never a guess from the id prefix (AC 3)' {
            # A synthetic id whose prefix says "claude" but whose registry backend is gemini.
            $env:GEMINI_API_KEY = $script:Sentinel.GEMINI_API_KEY
            $real = Get-FirstRegisteredId 'gemini'
            InModuleScope AIEnrich -Parameters @{ Real = $real } {
                param($Real)
                $script:ModelRegistry['claude-lookalike-t4088'] = @{ Backend = 'gemini'; ApiModelId = $Real }   # model-lint:allow-nonselect synthetic registry entry: proves Backend comes from the registry, not the id prefix (t/4088)
            }
            try {
                Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { $global:AclmGeminiOk }
                $logger = { param($rc, $st, $ctx) $global:AclmCap.Add($ctx) }
                Invoke-AIApi -Prompt 'hi' -Model 'claude-lookalike-t4088' -FallbackModels @() -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue | Out-Null   # model-lint:allow-nonselect synthetic registry entry (t/4088)
                $global:AclmCap[0].Backend | Should -Be 'gemini'
            } finally {
                InModuleScope AIEnrich { $script:ModelRegistry.Remove('claude-lookalike-t4088') }
            }
        }

        It 'a 2-argument logger (pre-t/4088 shape) still works' {
            $env:GEMINI_API_KEY = $script:Sentinel.GEMINI_API_KEY
            Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { $global:AclmGeminiOk }
            $logger = { param($rc, $st) $global:AclmCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
            $w = $null
            $r = Invoke-AIApi -Prompt 'hi' -Model (Get-FirstRegisteredId 'gemini') -FallbackModels @() -SkipTokenCheck -CallLogger $logger -WarningVariable w -WarningAction SilentlyContinue
            $r.Text | Should -Be 'ok'
            $global:AclmCap.Count | Should -Be 1
            @($w | Where-Object { "$_" -match 'call-logger threw' }).Count | Should -Be 0
        }
    }

    Context 'Writer: 10 fields in contract order, closed vocabulary, no key material' {

        BeforeEach {
            $env:AI_CALL_LOG_ENABLED = '1'
            $script:LogFile = Join-Path $TestDrive "t4088-$(New-Guid).jsonl"
        }

        It 'writes the 10 fields in contract order' {
            InModuleScope AITriad -Parameters @{ P = $script:LogFile; M = (Get-FirstRegisteredId 'gemini') } {
                param($P, $M)
                Write-AICallLogEntry -Scenario 'Chat' -PromptID 'p' -PromptStart 's' -RetryCount 0 -Status '200' -Model $M -Backend 'gemini' -KeySource 'env:GEMINI_API_KEY' -Path $P
            }
            $line = Get-Content -LiteralPath $script:LogFile | Select-Object -First 1
            @(($line | ConvertFrom-Json).PSObject.Properties.Name) -join ',' | Should -Be ($script:FieldOrder -join ',')
        }

        It 'a KeySource outside the vocabulary (<Value>) is written as '''' with a WARN, never as text' -ForEach @(
            @{ Value = 'env:NOT_A_KEY_VAR' }
            @{ Value = 'x3Pa-explct-Nd6g' }
            @{ Value = 'Explicit' }
        ) {
            $w = InModuleScope AITriad -Parameters @{ P = $script:LogFile; V = $Value } {
                param($P, $V)
                Write-AICallLogEntry -Status '200' -KeySource $V -Path $P -WarningVariable w -WarningAction SilentlyContinue
                @($w).Count
            }
            $w | Should -Be 1
            (Get-Content -LiteralPath $script:LogFile | ConvertFrom-Json).KeySource | Should -Be ''
            Get-Content -Raw -LiteralPath $script:LogFile | Should -Not -Match ([regex]::Escape($Value))
        }

        It 'no key material, not even a 4-character prefix or suffix, reaches the log (AC 2)' {
            foreach ($v in 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_API_KEY') {
                [Environment]::SetEnvironmentVariable($v, $script:Sentinel[$v])
            }
            # Drive real calls, then write each captured context exactly as Invoke-AIByUsage does.
            # The three paths are a success with an explicit key, a cascade (claude 500 -> gemini) whose
            # error body echoes the key, and a gemini AI_API_KEY fallback.
            Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
                if ($Uri -match 'anthropic') {
                    $ex = [System.Net.Http.HttpRequestException]::new("upstream rejected key h2Vn-anthro-Lb8c")
                    throw $ex
                }
                $global:AclmGeminiOk
            }
            $logger = { param($rc, $st, $ctx) $global:AclmCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st; Ctx = $ctx }) }
            Invoke-AIApi -Prompt 'hi' -Model (Get-FirstRegisteredId 'gemini') -ApiKey $script:Sentinel.Explicit -FallbackModels @() -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
            Invoke-AIApi -Prompt 'hi' -Model (Get-FirstRegisteredId 'claude') -FallbackModels @(Get-FirstRegisteredId 'gemini') -MaxRetries 1 -RetryDelays @(0) -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
            $env:GEMINI_API_KEY = $null
            Invoke-AIApi -Prompt 'hi' -Model (Get-FirstRegisteredId 'gemini') -FallbackModels @() -SkipTokenCheck -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
            $global:AclmCap.Count | Should -Be 4

            foreach ($c in $global:AclmCap) {
                InModuleScope AITriad -Parameters @{ P = $script:LogFile; C = $c } {
                    param($P, $C)
                    Write-AICallLogEntry -Scenario 'Chat' -PromptStart 'hi' -RetryCount $C.RetryCount -Status $C.Status `
                        -Model $C.Ctx.Model -Backend $C.Ctx.Backend -KeySource $C.Ctx.KeySource -Path $P
                }
            }
            $raw = Get-Content -Raw -LiteralPath $script:LogFile
            @(($raw -split "`n") | Where-Object { $_ }).Count | Should -Be 4
            foreach ($s in $script:Sentinel.Values) {
                $raw | Should -Not -Match ([regex]::Escape($s))
                $raw | Should -Not -Match ([regex]::Escape($s.Substring(0, 4))) -Because "a 4-character prefix of a key must not appear"
                $raw | Should -Not -Match ([regex]::Escape($s.Substring($s.Length - 4))) -Because "a 4-character suffix of a key must not appear"
            }
            # And the sources were recorded as sources.
            @(($raw -split "`n") | Where-Object { $_ } | ForEach-Object { ($_ | ConvertFrom-Json).KeySource }) -join ',' |
                Should -Be 'explicit,env:ANTHROPIC_API_KEY,env:GEMINI_API_KEY,fallback:AI_API_KEY'
        }
    }

    Context 'Conformance fixture (the contract artifact shared with the TS writers)' {

        It 'Get-AICallLog parses every fixture line, and the legacy 7-field line reads the new fields as ''''' {
            $env:AI_CALL_LOG_ENABLED = '1'
            $e = @(Get-AICallLog -Path $script:Fixture)
            $e.Count | Should -Be 10
            ($e | Select-Object -First 9 | ForEach-Object KeySource) -join ',' |
                Should -Be 'env:GEMINI_API_KEY,env:ANTHROPIC_API_KEY,env:GROQ_API_KEY,fallback:AI_API_KEY,explicit,store,keyvault,none,'
            $e[9].Model | Should -Be ''
            $e[9].Backend | Should -Be ''
            $e[9].KeySource | Should -Be ''
        }

        It 'every fixture KeySource is in the closed vocabulary, and every Model/Backend pair matches ai-models.json' {
            $reg = @{}
            (Get-Content -Raw (Join-Path $PSScriptRoot '..' 'ai-models.json') | ConvertFrom-Json).models | ForEach-Object { $reg[$_.id] = $_.backend }
            foreach ($line in Get-Content -LiteralPath $script:Fixture) {
                $r = $line | ConvertFrom-Json
                if (-not $r.PSObject.Properties['KeySource']) { continue }   # the legacy line
                InModuleScope AITriad -Parameters @{ V = [string]$r.KeySource } { param($V) Test-AICallLogKeySource -Value $V } | Should -BeTrue
                $reg[$r.Model] | Should -Be $r.Backend -Because "fixture model $($r.Model) must be registered under backend $($r.Backend)"
            }
        }

        It 'the writer round-trips each 10-field fixture line: same fields, same order, same values (ID and Datetime are minted)' {
            $env:AI_CALL_LOG_ENABLED = '1'
            $out = Join-Path $TestDrive "roundtrip-$(New-Guid).jsonl"
            $src = @(Get-Content -LiteralPath $script:Fixture | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.PSObject.Properties['KeySource'] })
            foreach ($r in $src) {
                InModuleScope AITriad -Parameters @{ P = $out; R = $r } {
                    param($P, $R)
                    Write-AICallLogEntry -Scenario $R.Scenario -PromptID $R.PromptID -PromptStart $R.PromptStart -RetryCount $R.RetryCount `
                        -Status $R.Status -Model $R.Model -Backend $R.Backend -KeySource $R.KeySource -Path $P
                }
            }
            $got = @(Get-Content -LiteralPath $out | ForEach-Object { $_ | ConvertFrom-Json })
            $got.Count | Should -Be $src.Count
            for ($i = 0; $i -lt $src.Count; $i++) {
                (@($got[$i].PSObject.Properties.Name) -join ',') | Should -Be ($script:FieldOrder -join ',')
                foreach ($f in $script:FieldOrder | Where-Object { $_ -notin 'ID', 'Datetime' }) {
                    "$($got[$i].$f)" | Should -Be "$($src[$i].$f)" -Because "field $f of fixture line $($i + 1)"
                }
            }
        }
    }
}
