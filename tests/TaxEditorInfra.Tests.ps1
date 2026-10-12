# Tag: health (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-TaxEditorInfra' -Tag 'health' {

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Test-TaxEditorInfra 2>$null } | Should -Throw
    }

    It 'Throws when az CLI is not logged in' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 1; return $null } -ModuleName AITriad
        { Test-TaxEditorInfra 2>$null } | Should -Throw
    }

    It 'Throws when template path does not exist' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return '{"id":"sub-123"}'
        } -ModuleName AITriad

        { Test-TaxEditorInfra -TemplatePath 'C:\nonexistent\main.bicep' 2>$null } | Should -Throw
    }

    It 'Returns result with change detection' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[{"changeType":"Modify","resourceId":"/sub/rg/res1"},{"changeType":"NoChange","resourceId":"/sub/rg/res2"}]}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock git -MockWith { return 'C:/Users/jsnov/repos/ai-triad-research' } -ModuleName AITriad

        $BicepPath = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
        $result = Test-TaxEditorInfra -TemplatePath $BicepPath
        $result.Action | Should -Be 'InfraWhatIf'
        $result.HasDeletes | Should -BeFalse
        $result.ChangeCount | Should -Be 2
    }

    It 'Detects resource deletions and warns' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[{"changeType":"Delete","resourceId":"/sub/rg/doomed-resource"}]}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad

        $BicepPath = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
        $result = Test-TaxEditorInfra -TemplatePath $BicepPath 3>$null
        $result.HasDeletes | Should -BeTrue
        $result.ChangeCount | Should -Be 1
    }

    It 'Passes additional parameters to az' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[]}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad

        $BicepPath = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
        $result = Test-TaxEditorInfra -TemplatePath $BicepPath -Parameters @{ containerImage = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0' }
        $result.Action | Should -Be 'InfraWhatIf'
        Should -Invoke 'az' -ModuleName AITriad -ParameterFilter {
            $args -contains '--parameters'
        }
    }
}

Describe 'Deploy-TaxEditorInfra' -Tag 'health' {

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Deploy-TaxEditorInfra -Commit 'abc1234' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when git is not found' {
        Mock Get-Command -MockWith {
            param($Name)
            if ($Name -eq 'az') { return @{ Name = 'az' } }
            return $null
        } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return '{"id":"sub-123"}'
        } -ModuleName AITriad

        { Deploy-TaxEditorInfra -Commit 'abc1234' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when commit not found' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock Get-Command { @{ Name = 'git' } } -ParameterFilter { $Name -eq 'git' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock -CommandName 'git' -MockWith {
            $global:LASTEXITCODE = 1
            return $null
        } -ModuleName AITriad

        { Deploy-TaxEditorInfra -Commit 'nonexistent123' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'WhatIf returns preview without deploying' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock Get-Command { @{ Name = 'git' } } -ParameterFilter { $Name -eq 'git' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[{"changeType":"Modify","resourceId":"/sub/rg/res1"}]}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock -CommandName 'git' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'rev-parse') {
                return 'abc1234567890abcdef1234567890abcdef123456'
            }
            return '// bicep content'
        } -ModuleName AITriad

        $result = Deploy-TaxEditorInfra -Commit 'abc1234' -WhatIf
        $result.Action | Should -Be 'InfraDeployPreview'
        $result.Deployed | Should -BeFalse
    }

    It 'Happy path: deploys Bicep from a specific commit' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock Get-Command { @{ Name = 'git' } } -ParameterFilter { $Name -eq 'git' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[{"changeType":"Modify","resourceId":"/sub/rg/res1"}]}'
            }
            if ($args -contains 'create') {
                return '{"properties":{"provisioningState":"Succeeded"}}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock -CommandName 'git' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'rev-parse') {
                return 'abc1234567890abcdef1234567890abcdef123456'
            }
            return '// bicep content'
        } -ModuleName AITriad

        $result = Deploy-TaxEditorInfra -Commit 'abc1234' -Confirm:$false
        $result.Action | Should -Be 'InfraDeploy'
        $result.Commit | Should -Be 'abc1234567'
        $result.Deployed | Should -BeTrue
        $result.ProvisioningState | Should -Be 'Succeeded'
    }

    It 'Warns on resource deletions detected in what-if' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock Get-Command { @{ Name = 'git' } } -ParameterFilter { $Name -eq 'git' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'what-if') {
                return '{"changes":[{"changeType":"Delete","resourceId":"/sub/rg/doomed"}]}'
            }
            if ($args -contains 'create') {
                return '{"properties":{"provisioningState":"Succeeded"}}'
            }
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock -CommandName 'git' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'rev-parse') {
                return 'def4567890abcdef1234567890abcdef123456789'
            }
            return '// bicep with deletions'
        } -ModuleName AITriad

        $result = Deploy-TaxEditorInfra -Commit 'def4567' -Confirm:$false 3>$null
        $result.HasDeletes | Should -BeTrue
        $result.Deployed | Should -BeTrue
    }
}
