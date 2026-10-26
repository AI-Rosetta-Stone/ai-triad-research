# Tag: health (t/4505 AC3, t/4516)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4505 AC3 / t/4516 — the identity-allowlist-unreachable probe (Phase 10) in
    Invoke-TaxEditorSmokeTest, asserted via the ANON GET /health endpoint.
.DESCRIPTION
    /health.identityAllowlistUnreachable (t/4505, PR #3825) is a COUNT ONLY, exposed to an
    anonymous caller (meta.ts's !isAdmin() branch). WARN-FIRST like Phases 8/9: the PI's two
    legacy AAD-derived admin names correctly show as unreachable today (until #3741/t/4326's
    IDENTITY_MAP update lands) and stay unreachable, so a hard `== 0` would fail every deploy.
    A count at or below the dated known-pending list (2, 2026-10-26) is [PASS]; above it
    surfaces as ::warning:: and is EXCLUDED from OverallPass.

    /health is ALSO one of Test-TaxEditorEndpoints' own standard (gating) checks, so the
    full-integration tests below always keep /health reachable — an unreachable /health
    belongs to that pre-existing gate, not to this phase. The unreachable case for THIS
    phase is covered at the unit level (direct call, its own narrow mock), below.

    Mocks the private Invoke-RemoteCheck HTTP seam (no spend/network) — the proven recipe
    from Invoke-TaxEditorSmokeTest.CachePresence.Tests.ps1.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorSmokeTest — identity allowlist unreachable (/health), warn-first (t/4516)' -Tag 'health' {

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
                    '*/health' {
                        # Always reachable here — /health going DOWN is the pre-existing
                        # Test-TaxEditorEndpoints gate's concern, not this phase's.
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 9
                            Body = [PSCustomObject]@{ status = 'ok'; identityAllowlistUnreachable = $script:AllowlistCount }
                            ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/embeddings/compute' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 150
                            Body = [PSCustomObject]@{ vectors = @(1, 2, 3, 4) }; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/readyz' {
                        return [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 8
                            Body = $null; ContentType = 'application/json'; RawBody = ''; Error = $null }
                    }
                    '*/api/analytics/query' {
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

    It 'AT the known-pending count (2): [PASS], OverallPass true' {
        InModuleScope AITriad {
            $script:AllowlistCount = 2
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.IdentityAllowlistUnreachable | Should -Be 2
            $result.IdentityAllowlistStatus       | Should -Be 'ok'
            $result.OverallPass                   | Should -BeTrue
        }
    }

    It 'BELOW the known-pending count (0, legacy names already remapped): still ok' {
        InModuleScope AITriad {
            $script:AllowlistCount = 0
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.IdentityAllowlistUnreachable | Should -Be 0
            $result.IdentityAllowlistStatus       | Should -Be 'ok'
            $result.OverallPass                   | Should -BeTrue
        }
    }

    It 'ABOVE the known-pending count (3): breach, but OverallPass STILL true (warn-first, excluded from gate)' {
        InModuleScope AITriad {
            $script:AllowlistCount = 3
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null
            $result.IdentityAllowlistUnreachable | Should -Be 3
            $result.IdentityAllowlistStatus       | Should -Be 'breach'
            $result.OverallPass                   | Should -BeTrue -Because 'a new unreachable entry is a monitoring signal, not a hard failure'
        }
    }

    It 'surfaces a ::warning:: annotation when the count exceeds the known-pending list' {
        InModuleScope AITriad {
            $script:AllowlistCount = 3
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
            $out | Should -Match '::warning::Identity allowlist unreachable count'
        }
    }

    It 'emits NO allowlist warning at or below the known-pending count' {
        InModuleScope AITriad {
            $script:AllowlistCount = 2
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>&1 | Out-String
            $out | Should -Not -Match '::warning::Identity allowlist unreachable count'
        }
    }
}

Describe 'Invoke-SmokeIdentityAllowlistPhase (unit-level, t/4516)' -Tag 'health' {

    It 'reports Status=unreachable, Count=$null, and never throws when /health itself is down' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $false; StatusCode = 0; ResponseMs = 5
                    Body = $null; ContentType = ''; RawBody = ''; Error = 'connection refused' }
            }
            $r = Invoke-SmokeIdentityAllowlistPhase -BaseUrl 'https://stub' -TimeoutSec 5 6>$null
            $r.Status | Should -Be 'unreachable'
            $r.Count  | Should -BeNullOrEmpty
        }
    }

    It 'reports the dated known-pending count (2, 2026-10-26)' {
        InModuleScope AITriad {
            $script:SmokeIdentityAllowlistKnownPendingCount | Should -Be 2
        }
    }
}
