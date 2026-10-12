# Tag: unit (t/3242)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    AI Call Log — capture hook (t/3242; epic t/3235, TL ruling Option C t/3242#2).
.DESCRIPTION
    Invoke-AIApi (AIEnrich) invokes an injected -CallLogger scriptblock ONCE per call with
    (RetryCount, Status), fired before the failure $null-return / success extraction so failures
    are logged too. Invoke-AIByUsage (AITriad) supplies a GetNewClosure scriptblock that — thanks
    to AITriad module affinity — reaches the private Write-AICallLogEntry across the module boundary.

    IoC tests inject a capturing logger to assert RetryCount/Status at the AIEnrich choke point
    (incl. a 429-retry, a terminal 500, cascade-forwarding, and fail-safety). End-to-end tests
    drive Invoke-AIByUsage → the real writer (path redirected to TestDrive). $global: state is used
    for cross-module-scope visibility (mocks run in AIEnrich's scope).
#>

BeforeAll {
    # Import BOTH modules: AITriad for Invoke-AIByUsage + the private Write-AICallLogEntry, then
    # AIEnrich LAST so Invoke-AIApi is directly callable + mockable (-ModuleName AIEnrich) in the
    # test scope (AITriad's internal -Force re-import otherwise shadows the direct handle).
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    # A minimal-but-valid Gemini success envelope (survives the gemini text extraction).
    $global:AclGeminiOk = [pscustomobject]@{
        candidates    = @([pscustomobject]@{
                content      = [pscustomobject]@{ parts = @([pscustomobject]@{ text = 'ok' }) }
                finishReason = 'STOP'
            })
        usageMetadata = [pscustomobject]@{ promptTokenCount = 1; candidatesTokenCount = 1; totalTokenCount = 2 }
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name AclGeminiOk -ErrorAction SilentlyContinue
}

Describe 'AI Call Log capture — Invoke-AIApi IoC logger (t/3242)' -Tag 'unit' {

    BeforeEach {
        $global:AclCap = [System.Collections.Generic.List[object]]::new()
        $global:AclCalls = 0
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { }
        Mock Resolve-AIApiKey -ModuleName AIEnrich -MockWith { 'fake-key' }
    }
    AfterEach {
        Remove-Variable -Scope Global -Name AclCap, AclCalls -ErrorAction SilentlyContinue
    }

    It 'fires the logger once on success: RetryCount 0, Status 200' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { $global:AclGeminiOk }
        $logger = { param($rc, $st) $global:AclCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -FallbackModels @() `
            -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
        $global:AclCap.Count       | Should -Be 1
        $global:AclCap[0].RetryCount | Should -Be 0
        $global:AclCap[0].Status     | Should -Be '200'
    }

    It 'increments RetryCount on a 429-then-200 (the retry-loop count reaches the log)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $global:AclCalls++
            if ($global:AclCalls -eq 1) {
                $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]429)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Too Many Requests', $r)
            }
            $global:AclGeminiOk
        }
        $logger = { param($rc, $st) $global:AclCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -FallbackModels @() `
            -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
        $global:AclCap.Count         | Should -Be 1
        $global:AclCap[0].RetryCount | Should -Be 1
        $global:AclCap[0].Status     | Should -Be '200'
    }

    It 'logs a terminal 500 (RetryCount 0, Status 500) — the failure IS captured (TL cond.4)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]500)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Server Error', $r)
        }
        $logger = { param($rc, $st) $global:AclCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
        # -MaxRetries 1: since t/4078 a 500 is retried, so one attempt is what makes this 500 terminal.
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -FallbackModels @() -MaxRetries 1 `
            -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
        $global:AclCap.Count         | Should -Be 1
        $global:AclCap[0].RetryCount | Should -Be 0
        $global:AclCap[0].Status     | Should -Be '500'
    }

    It 'a retried 500 is logged once, with its RetryCount (t/4078)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]500)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Server Error', $r)
        }
        $logger = { param($rc, $st) $global:AclCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -FallbackModels @() -MaxRetries 3 `
            -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
        $global:AclCap.Count         | Should -Be 1
        $global:AclCap[0].RetryCount | Should -Be 2
        $global:AclCap[0].Status     | Should -Be '500'
    }

    It 'is fail-safe: a THROWING logger does not break the AI call (TL cond.2)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith { $global:AclGeminiOk }
        $boom = { param($rc, $st) throw 'logger blew up' }
        { Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -FallbackModels @() `
                -CallLogger $boom -WarningAction SilentlyContinue } | Should -Not -Throw
    }

    It 'forwards the logger through the cascade — primary 500 + fallback 200 = 2 records (TL cond.1)' {
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $global:AclCalls++
            if ($global:AclCalls -eq 1) {
                $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]500)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Server Error', $r)
            }
            $global:AclGeminiOk
        }
        $logger = { param($rc, $st) $global:AclCap.Add([pscustomobject]@{ RetryCount = $rc; Status = $st }) }
        # -MaxRetries 1: since t/4078 a 500 is retried; one primary attempt makes the fallback serve call 2.
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -ApiKey 'fake' -MaxRetries 1 `
            -FallbackModels @('gemini-3.7-flash') -CallLogger $logger -WarningAction SilentlyContinue | Out-Null
        $global:AclCap.Count     | Should -Be 2
        $global:AclCap[0].Status | Should -Be '500'   # primary
        $global:AclCap[1].Status | Should -Be '200'   # fallback
    }
}

