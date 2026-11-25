# Tag: analytics (t/2668)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-AnalyticsBackend' -Tag 'analytics' {

    Context 'Write probe passes and event confirmed in eventTypes' {
        BeforeAll {
            # Capture the dynamic probe event_type from the POST body so the GET
            # mock can reflect it back — mirrors the real server round-trip.
            $script:CapturedProbeType = $null

            InModuleScope AITriad {
                function script:Invoke-RemoteCheck {
                    param($BaseUrl, $Path, $Method, $Body, $TimeoutSec, [switch]$ExpectJson)
                    if ($Method -eq 'POST') {
                        # Capture probe event_type from the payload hashtable
                        $script:CapturedProbeType = $Body.events[0].event_type
                        return [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 12; Error = $null
                            Body = [PSCustomObject]@{ ok = $true; count = 1 }
                            ContentType = 'application/json'; RawBody = ''
                        }
                    }
                    # GET — echo the captured probe type back in eventTypes
                    $eventTypes = [PSCustomObject]@{}
                    if ($script:CapturedProbeType) {
                        $eventTypes | Add-Member -NotePropertyName $script:CapturedProbeType -NotePropertyValue 1
                    }
                    return [PSCustomObject]@{
                        Success = $true; StatusCode = 200; ResponseMs = 20; Error = $null
                        Body = [PSCustomObject]@{
                            summary    = [PSCustomObject]@{ totalEvents = 1 }
                            eventTypes = $eventTypes
                        }
                        ContentType = 'application/json'; RawBody = ''
                    }
                }
            }
        }

        It 'Returns Healthy=$true when both probes pass' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $r.Healthy | Should -Be $true
                @($r.Checks).Count | Should -Be 2
            }
        }

        It 'Write check passes with ok=true count=1' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $writeCheck = @($r.Checks | Where-Object { $_.Check -match 'Write' })
                $writeCheck.Count | Should -Be 1
                $writeCheck[0].Pass | Should -Be $true
                $writeCheck[0].Detail | Should -Match 'ok=True'
                $writeCheck[0].Detail | Should -Match 'count=1'
            }
        }

        It 'Read check passes with probe event_type confirmed in eventTypes' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $readCheck = @($r.Checks | Where-Object { $_.Check -match 'Read' })
                $readCheck[0].Pass | Should -Be $true
                $readCheck[0].Detail | Should -Match 'confirmed'
            }
        }
    }

    Context 'Write probe fails when server returns count=0 (silent drop)' {
        BeforeAll {
            InModuleScope AITriad {
                function script:Invoke-RemoteCheck {
                    param($BaseUrl, $Path, $Method, $Body, $TimeoutSec, [switch]$ExpectJson)
                    if ($Method -eq 'POST') {
                        return [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 8; Error = $null
                            Body = [PSCustomObject]@{ ok = $true; count = 0 }
                            ContentType = 'application/json'; RawBody = ''
                        }
                    }
                    return [PSCustomObject]@{
                        Success = $false; StatusCode = 0; ResponseMs = 0
                        Error = 'skipped'; Body = $null; ContentType = ''; RawBody = ''
                    }
                }
            }
        }

        It 'Write check fails and Detail mentions dropped event' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $writeCheck = @($r.Checks | Where-Object { $_.Check -match 'Write' })
                $writeCheck[0].Pass | Should -Be $false
                $writeCheck[0].Detail | Should -Match 'dropped'
            }
        }

        It 'Healthy=$false when write probe fails' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $r.Healthy | Should -Be $false
            }
        }
    }

    Context 'Read probe fails when event absent from eventTypes' {
        BeforeAll {
            InModuleScope AITriad {
                function script:Invoke-RemoteCheck {
                    param($BaseUrl, $Path, $Method, $Body, $TimeoutSec, [switch]$ExpectJson)
                    if ($Method -eq 'POST') {
                        return [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 10; Error = $null
                            Body = [PSCustomObject]@{ ok = $true; count = 1 }
                            ContentType = 'application/json'; RawBody = ''
                        }
                    }
                    return [PSCustomObject]@{
                        Success = $true; StatusCode = 200; ResponseMs = 15; Error = $null
                        Body = [PSCustomObject]@{
                            summary    = [PSCustomObject]@{ totalEvents = 3 }
                            eventTypes = [PSCustomObject]@{ 'some.other.event' = 3 }
                        }
                        ContentType = 'application/json'; RawBody = ''
                    }
                }
            }
        }

        It 'Read check fails and Detail mentions absent event_type' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $readCheck = @($r.Checks | Where-Object { $_.Check -match 'Read' })
                $readCheck[0].Pass | Should -Be $false
                $readCheck[0].Detail | Should -Match 'absent'
            }
        }
    }

    Context 'Read probe soft-fails on auth redirect' {
        BeforeAll {
            InModuleScope AITriad {
                function script:Invoke-RemoteCheck {
                    param($BaseUrl, $Path, $Method, $Body, $TimeoutSec, [switch]$ExpectJson)
                    if ($Method -eq 'POST') {
                        return [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 9; Error = $null
                            Body = [PSCustomObject]@{ ok = $true; count = 1 }
                            ContentType = 'application/json'; RawBody = ''
                        }
                    }
                    return [PSCustomObject]@{
                        Success = $false; StatusCode = 302; ResponseMs = 5
                        Error = $null; Body = $null; ContentType = 'text/html'; RawBody = ''
                    }
                }
            }
        }

        It 'Read check Detail mentions auth when HTTP 302' {
            InModuleScope AITriad {
                $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
                $readCheck = @($r.Checks | Where-Object { $_.Check -match 'Read' })
                $readCheck[0].Detail | Should -Match 'Auth required'
            }
        }
    }

    It 'With no administrator headers the read probe is not run and never calls the query route (t/579)' {
        InModuleScope AITriad {
            Mock Invoke-RemoteCheck -MockWith {
                if ($Path -like '/api/analytics/query*') { throw 'the query route must not be read anonymously' }
                [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5; Error = $null
                    Body = [PSCustomObject]@{ ok = $true; count = 1 }; ContentType = 'application/json'; RawBody = '' }
            }
            $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -WarningVariable warn -WarningAction SilentlyContinue
            Should -Invoke Invoke-RemoteCheck -Times 0 -Exactly -ParameterFilter { $Path -like '/api/analytics/query*' }
            @($r.Checks | Where-Object { $_.Check -match 'Read' }).Count | Should -Be 0 -Because 'a probe that was not run is not reported as a check'
            @($warn | Where-Object { "$_" -match 'read probe needs admin \(t/579\), skipped' }).Count | Should -Be 1
        }
    }

    It 'Output object has Backend, Healthy, Checks, Timestamp properties' {
        InModuleScope AITriad {
            function script:Invoke-RemoteCheck {
                param($BaseUrl, $Path, $Method, $Body, $TimeoutSec, [switch]$ExpectJson)
                return [PSCustomObject]@{
                    Success = $false; StatusCode = 503; ResponseMs = 1
                    Error = 'timeout'; Body = $null; ContentType = ''; RawBody = ''
                }
            }
            $r = Test-AnalyticsBackend -BaseUrl 'http://fake' -WaitSec 0 -AuthHeaders @{ Cookie = 'admin' }
            $r.PSObject.Properties.Name | Should -Contain 'Backend'
            $r.PSObject.Properties.Name | Should -Contain 'Healthy'
            $r.PSObject.Properties.Name | Should -Contain 'Checks'
            $r.PSObject.Properties.Name | Should -Contain 'Timestamp'
        }
    }
}
