# Tag: health (t/1474)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression coverage for the false-green fix in Invoke-RemoteCheck (t/1474).
.DESCRIPTION
    The bug the fix targets: production data endpoints were returning
    `text/html` (SPA login page) with HTTP 200 to unauthenticated callers,
    and the smoke test reported Pass=True because:
      (a) `Content-Type` was never inspected, and
      (b) the `ExpectedField` gate short-circuited on `-and $Body` — when
          ConvertFrom-Json failed on HTML, `$Body` was `$null`, the gate
          skipped, and `$Success` stayed `$true`.

    Each `It` mocks `Invoke-WebRequest` to force the exact wire shape
    that produced the false-green in production, then asserts the fixed
    behavior. No live HTTP.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-RemoteCheck -ExpectJson (t/1474 AC#1)' -Tag 'health' {

    It 'FAILS when server returns 200 text/html and -ExpectJson is set (the false-green production bug)' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = '<!DOCTYPE html><html><title>Sign In</title></html>'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
            $r.StatusCode  | Should -Be 200
            $r.ContentType | Should -Match 'text/html'
            $r.Success     | Should -Be $false -Because 'HTML 200 must FAIL when -ExpectJson is set (t/1474 false-green fix)'
        }
    }

    It 'PASSES when server returns 200 application/json and -ExpectJson is set (backward-compat happy path)' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                    Content    = '{"nodes":[]}'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
            $r.Success     | Should -Be $true
            $r.ContentType | Should -Match 'application/json'
        }
    }

    It 'FAILS when server returns 200 with NO Content-Type header and -ExpectJson is set (t/4913: the old blocklist bypass)' {
        InModuleScope AITriad {
            # t/4913's production bug: a broken-path SPA fallback can return 200 with a
            # Content-Type that is neither 'application/json' NOR 'text/html' (missing header
            # here; a static host's rewrite rule stripped or never set one). The OLD guard
            # ($ContentType -match 'text/html') never fired for this shape, so a Field=$null
            # endpoint passed on status code alone -- exactly the "14/24 PASS against a
            # nonexistent prefix" the ticket reported. The NEW guard (must POSITIVELY contain
            # 'application/json') catches this and every other non-JSON shape, not just HTML.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{}
                    Content    = '<!DOCTYPE html><html><body>app shell</body></html>'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
            $r.ContentType | Should -Be '' -Because 'no Content-Type header was sent -- the exact shape the old blocklist check missed'
            $r.Success     | Should -Be $false -Because 't/4913: status-code-only pass must not survive a missing/non-JSON Content-Type'
        }
    }

    It 'FAILS when Content-Type claims JSON but the body does not parse, even with no -ExpectedField set (t/4913: minimal shape)' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json') }
                    Content    = 'not actually json'
                }
            }

            # No -ExpectedField: most of Test-TaxEditorEndpoints's /api/* checks have none, so
            # the body-parses check must apply unconditionally under -ExpectJson, not only when
            # a caller also happens to ask for a specific field.
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
            $r.Success | Should -Be $false -Because 't/4913: a non-JSON body must fail even without -ExpectedField'
        }
    }

    It 'PASSES when server returns 200 application/json with an EMPTY array body "[]" (staging incident, p/169#228)' {
        InModuleScope AITriad {
            # PowerShell's own pipeline-unroll trap: `$Response.Content | ConvertFrom-Json`
            # (without -NoEnumerate) emits the parsed array's ELEMENTS onto the pipeline, not
            # the array itself -- a genuinely empty JSON array therefore emits zero objects,
            # and a scalar assignment capturing zero objects becomes $null. The t/4913 fix's
            # "$null -eq $Body means it didn't parse" guard then wrongly failed a valid, common
            # response (/api/sources, /api/debates/list, /api/chats, /api/community/debates all
            # legitimately return "[]" on staging) -- this broke every staging deploy from
            # 19:23 onward. -NoEnumerate on ConvertFrom-Json is the fix: it keeps the parsed
            # result as one array object, empty or not, instead of unrolling it.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                    Content    = '[]'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/sources' -ExpectJson
            $r.Success | Should -Be $true `
                -Because 't/4913 regression: a genuinely empty JSON array is valid and parsed, not a failure'
            @($r.Body).Count | Should -Be 0
        }
    }

    It 'PASSES when server returns 200 application/json with an empty object body "{}"' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json') }
                    Content    = '{}'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
            $r.Success | Should -Be $true -Because 'an empty JSON object is also a valid, parsed body'
        }
    }

    It 'PASSES when the body has keys differing only by case (live-staging /api/lineage-categories, p/169#231)' {
        InModuleScope AITriad {
            # ConvertFrom-Json's default PSCustomObject mode throws "keys with different
            # casing" on exactly this shape -- case-folds property names, so
            # 'AI Alignment research' and 'AI alignment research' collide. The -AsHashtable
            # fallback parses it fine (hashtable keys are case-preserving).
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                    Content    = '{"AI Alignment research":"a","AI alignment research":"b"}'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/lineage-categories' -ExpectJson
            $r.Success | Should -Be $true `
                -Because 't/4913 live-staging follow-up: case-colliding JSON keys are valid JSON and must parse via the -AsHashtable fallback'
            $r.Body | Should -BeOfType [hashtable]
            $r.Body['AI Alignment research'] | Should -Be 'a'
            $r.Body['AI alignment research'] | Should -Be 'b'
        }
    }

    It 'still respects -ExpectedField against a Hashtable-shaped body (the -AsHashtable fallback)' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json') }
                    Content    = '{"Category":"x","category":"y","nodes":[1,2,3]}'
                }
            }

            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/lineage-categories' -ExpectJson -ExpectedField 'nodes'
            $r.Success | Should -Be $true -Because '-ExpectedField must find a key on a Hashtable body too, not just a PSCustomObject'
        }
    }

    It 'PASSES when server returns 200 text/html and -ExpectJson is NOT set (existing callers unaffected — AC#4)' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = '<html>ok</html>'
                }
            }

            # Simulates /third-party-notices — legitimately HTML, no -ExpectJson passed
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/third-party-notices'
            $r.Success | Should -Be $true
        }
    }
}

