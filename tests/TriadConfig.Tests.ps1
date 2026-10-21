# Tag: config (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Resolve-TriadConfigRequest (private helper)' -Tag 'config' {

    BeforeAll {
        $OrigToken = $env:GITHUB_TOKEN
        $OrigUrl   = $env:TAXONOMY_EDITOR_URL
    }

    AfterAll {
        $env:GITHUB_TOKEN = $OrigToken
        $env:TAXONOMY_EDITOR_URL = $OrigUrl
    }

    It 'Returns BaseUrl and Headers when GITHUB_TOKEN is set' {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = 'test-token-abc'
            $result = Resolve-TriadConfigRequest -BaseUrl 'https://example.com'
            $result.BaseUrl | Should -Be 'https://example.com'
            $result.Headers['Authorization'] | Should -Be 'Bearer test-token-abc'
            $result.Headers['Accept'] | Should -Be 'application/json'
        }
    }

    It 'Trims trailing slash from BaseUrl' {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = 'test-token'
            $result = Resolve-TriadConfigRequest -BaseUrl 'https://example.com/'
            $result.BaseUrl | Should -Be 'https://example.com'
        }
    }

    It 'Falls back to TAXONOMY_EDITOR_URL env var' {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = 'test-token'
            $env:TAXONOMY_EDITOR_URL = 'https://from-env.example.com'
            $result = Resolve-TriadConfigRequest
            $result.BaseUrl | Should -Be 'https://from-env.example.com'
            $env:TAXONOMY_EDITOR_URL = $null
        }
    }

    It 'Falls back to default production URL when no BaseUrl or env var' {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = 'test-token'
            $env:TAXONOMY_EDITOR_URL = $null
            $result = Resolve-TriadConfigRequest
            $result.BaseUrl | Should -Match 'yellowbush'
        }
    }

    It 'Throws ActionableError when GITHUB_TOKEN is missing' {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = $null
            { Resolve-TriadConfigRequest -BaseUrl 'https://example.com' } | Should -Throw
        }
    }
}

Describe 'Get-TriadConfig' -Tag 'config' {

    BeforeAll {
        $env:GITHUB_TOKEN = 'test-token-for-config'

        $script:MockConfigResponse = [PSCustomObject]@{
            config   = [PSCustomObject]@{
                resilience = [PSCustomObject]@{
                    circuitThreshold = 5
                    circuitCooldownMs = 60000
                }
                quotas = [PSCustomObject]@{
                    defaultMaxChats = 25
                    defaultMaxDebates = 15
                }
            }
            defaults = [PSCustomObject]@{
                resilience = [PSCustomObject]@{
                    circuitThreshold = 5
                    circuitCooldownMs = 60000
                }
            }
            errors      = @()
            fileExists  = $true
            lastModified = '2026-06-24T12:00:00Z'
        }

        Mock Invoke-RestMethod -ModuleName AITriad -MockWith { $script:MockConfigResponse }
    }

    It 'Is exported from the module' {
        Get-Command Get-TriadConfig -Module AITriad -ErrorAction Stop | Should -Not -BeNullOrEmpty
    }

    It 'Accepts BaseUrl, OutputPath, IncludeDefaults, Format parameters' {
        $cmd = Get-Command Get-TriadConfig -Module AITriad
        $cmd.Parameters.ContainsKey('BaseUrl') | Should -Be $true
        $cmd.Parameters.ContainsKey('OutputPath') | Should -Be $true
        $cmd.Parameters.ContainsKey('IncludeDefaults') | Should -Be $true
        $cmd.Parameters.ContainsKey('Format') | Should -Be $true
    }

    It 'Saves config to OutputPath in json format' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "triad-config-test-$(Get-Random).json"
            try {
                $output = Get-TriadConfig -BaseUrl 'https://test.example.com' -OutputPath $tempFile
                Test-Path $tempFile | Should -Be $true
                $saved = Get-Content $tempFile -Raw | ConvertFrom-Json
                $saved.resilience.circuitThreshold | Should -Be 5
                $saved.quotas.defaultMaxChats | Should -Be 25
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Writes defaults file when -IncludeDefaults is specified' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "triad-config-defaults-test-$(Get-Random).json"
            $defaultsFile = [System.IO.Path]::ChangeExtension($tempFile, '.defaults.json')
            try {
                Get-TriadConfig -BaseUrl 'https://test.example.com' -OutputPath $tempFile -IncludeDefaults
                Test-Path $defaultsFile | Should -Be $true
                $defaults = Get-Content $defaultsFile -Raw | ConvertFrom-Json
                $defaults.resilience.circuitThreshold | Should -Be 5
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
                if (Test-Path $defaultsFile) { Remove-Item $defaultsFile -Force }
            }
        }
    }

    It 'Outputs table format to console' {
        InModuleScope AITriad {
            $output = Get-TriadConfig -BaseUrl 'https://test.example.com' -Format table
            $joined = $output -join "`n"
            $joined | Should -Match 'resilience'
            $joined | Should -Match 'quotas'
        }
    }

    It 'Calls correct API endpoint' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "triad-config-endpoint-$(Get-Random).json"
            try {
                Get-TriadConfig -BaseUrl 'https://my-server.example.com' -OutputPath $tempFile
                Should -Invoke Invoke-RestMethod -ModuleName AITriad -ParameterFilter {
                    $Uri -eq 'https://my-server.example.com/api/admin/config' -and $Method -eq 'GET'
                }
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }
}

