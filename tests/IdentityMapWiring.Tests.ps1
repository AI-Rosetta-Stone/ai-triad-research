# t/4326: IDENTITY_MAP (read by taxonomy-editor/src/server/principalName.ts) must reach BOTH apps
# through the same path as ADMIN_USERS: vars.IDENTITY_MAP -> identityMap Bicep param -> baseEnv
# (inherited by staging) -> verified by deploy-azure.yml's ExpectedEnvVars gate. Static checks
# against the real files, so a later edit that drops one hop fails CI instead of silently
# shipping an empty map (which would strip the smoke account's read-only tier and the PI's admin).

BeforeAll {
    $root    = Join-Path $PSScriptRoot '..'
    $bicep   = Get-Content (Join-Path $root 'deploy/azure/main.bicep') -Raw
    $deploy  = Get-Content (Join-Path $root '.github/workflows/deploy-azure.yml') -Raw
    $getEnv  = Join-Path $root 'operations/devops/Get-BicepBaseEnv.ps1'
}

Describe 'IDENTITY_MAP deploy plumbing (t/4326)' {
    It 'declares an identityMap string param defaulting to empty' {
        $bicep | Should -Match "(?m)^param identityMap string = ''\s*$"
    }

    It 'sets IDENTITY_MAP from the identityMap param in baseEnv' {
        $bicep | Should -Match "\{ name: 'IDENTITY_MAP', value: identityMap \}"
    }

    It 'is not filtered out of stagingBaseEnv (staging inherits it)' {
        $filter = [regex]::Match($bicep, 'filter\(baseEnv,[^\r\n]+').Value
        $filter | Should -Not -BeNullOrEmpty
        $filter | Should -Not -Match 'IDENTITY_MAP'
    }

    It 'is found by Get-BicepBaseEnv (prod and -ForStaging)' {
        $names = (& $getEnv -BicepPath (Join-Path $root 'deploy/azure/main.bicep') -NamesOnly)
        $names | Should -Contain 'IDENTITY_MAP'
        $stg = (& $getEnv -BicepPath (Join-Path $root 'deploy/azure/main.bicep') -ForStaging -NamesOnly)
        $stg | Should -Contain 'IDENTITY_MAP'
    }

    It 'passes identityMap to the what-if QUOTED, via env (values may contain spaces)' {
        $deploy | Should -Match 'IDENTITY_MAP_VALUE: \$\{\{ vars\.IDENTITY_MAP \}\}'
        $deploy | Should -Match 'identityMap="\$IDENTITY_MAP_VALUE" \\'
    }

    It 'passes identityMap to the arm-deploy apply QUOTED' {
        $deploy | Should -Match '(?m)^\s+identityMap="\$\{\{ vars\.IDENTITY_MAP \}\}"\s*$'
    }

    It 'never passes identityMap unquoted (a space would split the argument)' {
        $deploy | Should -Not -Match 'identityMap=\$\{\{'
    }

    It 'refuses quote/shell characters in the value before the what-if' {
        $deploy | Should -Match 'vars\.IDENTITY_MAP contains a quote, backtick or'
    }

    It 'is in the ExpectedEnvVars drift gate' {
        $deploy | Should -Match "IDENTITY_MAP\s+= '\$\{\{ vars\.IDENTITY_MAP \}\}'"
    }
}
