# Tag: health (t/737)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/737: Invoke-RemoteCheck returns the X-Auth-Reason header of a refused request, so a caller
    can tell why the server said no (authGates.ts: anon_route_blocked, no_session, ...).
.DESCRIPTION
    The real catch path is exercised: Invoke-WebRequest is mocked to throw the exception type it
    throws for a non-2xx answer, carrying a real HttpResponseMessage. No network.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-RemoteCheck: X-Auth-Reason of a refused request (t/737)' -Tag 'health' {

    It 'returns the header of a 403 as AuthReason' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                $Resp = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]::Forbidden)
                $Resp.Headers.Add('X-Auth-Reason', 'anon_route_blocked')
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Response status code does not indicate success: 403 (Forbidden).', $Resp)
            }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/api/embeddings/compute' -Method POST -Body '{}'
            $r.Success    | Should -BeFalse
            $r.StatusCode | Should -Be 403
            $r.AuthReason | Should -Be 'anon_route_blocked'
        }
    }

    It 'AuthReason is empty when a refused request carries no such header' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith {
                $Resp = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]::Forbidden)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Response status code does not indicate success: 403 (Forbidden).', $Resp)
            }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/x'
            $r.StatusCode | Should -Be 403
            $r.AuthReason | Should -Be ''
        }
    }

    It 'AuthReason is empty when the server never answered, and on a success' {
        InModuleScope AITriad {
            Mock Invoke-WebRequest -MockWith { throw [System.Net.Http.HttpRequestException]::new('No connection could be made') }
            $r = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/x'
            $r.StatusCode | Should -Be 0
            $r.AuthReason | Should -Be ''
            Mock Invoke-WebRequest -MockWith {
                [PSCustomObject]@{ StatusCode = 200; Content = '{"ok":true}'; Headers = @{ 'Content-Type' = @('application/json') } }
            }
            $ok = Invoke-RemoteCheck -BaseUrl 'https://stub' -Path '/x'
            $ok.Success    | Should -BeTrue
            $ok.AuthReason | Should -Be ''
        }
    }
}
