# Tag: health (t/2667)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the t/2667 analytics write/read round-trip probe added to
    Invoke-TaxEditorSmokeTest (Phase 5).
.DESCRIPTION
    Q3b prevention (failure Class 3): the blob analytics backend silently drops
    events when misconfigured while the server still returns 200. The probe's
    authoritative detector is a DELTA READ-BACK — read aggregated totalEvents,
    POST a synthetic event, read again, require the count to increase.

    These tests mock the Private Invoke-RemoteCheck (the analytics phase's HTTP
    helper) inside the module and stub the other four phases so the orchestration
    runs offline. Gate integrity is proven both ways: a clean round-trip passes,
    and each failure mode (silent drop / write unreachable / read path broken)
    sinks OverallPass and surfaces in FailedEndpoints.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorSmokeTest analytics round-trip probe (t/2667, t/4967)' -Tag 'health' {

    BeforeEach {
        InModuleScope AITriad {
            # Stub the four non-analytics phases so OverallPass hinges on analytics.
            Mock Test-TaxEditorHealth -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Test-TaxEditorEndpoints -MockWith {
                @([PSCustomObject]@{
                    Endpoint = '/api/models'; Category = 'Core'; Description = 'stub'
                    Status = 200; Pass = $true; Ms = 42; NodeCount = 0; Error = $null
                })
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Start-Sleep -MockWith { }

            # Fallback for any path not explicitly stubbed (e.g. Phase 9 /readyz cache probe,
            # t/3088) — a benign reachable 200. Specific -ParameterFilter mocks below take
            # precedence, so analytics call-count assertions are unaffected.
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5
                    Body = $null; ContentType = 'application/json'; RawBody = ''; Error = $null }
            }

            # Phase 5 now establishes an anon session (t/2684) before the round-trip —
            # stub it so the tests stay offline and fast. Default: a real session so
            # the -Session param is threaded through the three calls; individual tests
            # override to $null to exercise the unavailable path.
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }

            # Phase 7 (t/2689) runs before analytics — stub it so analytics tests focus on their phase.
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/health/oped-files' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 5
                    Body = [PSCustomObject]@{ ok = $true; assets = @() }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }

            # Helper builds an Invoke-RemoteCheck-shaped result.
            function script:New-RCResult ($Success, $Status, $Body) {
                [PSCustomObject]@{
                    Success = $Success; StatusCode = $Status; ResponseMs = 10
                    Body = $Body; ContentType = 'application/json'; RawBody = ''; Error = $(if (-not $Success) { "HTTP $Status" } else { $null })
                }
            }
        }
    }

    It 'clean round-trip: totalEvents increases → Analytics PASS, OverallPass true' {
        InModuleScope AITriad {
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                $total = if ($script:QueryCall -eq 1) { 5 } else { 6 }   # +1 after write
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = $total }
                    eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:QueryCall -ge 2) { 1 } else { 0 } }
                })
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeTrue -Because 'a clean analytics round-trip with all other phases green must pass'
            @($result.FailedEndpoints | Where-Object { $_.Category -eq 'Analytics' }).Count |
                Should -Be 0 -Because 'neither analytics probe should fail on a healthy round-trip'
            @($result.Categories | Where-Object { $_.Category -eq 'Analytics' }).Count |
                Should -Be 1 -Because 'the Analytics category must appear in the per-category breakdown'
        }
    }

    It 'SILENT DROP: totalEvents flat after a 200 write → delta FAILS, OverallPass false (the critical catch)' {
        InModuleScope AITriad {
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                New-RCResult $true 200 ([PSCustomObject]@{ summary = [PSCustomObject]@{ totalEvents = 5 } })  # never increases
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })  # server reports success — the trap
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeFalse -Because 'a silent drop (write 200 but nothing stored) must sink the gate'
            $delta = $result.FailedEndpoints | Where-Object { $_.Endpoint -like '*delta read-back*' }
            $delta | Should -Not -BeNullOrEmpty -Because 'the delta read-back is the authoritative silent-drop detector'
            $delta.Error | Should -Match 'Silent drop'
            # The write probe alone reports 200+ok:true — proving it can NOT be the detector.
            $write = $result.FailedEndpoints | Where-Object { $_.Endpoint -eq 'POST /api/analytics/event' }
            $write | Should -BeNullOrEmpty -Because 'the write is reachability-only; it passes on the silent drop, which is exactly why the delta is needed'
        }
    }

    It 'WRITE UNREACHABLE: POST non-200 → write probe FAILS, OverallPass false' {
        InModuleScope AITriad {
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                New-RCResult $true 200 ([PSCustomObject]@{ summary = [PSCustomObject]@{ totalEvents = 5 } })
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $false 502 $null
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeFalse
            $write = $result.FailedEndpoints | Where-Object { $_.Endpoint -eq 'POST /api/analytics/event' }
            $write | Should -Not -BeNullOrEmpty -Because 'an unreachable write endpoint must fail the gate'
        }
    }

    It 'READ PATH BROKEN: baseline query non-200 → delta FAILS "Baseline read failed", OverallPass false' {
        InModuleScope AITriad {
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                New-RCResult $false 302 $null   # e.g. auth redirect / read path down
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeFalse
            $delta = $result.FailedEndpoints | Where-Object { $_.Endpoint -like '*delta read-back*' }
            $delta | Should -Not -BeNullOrEmpty
            $delta.Error | Should -Match 'Baseline read failed'
        }
    }

    It 'ANON SESSION: establishes one and threads it through all three Phase-5 calls (t/2684)' {
        InModuleScope AITriad {
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                $total = if ($script:QueryCall -eq 1) { 5 } else { 6 }
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = $total }
                    eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:QueryCall -ge 2) { 1 } else { 0 } }
                })
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })
            }

            Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null | Out-Null

            # The anon session is established exactly once for the phase.
            Should -Invoke New-AnonymousWebSession -Times 1 -Exactly

            # …and threaded to all three analytics calls (baseline GET, POST event,
            # read-back GET) — the fix for the cookie-less interstitial false-positive.
            Should -Invoke Invoke-RemoteCheck -Times 3 -Exactly -ParameterFilter {
                ($Path -eq '/api/analytics/query?includeSystem=true' -or $Path -eq '/api/analytics/event') -and $null -ne $Session
            }
        }
    }

    It 'ANON SESSION UNAVAILABLE: warns and proceeds session-less, does not throw (t/2684)' {
        InModuleScope AITriad {
            Mock New-AnonymousWebSession -MockWith { $null }
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                $total = if ($script:QueryCall -eq 1) { 5 } else { 6 }
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = $total }
                    eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:QueryCall -ge 2) { 1 } else { 0 } }
                })
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })
            }

            # No -Session flows through when the session could not be established.
            { Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null } | Should -Not -Throw
            Should -Invoke Invoke-RemoteCheck -Times 3 -Exactly -ParameterFilter {
                ($Path -eq '/api/analytics/query?includeSystem=true' -or $Path -eq '/api/analytics/event') -and $null -eq $Session
            }
        }
    }

    It 'INCLUDES SYSTEM EVENTS: both the baseline and read-back GET carry ?includeSystem=true (t/4967)' {
        InModuleScope AITriad {
            # t/4967: #4702 hides smoke-* events (this probe's own user/session_id prefix)
            # from analytics reads by default. Without ?includeSystem=true on BOTH query
            # reads, the delta read-back can no longer see its own write and reports a
            # false "silent drop" -- blocking staging/prod deploys. A mock that only
            # matches the UNqualified path (no query string) would never fire, and the
            # orchestration would fall through to the generic 200/Body=$null stub
            # registered in BeforeEach, flattening every delta to 0 -- so this asserts the
            # exact qualified path was called, not just that SOME query call happened.
            $script:QueryCall = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:QueryCall++
                $total = if ($script:QueryCall -eq 1) { 5 } else { 6 }
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = $total }
                    eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:QueryCall -ge 2) { 1 } else { 0 } }
                })
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 1 })
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeTrue -Because 'the qualified mock must have actually been hit for the round-trip to see its own delta'
            Should -Invoke Invoke-RemoteCheck -Times 2 -Exactly -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } `
                -Because 'both the baseline read and the read-back must carry the param, not just one of them'
            Should -Invoke Invoke-RemoteCheck -Times 0 -Exactly -ParameterFilter { $Path -eq '/api/analytics/query' } `
                -Because 'the UNqualified path must never be called -- that would silently fall through to the generic stub and mask every future regression here'
        }
    }
}
