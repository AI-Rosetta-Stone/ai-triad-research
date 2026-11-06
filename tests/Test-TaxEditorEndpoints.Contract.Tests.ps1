# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for list→load contract checking and -UserType parameter (t/2374).
.DESCRIPTION
    Covers: -UserType Anonymous session setup, Invoke-ListLoadContractTest
    happy path, contract violation (t/2368 scenario), and empty-list skip.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-TaxEditorEndpoints — UserType + list→load contract (t/2374)' -Tag 'contract','health' {

    # ── UserType session setup ────────────────────────────────────────────────

    Context 'UserType=Anonymous — establishes anon session before sweep' {

        It 'calls New-AnonymousWebSession exactly once when -UserType Anonymous' {
            InModuleScope AITriad {
                $script:AnonCalls = 0
                Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
                Mock New-AnonymousWebSession -MockWith { $script:AnonCalls++; $null }
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5
                        Body = $null; RawBody = '{"status":"ok"}'; Error = $null; ContentType = 'application/json' }
                }

                Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Health `
                    -UserType Anonymous 6>$null

                $script:AnonCalls | Should -Be 1 `
                    -Because '-UserType Anonymous must establish one anon session before the sweep'
            }
        }

        It 'does NOT call New-AnonymousWebSession when -UserType Authenticated (default)' {
            InModuleScope AITriad {
                $script:AnonCalls = 0
                Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
                Mock New-AnonymousWebSession -MockWith { $script:AnonCalls++; $null }
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5
                        Body = $null; RawBody = '{"status":"ok"}'; Error = $null; ContentType = 'application/json' }
                }

                Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Health 6>$null

                $script:AnonCalls | Should -Be 0 `
                    -Because 'Authenticated (default) must not establish an anon session'
            }
        }

        It '-AnonymousSession switch still calls New-AnonymousWebSession (backward compat)' {
            InModuleScope AITriad {
                $script:AnonCalls = 0
                Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
                Mock New-AnonymousWebSession -MockWith { $script:AnonCalls++; $null }
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{ Success = $true; StatusCode = 200; ResponseMs = 5
                        Body = $null; RawBody = '{"status":"ok"}'; Error = $null; ContentType = 'application/json' }
                }

                Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Health `
                    -AnonymousSession 6>$null

                $script:AnonCalls | Should -Be 1 `
                    -Because '-AnonymousSession must still work for backward compatibility'
            }
        }
    }

    # ── Invoke-ListLoadContractTest — happy path ──────────────────────────────

    Context 'List→load contract — happy path (list 200 → load 200)' {

        It 'returns Pass=true and the resolved load URL when both requests succeed' {
            InModuleScope AITriad {
                $script:CallNum = 0
                Mock Invoke-RemoteCheck -MockWith {
                    $script:CallNum++
                    if ($script:CallNum -eq 1) {
                        # list response
                        [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 10
                            Body    = @([PSCustomObject]@{ id = 'debate-abc' })
                            RawBody = $null; Error = $null; ContentType = 'application/json'
                        }
                    } else {
                        # load response
                        [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 12
                            Body    = [PSCustomObject]@{ id = 'debate-abc' }
                            RawBody = $null; Error = $null; ContentType = 'application/json'
                        }
                    }
                }

                $Result = Invoke-ListLoadContractTest `
                    -BaseUrl      'https://stub' `
                    -ListPath     '/api/community/debates' `
                    -LoadTemplate '/api/community/debates/{id}' `
                    -Category     'Community' `
                    -Description  'Community debate list→load contract (t/2374)' `
                    -TimeoutSec   15

                $Result.Pass     | Should -Be $true  -Because '200 list + 200 load satisfies the contract'
                $Result.Endpoint | Should -Be '/api/community/debates/debate-abc' `
                    -Because 'endpoint must be the resolved load URL'
                $Result.Category | Should -Be 'Community'
            }
        }
    }

    # ── Invoke-ListLoadContractTest — contract violation ──────────────────────

    Context 'List→load contract — violation (list 200 → load 404) — t/2368 scenario' {

        It 'returns Pass=false when load returns 404 for a listed item' {
            InModuleScope AITriad {
                $script:CallNum = 0
                Mock Invoke-RemoteCheck -MockWith {
                    $script:CallNum++
                    if ($script:CallNum -eq 1) {
                        # list returns an item
                        [PSCustomObject]@{
                            Success = $true; StatusCode = 200; ResponseMs = 8
                            Body    = @([PSCustomObject]@{ id = 'debate-xyz' })
                            RawBody = $null; Error = $null; ContentType = 'application/json'
                        }
                    } else {
                        # load returns 404 — the t/2368 scenario
                        [PSCustomObject]@{
                            Success = $false; StatusCode = 404; ResponseMs = 7
                            Body    = $null; RawBody = $null
                            Error   = '404 Not Found'; ContentType = $null
                        }
                    }
                }

                $Result = Invoke-ListLoadContractTest `
                    -BaseUrl      'https://stub' `
                    -ListPath     '/api/community/debates' `
                    -LoadTemplate '/api/community/debates/{id}' `
                    -Category     'Community' `
                    -Description  'Community debate list→load contract (t/2374)' `
                    -TimeoutSec   15

                $Result.Pass   | Should -Be $false `
                    -Because '404 on a listed item is a contract violation (t/2368 scenario)'
                $Result.Status | Should -Be 404
            }
        }
    }

    # ── Invoke-ListLoadContractTest — empty list ──────────────────────────────

    Context 'List→load contract — empty list (no items to load)' {

        It 'returns Pass=true with a skipped description when the list is empty' {
            InModuleScope AITriad {
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{
                        Success = $true; StatusCode = 200; ResponseMs = 6
                        Body    = @()   # empty list
                        RawBody = $null; Error = $null; ContentType = 'application/json'
                    }
                }

                $Result = Invoke-ListLoadContractTest `
                    -BaseUrl      'https://stub' `
                    -ListPath     '/api/community/debates' `
                    -LoadTemplate '/api/community/debates/{id}' `
                    -Category     'Community' `
                    -Description  'Community debate list→load contract (t/2374)' `
                    -TimeoutSec   15

                $Result.Pass        | Should -Be $true `
                    -Because 'an empty list is not a violation — nothing listed means nothing to verify'
                $Result.Description | Should -BeLike '*skipped*' `
                    -Because 'description must signal the skip so callers can distinguish from a true pass'
            }
        }
    }

    # ── Invoke-ListLoadContractTest — list request not JSON (t/4913) ──────────

    Context 'List→load contract — list request did not return JSON' {

        It 'skips gracefully (Pass=true) when the list genuinely returned the EasyAuth HTML redirect' {
            InModuleScope AITriad {
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{
                        Success = $false; StatusCode = 200; ResponseMs = 6
                        Body    = $null; RawBody = '<html>sign in</html>'; Error = $null
                        ContentType = 'text/html; charset=utf-8'
                    }
                }

                $Result = Invoke-ListLoadContractTest `
                    -BaseUrl      'https://stub' `
                    -ListPath     '/api/community/debates' `
                    -LoadTemplate '/api/community/debates/{id}' `
                    -Category     'Community' `
                    -Description  'Community debate list→load contract (t/2374)' `
                    -TimeoutSec   15

                $Result.Pass        | Should -Be $true `
                    -Because 'the diagnosed EasyAuth revision-FQDN HTML redirect is a known benign case'
                $Result.Description | Should -BeLike '*skipped*'
            }
        }

        It 'FAILS (does not skip) when the list returns 200 with no Content-Type and no error — the t/4913 broken-prefix shape' {
            InModuleScope AITriad {
                Mock Invoke-RemoteCheck -MockWith {
                    [PSCustomObject]@{
                        Success = $false; StatusCode = 200; ResponseMs = 6
                        Body    = $null; RawBody = ''; Error = $null
                        ContentType = ''
                    }
                }

                $Result = Invoke-ListLoadContractTest `
                    -BaseUrl      'https://stub' `
                    -ListPath     '/api/community/debates' `
                    -LoadTemplate '/api/community/debates/{id}' `
                    -Category     'Community' `
                    -Description  'Community debate list→load contract (t/2374)' `
                    -TimeoutSec   15

                $Result.Pass | Should -Be $false `
                    -Because 't/4913: a non-JSON, non-HTML 200 (e.g. a broken-path SPA fallback with no Content-Type) must not be mistaken for the benign EasyAuth redirect'
            }
        }
    }
}
