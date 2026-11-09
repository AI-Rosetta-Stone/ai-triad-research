# Tag: health (t/3088 follow-up #1)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/3088 follow-up #1 — the embeddings-cache-presence probe (Phase 9) in
    Invoke-TaxEditorSmokeTest, asserted via the ANON /readyz endpoint.
.DESCRIPTION
    /health.embeddings.cachePresent (t/3086) is admin-only (meta.ts anon branch early-returns
    status+ai), so an anon smoke can't read it. /readyz (t/3112, PUBLIC_EXACT_PATHS) returns
    200 IFF the precomputed-vector cache is loaded — the anon "cache present" signal. Like the
    Phase 8 latency probe, this is WARN-FIRST: a 503 (cold-revision prewarm) or unreachable
    surfaces as ::warning:: and is EXCLUDED from OverallPass so it can't false-red the gate.

    Mocks the private Invoke-RemoteCheck HTTP seam (no spend/network) — the proven recipe.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorSmokeTest — embeddings cache presence (/readyz), warn-first (t/3088)' -Tag 'health' {

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
                    '*/readyz' {
                        return [PSCustomObject]@{ Success = ($script:ReadyzStatus -eq 200); StatusCode = $script:ReadyzStatus; ResponseMs = 8
                            Body = $null; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/embeddings/compute' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 150
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

    It 'PRESENT: /readyz 200 → cache present, OverallPass true' {
        InModuleScope AITriad {
            $script:ReadyzStatus = 200
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingCachePresent | Should -BeTrue
            $result.EmbeddingCacheStatus  | Should -Be 'present'
            $result.OverallPass           | Should -BeTrue
        }
    }

    It 'WARMING: /readyz 503 → not present but OverallPass STILL true (warn-first, excluded from gate)' {
        InModuleScope AITriad {
            $script:ReadyzStatus = 503
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingCachePresent | Should -BeFalse
            $result.EmbeddingCacheStatus  | Should -Be 'warming'
            $result.OverallPass           | Should -BeTrue -Because 'a cold-revision prewarm 503 is a monitoring signal, not a hard failure'
        }
    }

    It 'UNREACHABLE: /readyz 0 → status unreachable, OverallPass still true' {
        InModuleScope AITriad {
            $script:ReadyzStatus = 0
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.EmbeddingCachePresent | Should -BeFalse
            $result.EmbeddingCacheStatus  | Should -Be 'unreachable'
            $result.OverallPass           | Should -BeTrue
        }
    }

    It 'surfaces a ::warning:: annotation when the cache is not present' {
        InModuleScope AITriad {
            $script:ReadyzStatus = 503
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
            $out | Should -Match '::warning::Embeddings cache not present'
        }
    }

    It 'emits NO cache warning when present' {
        InModuleScope AITriad {
            $script:ReadyzStatus = 200
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
            $out | Should -Not -Match '::warning::Embeddings cache not present'
        }
    }
}
