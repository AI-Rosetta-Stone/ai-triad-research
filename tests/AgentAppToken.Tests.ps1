# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4096 Decision A: offline tests for the agent App token module. No network, no vault:
# a throwaway RSA key is generated per run, so no real App key is ever needed here.

BeforeAll {
    # CI runners don't have Microsoft.PowerShell.SecretManagement, and Pester can only mock a
    # command that exists. Provide a stand-in Get-Secret when the real one is absent; every test
    # mocks it anyway. The module itself already turns a missing Get-Secret into an actionable error.
    $script:stubbedGetSecret = $false
    if (-not (Get-Command Get-Secret -ErrorAction SilentlyContinue)) {
        function global:Get-Secret { param($Vault, $Name, [switch] $AsPlainText) throw 'SecretManagement is not installed (test stand-in)' }
        $script:stubbedGetSecret = $true
    }
    Import-Module (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'AgentAppToken.psm1') -Force

    function ConvertFrom-Base64Url([string] $s) {
        $p = $s.Replace('-', '+').Replace('_', '/')
        switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
        [Convert]::FromBase64String($p)
    }

    $script:rsa = [Security.Cryptography.RSA]::Create(2048)
    $script:pem = $script:rsa.ExportRSAPrivateKeyPem()
    $script:now = [datetimeoffset]::new(2026, 10, 8, 12, 0, 0, [timespan]::Zero)

    # The JWT builder is module-private (C7), so reach it through the module's scope.
    function Invoke-NewJwt([long] $AppId, [string] $Pem, [datetimeoffset] $Now) {
        InModuleScope AgentAppToken -Parameters @{ a = $AppId; p = $Pem; n = $Now } {
            param($a, $p, $n) New-GitHubAppJwt -AppId $a -PrivateKeyPem $p -Now $n
        }
    }
}

AfterAll {
    $script:rsa.Dispose()
    Remove-Module AgentAppToken -ErrorAction SilentlyContinue
    if ($script:stubbedGetSecret) { Remove-Item Function:\global:Get-Secret -ErrorAction SilentlyContinue }
}

Describe 'Module surface (SO C7)' {
    It 'exports exactly Get-AgentAppToken and Invoke-AsAgentApp' {
        @((Get-Module AgentAppToken).ExportedFunctions.Keys | Sort-Object) | Should -Be @('Get-AgentAppToken', 'Invoke-AsAgentApp')
    }

    It 'does not expose the plaintext minting helper' {
        Get-Command New-AgentAppInstallationToken -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }

    It 'does not expose the JWT builder either' {
        Get-Command New-GitHubAppJwt -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
    }
}

