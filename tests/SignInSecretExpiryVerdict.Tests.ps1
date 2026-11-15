# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4294: proof for the sign-in secret expiry predicate on all three arms. A secret
# expiring inside the 30-day window must WARN. One well outside it must be CLEAN. A credential
# list the check could not read must be UNREADABLE, never CLEAN (t/4496 convention).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'SignInSecretExpiryVerdict.ps1')
    $script:Now = [datetimeoffset]'2026-11-09T12:00:00Z'
    function New-Cred([string]$Name, [double]$DaysFromNow) {
        [pscustomobject]@{ displayName = $Name; endDateTime = $script:Now.AddDays($DaysFromNow).ToString('yyyy-MM-ddTHH:mm:ssZ') }
    }
}

Describe 'Get-SignInSecretExpiryVerdict' -Tag 'config' {
    It 'WARNs when an easyauth-* secret expires in 10 days' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'easyauth-2026-01-01' 10) -Now $script:Now
        $v.Status | Should -Be 'WARN'
        @($v.Expiring).Count | Should -Be 1
        $v.Expiring[0].displayName | Should -Be 'easyauth-2026-01-01'
        $v.Expiring[0].daysLeft | Should -Be 10
        $v.Message | Should -Match 'expires in 10 day'
    }

    It 'is CLEAN when the only easyauth-* secret expires in 90 days' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'easyauth-2026-01-01' 90) -Now $script:Now
        $v.Status | Should -Be 'CLEAN'
        @($v.Expiring).Count | Should -Be 0
        $v.Checked[0].daysLeft | Should -Be 90
    }

    It 'is UNREADABLE, not CLEAN, when the credential list could not be read' {
        $v = Get-SignInSecretExpiryVerdict -Credentials $null -ReadError 'ERROR: Insufficient privileges to complete the operation.' -Now $script:Now
        $v.Status | Should -Be 'UNREADABLE'
        $v.Status | Should -Not -Be 'CLEAN'
        $v.Reason | Should -Match 'Insufficient privileges'
        $v.Message | Should -Match 'NOT a clean result'
    }

    It 'is UNREADABLE when a read error is set even if a stale list is also passed' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'easyauth-x' 200) -ReadError 'timeout' -Now $script:Now
        $v.Status | Should -Be 'UNREADABLE'
    }

    It 'is UNREADABLE when the list is null with no error text' {
        (Get-SignInSecretExpiryVerdict -Credentials $null -Now $script:Now).Status | Should -Be 'UNREADABLE'
    }

    It 'is UNREADABLE when no credential matches easyauth-* (sign-in secret not identifiable)' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'someone-elses-cred' 200) -Now $script:Now
        $v.Status | Should -Be 'UNREADABLE'
        $v.IgnoredCount | Should -Be 1
    }

    It 'is UNREADABLE when the list is empty' {
        (Get-SignInSecretExpiryVerdict -Credentials @() -Now $script:Now).Status | Should -Be 'UNREADABLE'
    }

    It 'is UNREADABLE when an easyauth-* endDateTime does not parse' {
        $cred = [pscustomobject]@{ displayName = 'easyauth-bad'; endDateTime = 'not-a-date' }
        $v = Get-SignInSecretExpiryVerdict -Credentials @($cred) -Now $script:Now
        $v.Status | Should -Be 'UNREADABLE'
        $v.Reason | Should -Match 'unparseable'
    }

    It 'WARNs on an already-expired easyauth-* leftover even when a fresh one exists' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @((New-Cred 'easyauth-old' -3), (New-Cred 'easyauth-new' 300)) -Now $script:Now
        $v.Status | Should -Be 'WARN'
        @($v.Expiring).Count | Should -Be 1
        $v.Message | Should -Match 'easyauth-old EXPIRED 3 day'
    }

    It 'ignores non-easyauth credentials that expire soon' {
        $v = Get-SignInSecretExpiryVerdict -Credentials @((New-Cred 'ci-other' 2), (New-Cred 'easyauth-a' 120)) -Now $script:Now
        $v.Status | Should -Be 'CLEAN'
        $v.IgnoredCount | Should -Be 1
    }

    It 'treats exactly WarnDays left as WARN and WarnDays+1 as CLEAN (boundary)' {
        (Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'easyauth-a' 30) -Now $script:Now).Status | Should -Be 'WARN'
        (Get-SignInSecretExpiryVerdict -Credentials @(New-Cred 'easyauth-a' 31) -Now $script:Now).Status | Should -Be 'CLEAN'
    }

    It 'accepts [datetime] endDateTime values (what ConvertFrom-Json produces for ISO dates)' {
        $json = '[{"displayName":"easyauth-j","endDateTime":"2026-11-19T12:00:00Z"}]'
        $v = Get-SignInSecretExpiryVerdict -Credentials @($json | ConvertFrom-Json) -Now $script:Now
        $v.Status | Should -Be 'WARN'
        $v.Expiring[0].daysLeft | Should -Be 10
    }
}

