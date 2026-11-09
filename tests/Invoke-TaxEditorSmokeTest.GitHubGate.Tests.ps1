# Tag: health (t/2673)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the t/2673 smoke-test GitHub-flap false-negative gate.
.DESCRIPTION
    Invoke-TaxEditorSmokeTest used to fold GitHubOk into OverallPass. A transient
    GitHub API flap (status page / rate-limit / GHCR — monitoring signals, not app
    health) therefore sank OverallPass even when all 26 app endpoints passed,
    causing a false-negative rollback on the step-1 staging isolation deploy
    (run 31890116255, 2026-08-15). The fix gates OverallPass on app health only
    (Health + Endpoints + Azure) and surfaces a degraded GitHub check as a CI
    warning.

    Both gate arms are proven: (1) a GitHub flap with a healthy app yields PASS;
    (2) each real app failure (Health / Endpoints / Azure) still sinks the gate.

    Offline mocking — mock the PRIVATE primitives, not the public phase functions:
      - Invoke-HealthProbe   (innermost of Test-TaxEditorHealth) + Start-Sleep
      - Invoke-RemoteCheck   (per-endpoint HTTP primitive of Test-TaxEditorEndpoints,
                              Invoke-ListLoadContractTest, AND the Phase-5 analytics
                              round-trip). Path-filtered for the two analytics routes
                              (below); a general mock serves the rest.
      - New-AnonymousWebSession (anon-session primitive of the -UserType Anonymous
                              Community re-scan; raw Invoke-WebRequest)
    Test-AzureHealth / Test-GitHubHealth are mocked directly (phase boundary).

    Analytics phase (t/2667, Phase 5) post-dates this branch's cut and arrived via a
    merge from main. Its delta read-back probe (Class-3 silent-drop detector) does
    GET /api/analytics/query (baseline) → POST /api/analytics/event (ok:true) → GET
    query again and requires totalEvents to increase. It uses Invoke-RemoteCheck but
    reads analytics-specific body fields, so the healthy arms path-filter that
    primitive to return summary.totalEvents (5→6) and ok:true — mirroring
    Invoke-TaxEditorSmokeTest.Analytics.Tests.ps1. Without it the probe reports
    "Baseline read failed" / "Unexpected write response" and false-reds the app.

    The general (non-analytics) Invoke-RemoteCheck mock returns a UNIFORM Body of
    [PSCustomObject]@{ nodes = @(); id = 'stub-item' }: nodes routes resolve
    `.nodes` (no strict-mode throw) and the list->load contract tests get a non-null
    item with an id (deterministic load path), avoiding an empty-array Body that read
    back as $null on the CI runner. RawBody carries a root div + script so the SPA
    '/' check passes. ARM 1's -Because surfaces $result.FailedEndpoints so any future
    regression names the offending endpoint in the CI log.

    Why mock the primitive, not the public Test-TaxEditorEndpoints: mocking the
    public function did not intercept under InModuleScope on the ubuntu runner (same
    quirk that first bit the public Test-TaxEditorHealth mock). Mocking the innermost
    private primitive is the proven-on-CI recipe (ColdStart / Analytics test files).
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorSmokeTest GitHub-flap gate exclusion (t/2673)' -Tag 'health' {

    It 'ARM 1 — GitHub degraded + healthy app yields OverallPass=$true (AC#1)' {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 42
                    Body = [PSCustomObject]@{ nodes = @(); id = 'stub-item' }
                    ContentType = 'application/json'
                    RawBody = '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
                    Error = $null
                }
            }
            $script:AnalyticsQ = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:AnalyticsQ++
                $total = if ($script:AnalyticsQ -eq 1) { 5 } else { 6 }
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{
                        summary    = [PSCustomObject]@{ totalEvents = $total }
                        eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:AnalyticsQ -ge 2) { 1 } else { 0 } }
                    }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{ ok = $true; count = 1 }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/health/oped-files' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{ ok = $true; assets = @('a','b','c') }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith {
                [PSCustomObject]@{
                    Healthy = $false
                    Checks  = @([PSCustomObject]@{ Check = 'RateLimit'; Pass = $false; Detail = 'API 503 flap' })
                }
            }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
            $failed = @($result.FailedEndpoints | ForEach-Object { "$($_.Endpoint)[$($_.Status)]=$($_.Error)" }) -join ' ; '
            $diag = "HealthOk=$($result.HealthOk) AzureOk=$($result.AzureOk) EndpointsFailed=$($result.EndpointsFailed) GitHubOk=$($result.GitHubOk) OverallPass=$($result.OverallPass) | FAILED=[$failed]"

            $result.HealthOk        | Should -BeTrue  -Because "healthy-app precondition must hold (mock check): $diag"
            $result.AzureOk         | Should -BeTrue  -Because "healthy-app precondition must hold (mock check): $diag"
            $result.EndpointsFailed | Should -Be 0    -Because "healthy-app precondition must hold (mock check): $diag"
            $result.OverallPass     | Should -BeTrue  -Because "a GitHub API flap is a monitoring signal, not app health — it must not block the traffic shift: $diag"
            $result.GitHubOk        | Should -BeFalse -Because "the degraded GitHub status must still be reported (surfaced as a CI warning): $diag"
        }
    }

    It 'ARM 1 — surfaces a ::warning:: annotation when GitHub is degraded (AC#2)' {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 42
                    Body = [PSCustomObject]@{ nodes = @(); id = 'stub-item' }
                    ContentType = 'application/json'
                    RawBody = '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
                    Error = $null
                }
            }
            $script:AnalyticsQ = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:AnalyticsQ++
                $total = if ($script:AnalyticsQ -eq 1) { 5 } else { 6 }
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{
                        summary    = [PSCustomObject]@{ totalEvents = $total }
                        eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:AnalyticsQ -ge 2) { 1 } else { 0 } }
                    }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{ ok = $true; count = 1 }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $false; Checks = @() } }

            # 6>&1 merges the Information stream (Write-Host) into the success
            # stream; Out-String renders every record so we can assert on the text.
            $out = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>&1 | Out-String

            $out | Should -Match '::warning::.*GitHub services degraded' -Because 'a degraded GitHub check must surface as a CI warning, not silently pass'
        }
    }

    It 'ARM 2 — a real Health-phase failure still sinks OverallPass (gate integrity, AC#3)' {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $false
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 42
                    Body = [PSCustomObject]@{ nodes = @(); id = 'stub-item' }
                    ContentType = 'application/json'
                    RawBody = '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
                    Error = $null
                }
            }
            $script:AnalyticsQ = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:AnalyticsQ++
                $total = if ($script:AnalyticsQ -eq 1) { 5 } else { 6 }
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{
                        summary    = [PSCustomObject]@{ totalEvents = $total }
                        eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:AnalyticsQ -ge 2) { 1 } else { 0 } }
                    }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{ ok = $true; count = 1 }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }

            # -HealthMaxAttempts 1 → single probe, no retry (fast, deterministic).
            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -HealthMaxAttempts 1 6>$null

            $result.OverallPass | Should -BeFalse -Because 'a down health phase is real app failure and must still fail the gate'
            $result.HealthOk    | Should -BeFalse
        }
    }

    It 'ARM 2 — a real endpoint failure still sinks OverallPass (gate integrity, AC#3)' {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            # Every endpoint probe fails → the real Test-TaxEditorEndpoints produces
            # failing rows → EndpointsFailed > 0 → the gate must still sink. (Analytics
            # paths fail too under this blanket mock — consistent with app-down.)
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{
                    Success = $false; StatusCode = 500; ResponseMs = 12; Body = $null
                    ContentType = 'application/json'; RawBody = ''; Error = 'HTTP 500'
                }
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass     | Should -BeFalse -Because 'a failing application endpoint is real app failure and must still fail the gate'
            $result.EndpointsFailed | Should -BeGreaterThan 0
        }
    }

    It 'ARM 2 — a real Azure-infra failure still sinks OverallPass (gate integrity, AC#3)' {
        InModuleScope AITriad {
            Mock Invoke-HealthProbe -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $true
                $r.Checks = @(); $r.AverageMs = 0; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Start-Sleep -MockWith { }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Invoke-RemoteCheck -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 42
                    Body = [PSCustomObject]@{ nodes = @(); id = 'stub-item' }
                    ContentType = 'application/json'
                    RawBody = '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
                    Error = $null
                }
            }
            $script:AnalyticsQ = 0
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/query?includeSystem=true' } -MockWith {
                $script:AnalyticsQ++
                $total = if ($script:AnalyticsQ -eq 1) { 5 } else { 6 }
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{
                        summary    = [PSCustomObject]@{ totalEvents = $total }
                        eventTypes = [PSCustomObject]@{ 'view.dwell' = if ($script:AnalyticsQ -ge 2) { 1 } else { 0 } }
                    }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Invoke-RemoteCheck -ParameterFilter { $Path -eq '/api/analytics/event' } -MockWith {
                [PSCustomObject]@{
                    Success = $true; StatusCode = 200; ResponseMs = 10
                    Body = [PSCustomObject]@{ ok = $true; count = 1 }
                    ContentType = 'application/json'; RawBody = ''; Error = $null
                }
            }
            Mock Test-AzureHealth  -MockWith { [PSCustomObject]@{ Healthy = $false; Checks = @() } }
            Mock Test-GitHubHealth -MockWith { [PSCustomObject]@{ Healthy = $true; Checks = @() } }

            $result = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null

            $result.OverallPass | Should -BeFalse -Because 'a down Azure infra phase is real app failure and must still fail the gate'
            $result.AzureOk     | Should -BeFalse
        }
    }
}