Describe 'Invoke-RemoteCheck ExpectedField null-body short-circuit (t/1474 AC#3 / Change C)' -Tag 'health' {

    It 'FAILS when ExpectedField is set and body is null (HTML/parse failure)' {
        InModuleScope AITriad {
            # HTML body → ConvertFrom-Json throws → $Body = $null. Pre-fix, the outer
            # `-and $Body` guard skipped the ExpectedField check and Success stayed true.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html') }
                    Content    = '<html>oh no</html>'
                }
            }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectedField 'nodes'
            $r.Success | Should -Be $false -Because 'ExpectedField=nodes must fail when body is unparseable (t/1474 Change C)'
        }
    }

    It 'FAILS when ExpectedField is set and body is valid JSON but missing the field' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json') }
                    Content    = '{"something_else":true}'
                }
            }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectedField 'nodes'
            $r.Success | Should -Be $false
        }
    }

    It 'PASSES when ExpectedField is set and body contains the field' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('application/json') }
                    Content    = '{"nodes":[]}'
                }
            }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectedField 'nodes'
            $r.Success | Should -Be $true
        }
    }
}

Describe 'Test-TaxEditorEndpoints propagates -ExpectJson for non-Static endpoints (t/1474 AC#2 / Change D)' -Tag 'health' {

    It 'Data-category endpoint reports FAIL when server returns HTML 200 (the exact production regression)' {
        InModuleScope AITriad {
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            # Server returns SPA shell for every API path — the production false-green scenario.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                    Content    = '<!DOCTYPE html><html><title>Sign In</title></html>'
                }
            }

            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub' -Category Data 6>$null
            $results | Should -Not -BeNullOrEmpty
            # Every Data endpoint should now FAIL because HTML 200 tripped -ExpectJson
            @($results | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0 `
                -Because 'HTML 200 on Data endpoints must no longer report Pass=True (t/1474)'
        }
    }

    It 'every /api/* endpoint check FAILS against a nonexistent path prefix (t/4913 AC#1 — the full repro)' {
        InModuleScope AITriad {
            Mock Get-TaxEditorBaseUrl -MockWith { 'https://stub.example.com' }
            # The anon-auth endpoint doesn't exist under a broken prefix either -- session
            # establishment degrades gracefully, same as a real -AnonymousSession call against
            # a dead host.
            Mock New-AnonymousWebSession -MockWith { $null }
            # The SPA fallback for a nonexistent prefix: 200, status-only signal, NO Content-Type
            # header (t/4913's actual production shape) and a generic shell body -- not the Easy
            # Auth Sign-In interstitial, so the AuthGated reclassify-to-PASS block must not fire
            # either. Every /api/* endpoint has -ExpectJson set, so this must fail all of them.
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{
                    StatusCode = 200
                    Headers    = @{}
                    Content    = '<!DOCTYPE html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'
                }
            }

            $results = Test-TaxEditorEndpoints -BaseUrl 'https://stub/t4912-broken-prefix' -AnonymousSession 6>$null
            $ApiResults = @($results | Where-Object { $_.Endpoint -like '/api/*' })
            $ApiResults | Should -Not -BeNullOrEmpty
            @($ApiResults | Where-Object { $_.Pass -eq $true }).Count | Should -Be 0 `
                -Because 't/4913: a status-only 200 against a broken prefix must not report ANY /api/* endpoint as passing'
        }
    }
}