Describe 'New-GitHubAppJwt (t/4096)' {
    It 'produces three base64url segments with no padding' {
        $jwt = Invoke-NewJwt 5236159 $script:pem $script:now
        $jwt.Split('.').Count | Should -Be 3
        $jwt | Should -Not -Match '[=+/]'
    }

    It 'declares RS256 in the header' {
        $jwt = Invoke-NewJwt 5236159 $script:pem $script:now
        $h = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url $jwt.Split('.')[0])) | ConvertFrom-Json
        $h.alg | Should -Be 'RS256'
        $h.typ | Should -Be 'JWT'
    }

    It 'sets iss to the App ID and backdates iat 60s with exp within GitHub''s 10-minute limit' {
        $jwt = Invoke-NewJwt 5236159 $script:pem $script:now
        $p = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url $jwt.Split('.')[1])) | ConvertFrom-Json
        $p.iss | Should -Be '5236159'
        $p.iat | Should -Be ($script:now.ToUnixTimeSeconds() - 60)
        ($p.exp - $p.iat) | Should -BeLessOrEqual 600
        $p.exp | Should -BeGreaterThan $script:now.ToUnixTimeSeconds()
    }

    It 'has a signature that verifies with the matching public key' {
        $jwt = Invoke-NewJwt 5236159 $script:pem $script:now
        $parts = $jwt.Split('.')
        $script:rsa.VerifyData([Text.Encoding]::UTF8.GetBytes("$($parts[0]).$($parts[1])"), (ConvertFrom-Base64Url $parts[2]),
            [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1) | Should -BeTrue
    }

    It 'does NOT verify against a different key (negative arm)' {
        $jwt = Invoke-NewJwt 5236159 $script:pem $script:now
        $parts = $jwt.Split('.')
        $other = [Security.Cryptography.RSA]::Create(2048)
        try {
            $other.VerifyData([Text.Encoding]::UTF8.GetBytes("$($parts[0]).$($parts[1])"), (ConvertFrom-Base64Url $parts[2]),
                [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1) | Should -BeFalse
        } finally { $other.Dispose() }
    }

    It 'throws on a malformed key rather than producing an unsigned token' {
        { Invoke-NewJwt 1 'not a pem' $script:now } | Should -Throw
    }
}

Describe 'Get-AgentAppToken (t/4096)' {
    It 'rejects an unknown role' {
        { Get-AgentAppToken -Role 'admin' } | Should -Throw
    }

    It 'fails with an actionable message when the vault or secret is missing, and never calls GitHub' {
        Mock -ModuleName AgentAppToken Get-Secret { throw 'Vault not found in registry: AiTriadAgentApps' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { throw 'must not be called' }
        { Get-AgentAppToken -Role reviewer -AsPlainText } | Should -Throw '*ai-triad-reviewer-key*'
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 0
    }

    It 'with -AsPlainText, posts to the reviewer installation and returns only the token' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; expires_at = '2026-10-08T13:00:00Z'; repositories = @([pscustomobject]@{ name = 'ai-triad-research' }) } }
        Get-AgentAppToken -Role reviewer -AsPlainText | Should -Be 'ghs_TESTONLY'
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://api.github.com/app/installations/170628507/access_tokens' -and $Method -eq 'Post'
        }
    }

    It 'C2: without -AsPlainText, writes nothing token-shaped to the output stream' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; expires_at = '2026-10-08T13:00:00Z'; repositories = @([pscustomobject]@{ name = 'ai-triad-research' }) } }
        $out = Get-AgentAppToken -Role reviewer
        $out | Should -BeOfType [securestring]
        ($out | Out-String) | Should -Not -Match 'ghs_'
    }

    It 'C3: the request body names exactly one repository (default ai-triad-research) and the role''s permissions' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; repositories = @([pscustomobject]@{ name = 'ai-triad-research' }) } }
        $null = Get-AgentAppToken -Role reviewer -AsPlainText
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 1 -ParameterFilter {
            $b = $Body | ConvertFrom-Json
            @($b.repositories).Count -eq 1 -and $b.repositories[0] -eq 'ai-triad-research' -and
            $b.permissions.pull_requests -eq 'write' -and $b.permissions.contents -eq 'read' -and
            -not ($b.permissions.PSObject.Properties.Name -contains 'workflows')
        }
    }

    It 'C3: ai-triad-data must be named explicitly and is the only repository in the body' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; repositories = @([pscustomobject]@{ name = 'ai-triad-data' }) } }
        $null = Get-AgentAppToken -Role author -Repository ai-triad-data -AsPlainText
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 1 -ParameterFilter {
            $b = $Body | ConvertFrom-Json
            @($b.repositories).Count -eq 1 -and $b.repositories[0] -eq 'ai-triad-data'
        }
    }

    It 'C3: rejects a repository outside the allowed set' {
        { Get-AgentAppToken -Role author -Repository 'some-other-repo' -AsPlainText } | Should -Throw
    }

    It 'accepts app-scratch as a legal -Repository value' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; repositories = @([pscustomobject]@{ name = 'app-scratch' }) } }
        Get-AgentAppToken -Role author -Repository app-scratch -AsPlainText | Should -Be 'ghs_TESTONLY'
    }

    It 't/4096#56-59: throws an actionable error naming the installation''s real repos when GitHub silently drops the requested repo from the grant' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod {
            if ($Method -eq 'Post' -and $Body -like '*app-scratch*') {
                # The restricted mint "succeeds" but grants nothing -- the silent-drop case.
                [pscustomobject]@{ token = 'ghs_SCOPED_EMPTY'; repositories = @() }
            } elseif ($Method -eq 'Post') {
                # The unrestricted probe mint used only to enumerate the real repos.
                [pscustomobject]@{ token = 'ghs_PROBE' }
            } elseif ($Uri -like '*installation/repositories*') {
                [pscustomobject]@{ repositories = @([pscustomobject]@{ name = 'ai-triad-research' }, [pscustomobject]@{ name = 'ai-triad-data' }) }
            } else { [pscustomobject]@{} }
        }
        { Get-AgentAppToken -Role author -Repository app-scratch -AsPlainText } | Should -Throw '*ai-triad-research, ai-triad-data*'
    }

    It 'does NOT throw the silent-drop error when the requested repo IS in the grant (happy path unaffected)' {
        Mock -ModuleName AgentAppToken Get-Secret { $script:pem }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { [pscustomobject]@{ token = 'ghs_TESTONLY'; repositories = @([pscustomobject]@{ name = 'ai-triad-research' }) } }
        { Get-AgentAppToken -Role reviewer -AsPlainText } | Should -Not -Throw
    }
}

