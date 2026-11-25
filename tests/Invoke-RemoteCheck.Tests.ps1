# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization coverage for Invoke-RemoteCheck pinning behavior across a
    behavior-preserving complexity refactor (helpers extracted in-file).
.DESCRIPTION
    Race-safe: dot-sources ONLY the Private function file under test (never
    Import-Module of the batch worktree module), so it is unaffected by other
    agents editing sibling files in the same worktree. Invoke-WebRequest is
    mocked so no live HTTP occurs.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-RemoteCheck.ps1')
}

Describe 'Invoke-RemoteCheck characterization (complexity refactor pin)' {

    It 'returns Success=$true for 200 JSON (happy path)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                Content    = '{"nodes":[]}'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes'
        $r.Success     | Should -Be $true
        $r.StatusCode  | Should -Be 200
        $r.ContentType | Should -Match 'application/json'
        $r.Error       | Should -Be $null
    }

    It 'FAILS 200 text/html when -ExpectJson set (t/1474 false-green)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                Content    = '<!DOCTYPE html><html><title>Sign In</title></html>'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
        $r.Success | Should -Be $false
    }

    It 'PASSES 200 text/html when -ExpectJson NOT set (third-party-notices)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('text/html; charset=utf-8') }
                Content    = '<html>ok</html>'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/third-party-notices'
        $r.Success | Should -Be $true
    }

    It 'FAILS 200 with NO Content-Type under -ExpectJson (t/4913 blocklist bypass)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{}
                Content    = '<!DOCTYPE html><html><body>app shell</body></html>'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
        $r.ContentType | Should -Be ''
        $r.Success     | Should -Be $false
    }

    It 'FAILS when Content-Type claims JSON but body does not parse (t/4913)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json') }
                Content    = 'not actually json'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectJson
        $r.Success | Should -Be $false
    }

    It 'PASSES empty JSON array "[]" (p/169#228 -NoEnumerate pin)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                Content    = '[]'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/sources' -ExpectJson
        $r.Success        | Should -Be $true
        @($r.Body).Count  | Should -Be 0
    }

    It 'PASSES case-colliding JSON keys via -AsHashtable fallback (p/169#231)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json; charset=utf-8') }
                Content    = '{"AI Alignment research":"a","AI alignment research":"b"}'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/lineage-categories' -ExpectJson
        $r.Success | Should -Be $true
        $r.Body    | Should -BeOfType [hashtable]
        $r.Body['AI Alignment research'] | Should -Be 'a'
        $r.Body['AI alignment research'] | Should -Be 'b'
    }

    It 'respects -ExpectedField on a Hashtable body' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json') }
                Content    = '{"Category":"x","category":"y","nodes":[1,2,3]}'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/lineage-categories' -ExpectJson -ExpectedField 'nodes'
        $r.Success | Should -Be $true
    }

    It 'FAILS -ExpectedField when body unparseable (t/1474 Change C)' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('text/html') }
                Content    = '<html>oh no</html>'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -ExpectedField 'nodes'
        $r.Success | Should -Be $false
    }

    It 'FAILS -ExpectedField when valid JSON missing the field' {
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

    It 'FAILS when status code not acceptable' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 404
                Headers    = @{ 'Content-Type' = @('application/json') }
                Content    = '{"nodes":[]}'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes'
        $r.Success | Should -Be $false
    }

    It 'honors -AcceptableStatusCodes override' {
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 204
                Headers    = @{ 'Content-Type' = @('application/json') }
                Content    = ''
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes' -AcceptableStatusCodes @(200, 204)
        $r.Success | Should -Be $true
    }

    It 'truncates RawBody to 4096 chars (t/1500#7)' {
        $big = '<html>' + ('x' * 5000) + '</html>'
        Mock Invoke-WebRequest -MockWith {
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('text/html') }
                Content    = $big
            }
        }.GetNewClosure()
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/'
        $r.RawBody.Length | Should -Be 4096
    }

    It 'returns a failure result on request exception' {
        Mock Invoke-WebRequest -MockWith { throw 'boom' }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/nodes'
        $r.Success    | Should -Be $false
        $r.StatusCode | Should -Be 0
        $r.Body       | Should -Be $null
        $r.Error      | Should -Match 'boom'
    }

    It 'JSON-encodes a hashtable Body and sets Content-Type (POST flow)' {
        $captured = $null
        Mock Invoke-WebRequest -MockWith {
            $script:capturedBody = $Body
            $script:capturedCT   = $ContentType
            [PSCustomObject]@{
                StatusCode = 200
                Headers    = @{ 'Content-Type' = @('application/json') }
                Content    = '{"ok":true}'
            }
        }
        $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/x' -Method POST -Body @{ a = 1 }
        $r.Success | Should -Be $true
        $script:capturedBody | Should -Match '"a":1'
        $script:capturedCT   | Should -Be 'application/json'
    }
}
