# Tag: health (t/3088)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/3088 — timed embedding-latency probe (Measure-EmbeddingLatency) + its non-gating
    Performance category in Invoke-TaxEditorSmokeTest.
.DESCRIPTION
    Prevention for the t/3085 class: embeddings.json was unreachable in prod for 3.5
    months, so every debate re-embedded ~3,600 static texts in-process (25-48s) where a
    cache hit is milliseconds. Nothing FAILED — error-rate gates were blind — so only a
    wall-time ceiling catches it.

    All tests mock the private Invoke-RemoteCheck HTTP seam (no spend, no network) — the
    proven-on-CI recipe (mock the innermost primitive, not the public phase fn; t/2673).
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Measure-EmbeddingLatency — timed probe arms (t/3088)' -Tag 'health' {

    It 'OK: a fast 200 under the ceiling → Status ok, vector count, http 200' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 120
                    Body = [PSCustomObject]@{ vectors = @(1, 2, 3, 4) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status     | Should -Be 'ok'
            $r.DurationMs | Should -Be 120
            $r.Count      | Should -Be 4
            $r.HttpStatus | Should -Be 200
        }
    }

    It 'DEGRADED (slow): a 200 OVER the ceiling → Status degraded (the correct-but-100x-slow catch)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5000
                    Body = [PSCustomObject]@{ vectors = @(1, 2, 3, 4) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status     | Should -Be 'degraded'
            $r.DurationMs | Should -Be 5000
        }
    }

    It 'CEILING param is load-bearing: same 1500ms is ok at 2s but degraded at 1s' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 1500
                    Body = [PSCustomObject]@{ vectors = @(1) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            (Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2).Status | Should -Be 'ok'
            (Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 1).Status | Should -Be 'degraded'
        }
    }

    It 'DEGRADED (non-200): a completed 503 load-shed → Status degraded, http 503 (answered, not unreachable)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 503; ResponseMs = 200
                    Body = $null; ContentType = 'application/json'; RawBody = ''; Error = 'HTTP 503' }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status     | Should -Be 'degraded'
            $r.HttpStatus | Should -Be 503
            $r.Count      | Should -Be 0
        }
    }

    It 'UNREACHABLE (StatusCode 0): server never answered → New-ActionableError (distinct from slow)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 0; ResponseMs = 15000
                    Body = $null; ContentType = ''; RawBody = ''; Error = 'No connection could be made' }
            }
            { Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2 } |
                Should -Throw -ExpectedMessage '*unreachable*'
        }
    }

    It 'empty -NodeId → actionable error (no silent zero-length probe)' {
        InModuleScope AITriad {
            { Measure-EmbeddingLatency -BaseUrl 'https://stub' -NodeId @() } |
                Should -Throw -ExpectedMessage '*node id*'
        }
    }

    It 'sends texts AND ids as JSON ARRAYS even for a single id (server requires an array — 413 otherwise)' {
        InModuleScope AITriad {
            $script:CapturedBody = $null
            Mock Invoke-RemoteCheck -MockWith {
                $script:CapturedBody = $Body
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 50
                    Body = [PSCustomObject]@{ vectors = @(1) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            $null = Measure-EmbeddingLatency -BaseUrl 'https://stub' -NodeId @('skp-beliefs-001')
            $script:CapturedBody | Should -Match '"texts":\['
            $script:CapturedBody | Should -Match '"ids":\['
            $script:CapturedBody | Should -Match 'skp-beliefs-001'
        }
    }
}

Describe 'Invoke-TaxEditorSmokeTest — embedding probe is its OWN category, NON-gating (t/3088)' -Tag 'health' {

    # Full offline pipeline: mock every private primitive healthy; the embeddings-compute
    # path returns slow so the probe is `degraded`. Asserts a slow embed does NOT sink
    # OverallPass (mirrors the GitHub-check exclusion, t/2673) — perf ceiling is its own
    # signal, not a hard failure of unrelated checks.
    BeforeEach {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }

            $script:AnQ = 0
            Mock Invoke-RemoteCheck -MockWith {
                switch -Wildcard ($Path) {
                    '*/api/embeddings/compute' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = $script:EmbMs
                            Body = [PSCustomObject]@{ vectors = @(1, 2, 3, 4) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/analytics/query*' {
                        $script:AnQ++
                        $total = if ($script:AnQ -eq 1) { 5 } else { 6 }
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 10
                            Body = [PSCustomObject]@{ summary = [PSCustomObject]@{ totalEvents = $total }; eventTypes = [PSCustomObject]@{ 'view.dwell' = 1 } }
                            ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/analytics/event' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 10
                            Body = [PSCustomObject]@{ ok = $true; count = 1 }; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/health/oped-files' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 10
                            Body = [PSCustomObject]@{ ok = $true; assets = @('soul', 'oped') }; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    default {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 42
                            Body = [PSCustomObject]@{ nodes = @(); id = 'stub-item' }; ContentType = 'application/json'
                            RawBody = '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'; Error = $null }
                    }
                }
            }
        }
    }

    It 'a DEGRADED embedding probe does NOT sink OverallPass (own category, warning-only)' {
        InModuleScope AITriad {
            $script:EmbMs = 5000   # over the 2s ceiling → degraded
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null

            $result.EmbeddingStatus | Should -Be 'degraded'
            $result.EmbeddingLatencyMs | Should -Be 5000
            $result.OverallPass | Should -BeTrue -Because 'a slow embed is a monitoring signal, not a hard failure — it must not false-red the deploy gate'
            $result.HealthOk | Should -BeTrue
            $result.AzureOk  | Should -BeTrue
        }
    }

    It 'surfaces a ::warning:: annotation when the embedding probe is degraded' {
        InModuleScope AITriad {
            $script:EmbMs = 5000
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
            $out | Should -Match '::warning::Embedding latency degraded'
        }
    }

    It 'a fast embedding probe reports ok and the field is populated' {
        InModuleScope AITriad {
            $script:EmbMs = 150   # under the 2s ceiling → ok
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingStatus    | Should -Be 'ok'
            $result.EmbeddingLatencyMs | Should -Be 150
            $result.OverallPass        | Should -BeTrue
        }
    }
}
