# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/1657 — Test-TaxEditorEndpoints must be auth-aware: an Azure Easy Auth
# Sign-In interstitial (200 text/html) served to an anonymous smoke-test caller
# on a route marked AuthGated is EXPECTED (auth-gating is working), not a
# failure. The t/1474 ExpectJson guard flags HTML-200 as failure; the caller's
# reclassify block flips it back to PASS ONLY when the row is AuthGated AND the
# body carries the interstitial title. These tests exercise the real
# Invoke-RemoteCheck (t/1474 guard) AND the caller reclassify together by
# mocking the innermost Invoke-WebRequest, mirroring
# Invoke-RemoteCheck.ExpectJson.Tests.ps1.

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # The literal Azure Easy Auth interstitial title. The em-dash is U+2014 and
    # must match the caller's reclassify regex `Sign In\s*—\s*AITriad Taxonomy Editor`.
    $script:Interstitial = '<!DOCTYPE html><html><head><title>Sign In — AITriad Taxonomy Editor</title></head><body>Please sign in to continue.</body></html>'

    # A generic HTML-200 error page that is NOT the interstitial — a genuinely
    # broken route. Its body must NOT contain the interstitial title.
    $script:BrokenHtml = '<!DOCTYPE html><html><head><title>500 Internal Server Error</title></head><body>Something went wrong.</body></html>'
}

Describe 'Test-TaxEditorEndpoints — auth-gated interstitial reclassify (t/1657)' -Tag 'health' {

    It 'FAILs (never PASSes) a Data row on the interstitial with no session established — Arm A (t/4631)' {
        InModuleScope AITriad -Parameters @{ Interstitial = $script:Interstitial } {
            param($Interstitial)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $Interstitial
                }
            }

            # -Category Data, no -AnonymousSession/-UserType Anonymous: the
            # interstitial means no data was ever verified, so every row must
            # FAIL with a reason — a PASS here would be indistinguishable from a
            # real, verified data response (the t/4631 false-PASS this guards).
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Data 6>$null

            @($results).Count | Should -Be 5
            @($results | Where-Object { $_.Pass -eq $true }).Count  | Should -Be 0
            @($results | Where-Object { $_.Pass -eq $false }).Count | Should -Be 5
            @($results | Where-Object { $_.Error -match 'no anonymous session was established' }).Count | Should -Be 5
        }
    }

    It 'FAILs a Data row on the interstitial even when a session was established — Arm A variant (t/4631)' {
        InModuleScope AITriad -Parameters @{ Interstitial = $script:Interstitial } {
            param($Interstitial)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            # Every call — session establishment AND every endpoint request —
            # returns the interstitial. A session was established (2xx), but the
            # data endpoints still never return real data: must still FAIL, with
            # a reason naming the established-session case specifically.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $Interstitial
                }
            }

            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Data -UserType Anonymous 6>$null

            @($results).Count | Should -Be 5
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0
            @($results | Where-Object { $_.Error -match 'despite an established anonymous session' }).Count | Should -Be 5
        }
    }

    It 'PASSes a Data row only when a real body with nodes is returned via an established session — Arm B (t/4631)' {
        InModuleScope AITriad {
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                param($Uri)
                if ($Uri -match '/\.auth/anonymous') {
                    # Session establishment: any 2xx with no body is enough.
                    return [PSCustomObject]@{
                        StatusCode = 200
                        Headers    = @{ 'Content-Type' = @('application/json') }
                        Content    = '{}'
                    }
                }
                # A real, session-authenticated data response — JSON, non-empty nodes.
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                    Content    = '{"nodes":[{"id":"acc-beliefs-001"},{"id":"acc-beliefs-002"}]}'
                }
            }

            # /api/edges and /api/conflicts have no 'nodes' field (Field=$null), so
            # they PASS on Success alone; the 3 taxonomy rows assert NodeCount too.
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Data -UserType Anonymous 6>$null

            @($results).Count | Should -Be 5
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 5
            $nodeRows = @($results | Where-Object { $_.Endpoint -like '/api/taxonomy/*' })
            $nodeRows.Count | Should -Be 3
            @($nodeRows | Where-Object { $_.NodeCount -gt 0 }).Count | Should -Be 3
        }
    }

    It 'does NOT reclassify the interstitial on public (non-AuthGated) routes' {
        InModuleScope AITriad -Parameters @{ Interstitial = $script:Interstitial } {
            param($Interstitial)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $Interstitial
                }
            }

            # -Category Health selects 3 public rows (/healthz, /health,
            # /api/data/available) — none carry AuthGated. A public route serving
            # the auth interstitial is a real regression and must still FAIL.
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Health 6>$null

            @($results).Count | Should -Be 3
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0
        }
    }

    It 'still FAILS an AuthGated route serving a non-interstitial HTML-200 (gate-signal integrity)' {
        InModuleScope AITriad -Parameters @{ BrokenHtml = $script:BrokenHtml } {
            param($BrokenHtml)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $BrokenHtml
                }
            }

            # AuthGated rows serving HTML that is NOT the interstitial (a broken
            # route) must NOT be masked — the reclassify requires the title.
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Data 6>$null

            @($results).Count | Should -Be 5
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0
        }
    }

    It 'reclassifies the interstitial on the "/" SPA root (Frontend) to PASS' {
        InModuleScope AITriad -Parameters @{ Interstitial = $script:Interstitial } {
            param($Interstitial)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $Interstitial
                }
            }

            # -Category Frontend selects the single '/' __spa row (AuthGated). The
            # interstitial has no root div / script tag, so the SPA-shell check
            # flips it to fail; the reclassify block (which now runs AFTER the SPA
            # check) restores it to PASS on the interstitial title. This guards the
            # reopen: adding AuthGated to '/' alone is inert unless the reclassify
            # runs after the SPA check has flipped Success to $false (t/1657#3).
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Frontend 6>$null

            @($results).Count | Should -Be 1
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 1
        }
    }

    It 'still FAILS the "/" SPA root serving a broken (non-interstitial) shell (gate integrity)' {
        InModuleScope AITriad -Parameters @{ BrokenHtml = $script:BrokenHtml } {
            param($BrokenHtml)
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = $BrokenHtml
                }
            }

            # A genuinely broken shell (no root div/script AND no interstitial
            # title) must stay failed — the SPA check flips it, and the reclassify
            # finds no title to match. This proves the '/' reclassify did not
            # weaken the SPA-shell gate.
            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Frontend 6>$null

            @($results).Count | Should -Be 1
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0
        }
    }
}