Describe 'AI Call Log capture — Invoke-AIByUsage end-to-end wiring (t/3242)' -Tag 'unit' {

    BeforeEach {
        Mock Get-UsageConfig -ModuleName AITriad -MockWith { @{ message = 'Say hi'; model = 'gemini-3.5-flash-lite' } }
        # Mock Invoke-AIApi at the AITriad boundary: fire the injected logger like a real success (one
        # attempt, HTTP 200) and return a result. This isolates the Invoke-AIByUsage WIRING from the
        # AIEnrich internals (model registry / key resolution / HTTP / extraction) — the real
        # Invoke-AIApi behavior (firing the logger with the right RetryCount/Status) is covered by the
        # IoC tests above, so it must not be re-driven through the full stack here (env-fragile).
        Mock Invoke-AIApi -ModuleName AITriad -MockWith {
            if ($CallLogger) { & $CallLogger 0 '200' }
            [pscustomobject]@{ Text = 'ok'; Backend = 'gemini' }
        }
        $global:AclLogFile = Join-Path $TestDrive 'e2e-ai-call-log.jsonl'
        # $TestDrive persists across Its in a Describe — clear any prior record so each test is isolated.
        Remove-Item -LiteralPath $global:AclLogFile -Force -ErrorAction SilentlyContinue
        Mock Get-AICallLogPath -ModuleName AITriad -MockWith { $global:AclLogFile }
    }
    AfterEach {
        Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue
        Remove-Variable -Scope Global -Name AclLogFile -ErrorAction SilentlyContinue
    }

    It 'flag ON: the closure reaches Write-AICallLogEntry across the module boundary and writes a record' {
        $env:AI_CALL_LOG_ENABLED = '1'
        Invoke-AIByUsage -UsageId 'enrichment.demo-scenario' -Values @{} -WarningAction SilentlyContinue | Out-Null
        Test-Path -LiteralPath $global:AclLogFile | Should -BeTrue
        $rec = Get-Content -LiteralPath $global:AclLogFile | Select-Object -First 1 | ConvertFrom-Json
        $rec.PromptID   | Should -Be 'enrichment.demo-scenario'
        $rec.Scenario   | Should -Be 'enrichment.demo-scenario'   # defaulted to the UsageId
        $rec.Status     | Should -Be 200
        $rec.RetryCount | Should -Be 0
        $rec.PromptStart | Should -Be 'Say hi'
    }

    It 'honors an explicit -Scenario tag' {
        $env:AI_CALL_LOG_ENABLED = '1'
        Invoke-AIByUsage -UsageId 'enrichment.demo-scenario' -Values @{} -Scenario 'Debate' -WarningAction SilentlyContinue | Out-Null
        $rec = Get-Content -LiteralPath $global:AclLogFile | Select-Object -First 1 | ConvertFrom-Json
        $rec.Scenario | Should -Be 'Debate'
    }

    It 'flag OFF: no record is written (writer no-ops end-to-end)' {
        Invoke-AIByUsage -UsageId 'enrichment.demo-scenario' -Values @{} -WarningAction SilentlyContinue | Out-Null
        Test-Path -LiteralPath $global:AclLogFile | Should -BeFalse
    }
}
