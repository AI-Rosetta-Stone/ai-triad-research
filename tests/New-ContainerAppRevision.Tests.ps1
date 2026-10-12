# Tag: taxonomy (t/1500)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers New-ContainerAppRevision (t/1500 Phase 3).
.DESCRIPTION
    Mocks Invoke-Az so tests run without a live Azure login.
    Verifies revision-name extraction, empty-name fatal error, and -EnvVars forwarding.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'New-ContainerAppRevision (t/1500)' -Tag 'taxonomy' {

    BeforeEach {
        InModuleScope AITriad {
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith {
                [PSCustomObject]@{ Source = 'az' }
            }
        }
    }

    It 'Happy path: parses latestRevisionName from JSON and returns it' {
        InModuleScope AITriad {
            $mockJson = ([PSCustomObject]@{
                properties = [PSCustomObject]@{
                    latestRevisionName = 'taxonomy-editor--deploy-abc1234'
                }
            }) | ConvertTo-Json -Depth 4 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            $r = New-ContainerAppRevision `
                -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
                -RevisionSuffix 'deploy-abc1234-12345'

            $r.RevisionName | Should -Be 'taxonomy-editor--deploy-abc1234'
            $r.ImageRef     | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234'
            $r.Suffix       | Should -Be 'deploy-abc1234-12345'
            $r.Timestamp    | Should -Not -BeNullOrEmpty
        }
    }

    It 'Empty latestRevisionName throws ActionableError (TL note 2)' {
        InModuleScope AITriad {
            $mockJson = ([PSCustomObject]@{
                properties = [PSCustomObject]@{
                    latestRevisionName = ''
                }
            }) | ConvertTo-Json -Depth 4 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            { New-ContainerAppRevision `
                -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
                -RevisionSuffix 'deploy-abc1234-12345' } |
                Should -Throw
        }
    }

    It 'Null latestRevisionName (missing property) also throws ActionableError' {
        InModuleScope AITriad {
            # properties exists but latestRevisionName key is absent
            $mockJson = ([PSCustomObject]@{
                properties = [PSCustomObject]@{ someOtherField = 'x' }
            }) | ConvertTo-Json -Depth 4 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            { New-ContainerAppRevision `
                -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
                -RevisionSuffix 'deploy-abc1234-12345' } |
                Should -Throw
        }
    }

    It '-EnvVars passes --set-env-vars and KEY=val pairs to Invoke-Az' {
        InModuleScope AITriad {
            $mockJson = ([PSCustomObject]@{
                properties = [PSCustomObject]@{
                    latestRevisionName = 'taxonomy-editor--deploy-env-test'
                }
            }) | ConvertTo-Json -Depth 4 -Compress

            # Store captured args in a module-scoped variable so the assertion
            # can read them after the Mock scriptblock executes.
            $script:CapturedEnvArgs = $null

            Mock Invoke-Az -MockWith {
                $script:CapturedEnvArgs = $Arguments
                $mockJson
            }

            New-ContainerAppRevision `
                -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
                -RevisionSuffix 'deploy-env-test' `
                -EnvVars @{ K1 = 'v1'; K2 = 'v2' } | Out-Null

            $script:CapturedEnvArgs | Should -Contain '--set-env-vars'
            # At least one K=v pair must be present in the args list
            $HasKvPair = @($script:CapturedEnvArgs | Where-Object { $_ -match '^K[12]=v[12]$' }).Count
            $HasKvPair | Should -BeGreaterThan 0
        }
    }

    It 'ActionableError when az not on PATH' {
        InModuleScope AITriad {
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith { $null }

            { New-ContainerAppRevision `
                -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
                -RevisionSuffix 'deploy-abc1234-12345' } |
                Should -Throw
        }
    }
}
