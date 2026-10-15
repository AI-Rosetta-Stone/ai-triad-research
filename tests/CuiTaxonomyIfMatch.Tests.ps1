# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
    t/4222 (SO condition C2 on #3266): the CUI tests' PUT /api/taxonomy/:pov must carry If-Match
    from a fresh GET's ETag, because #3266 (t/4187) answers a PUT without it with 428. With no
    ETag (a server before #3266) the PUT goes out without If-Match and a WARN says so.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Get-CuiTaxonomyWriteHeaders (t/4222)' -Tag 'cui' {
    It 'adds If-Match from the GET ETag and keeps the caller headers, without modifying them' {
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            [pscustomobject]@{ StatusCode = 200; Headers = @{ ETag = '"v7"' } }
        }
        $auth = @{ Authorization = 'Bearer x' }
        $h = & (Get-Module AITriad) { param($a) Get-CuiTaxonomyWriteHeaders -BaseUrl 'http://h/' -Pov 'accelerationist' -Headers $a } $auth
        $h['If-Match'] | Should -Be '"v7"'
        $h['Authorization'] | Should -Be 'Bearer x'
        $auth.ContainsKey('If-Match') | Should -BeFalse -Because 'the caller hashtable must not be mutated'
        Should -Invoke Invoke-WebRequest -ModuleName AITriad -Times 1 -ParameterFilter {
            $Method -eq 'GET' -and $Uri -eq 'http://h/api/taxonomy/accelerationist' -and $Headers['Authorization'] -eq 'Bearer x'
        }
    }

    It 'no ETag (a server before #3266): no If-Match, and a WARN says so' {
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith { [pscustomobject]@{ StatusCode = 200; Headers = @{} } }
        $w = $null
        $h = & (Get-Module AITriad) { Get-CuiTaxonomyWriteHeaders -BaseUrl 'http://h' -Pov 'accelerationist' -WarningVariable ww -WarningAction SilentlyContinue; $script:__w = $ww }
        $w = & (Get-Module AITriad) { $script:__w }
        $h.ContainsKey('If-Match') | Should -BeFalse
        ($w -join ' ') | Should -Match 'returned no ETag'
    }

    It 'a failed GET: no If-Match, a WARN, and no throw (the PUT reports its own failure)' {
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith { throw 'boom' }
        $h = & (Get-Module AITriad) { Get-CuiTaxonomyWriteHeaders -BaseUrl 'http://h' -Pov 'accelerationist' -WarningAction SilentlyContinue }
        $h | Should -BeOfType [hashtable]
        $h.ContainsKey('If-Match') | Should -BeFalse
    }
}

Describe 'CUI scripts send If-Match on PUT /api/taxonomy (t/4222)' -Tag 'cui' {
    AfterEach { Remove-Variable -Name __cuiEtagN, __cuiPuts -Scope Global -ErrorAction SilentlyContinue }
    BeforeEach {
        # Each GET returns a new version, so a stale ETag on the restore PUT would show up.
        $global:__cuiEtagN = 0; $global:__cuiPuts = [System.Collections.Generic.List[object]]::new()
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            if ($Method -eq 'PUT') {
                $global:__cuiPuts.Add([pscustomobject]@{ Uri = $Uri; IfMatch = $Headers['If-Match'] })
                return [pscustomobject]@{ StatusCode = 200; Headers = @{} }
            }
            $global:__cuiEtagN++
            [pscustomobject]@{ StatusCode = 200; Headers = @{ ETag = "`"v$($global:__cuiEtagN)`"" } }
        }
        Mock Invoke-RemoteCheck -ModuleName AITriad -MockWith {
            if ($Path -eq '/api/auth/me') { return [pscustomobject]@{ Success = $true; Body = [pscustomobject]@{ anonymous = $false }; ResponseMs = 1; Error = $null } }
            if ($Path -eq '/api/user/profile') { return [pscustomobject]@{ Success = $true; Body = [pscustomobject]@{ storageUserId = 'u' }; ResponseMs = 1; Error = $null } }
            [pscustomobject]@{ Success = $true; ResponseMs = 1; Error = $null
                Body = [pscustomobject]@{ nodes = @([pscustomobject]@{ id = 'acc-beliefs-001'; description = 'd' }) } }
        }
    }

    It 'Test-CuiTax010: the edit PUT and the restore PUT each send the ETag from their own fresh GET' {
        & (Get-Module AITriad) { Test-CuiTax010 -BaseUrl 'http://h' -AuthHeaders @{ Authorization = 'Bearer x' } } | Out-Null
        $puts = @($global:__cuiPuts)
        @($puts).Count | Should -Be 2
        $puts[0].IfMatch | Should -Be '"v1"'
        $puts[1].IfMatch | Should -Be '"v2"' -Because 'the restore PUT must re-read the ETag after the edit PUT'
    }

    It 'Test-CuiAuth001: the write-access PUT sends If-Match' {
        & (Get-Module AITriad) { Test-CuiAuth001 -BaseUrl 'http://h' -AuthHeaders @{ Authorization = 'Bearer x' } } | Out-Null
        $puts = @($global:__cuiPuts)
        @($puts | Where-Object { $_.Uri -like '*/api/taxonomy/accelerationist' }).Count | Should -Be 1
        @($puts | Where-Object { $_.Uri -like '*/api/taxonomy/accelerationist' })[0].IfMatch | Should -Be '"v1"'
    }

    It 'Test-CuiAuth002: the anonymous taxonomy PUT sends If-Match so a 428 cannot mask the 401/403' {
        & (Get-Module AITriad) { Test-CuiAuth002 -BaseUrl 'http://h' } | Out-Null
        $puts = @($global:__cuiPuts)
        $tax = @($puts | Where-Object { $_.Uri -like '*/api/taxonomy/accelerationist' })
        $tax.Count | Should -Be 1
        $tax[0].IfMatch | Should -Be '"v1"'
    }
}
