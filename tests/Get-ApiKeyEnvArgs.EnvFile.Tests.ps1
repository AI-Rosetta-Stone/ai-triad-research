# Tag: unit (t/2530)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    L3 regression (t/2530): Get-ApiKeyEnvArgs passes AI keys to Docker via a
    private 0600 --env-file, never as `--env KEY=value` argv (which leaks values
    into `docker inspect` / the process list). Pure PS, keyless — always runs.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    $script:KeyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'AI_API_KEY', 'AI_MODEL')
    $script:SavedKeyVars = @{}
    foreach ($v in $script:KeyVars) {
        $script:SavedKeyVars[$v] = [Environment]::GetEnvironmentVariable($v)
        [Environment]::SetEnvironmentVariable($v, $null)
    }
}

AfterAll {
    foreach ($v in $script:KeyVars) {
        [Environment]::SetEnvironmentVariable($v, $script:SavedKeyVars[$v])
    }
}

Describe 'Get-ApiKeyEnvArgs env-file (t/2530 L3)' -Tag 'unit' {

    AfterEach {
        foreach ($v in $script:KeyVars) { [Environment]::SetEnvironmentVariable($v, $null) }
    }

    It 'returns @() and writes no file when no keys are set' {
        InModuleScope AITriad {
            $result = @(Get-ApiKeyEnvArgs)
            $result.Count | Should -Be 0
        }
    }

    It 'returns --env-file (not --env) and keeps the secret out of argv' {
        [Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'gemini-secret-xyz')
        InModuleScope AITriad {
            $result = @(Get-ApiKeyEnvArgs)
            try {
                $result[0] | Should -Be '--env-file'
                $result.Count | Should -Be 2
                # No --env style flag, and the raw secret never appears in argv.
                ($result -contains '--env') | Should -BeFalse
                ($result -join ' ') | Should -Not -Match 'gemini-secret-xyz'

                $envFile = $result[1]
                Test-Path -LiteralPath $envFile | Should -BeTrue
                (Get-Content -Raw -LiteralPath $envFile) | Should -Match 'GEMINI_API_KEY=gemini-secret-xyz'

                if (-not $IsWindows) {
                    (Get-Item -LiteralPath $envFile).UnixMode | Should -Be '-rw-------'
                }
            }
            finally {
                if ($result.Count -ge 2 -and (Test-Path -LiteralPath $result[1])) {
                    Remove-Item -LiteralPath $result[1] -Force
                }
            }
        }
    }

    It 'passes OPENAI_API_KEY and ZAI_API_KEY through (t/4755 -- these two were missing)' {
        [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', 'openai-secret-abc')
        [Environment]::SetEnvironmentVariable('ZAI_API_KEY', 'zai-secret-def')
        InModuleScope AITriad {
            $result = @(Get-ApiKeyEnvArgs)
            try {
                $envFile = $result[1]
                $content = Get-Content -Raw -LiteralPath $envFile
                $content | Should -Match 'OPENAI_API_KEY=openai-secret-abc'
                $content | Should -Match 'ZAI_API_KEY=zai-secret-def'
            }
            finally {
                if ($result.Count -ge 2 -and (Test-Path -LiteralPath $result[1])) {
                    Remove-Item -LiteralPath $result[1] -Force
                }
            }
        }
    }
}