Describe 'Set-TriadConfig' -Tag 'config' {

    BeforeAll {
        $env:GITHUB_TOKEN = 'test-token-for-config'

        Mock Invoke-RestMethod -ModuleName AITriad -MockWith {
            [PSCustomObject]@{ ok = $true; errors = @() }
        }
        Mock Invoke-TriadConfigReload -ModuleName AITriad -MockWith {}
    }

    It 'Is exported from the module' {
        Get-Command Set-TriadConfig -Module AITriad -ErrorAction Stop | Should -Not -BeNullOrEmpty
    }

    It 'Accepts InputPath, BaseUrl, DiffFirst, Reload parameters' {
        $cmd = Get-Command Set-TriadConfig -Module AITriad
        $cmd.Parameters.ContainsKey('InputPath') | Should -Be $true
        $cmd.Parameters.ContainsKey('BaseUrl') | Should -Be $true
        $cmd.Parameters.ContainsKey('DiffFirst') | Should -Be $true
        $cmd.Parameters.ContainsKey('Reload') | Should -Be $true
    }

    It 'Supports ShouldProcess (WhatIf/Confirm)' {
        $cmd = Get-Command Set-TriadConfig -Module AITriad
        $cmd.Parameters.ContainsKey('WhatIf') | Should -Be $true
        $cmd.Parameters.ContainsKey('Confirm') | Should -Be $true
    }

    It 'Throws when InputPath does not exist' {
        InModuleScope AITriad {
            { Set-TriadConfig -InputPath '/nonexistent/path.json' -BaseUrl 'https://x.com' -Confirm:$false } |
                Should -Throw
        }
    }

    It 'Throws on invalid JSON in config file' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "bad-json-$(Get-Random).json"
            try {
                Set-Content -Path $tempFile -Value '{ invalid json !!!'
                { Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://x.com' -Confirm:$false } |
                    Should -Throw
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Throws on unknown config sections' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "unknown-section-$(Get-Random).json"
            try {
                @{ resilience = @{ circuitThreshold = 5 }; bogusSection = @{ x = 1 } } |
                    ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                { Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://x.com' -Confirm:$false } |
                    Should -Throw
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Uploads valid config via PUT' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "valid-config-$(Get-Random).json"
            try {
                @{ resilience = @{ circuitThreshold = 10 } } |
                    ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://upload-test.example.com' -Confirm:$false
                Should -Invoke Invoke-RestMethod -ModuleName AITriad -ParameterFilter {
                    $Uri -eq 'https://upload-test.example.com/api/admin/config' -and $Method -eq 'PUT'
                }
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Calls Invoke-TriadConfigReload when -Reload is specified' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "reload-test-$(Get-Random).json"
            try {
                @{ quotas = @{ defaultMaxChats = 30 } } |
                    ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://reload-test.example.com' -Reload -Confirm:$false
                Should -Invoke Invoke-TriadConfigReload -ModuleName AITriad
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Accepts all known config sections without error' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "all-sections-$(Get-Random).json"
            try {
                @{
                    _meta        = @{ version = 1 }
                    resilience   = @{ circuitThreshold = 5 }
                    rateLimiting = @{ windowMs = 60000 }
                    tiers        = @{ platform = @{ requestsPerMinute = 60 } }
                    quotas       = @{ defaultMaxChats = 25 }
                    sessions     = @{ anonymousTtlMs = 14400000 }
                    analytics    = @{ retentionDays = 90 }
                    flightRecorder = @{ maxDumpsPerWindow = 5 }
                    community    = @{ maxPendingPerUser = 20 }
                    feedback     = @{ defaultPageLimit = 50 }
                    server       = @{ apiKeyMaskLength = 4 }
                    cache        = @{ defaultTtlMs = 30000 }
                } | ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                { Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://x.com' -Confirm:$false } |
                    Should -Not -Throw
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }
}

Describe 'Invoke-TriadConfigReload' -Tag 'config' {

    BeforeAll {
        $env:GITHUB_TOKEN = 'test-token-for-config'

        $script:MockReloadResponse = [PSCustomObject]@{
            ok         = $true
            reloadedAt = '2026-06-24T12:01:00Z'
            errors     = @()
        }

        Mock Invoke-RestMethod -ModuleName AITriad -MockWith { $script:MockReloadResponse }
    }

    It 'Is exported from the module' {
        Get-Command Invoke-TriadConfigReload -Module AITriad -ErrorAction Stop | Should -Not -BeNullOrEmpty
    }

    It 'Accepts BaseUrl and PassThru parameters' {
        $cmd = Get-Command Invoke-TriadConfigReload -Module AITriad
        $cmd.Parameters.ContainsKey('BaseUrl') | Should -Be $true
        $cmd.Parameters.ContainsKey('PassThru') | Should -Be $true
    }

    It 'Calls reload endpoint via POST' {
        InModuleScope AITriad {
            Invoke-TriadConfigReload -BaseUrl 'https://reload.example.com'
            Should -Invoke Invoke-RestMethod -ModuleName AITriad -ParameterFilter {
                $Uri -eq 'https://reload.example.com/api/admin/config/reload' -and $Method -eq 'POST'
            }
        }
    }

    It 'Returns response object when -PassThru is specified' {
        InModuleScope AITriad {
            $output = @(Invoke-TriadConfigReload -BaseUrl 'https://reload.example.com' -PassThru)
            $responseObj = $output | Where-Object { $null -ne $_ -and $_.PSObject.Properties['ok'] } | Select-Object -First 1
            $responseObj | Should -Not -BeNullOrEmpty
            $responseObj.ok | Should -Be $true
            $responseObj.reloadedAt | Should -Be '2026-06-24T12:01:00Z'
        }
    }

    It 'Does not return response without -PassThru' {
        InModuleScope AITriad {
            $result = Invoke-TriadConfigReload -BaseUrl 'https://reload.example.com'
            $hasOk = $false
            foreach ($item in @($result)) {
                if ($null -ne $item -and $item.PSObject.Properties['ok']) { $hasOk = $true }
            }
            $hasOk | Should -Be $false
        }
    }
}

Describe 'Config cmdlets refuse an HTML sign-in page (t/4370)' -Tag 'config' {
    # A hosted Easy-Auth deployment answers an unauthenticated admin call with HTTP 200 text/html.
    # Invoke-RestMethod hands that back as a string; before t/4370 every cmdlet read it as success.

    BeforeAll {
        $env:GITHUB_TOKEN = 'test-token-for-config'
        $script:SignInPage = "<!DOCTYPE html>`n<html><head><title>Sign in</title></head><body>Easy Auth</body></html>"
        Mock Invoke-RestMethod -ModuleName AITriad -MockWith { $script:SignInPage }
    }

    It 'Set-TriadConfig throws and does not report success' {
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "html-set-$(Get-Random).json"
            try {
                @{ quotas = @{ defaultMaxChats = 30 } } | ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                $out = $null
                $err = { $out = Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://staging.example.com' -Confirm:$false } |
                    Should -Throw -PassThru
                $err.Exception.Message | Should -Match 'Goal:'
                $err.Exception.Message | Should -Match 'HTML page'
                $err.Exception.Message | Should -Match 'Runtime Config panel'
                @($out) -join "`n" | Should -Not -Match 'uploaded successfully'
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Set-TriadConfig -Reload does not trigger a reload after an HTML response' {
        Mock Invoke-TriadConfigReload -ModuleName AITriad -MockWith {}
        InModuleScope AITriad {
            $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "html-reload-$(Get-Random).json"
            try {
                @{ quotas = @{ defaultMaxChats = 30 } } | ConvertTo-Json -Depth 5 | Set-Content -Path $tempFile
                { Set-TriadConfig -InputPath $tempFile -BaseUrl 'https://staging.example.com' -Reload -Confirm:$false } | Should -Throw
                Should -Invoke Invoke-TriadConfigReload -ModuleName AITriad -Times 0 -Exactly
            } finally {
                if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            }
        }
    }

    It 'Get-TriadConfig throws and does not save the page as config' {
        InModuleScope AITriad {
            $outFile = Join-Path ([System.IO.Path]::GetTempPath()) "html-get-$(Get-Random).json"
            try {
                { Get-TriadConfig -OutputPath $outFile -BaseUrl 'https://staging.example.com' } | Should -Throw -ExpectedMessage '*HTML page*'
                Test-Path $outFile | Should -Be $false
            } finally {
                if (Test-Path $outFile) { Remove-Item $outFile -Force }
            }
        }
    }

    It 'Invoke-TriadConfigReload throws and does not report success' {
        InModuleScope AITriad {
            $out = $null
            { $out = Invoke-TriadConfigReload -BaseUrl 'https://staging.example.com' } | Should -Throw -ExpectedMessage '*HTML page*'
            @($out) -join "`n" | Should -Not -Match 'reloaded successfully'
        }
    }

    It 'A non-HTML string response is refused too' {
        Mock Invoke-RestMethod -ModuleName AITriad -MockWith { 'OK' }
        InModuleScope AITriad {
            { Invoke-TriadConfigReload -BaseUrl 'https://staging.example.com' } | Should -Throw -ExpectedMessage '*non-JSON response*'
        }
    }
}

Describe 'Module Manifest - Config Cmdlets' -Tag 'config' {

    It 'Test-ModuleManifest passes' {
        $manifestPath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psd1'
        { Test-ModuleManifest -Path $manifestPath -ErrorAction Stop } | Should -Not -Throw
    }

    It 'FunctionsToExport includes all 3 config cmdlets' {
        $manifestPath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psd1'
        $manifest = Test-ModuleManifest -Path $manifestPath
        $manifest.ExportedFunctions.Keys | Should -Contain 'Get-TriadConfig'
        $manifest.ExportedFunctions.Keys | Should -Contain 'Set-TriadConfig'
        $manifest.ExportedFunctions.Keys | Should -Contain 'Invoke-TriadConfigReload'
    }
}
