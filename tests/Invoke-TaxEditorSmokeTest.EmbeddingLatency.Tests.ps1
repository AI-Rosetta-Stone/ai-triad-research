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

    It 'DEGRADED (no vectors): a fast 200 that returns no vectors measured nothing (t/621)' {
        InModuleScope AITriad {
            # Prod, run 45617524758: `109ms (ceiling 2s, 0 vectors, http 200)` was reported as PASS.
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 109
                    Body = [PSCustomObject]@{ vectors = @() }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status | Should -Be 'degraded' -Because 'a response that looked nothing up is fast whatever state the cache is in'
            $r.Count  | Should -Be 0
            $r.Error  | Should -Be 'no vectors returned; latency not measured'
            # A body with no vectors field at all reads the same way.
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 90; Body = [PSCustomObject]@{ ok = $true }; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }
            (Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2).Status | Should -Be 'degraded'
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

    It 'FAILED (non-200): a completed 503 load-shed → Status failed, http 503 (answered, not unreachable, not slow) (t/747)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 503; ResponseMs = 200
                    Body = $null; ContentType = 'application/json'; RawBody = ''; Error = 'HTTP 503' }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status     | Should -Be 'failed' -Because 'the request did not succeed, so no latency was measured'
            $r.HttpStatus | Should -Be 503
            $r.Count      | Should -Be 0
        }
    }

    It 'carries the X-Auth-Reason of a refused request, which is a failed probe (t/737, t/747)' {
        InModuleScope AITriad {
            # CI container smoke, run 45725505446: `65ms (ceiling 2s, 0 vectors, http 403)`.
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 403; ResponseMs = 65
                    Body = $null; ContentType = 'application/json'; RawBody = ''; Error = 'HTTP 403'; AuthReason = 'anon_route_blocked' }
            }
            $r = Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2
            $r.Status     | Should -Be 'failed' -Because 'the probe reports the reason; the phase decides what it means'
            $r.HttpStatus | Should -Be 403
            $r.AuthReason | Should -Be 'anon_route_blocked'
            # A result with no AuthReason field (an older mock, a success) reads as no reason.
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 503; ResponseMs = 200; Body = $null; ContentType = ''; RawBody = ''; Error = 'HTTP 503' }
            }
            (Measure-EmbeddingLatency -BaseUrl 'https://stub' -CeilingSec 2).AuthReason | Should -Be ''
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
            # t/747: -AsArray on an array argument wrote '[["x"]]'; the server answered 500 to it.
            $script:CapturedBody | Should -Not -Match '\[\['
            $One = $script:CapturedBody | ConvertFrom-Json
            @($One.ids).Count   | Should -Be 1
            @($One.texts).Count | Should -Be 1
            $One.ids[0]   | Should -BeOfType ([string])
            $One.ids[0]   | Should -Be 'skp-beliefs-001'
            $One.texts[0] | Should -BeOfType ([string])
            # The default batch of four: four strings each, not one array of four.
            $null = Measure-EmbeddingLatency -BaseUrl 'https://stub'
            $script:CapturedBody | Should -Not -Match '\[\['
            $Four = $script:CapturedBody | ConvertFrom-Json
            @($Four.ids).Count   | Should -Be 4
            @($Four.texts).Count | Should -Be 4
            foreach ($V in @($Four.ids) + @($Four.texts)) { $V | Should -BeOfType ([string]) }
            $Four.ids | Should -Be @('skp-beliefs-001', 'sit-001', 'acc-desires-001', 'saf-desires-001')
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
                    '*/api/analytics/query?includeSystem=true' {
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

    It 'the phase gives the probe an anonymous session (t/621: without one the route answers 401 or returns no vectors)' {
        InModuleScope AITriad {
            $script:EmbMs = 150
            $script:ProbeSession = 'not called'
            Mock Measure-EmbeddingLatency -MockWith {
                $script:ProbeSession = $Session
                [PSCustomObject]@{ DurationMs = 150; Status = 'ok'; Count = 4; HttpStatus = 200; CeilingSec = 2; NodeIds = @('x'); Error = $null }
            }
            $null = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>$null
            $script:ProbeSession | Should -BeOfType ([Microsoft.PowerShell.Commands.WebRequestSession])
            # No session to be had: the probe still runs, with none, and the phase says so.
            Mock New-AnonymousWebSession -MockWith { $null }
            $script:ProbeSession = 'not called'
            $out = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>&1 | Out-String
            $script:ProbeSession | Should -BeNullOrEmpty
            $out | Should -Match 'anonymous session not established'
        }
    }

    It 'a probe that returns no vectors is a warning with the reason, and does not sink OverallPass (t/621)' {
        InModuleScope AITriad {
            Mock Measure-EmbeddingLatency -MockWith {
                [PSCustomObject]@{ DurationMs = 109; Status = 'degraded'; Count = 0; HttpStatus = 200; CeilingSec = 2; NodeIds = @('x'); Error = 'no vectors returned; latency not measured' }
            }
            $out = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>&1 | Out-String
            $out | Should -Match '\[DEGRADED\] embeddings\.compute'
            $out | Should -Match 'no vectors returned, latency not measured'
            $out | Should -Match '::warning::Embedding latency degraded'
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingStatus | Should -Be 'degraded'
            $result.OverallPass | Should -BeTrue -Because 'the probe is a monitoring signal; it never fails a deploy'
        }
    }

    It 'free tier off: 403 with anon_route_blocked is reported as skipped, with no warning (t/737)' {
        InModuleScope AITriad {
            Mock Measure-EmbeddingLatency -MockWith {
                [PSCustomObject]@{ DurationMs = 65; Status = 'failed'; Count = 0; HttpStatus = 403; CeilingSec = 2; NodeIds = @('x'); Error = 'HTTP 403'; AuthReason = 'anon_route_blocked' }
            }
            $out = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>&1 | Out-String
            $out | Should -Match '\[SKIPPED\] embeddings\.compute'
            $out | Should -Match 'skipped: free tier off \(anon embeddings need the free-tier key\)'
            $out | Should -Not -Match '::warning::'
            $out | Should -Not -Match '\[DEGRADED\]'
            $out | Should -Not -Match '\[FAILED\]'
            $Phase = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>$null
            $Phase.Status | Should -Be 'skipped'
            $Phase.Reason | Should -Be 'free tier off (anon embeddings need the free-tier key)'
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingStatus | Should -Be 'skipped'
            $result.OverallPass     | Should -BeTrue
        }
    }

    It 'any other refusal is reported as a failed probe, never as slow, with the reason: <Case>' -ForEach @(
        @{ Case = '403 with another reason'; Http = 403; Reason = 'user_not_in_allowlist'; Shown = 'auth reason user_not_in_allowlist' }
        @{ Case = '403 with no reason'; Http = 403; Reason = ''; Shown = 'http 403\)' }
        @{ Case = '401 with anon_route_blocked'; Http = 401; Reason = 'anon_route_blocked'; Shown = 'auth reason anon_route_blocked' }
        @{ Case = '401 no_session'; Http = 401; Reason = 'no_session'; Shown = 'auth reason no_session' }
        @{ Case = '500'; Http = 500; Reason = ''; Shown = 'http 500\)' }
    ) {
        InModuleScope AITriad -Parameters @{ Http = $Http; Reason = $Reason; Shown = $Shown } {
            param($Http, $Reason, $Shown)
            $script:ProbeHttp = $Http; $script:ProbeReason = $Reason
            Mock Measure-EmbeddingLatency -MockWith {
                [PSCustomObject]@{ DurationMs = 70; Status = 'failed'; Count = 0; HttpStatus = $script:ProbeHttp; CeilingSec = 2; NodeIds = @('x'); Error = "HTTP $($script:ProbeHttp)"; AuthReason = $script:ProbeReason }
            }
            $out = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>&1 | Out-String
            $out | Should -Match '\[FAILED\] embeddings\.compute — probe failed, no latency measured'
            $out | Should -Match $Shown
            $out | Should -Match '::warning::Embedding probe failed — probe failed, no latency measured'
            $out | Should -Not -Match 'Embedding latency degraded' -Because 'a failed request is not a slow one'
            $out | Should -Not -Match '\[DEGRADED\]'
            $out | Should -Not -Match 'SKIPPED'
            $Phase = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>$null
            $Phase.Status  | Should -Be 'failed'
            $Phase.Reason  | Should -Be ''
            $Phase.Summary | Should -Match '^probe failed, no latency measured \(http \d+'
        }
    }

    It 'an HTTP 500 from the endpoint is a FAILED probe in the smoke summary, with a warning, and does not sink OverallPass (t/747)' {
        InModuleScope AITriad {
            # Prod since deploy-63c11e7: the endpoint answered 500 to the probe and the smoke read like a slow response.
            Mock Measure-EmbeddingLatency -MockWith {
                [PSCustomObject]@{ DurationMs = 44; Status = 'failed'; Count = 0; HttpStatus = 500; CeilingSec = 2; NodeIds = @('x'); Error = 'HTTP 500'; AuthReason = '' }
            }
            $SummaryFile = Join-Path $TestDrive 'step-summary.md'
            Set-Content -LiteralPath $SummaryFile -Value '' -NoNewline
            $SavedSummary = $env:GITHUB_STEP_SUMMARY
            $env:GITHUB_STEP_SUMMARY = $SummaryFile
            try {
                $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
                $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            } finally { $env:GITHUB_STEP_SUMMARY = $SavedSummary }
            $out | Should -Match '\[FAILED\] embeddings\.compute — probe failed, no latency measured \(http 500\)'
            $out | Should -Match '::warning::Embedding probe failed'
            $out | Should -Match 'Embedding probe: probe failed, no latency measured \(http 500\)' -Because 'the summary block names the failed probe'
            $out | Should -Not -Match 'Embedding latency degraded'
            (Get-Content -Raw -LiteralPath $SummaryFile) | Should -Match 'Embedding probe: probe failed, no latency measured \(http 500\)'
            $result.EmbeddingStatus  | Should -Be 'failed'
            $result.EmbeddingSummary | Should -Be 'probe failed, no latency measured (http 500)'
            $result.OverallPass      | Should -BeTrue -Because 'the probe is a monitoring signal; it never fails a deploy'
        }
    }

    It 'a slow probe is reported as slow, not as failed, and writes nothing to the job summary (t/747)' {
        InModuleScope AITriad {
            $script:EmbMs = 5000
            $SummaryFile = Join-Path $TestDrive 'step-summary-slow.md'
            Set-Content -LiteralPath $SummaryFile -Value '' -NoNewline
            $SavedSummary = $env:GITHUB_STEP_SUMMARY
            $env:GITHUB_STEP_SUMMARY = $SummaryFile
            try { $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String }
            finally { $env:GITHUB_STEP_SUMMARY = $SavedSummary }
            $out | Should -Match '\[DEGRADED\] embeddings\.compute'
            $out | Should -Match '::warning::Embedding latency degraded'
            $out | Should -Match 'Embedding probe: slow: 5000ms against a ceiling of 2s'
            $out | Should -Not -Match 'probe failed'
            (Get-Content -Raw -LiteralPath $SummaryFile) | Should -BeNullOrEmpty
        }
    }

    It 'an unreachable server is a failed probe too' {
        InModuleScope AITriad {
            Mock Measure-EmbeddingLatency -MockWith { throw 'embeddings endpoint unreachable at https://stub/api/embeddings/compute after 15000ms' }
            $out = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>&1 | Out-String
            $out | Should -Match '\[FAILED\] embeddings\.compute — unreachable'
            $out | Should -Match '::warning::Embedding probe failed — probe failed, no latency measured \(server unreachable\)'
            (Invoke-SmokeEmbeddingLatencyPhase -BaseUrl 'https://stub' -TimeoutSec 5 -CeilingSec 2 6>$null).Status | Should -Be 'unreachable'
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
