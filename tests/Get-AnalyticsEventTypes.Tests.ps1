# Tag: health (t/2708)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Get-AnalyticsEventTypes (t/2708) — read-side analytics diagnostics.
.DESCRIPTION
    Mocks the module-internal Invoke-RemoteCheck and New-AnonymousWebSession so the
    cmdlet runs offline. Covers the happy path (per-type rows sorted desc, including
    the zero-count instrumentation-gap discriminator), empty aggregation, a failed
    query, the auth-interstitial shape (no eventTypes), and staging URL resolution.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-AnalyticsEventTypes' -Tag 'health' {

    BeforeEach {
        InModuleScope AITriad {
            Mock New-AnonymousWebSession -MockWith { [Microsoft.PowerShell.Commands.WebRequestSession]::new() }
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://prod.example' }

            function script:New-RCResult ($Success, $Status, $Body) {
                [PSCustomObject]@{
                    Success = $Success; StatusCode = $Status; ResponseMs = 5
                    Body = $Body; ContentType = 'application/json'; RawBody = ''
                    Error = $(if (-not $Success) { "HTTP $Status" } else { $null })
                }
            }
        }
    }

    It 'Returns per-event-type rows sorted by count desc (incl. zero-count gap)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = 42 }
                    eventTypes = [PSCustomObject]@{ 'tab.switch' = 42; 'view.dwell' = 0 }
                })
            }

            $rows = @(Get-AnalyticsEventTypes -AuthHeaders @{ Cookie = 'admin' } 6>$null)

            $rows.Count | Should -Be 2
            $rows[0].EventType | Should -Be 'tab.switch'
            $rows[0].Count     | Should -Be 42
            ($rows | Where-Object EventType -eq 'view.dwell').Count | Should -Be 0 -Because 'the zero-count discriminator must surface, not be dropped'
        }
    }

    It 'Sends the administrator headers and the from/to window, and opens no anonymous session (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = 1 }
                    eventTypes = [PSCustomObject]@{ 'tab.switch' = 1 }
                })
            }

            Get-AnalyticsEventTypes -Days 14 -AuthHeaders @{ Cookie = 'admin' } 6>$null | Out-Null

            Should -Invoke New-AnonymousWebSession -Times 0 -Exactly -Because 'the route is administrator-only since t/579; no anonymous session is opened'
            Should -Invoke Invoke-RemoteCheck -Times 1 -Exactly -ParameterFilter {
                $Path -like '/api/analytics/query?from=*&to=*' -and $ExtraHeaders['Cookie'] -eq 'admin' -and $null -eq $Session
            }
        }
    }

    It 'Refuses, with no request made, when no administrator headers are given (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith { throw 'must not be called' }
            { Get-AnalyticsEventTypes 6>$null } | Should -Throw -ExpectedMessage '*administrator-only*'
            Should -Invoke Invoke-RemoteCheck -Times 0 -Exactly
            Should -Invoke New-AnonymousWebSession -Times 0 -Exactly
        }
    }

    It 'A 403 says the headers are not an administrator session, and nowhere says the route is anon-allowed' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith { New-RCResult $false 403 $null }
            $Err = $null
            try { Get-AnalyticsEventTypes -AuthHeaders @{ Cookie = 'not-admin' } 6>$null } catch { $Err = $_ }
            "$Err" | Should -Match "not an administrator's session"
            "$Err" | Should -Not -Match 'anon-allowed'
        }
    }

    It 'Empty aggregation → no rows, does not throw' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                New-RCResult $true 200 ([PSCustomObject]@{
                    summary    = [PSCustomObject]@{ totalEvents = 0 }
                    eventTypes = [PSCustomObject]@{}
                })
            }

            $rows = @(Get-AnalyticsEventTypes -AuthHeaders @{ Cookie = 'admin' } 6>$null)
            $rows.Count | Should -Be 0
        }
    }

    It 'Failed query → throws ActionableError' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith { New-RCResult $false 502 $null }
            { Get-AnalyticsEventTypes -AuthHeaders @{ Cookie = 'admin' } 6>$null } | Should -Throw
        }
    }

    It 'Auth interstitial (200, no eventTypes) → throws ActionableError' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith { New-RCResult $true 200 ([PSCustomObject]@{ note = 'sign-in' }) }
            { Get-AnalyticsEventTypes -AuthHeaders @{ Cookie = 'admin' } 6>$null } | Should -Throw
        }
    }

    It '-Env staging without a configured URL → throws ActionableError' {
        InModuleScope AITriad {
            $saved = $env:TAXEDITOR_STAGING_URL
            Remove-Item Env:\TAXEDITOR_STAGING_URL -ErrorAction SilentlyContinue
            try {
                { Get-AnalyticsEventTypes -Env staging 6>$null } | Should -Throw
            }
            finally {
                if ($null -ne $saved) { $env:TAXEDITOR_STAGING_URL = $saved }
            }
        }
    }
}
