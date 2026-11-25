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

Describe 'Invoke-TaxEditorSmokeTest analytics write probe (t/2667; read-back removed, t/579)' -Tag 'health' {

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

            # Incident t/579: GET /api/analytics/query exposed user identifiers to anonymous callers and now
            # refuses them (#5500); it becomes admin-only (t/592). The smoke no longer reads it: an anonymous
            # read-back could only fail, and a failing smoke rolls the deploy back. Every test here makes the
            # query route answer 403, as production does, so a smoke that still read it would fail them.
            # (In this one BeforeEach on purpose: a second BeforeEach in the same Describe replaces the first
            # under the CI's Pester, which left these tests with no mocks at all.)
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -like '/api/analytics/query*' } -MockWith {
                New-RCResult $false 403 $null
            }
        }
    }

    It 'write 200 + ok:true → Analytics PASS and OverallPass true, with the query route refusing anonymous reads (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null

            $result.OverallPass | Should -BeTrue -Because 'a refused analytics read must never fail the smoke: it would roll back the deploy that refuses it'
            @($result.FailedEndpoints | Where-Object { $_.Category -eq 'Analytics' }).Count | Should -Be 0
            $cat = @($result.Categories | Where-Object { $_.Category -eq 'Analytics' })
            $cat.Count | Should -Be 1 -Because 'the Analytics category must appear in the per-category breakdown'
        }
    }

    It 'never calls GET /api/analytics/query, with or without includeSystem (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            $null = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null

            Should -Invoke Invoke-RemoteCheck -Times 0 -Exactly -ParameterFilter { $Path -like '/api/analytics/query*' } `
                -Because 'the route exposed user identifiers to anonymous callers; the smoke must not read it as one'
            Should -Invoke Invoke-RemoteCheck -Times 1 -Exactly -ParameterFilter { $Path -eq '/api/analytics/event' -and $Method -eq 'POST' }
        }
    }

    It 'the phase emits the write check only, and says on every run that the read-back was skipped (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            $all = @(Invoke-SmokeAnalyticsPhase -BaseUrl 'https://stub' -TimeoutSec 5 3>&1 6>$null)
            $warn = @($all | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            $rows = @($all | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] })

            $rows.Count | Should -Be 1
            $rows[0].Endpoint | Should -Be 'POST /api/analytics/event'
            $rows[0].Pass | Should -BeTrue
            @($rows | Where-Object { $_.Endpoint -like '*analytics/query*' }).Count | Should -Be 0 -Because 'a skipped check is a logged note, not a result row that could fail'
            @($warn | Where-Object { "$_" -match 'read-back needs admin \(t/579\), skipped' }).Count | Should -Be 1
        }
    }

    It 'the write batch still carries the smoke-probe and view.dwell events' {
        InModuleScope AITriad {
            $script:SentBody = $null
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                $script:SentBody = $Body
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            $null = Invoke-SmokeAnalyticsPhase -BaseUrl 'https://stub' -TimeoutSec 5 3>$null 6>$null

            $events = @(($script:SentBody | ConvertFrom-Json).events)
            @($events.event_type) | Should -Be @('smoke-probe', 'view.dwell')
            @($events.user | Sort-Object -Unique) | Should -Be @('smoke-probe')
        }
    }

    It 'WRITE UNREACHABLE: POST non-200 → write probe FAILS, OverallPass false' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $false 502 $null
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null

            $result.OverallPass | Should -BeFalse
            $write = $result.FailedEndpoints | Where-Object { $_.Endpoint -eq 'POST /api/analytics/event' }
            $write | Should -Not -BeNullOrEmpty -Because 'an unreachable write endpoint must fail the gate'
        }
    }

    It 'WRITE REFUSED IN THE BODY: 200 with ok:false → write probe FAILS, OverallPass false' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $false })
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null

            $result.OverallPass | Should -BeFalse
            ($result.FailedEndpoints | Where-Object { $_.Endpoint -eq 'POST /api/analytics/event' }).Error | Should -Match 'ok=False'
        }
    }

    It 'ANON SESSION: establishes one and threads it through the write (t/2684)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null | Out-Null

            # One anonymous session for the analytics phase and one for the embedding-latency phase (t/621).
            Should -Invoke New-AnonymousWebSession -Times 2 -Exactly
            Should -Invoke Invoke-RemoteCheck -Times 1 -Exactly -ParameterFilter { $Path -eq '/api/analytics/event' -and $null -ne $Session }
        }
    }

    It 'ANON SESSION UNAVAILABLE: warns and proceeds session-less, does not throw (t/2684)' {
        InModuleScope AITriad {
            Mock New-AnonymousWebSession -MockWith { $null }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{ ok = $true; count = 2 })
            }

            { Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null 3>$null } | Should -Not -Throw
            Should -Invoke Invoke-RemoteCheck -Times 1 -Exactly -ParameterFilter { $Path -eq '/api/analytics/event' -and $null -eq $Session }
        }
    }
}
