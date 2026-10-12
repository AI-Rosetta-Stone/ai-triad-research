# Tag: config (t/4135)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4135 B1: $script:AIBackendProfiles (AIEnrich.psm1) and the backend registry agree, in both directions.
.DESCRIPTION
    Invoke-AIApi builds every request from the backend's row in $script:AIBackendProfiles. A registry backend
    with no row would send nothing useful (empty URI and body); a row for a backend the registry no longer
    has is dead configuration that hides drift. So (TL condition):
      1. every backend in ai-models.json (backends[].id and every models[].backend) has a profile row;
      2. every profile row is a registered backend;
      3. every row is well formed (known RequestShape and AuthStyle, a UriTemplate, a DisplayName);
      4. each row's EnvHint (the pinned missing-key warning text) names that backend's key variables from
         $script:AIApiKeyEnvVarMap. Gemini's also names AI_API_KEY, its gemini-only fallback (t/4102), and
         the one keyless backend (ollama) has no key variables and AuthStyle 'none'.
    Backends are enumerated from ai-models.json at test time, never from a pinned list.
    Listed in scripts/Verify-Config.ps1's $PesterGates, so `npm run verify:config` runs it.
#>

BeforeDiscovery {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue
    $ProfileNames = @(& (Get-Module AIEnrich) { @($script:AIBackendProfiles.Keys) } | Sort-Object)
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    $config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..' 'ai-models.json') | ConvertFrom-Json
    $script:RegistryBackends = @(@($config.backends | ForEach-Object { [string]$_.id }) +
        @($config.models | ForEach-Object { [string]$_.backend }) | Sort-Object -Unique)

    $module = Get-Module AIEnrich
    $script:Profiles = & $module { $script:AIBackendProfiles }
    $script:EnvVarMap = & $module { $script:AIApiKeyEnvVarMap }
    $script:LoadedBackends = @(& $module { @($script:ModelRegistry.Values | ForEach-Object { [string]$_.Backend }) } | Sort-Object -Unique)
    $script:ProfileBackends = @($script:Profiles.Keys | Sort-Object)
}

Describe 'AIBackendProfiles completeness (t/4135)' -Tag 'config' {

    It 'ai-models.json declares at least one backend (the population is not empty)' {
        $script:RegistryBackends.Count | Should -BeGreaterThan 0
        $script:ProfileBackends.Count | Should -BeGreaterThan 0
    }

    It 'every ai-models.json backend has a profile row' {
        $missing = @($script:RegistryBackends | Where-Object { $_ -notin $script:ProfileBackends })
        $missing | Should -BeNullOrEmpty -Because 'Invoke-AIApi builds requests only from $script:AIBackendProfiles: add a row for each backend (see /add-ai-backend)'
    }

    It 'every backend the module loaded into its model registry has a profile row' {
        $missing = @($script:LoadedBackends | Where-Object { $_ -notin $script:ProfileBackends })
        $missing | Should -BeNullOrEmpty
    }

    It 'every profile row is a registered ai-models.json backend' {
        $orphans = @($script:ProfileBackends | Where-Object { $_ -notin $script:RegistryBackends })
        $orphans | Should -BeNullOrEmpty -Because 'a profile row for a backend ai-models.json does not register is dead configuration'
    }

    It 'every profile row is well formed (<_>)' -ForEach $ProfileNames {
        $row = $script:Profiles[$_]
        $row.RequestShape | Should -BeIn @('gemini', 'claude', 'chat', 'openai-responses')
        $row.AuthStyle | Should -BeIn @('x-goog-api-key', 'x-api-key+anthropic-version', 'bearer', 'api-key', 'none')
        $row.UriTemplate | Should -Not -BeNullOrEmpty
        $row.DisplayName | Should -Not -BeNullOrEmpty
        $row.EnvHint | Should -Not -BeNullOrEmpty
        $row.ModelInBody | Should -BeOfType [bool]
    }

    It 'the EnvHint of <_> names each of its key variables from $script:AIApiKeyEnvVarMap' -ForEach $ProfileNames {
        $hint = $script:Profiles[$_].EnvHint
        if ($script:EnvVarMap.ContainsKey($_)) {
            foreach ($var in @($script:EnvVarMap[$_])) {
                $hint | Should -Match "(^|[^A-Z_])$var([^A-Z_]|$)" -Because "the missing-key warning for '$_' must name `$env:$var"
            }
            $script:Profiles[$_].AuthStyle | Should -Not -Be 'none' -Because 'a backend with key variables sends its key'
        }
        else {
            $script:Profiles[$_].AuthStyle | Should -Be 'none' -Because "'$_' has no key variables, so it must be keyless"
        }
        # Whole-variable match: GEMINI_API_KEY etc. contain the substring AI_API_KEY.
        $namesFallback = $hint -match '(^|[^A-Z_])AI_API_KEY([^A-Z_]|$)'
        if ($_ -eq 'gemini') { $namesFallback | Should -BeTrue -Because 'AI_API_KEY is the gemini-only fallback (t/4102)' }
        else { $namesFallback | Should -BeFalse -Because 'AI_API_KEY is never sent to any backend but gemini (t/4102)' }
    }

    It 'every backend with key variables has a profile row' {
        $missing = @($script:EnvVarMap.Keys | Where-Object { $_ -notin $script:ProfileBackends })
        $missing | Should -BeNullOrEmpty
    }
}