Describe 'Test-SignInSecretExpiry.ps1 shim' -Tag 'config' {
    BeforeAll {
        $script:Shim = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Test-SignInSecretExpiry.ps1'
    }
    BeforeEach {
        $script:Out = Join-Path ([System.IO.Path]::GetTempPath()) "sse-$([guid]::NewGuid()).json"
        $env:GITHUB_OUTPUT = $null
        $env:GITHUB_STEP_SUMMARY = $null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Out -ErrorAction SilentlyContinue
        Remove-Item Function:\az -ErrorAction SilentlyContinue
    }

    It 'reports UNREADABLE (with the Graph-permission hint) when az is denied' {
        function global:az {
            $global:LASTEXITCODE = 1
            [System.Management.Automation.ErrorRecord]::new(
                [System.Exception]::new('ERROR: Insufficient privileges to complete the operation.'),
                'AzDenied', [System.Management.Automation.ErrorCategory]::PermissionDenied, $null)
        }
        & $script:Shim -AadAppId '11111111-1111-1111-1111-111111111111' -OutputPath $script:Out -Now $script:Now 6>$null 3>$null
        $r = Get-Content -Raw $script:Out | ConvertFrom-Json
        $r.status | Should -Be 'UNREADABLE'
        $r.reason | Should -Match 'Application.Read.All'
        @($r.providerGaps).Count | Should -Be 2
    }

    It 'reports UNREADABLE without calling az when the app ID is empty' {
        function global:az { throw 'az must not be called' }
        & $script:Shim -AadAppId '' -OutputPath $script:Out -Now $script:Now 6>$null 3>$null
        (Get-Content -Raw $script:Out | ConvertFrom-Json).status | Should -Be 'UNREADABLE'
    }

    It 'reports UNREADABLE without calling az when the Azure login failed' {
        function global:az { throw 'az must not be called' }
        & $script:Shim -AadAppId '11111111-1111-1111-1111-111111111111' -AzLoginOutcome 'failure' -OutputPath $script:Out -Now $script:Now 6>$null 3>$null
        $r = Get-Content -Raw $script:Out | ConvertFrom-Json
        $r.status | Should -Be 'UNREADABLE'
        $r.reason | Should -Match 'login'
    }

    It 'reports WARN from a readable list and requests only displayName and endDateTime' {
        function global:az {
            $global:AzArgs = $args
            $global:LASTEXITCODE = 0
            '[{"displayName":"easyauth-2026-01-01","endDateTime":"2026-11-19T12:00:00Z"}]'
        }
        & $script:Shim -AadAppId '11111111-1111-1111-1111-111111111111' -OutputPath $script:Out -Now $script:Now 6>$null 3>$null
        $r = Get-Content -Raw $script:Out | ConvertFrom-Json
        $r.status | Should -Be 'WARN'
        ($global:AzArgs -join ' ') | Should -Match '\[\]\.\{displayName:displayName,endDateTime:endDateTime\}'
    }
}
