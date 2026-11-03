#Requires -Modules Pester
<#
.SYNOPSIS
    Tests for Get-BicepBaseEnv.ps1 -NamesOnly switch (t/3345).

    Verifies TL condition (3): -NamesOnly must be a superset of the hashtable keys
    AND must cover every name: entry in the fixture bicep (including non-literal keys).
#>

Describe 'Get-BicepBaseEnv -NamesOnly' {
    BeforeAll {
        $scriptRoot  = Split-Path $PSScriptRoot -Parent
        $getEnvScript = Join-Path $scriptRoot 'operations/devops/Get-BicepBaseEnv.ps1'
        $bicepFixture = Join-Path $PSScriptRoot 'fixtures/bicep-env-drift/good-main.bicep'
    }

    It 'Returns all names including non-literal keys (interpolated, resource-ref, param-ref)' {
        $names = & $getEnvScript -BicepPath $bicepFixture -NamesOnly
        # Literal keys
        $names | Should -Contain 'NODE_ENV'
        $names | Should -Contain 'HOME'
        $names | Should -Contain 'WEBSITE_AUTH_ENABLED'
        # Non-literal keys that the standard (hashtable) pass skips
        $names | Should -Contain 'ALLOWED_ORIGINS'       # interpolated value
        $names | Should -Contain 'AZURE_KEYVAULT_URL'    # resource property reference
        $names | Should -Contain 'ADMIN_USERS'           # parameter reference
    }

    It 'Is a superset of the hashtable keys returned by the standard pass' {
        $hashtable = & $getEnvScript -BicepPath $bicepFixture
        $names     = & $getEnvScript -BicepPath $bicepFixture -NamesOnly
        foreach ($key in $hashtable.Keys) {
            $names | Should -Contain $key -Because "-NamesOnly must include every literal key"
        }
    }

    It 'Returns more names than the hashtable (has at least one non-literal key)' {
        $hashtable = & $getEnvScript -BicepPath $bicepFixture
        $names     = & $getEnvScript -BicepPath $bicepFixture -NamesOnly
        $names.Count | Should -BeGreaterThan $hashtable.Count
    }

    It 'Returns a string array (not a hashtable)' {
        $names = & $getEnvScript -BicepPath $bicepFixture -NamesOnly
        $names | Should -BeOfType [string]
    }

    It 'Contains no duplicates' {
        $names  = & $getEnvScript -BicepPath $bicepFixture -NamesOnly
        $unique = $names | Sort-Object -Unique
        $unique.Count | Should -Be $names.Count
    }
}

Describe 'Get-BicepBaseEnv -ForStaging override merge (t/4794 incident regression)' {
    BeforeAll {
        $scriptRoot  = Split-Path $PSScriptRoot -Parent
        $getEnvScript = Join-Path $scriptRoot 'operations/devops/Get-BicepBaseEnv.ps1'
        $bicepFixture = Join-Path $PSScriptRoot 'fixtures/bicep-env-drift/good-main.bicep'
    }

    It 'A literal stagingEnvOverrides entry wins over baseEnv (the already-working shape)' {
        $env = & $getEnvScript -BicepPath $bicepFixture -ForStaging
        $env['NODE_ENV'] | Should -Be 'staging'
    }

    It 'REGRESSION (t/4794): a param-reference stagingEnvOverrides entry resolves to the param''s literal default, winning over baseEnv' {
        # Production shape: stagingEnvOverrides had `{ name: 'AZURE_USER_CONTENT_CONTAINER',
        # value: azureUserContentContainerStaging }` -- a bare param identifier, not a quoted
        # literal. The override was silently skipped, so baseEnv's prod literal ('user-content')
        # survived untouched and staging served prod's blob container for ~15h.
        $env = & $getEnvScript -BicepPath $bicepFixture -ForStaging
        $env['AI_TRIAD_DATA_ROOT'] | Should -Be '/mnt/staging-shared' -Because 'the param-ref override must win, not baseEnv''s prod literal (/mnt/shared)'
    }

    It 'Without -ForStaging, baseEnv''s own literal is returned unmodified (no cross-contamination)' {
        $env = & $getEnvScript -BicepPath $bicepFixture
        $env['AI_TRIAD_DATA_ROOT'] | Should -Be '/mnt/shared'
        $env['NODE_ENV'] | Should -Be 'production'
    }

    It 'Real main.bicep: the three t/4738 container vars resolve to staging-* under -ForStaging (live incident regression)' {
        $realBicep = Join-Path $scriptRoot 'deploy/azure/main.bicep'
        $env = & $getEnvScript -BicepPath $realBicep -ForStaging
        $env['AZURE_USER_CONTENT_CONTAINER']  | Should -Be 'staging-user-content'
        $env['AZURE_COMMUNITY_CONTAINER']     | Should -Be 'staging-community'
        $env['AZURE_BRIEF_EXPORTS_CONTAINER'] | Should -Be 'staging-brief-exports'
    }
}

Describe 'Get-BicepBaseEnv -NamesOnly against real main.bicep' {
    BeforeAll {
        $scriptRoot   = Split-Path $PSScriptRoot -Parent
        $getEnvScript = Join-Path $scriptRoot 'operations/devops/Get-BicepBaseEnv.ps1'
        $realBicep    = Join-Path $scriptRoot 'deploy/azure/main.bicep'
    }

    It 'Real main.bicep: -NamesOnly is a superset of literal-hashtable keys' {
        $hashtable = & $getEnvScript -BicepPath $realBicep
        $names     = & $getEnvScript -BicepPath $realBicep -NamesOnly
        foreach ($key in $hashtable.Keys) {
            $names | Should -Contain $key -Because "-NamesOnly must cover every literal key in real main.bicep"
        }
    }

    It 'Real main.bicep: -NamesOnly includes known non-literal keys' {
        $names = & $getEnvScript -BicepPath $realBicep -NamesOnly
        $names | Should -Contain 'ALLOWED_ORIGINS'    -Because 'interpolated value in baseEnv'
        $names | Should -Contain 'AZURE_KEYVAULT_URL' -Because 'resource property reference in baseEnv'
        # APPLICATIONINSIGHTS_* — at least one key from the AppInsights block
        $appInsightsKeys = @($names | Where-Object { $_ -like 'APPLICATIONINSIGHTS_*' })
        $appInsightsKeys.Count | Should -BeGreaterThan 0 -Because 'AppInsights resource-ref keys must appear in managed set'
    }
}