Describe 'Invoke-AsAgentApp (t/4096)' {
    It 'sets GH_TOKEN only inside the block and restores the previous value afterwards' {
        Mock -ModuleName AgentAppToken New-AgentAppInstallationToken { 'ghs_SCOPED' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { }
        $before = $env:GH_TOKEN
        $seen = Invoke-AsAgentApp -Role reviewer -ScriptBlock { $env:GH_TOKEN }
        $seen | Should -Be 'ghs_SCOPED'
        $env:GH_TOKEN | Should -Be $before
    }

    It 'restores GH_TOKEN even when the block throws' {
        Mock -ModuleName AgentAppToken New-AgentAppInstallationToken { 'ghs_SCOPED' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { }
        $before = $env:GH_TOKEN
        { Invoke-AsAgentApp -Role reviewer -ScriptBlock { throw 'boom' } } | Should -Throw 'boom'
        $env:GH_TOKEN | Should -Be $before
    }

    It 'C4: revokes the token when the block ends, with that token' {
        Mock -ModuleName AgentAppToken New-AgentAppInstallationToken { 'ghs_SCOPED' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { }
        Invoke-AsAgentApp -Role reviewer -ScriptBlock { 'work' } | Out-Null
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 1 -ParameterFilter {
            $Method -eq 'Delete' -and $Uri -eq 'https://api.github.com/installation/token' -and $Headers.Authorization -eq 'Bearer ghs_SCOPED'
        }
    }

    It 'C4: revokes even when the block throws' {
        Mock -ModuleName AgentAppToken New-AgentAppInstallationToken { 'ghs_SCOPED' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { }
        { Invoke-AsAgentApp -Role reviewer -ScriptBlock { throw 'boom' } } | Should -Throw 'boom'
        Should -Invoke -ModuleName AgentAppToken Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'Delete' }
    }

    It 'C4: a failed revoke warns but does not fail the caller''s work' {
        Mock -ModuleName AgentAppToken New-AgentAppInstallationToken { 'ghs_SCOPED' }
        Mock -ModuleName AgentAppToken Invoke-RestMethod { throw 'network down' }
        Mock -ModuleName AgentAppToken Write-Warning { }
        $r = Invoke-AsAgentApp -Role reviewer -ScriptBlock { 'done' }
        $r | Should -Be 'done'
        Should -Invoke -ModuleName AgentAppToken Write-Warning -Times 1 -ParameterFilter { $Message -like '*could not revoke*' }
    }
}
