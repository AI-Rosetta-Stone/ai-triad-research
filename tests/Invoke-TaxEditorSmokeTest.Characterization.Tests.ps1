# Tag: health (t/3910)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-TaxEditorSmokeTest, written BEFORE the t/3910 complexity
    refactor and passing unchanged on both sides of it.
.DESCRIPTION
    The five existing Invoke-TaxEditorSmokeTest.*.Tests.ps1 files cover the analytics delta,
    cold start, the GitHub gate, embedding latency and /readyz. This file pins what they don't:
    - the full host transcript and output object for an all-green run and an all-phases-red run
      (golden files; only Duration and Timestamp are masked);
    - the view.dwell eventType arms, the read-back-failed delta arm, and a write with no error text;
    - the -AssertDataPresence phase through the orchestrator;
    - every oped-files detail arm (string body, non-JSON, missing list, ok:false with no list,
      transport failure);
    - the embedding probe's unreachable catch, the -DeployedSha splat, and -Detailed.
    Regenerate the goldens only for an intended behaviour change: set
    $env:SMOKE_CHAR_REGEN = '1' and run this file once.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:FixtureDir = Join-Path $PSScriptRoot 'fixtures' 'taxeditor-smoketest'

    # Masks the two values that legitimately change between runs.
    function script:Get-NormalizedRun([object[]]$Stream) {
        $hostLines = @($Stream | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } |
                ForEach-Object { "$($_.MessageData)" })
        $result = @($Stream | Where-Object { $_ -isnot [System.Management.Automation.InformationRecord] })[-1]
        $text = ($hostLines -join "`n") -replace 'Duration: \d+(\.\d+)?s', 'Duration: <masked>s'
        $obj = [ordered]@{}
        foreach ($p in $result.PSObject.Properties) { $obj[$p.Name] = $p.Value }
        $obj['DurationSec'] = '<masked>'
        $obj['Timestamp'] = '<masked>'
        $json = [pscustomobject]$obj | ConvertTo-Json -Depth 6
        return [pscustomobject]@{ Host = $text; Json = $json; Result = $result; HostLines = $hostLines }
    }

    function script:Assert-Golden([string]$Name, [string]$Actual) {
        $path = Join-Path $script:FixtureDir $Name
        $norm = ($Actual -replace "`r`n", "`n").TrimEnd() + "`n"
        if ($env:SMOKE_CHAR_REGEN -eq '1') {
            New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null
            [System.IO.File]::WriteAllText($path, $norm)
        }
        $expected = ([System.IO.File]::ReadAllText($path) -replace "`r`n", "`n")
        $norm | Should -BeExactly $expected
    }
}

