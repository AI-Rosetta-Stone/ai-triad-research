# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for operations/devops/Test-StagingPreRevisionGate.ps1 (t/404, SO t/404#10).
.DESCRIPTION
    Each red arm asserts its own ::error:: message, including the unset-variable arm.
    The green arm runs on the real deploy/azure/main.bicep, with the same variable the sync uses.
    Fixtures are the stagingEnvOverrides lines the resolver reads, with parameter defaults.
#>

Describe 'Test-StagingPreRevisionGate (t/404)' {

    BeforeAll {
        $script:Gate = "$PSScriptRoot/../operations/devops/Test-StagingPreRevisionGate.ps1"
        $script:RealBicep = "$PSScriptRoot/../deploy/azure/main.bicep"
        $script:ProdRepo = 'AI-Rosetta-Stone/ai-triad-data'
        $script:ProdApp = '170629125'
        $script:StagingApp = '5503293'

        function script:New-StagingFixture ([string] $Repo = 'AI-Rosetta-Stone/ai-triad-data-staging', [string] $Branch = 'staging') {
            $f = [System.IO.Path]::GetTempFileName()
            Set-Content -Path $f -Value @"
param githubRepo string = 'AI-Rosetta-Stone/ai-triad-data'
param githubAppId string = '170629125'
param githubAppIdStaging string = ''
var stagingGithubAppId = empty(githubAppIdStaging) ? githubAppId : githubAppIdStaging
var baseEnv = [
  { name: 'GITHUB_REPO', value: githubRepo }
]
var stagingEnvOverrides = [
  { name: 'GITHUB_APP_ID', value: stagingGithubAppId }
  { name: 'GITHUB_REPO', value: '$Repo' }
  { name: 'STAGING_REPO', value: 'AI-Rosetta-Stone/ai-triad-data-staging' }
  { name: 'STAGING_APP_ID', value: stagingGithubAppId }
  { name: 'GITHUB_BRANCH', value: '$Branch' }
]
"@
            return $f
        }

        # Runs the gate in a child pwsh so its exit code is real. Env is passed explicitly per arm.
        function script:Invoke-Gate ([string] $BicepPath, [string] $StagingAppVar, [string] $ProdRepoVar = $script:ProdRepo, [string] $ProdAppVar = $script:ProdApp) {
            $env:SYNC_GITHUB_APP_ID_STAGING = $StagingAppVar
            $env:PROD_REPO = $ProdRepoVar
            $env:PROD_APP_ID = $ProdAppVar
            try {
                $out = & pwsh -NoProfile -File $script:Gate -BicepPath $BicepPath 2>&1 | Out-String
                return [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $out }
            } finally {
                Remove-Item Env:SYNC_GITHUB_APP_ID_STAGING, Env:PROD_REPO, Env:PROD_APP_ID -ErrorAction SilentlyContinue
            }
        }
    }

    It 'GREEN fixture: staging config with the staging App and repo passes' {
        $f = New-StagingFixture
        try {
            $r = Invoke-Gate -BicepPath $f -StagingAppVar $script:StagingApp
            $r.Exit | Should -Be 0
            $r.Output | Should -Match 'PASSED'
        } finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'GREEN real main.bicep: the same variable the sync uses resolves and passes' {
        $r = Invoke-Gate -BicepPath $script:RealBicep -StagingAppVar $script:StagingApp
        $r.Exit | Should -Be 0 -Because $r.Output
        $r.Output | Should -Match 't/77 pre-revision gate PASSED: staging repo .AI-Rosetta-Stone/ai-triad-data-staging.'
    }

    It 'RED: unset SYNC_GITHUB_APP_ID_STAGING refuses with its own message' {
        $r = Invoke-Gate -BicepPath $script:RealBicep -StagingAppVar ''
        $r.Exit | Should -Be 1
        $r.Output | Should -Match 'could not resolve the staging config'
        $r.Output | Should -Match 'SYNC_GITHUB_APP_ID_STAGING is empty'
    }

    It 'RED: staging GITHUB_REPO is the prod repo' {
        $f = New-StagingFixture -Repo 'AI-Rosetta-Stone/ai-triad-data'
        try {
            $r = Invoke-Gate -BicepPath $f -StagingAppVar $script:StagingApp
            $r.Exit | Should -Be 1
            $r.Output | Should -Match "staging config GITHUB_REPO is the prod repo 'AI-Rosetta-Stone/ai-triad-data'"
        } finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'RED: staging App id is the prod App id' {
        $f = New-StagingFixture
        try {
            $r = Invoke-Gate -BicepPath $f -StagingAppVar $script:ProdApp
            $r.Exit | Should -Be 1
            $r.Output | Should -Match "staging config GITHUB_APP_ID is the prod App \($($script:ProdApp)\)"
        } finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It "RED: staging branch is 'main'" {
        $f = New-StagingFixture -Branch 'main'
        try {
            $r = Invoke-Gate -BicepPath $f -StagingAppVar $script:StagingApp
            $r.Exit | Should -Be 1
            $r.Output | Should -Match "staging config GITHUB_BRANCH is 'main'"
        } finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'RED: prod reference unset (vars.SYNC_GITHUB_REPO empty) refuses with its own message' {
        $r = Invoke-Gate -BicepPath $script:RealBicep -StagingAppVar $script:StagingApp -ProdRepoVar ''
        $r.Exit | Should -Be 1
        $r.Output | Should -Match 'vars.SYNC_GITHUB_REPO or SYNC_GITHUB_APP_ID is unset'
    }
}
