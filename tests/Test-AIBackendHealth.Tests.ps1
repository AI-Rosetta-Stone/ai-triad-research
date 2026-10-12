# Tag: enrichment (t/2212)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Unit tests for Test-AIBackendHealth (t/2212).
.DESCRIPTION
    Mocks Invoke-AIApi to verify status/latency/error-message output without
    hitting live backends. Exercises: ok, timeout, error, and -All dispatch.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-AIBackendHealth' -Tag 'enrichment' {

    Context 'Single backend — ok' {
        BeforeEach {
            Mock Invoke-AIApi -ModuleName AITriad {
                [PSCustomObject]@{ Text = 'pong'; Backend = 'gemini'; Model = 'gemini-3.7-flash'; Truncated = $false; Usage = $null; RawResponse = $null }
            }
        }

        It 'Returns status ok when Invoke-AIApi succeeds' {
            $Result = Test-AIBackendHealth -Backend gemini
            $Result.Status   | Should -Be 'ok'
            $Result.Backend  | Should -Be 'gemini'
            $Result.LatencyMs | Should -BeGreaterOrEqual 0
            $Result.ErrorMessage | Should -BeNullOrEmpty
        }

        It 'Populates Model from ai-models.json defaults' {
            $Result = Test-AIBackendHealth -Backend gemini
            $Result.Model | Should -Not -BeNullOrEmpty
        }
    }

    Context 'Single backend — error (null result, no timeout)' {
        BeforeEach {
            Mock Invoke-AIApi -ModuleName AITriad { $null }
        }

        It 'Returns status error when Invoke-AIApi returns null' {
            $Result = Test-AIBackendHealth -Backend gemini
            $Result.Status | Should -Be 'error'
            $Result.ErrorMessage | Should -Not -BeNullOrEmpty
        }

        It 'Does not throw — failure is a reported row' {
            { Test-AIBackendHealth -Backend claude } | Should -Not -Throw
        }
    }

    Context 'Single backend — timeout' {
        BeforeEach {
            Mock Invoke-AIApi -ModuleName AITriad {
                # Simulate a slow call by writing a timeout warning, then returning null.
                Write-Warning 'Request timed out after 15 seconds (TaskCanceled)'
                $null
            }
        }

        It 'Returns status timeout when warning contains timeout keyword' {
            $Result = Test-AIBackendHealth -Backend gemini -TimeoutSec 15
            $Result.Status | Should -Be 'timeout'
        }
    }

    Context '-All dispatch' {
        BeforeEach {
            Mock Invoke-AIApi -ModuleName AITriad {
                [PSCustomObject]@{ Text = 'ok'; Backend = 'x'; Model = 'x'; Truncated = $false; Usage = $null; RawResponse = $null }
            }
        }

        It 'Emits one row per backend in ai-models.json defaults' {
            $Results = @(Test-AIBackendHealth -All)
            $Results.Count | Should -BeGreaterThan 1
        }

        It 'All rows have required properties' {
            $Results = @(Test-AIBackendHealth -All)
            foreach ($R in $Results) {
                $R.PSObject.Properties.Name | Should -Contain 'Backend'
                $R.PSObject.Properties.Name | Should -Contain 'Model'
                $R.PSObject.Properties.Name | Should -Contain 'Status'
                $R.PSObject.Properties.Name | Should -Contain 'LatencyMs'
                $R.PSObject.Properties.Name | Should -Contain 'ErrorMessage'
            }
        }
    }

    Context 'Probe call shape (t/4078)' {
        It 'sends ONE attempt with no cascade (MaxRetries 1, FallbackModels @()), which Invoke-AIApi accepts' {
            # -MaxRetries 0 sent no request at all and is now rejected by Invoke-AIApi's ValidateRange(1, 10).
            $script:ProbeArgs = $null
            Mock Invoke-AIApi -ModuleName AITriad {
                $script:ProbeArgs = @{ MaxRetries = $MaxRetries; FallbackModels = $FallbackModels; Bound = @($PesterBoundParameters.Keys) }
                [PSCustomObject]@{ Text = 'pong' }
            }
            Test-AIBackendHealth -Backend gemini | Out-Null
            $script:ProbeArgs.MaxRetries | Should -Be 1
            $script:ProbeArgs.Bound | Should -Contain 'FallbackModels'
            @($script:ProbeArgs.FallbackModels).Count | Should -Be 0
            # The real Invoke-AIApi lives in AIEnrich (imported by AITriad into its own scope).
            $real = & (Get-Module AITriad) { @(Get-Command Invoke-AIApi -All | Where-Object { $_.ModuleName -eq 'AIEnrich' })[0] }
            $range = $real.Parameters['MaxRetries'].Attributes |
                Where-Object { $_ -is [System.Management.Automation.ValidateRangeAttribute] }
            $range | Should -Not -BeNullOrEmpty
            [int]$script:ProbeArgs.MaxRetries | Should -BeGreaterOrEqual ([int]$range.MinRange)
        }

        It 'a 200 with no text (the t/4078 "response had no text" WARN) still reports the backend ok' {
            Mock Invoke-AIApi -ModuleName AITriad {
                Write-Warning 'Google Gemini: response had no text (backend gemini, model m, finishReason=MAX_TOKENS). Returning $null so a fallback can be tried.'
                $null
            }
            (Test-AIBackendHealth -Backend gemini).Status | Should -Be 'ok'
        }
    }

    Context 'Parameter validation' {
        It 'Rejects an unknown backend name' {
            { Test-AIBackendHealth -Backend 'nonexistent-backend' } | Should -Throw
        }

        It 'Requires either -Backend or -All' {
            { Test-AIBackendHealth } | Should -Throw
        }
    }
}