Describe 'Invoke-TaxEditorSmokeTest characterization (t/3910)' -Tag 'health' {

    BeforeEach {
        InModuleScope AITriad {
            function script:New-RC($Success = $true, $Status = 200, $Body = $null, $ContentType = 'application/json', $Ms = 10, $Err = $null) {
                [PSCustomObject]@{ Success = $Success; StatusCode = $Status; ResponseMs = $Ms
                    Body = $Body; ContentType = $ContentType; RawBody = ''; Error = $Err }
            }
            function script:New-QueryBody([int]$Total, [hashtable]$EventTypes) {
                $b = [ordered]@{ summary = [pscustomobject]@{ totalEvents = $Total } }
                if ($null -ne $EventTypes) { $b['eventTypes'] = [pscustomobject]$EventTypes }
                [pscustomobject]$b
            }

            # Per-test knobs. Every test starts from an all-green run and flips what it needs.
            $script:HealthOk = $true; $script:AzureOk = $true; $script:GitHubOk = $true
            $script:EndpointPass = $true
            $script:Q = @(
                (New-RC -Body (New-QueryBody -Total 5 -EventTypes @{})),
                (New-RC -Body (New-QueryBody -Total 7 -EventTypes @{ 'view.dwell' = 1 }))
            )
            $script:QIdx = 0
            $script:RC = @{
                'POST /api/analytics/event'     = (New-RC -Body ([pscustomobject]@{ ok = $true; count = 2 }))
                'GET /api/health/oped-files'    = (New-RC -Body ([pscustomobject]@{ ok = $true; assets = @('a', 'b', 'c') }))
                'GET /readyz'                   = (New-RC)
                'GET /health'                   = (New-RC -Body ([pscustomobject]@{ status = 'ok'; identityAllowlistUnreachable = 2 }))
                'GET /api/entities'             = (New-RC -Body @(1, 2, 3))
                'GET /api/organizations'        = (New-RC -Body @(1, 2))
                'GET /api/taxonomy/accelerationist' = (New-RC -Body ([pscustomobject]@{ nodes = @(1, 2, 3, 4) }))
            }
            $script:EmbedThrows = $false

            Mock Test-TaxEditorHealth -MockWith {
                $r = [TaxEditorHealthResult]::new()
                $r.BaseUrl = 'https://stub'; $r.Healthy = $script:HealthOk
                $r.Checks = @(
                    [pscustomobject]@{ Endpoint = '/healthz'; Purpose = 'liveness'; Ms = 11; Healthy = $script:HealthOk; Detail = $(if ($script:HealthOk) { '' } else { 'connection refused' }) }
                )
                $r.AverageMs = 11; $r.FreeTierKeyPoolSize = 0
                $r.Timestamp = (Get-Date).ToString('o'); $r
            }
            Mock Test-TaxEditorEndpoints -MockWith {
                @([PSCustomObject]@{
                        Endpoint = '/api/models'; Category = $(if ($UserType -eq 'Anonymous') { 'Community' } else { 'Core' }); Description = 'stub'
                        Status = $(if ($script:EndpointPass) { 200 } else { 500 }); Pass = $script:EndpointPass; Ms = 42
                        NodeCount = $(if ($UserType -eq 'Anonymous') { 0 } else { 12 }); Error = $(if ($script:EndpointPass) { $null } else { 'HTTP 500' })
                    })
            }
            Mock Test-AzureHealth -MockWith {
                [PSCustomObject]@{ Healthy = $script:AzureOk; Checks = @([pscustomobject]@{ Check = 'Container App'; Pass = $script:AzureOk; Detail = 'revision active' }) }
            }
            Mock Test-GitHubHealth -MockWith {
                [PSCustomObject]@{ Healthy = $script:GitHubOk; Checks = @([pscustomobject]@{ Check = 'Status page'; Pass = $script:GitHubOk; Detail = 'all systems' }) }
            }
            Mock Measure-EmbeddingLatency -MockWith {
                if ($script:EmbedThrows) { throw 'embed server unreachable' }
                [pscustomobject]@{ Status = 'ok'; DurationMs = 100; Count = 2; HttpStatus = 200 }
            }
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Start-Sleep -MockWith { }
            Mock Invoke-RemoteCheck -MockWith {
                $key = "$Method $Path"
                if ($key -eq 'GET /api/analytics/query') { $script:QIdx++; return $script:Q[$script:QIdx - 1] }
                if ($script:RC.ContainsKey($key)) { return $script:RC[$key] }
                New-RC
            }
        }
    }

    Context 'golden runs (host transcript + output object)' {

        It 'ALL GREEN with -AssertDataPresence' {
            $run = Get-NormalizedRun @(InModuleScope AITriad { Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -AssertDataPresence 6>&1 })
            Assert-Golden 'all-green.host.txt' $run.Host
            Assert-Golden 'all-green.result.json' $run.Json
            $run.Result.OverallPass | Should -BeTrue
        }

        It 'EVERY PHASE RED (health, endpoints, azure, github, analytics, data, oped, embedding, cache, identity allowlist)' {
            $run = Get-NormalizedRun @(InModuleScope AITriad {
                $script:HealthOk = $false; $script:AzureOk = $false; $script:GitHubOk = $false; $script:EndpointPass = $false
                $script:Q = @((New-RC -Body (New-QueryBody -Total 5 -EventTypes @{})), (New-RC -Body (New-QueryBody -Total 5 -EventTypes @{ 'view.dwell' = 0 })))
                $script:RC['POST /api/analytics/event'] = New-RC -Success $false -Status 503 -Err 'HTTP 503'
                $script:RC['GET /api/entities'] = New-RC -Body @()
                $script:RC['GET /api/organizations'] = New-RC -Success $false -Status 0 -Body $null -ContentType $null -Err 'timeout'
                $script:RC['GET /api/taxonomy/accelerationist'] = New-RC -Body '<html>Sign in</html>' -ContentType 'text/html'
                $script:RC['GET /api/health/oped-files'] = New-RC -Status 500 -Body ([pscustomobject]@{ ok = $false; missing = @('soul.json', 'p.prompt') })
                $script:RC['GET /readyz'] = New-RC -Success $true -Status 503
                $script:RC['GET /health'] = New-RC -Body ([pscustomobject]@{ status = 'ok'; identityAllowlistUnreachable = 3 })
                $script:EmbedThrows = $true
                Mock New-AnonymousWebSession -MockWith { $null }
                Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -AssertDataPresence -Detailed 6>&1
            })
            Assert-Golden 'all-red.host.txt' $run.Host
            Assert-Golden 'all-red.result.json' $run.Json
            $run.Result.OverallPass | Should -BeFalse
        }
    }

    Context 'analytics arms not covered by the Analytics tests' {

        It 'eventTypes missing from the read-back → dwell error names the missing field' {
            $r = InModuleScope AITriad {
                $script:Q = @((New-RC -Body (New-QueryBody -Total 5 -EventTypes $null)), (New-RC -Body (New-QueryBody -Total 6 -EventTypes $null)))
                Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
            }
            $dwell = @($r.FailedEndpoints | Where-Object Endpoint -eq 'GET /api/analytics/query (view.dwell eventType)')[0]
            $dwell.Error | Should -BeExactly 'eventTypes field missing from /api/analytics/query response'
        }

        It 'read-back fails → delta "Read-back failed" with the http error, dwell "after-read failed"' {
            $r = InModuleScope AITriad {
                $script:Q = @((New-RC -Body (New-QueryBody -Total 5 -EventTypes @{})), (New-RC -Success $false -Status 500 -Err 'HTTP 500'))
                Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
            }
            $byEp = @{}; foreach ($f in $r.FailedEndpoints) { $byEp[$f.Endpoint] = $f }
            $byEp['GET /api/analytics/query (delta read-back)'].Error | Should -BeExactly 'Read-back failed (status=500) — cannot confirm write landed: HTTP 500'
            $byEp['GET /api/analytics/query (view.dwell eventType)'].Error | Should -BeExactly 'after-read failed (status=500) — cannot check eventTypes'
        }

        It 'write returns 200 but ok:false and no error text → "Unexpected write response"' {
            $r = InModuleScope AITriad {
                $script:RC['POST /api/analytics/event'] = New-RC -Body ([pscustomobject]@{ ok = $false })
                Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
            }
            @($r.FailedEndpoints | Where-Object Endpoint -eq 'POST /api/analytics/event')[0].Error |
                Should -BeExactly 'Unexpected write response (status=200, ok=False)'
        }
    }

    Context 'oped-files detail arms' {

        It '<Name>' -ForEach @(
            @{ Name = 'string JSON body is parsed → pass with asset count'; Rc = @{ Body = '{"ok":true,"assets":["a","b"]}' }; Pass = $true; Detail = 'all assets present (2 files)' }
            @{ Name = 'text/html interstitial → non-JSON'; Rc = @{ Body = '<html/>'; ContentType = 'text/html' }; Pass = $false; Detail = 'non-JSON response (content-type=text/html, status=200) — endpoint unreachable or returned interstitial' }
            @{ Name = 'ok:false with a missing list'; Rc = @{ Status = 500; Body = [pscustomobject]@{ ok = $false; missing = @('a', 'b') } }; Pass = $false; Detail = 'MISSING: a, b (status=500)' }
            @{ Name = 'ok:false with no missing list'; Rc = @{ Status = 500; Body = [pscustomobject]@{ ok = $false } }; Pass = $false; Detail = 'MISSING: ok:false (no missing list) (status=500)' }
            @{ Name = 'transport failure with an ok:true JSON body'; Rc = @{ Success = $false; Status = 0; Body = [pscustomobject]@{ ok = $true } }; Pass = $false; Detail = 'failed (status=0)' }
        ) {
            $out = InModuleScope AITriad -Parameters @{ Rc = $Rc } {
                param($Rc)
                $script:RC['GET /api/health/oped-files'] = New-RC @Rc
                @(Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>&1)
            }
            $result = @($out | Where-Object { $_ -isnot [System.Management.Automation.InformationRecord] })[-1]
            $hostText = (@($out | Where-Object { $_ -is [System.Management.Automation.InformationRecord] }) | ForEach-Object { "$($_.MessageData)" }) -join "`n"
            $result.OpedFilesOk | Should -Be $Pass
            $hostText | Should -Match ([regex]::Escape("GET /api/health/oped-files — ") + '.*' + [regex]::Escape(" — $Detail"))
            if ($Pass) {
                $result.OverallPass | Should -BeTrue
            } else {
                $result.OverallPass | Should -BeFalse
                $hostText | Should -Match ([regex]::Escape("::error::Oped-files health check failed: $Detail"))
                @($result.FailedEndpoints | Where-Object Endpoint -eq 'GET /api/health/oped-files')[0].Error | Should -BeExactly $Detail
            }
        }
    }

    Context 'data presence, embedding, github splat, detailed' {

        It 'data presence: a failing route reports label: reason (+ http error) and sinks OverallPass' {
            $r = InModuleScope AITriad {
                $script:RC['GET /api/organizations'] = New-RC -Success $false -Status 0 -Body $null -ContentType $null -Err 'timeout'
                Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -AssertDataPresence 6>$null
            }
            $r.OverallPass | Should -BeFalse
            $org = @($r.FailedEndpoints | Where-Object Endpoint -eq 'GET /api/organizations')[0]
            $org.Category | Should -Be 'DataPresence'
            $org.Error | Should -Match '^organizations: .+ \(http: timeout\)$'
        }

        It 'data presence is skipped entirely without the switch' {
            InModuleScope AITriad {
                $r = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
                @($r.Categories | Where-Object Category -eq 'DataPresence').Count | Should -Be 0
                Should -Invoke Invoke-RemoteCheck -Times 0 -Exactly -ParameterFilter { $Path -eq '/api/entities' }
            }
        }

        It 'embedding probe throws → unreachable, 0ms, warning, gate unaffected' {
            $out = InModuleScope AITriad { $script:EmbedThrows = $true; @(Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>&1) }
            $result = @($out | Where-Object { $_ -isnot [System.Management.Automation.InformationRecord] })[-1]
            $hostText = (@($out | Where-Object { $_ -is [System.Management.Automation.InformationRecord] }) | ForEach-Object { "$($_.MessageData)" }) -join "`n"
            $result.EmbeddingStatus | Should -Be 'unreachable'
            $result.EmbeddingLatencyMs | Should -Be 0
            $result.OverallPass | Should -BeTrue
            $hostText | Should -Match ([regex]::Escape('[DEGRADED] embeddings.compute — unreachable: embed server unreachable'))
            $hostText | Should -Match ([regex]::Escape('::warning::Embedding latency unreachable — 0ms vs 2s ceiling'))
        }

        It '-DeployedSha is passed to Test-GitHubHealth only when given' {
            InModuleScope AITriad {
                $null = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' -DeployedSha 'abc123' 6>$null
                Should -Invoke Test-GitHubHealth -Times 1 -Exactly -ParameterFilter { $DeployedSha -eq 'abc123' -and $TimeoutSec -eq 15 }
                $script:QIdx = 0   # second run re-reads the two queued analytics responses
                $null = Invoke-TaxEditorSmokeTest -BaseUrl 'https://stub' 6>$null
                Should -Invoke Test-GitHubHealth -Times 1 -Exactly -ParameterFilter { -not $DeployedSha }
            }
        }
    }
}
