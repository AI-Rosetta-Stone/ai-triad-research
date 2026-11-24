#Requires -Modules Pester
<#
.SYNOPSIS
    t/77 Option B (PI, 2026-11-15): Get-BicepBaseEnv -ForStaging resolves STAGING_APP_ID from
    SYNC_GITHUB_APP_ID_STAGING and fails closed when that variable is empty.
#>

Describe 'Get-BicepBaseEnv -ForStaging: STAGING_APP_ID from SYNC_GITHUB_APP_ID_STAGING (t/77 Option B)' {
    BeforeAll {
        $scriptRoot   = Split-Path $PSScriptRoot -Parent
        $getEnvScript = Join-Path $scriptRoot 'operations/devops/Get-BicepBaseEnv.ps1'
        $mainBicep    = Join-Path $scriptRoot 'deploy/azure/main.bicep'
    }

    AfterEach {
        Remove-Item Env:SYNC_GITHUB_APP_ID_STAGING -ErrorAction SilentlyContinue
    }

    It 'resolves STAGING_APP_ID to the variable value when it is set' {
        $env:SYNC_GITHUB_APP_ID_STAGING = '5503293'
        $result = & $getEnvScript -BicepPath $mainBicep -ForStaging
        $result['STAGING_APP_ID'] | Should -Be '5503293'
    }

    It 'throws (fail closed) when SYNC_GITHUB_APP_ID_STAGING is empty' {
        $env:SYNC_GITHUB_APP_ID_STAGING = ''
        { & $getEnvScript -BicepPath $mainBicep -ForStaging -RequireStagingAppId } | Should -Throw -ExpectedMessage '*SYNC_GITHUB_APP_ID_STAGING is empty*'
    }

    It 'throws (fail closed) when SYNC_GITHUB_APP_ID_STAGING is not set at all' {
        Remove-Item Env:SYNC_GITHUB_APP_ID_STAGING -ErrorAction SilentlyContinue
        { & $getEnvScript -BicepPath $mainBicep -ForStaging -RequireStagingAppId } | Should -Throw -ExpectedMessage '*SYNC_GITHUB_APP_ID_STAGING is empty*'
    }

    It 'a CI checker (no -RequireStagingAppId) with the variable empty does not throw and leaves STAGING_APP_ID unmanaged' {
        $env:SYNC_GITHUB_APP_ID_STAGING = ''
        $result = & $getEnvScript -BicepPath $mainBicep -ForStaging
        $result.ContainsKey('STAGING_APP_ID') | Should -BeFalse
    }

    It 'GITHUB_APP_ID on staging is the staging App id from the variable (SO t/77#13), not left unset' {
        $env:SYNC_GITHUB_APP_ID_STAGING = '5503293'
        $result = & $getEnvScript -BicepPath $mainBicep -ForStaging -RequireStagingAppId
        $result['GITHUB_APP_ID'] | Should -Be '5503293'
        $result['STAGING_APP_ID'] | Should -Be '5503293'
    }

    It 'GITHUB_APP_ID with the variable empty and -RequireStagingAppId throws (the sync refuses, not an empty App id)' {
        $env:SYNC_GITHUB_APP_ID_STAGING = ''
        { & $getEnvScript -BicepPath $mainBicep -ForStaging -RequireStagingAppId } | Should -Throw -ExpectedMessage "*entry 'GITHUB_APP_ID'*"
    }

    It 'without -ForStaging the App id is not resolved and no throw happens' {
        Remove-Item Env:SYNC_GITHUB_APP_ID_STAGING -ErrorAction SilentlyContinue
        $result = & $getEnvScript -BicepPath $mainBicep
        $result.ContainsKey('STAGING_APP_ID') | Should -BeFalse
    }
}
