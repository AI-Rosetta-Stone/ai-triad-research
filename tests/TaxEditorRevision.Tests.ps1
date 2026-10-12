# Tag: health (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-TaxEditorRevision' -Tag 'health' {

    BeforeAll {
        $SampleRevisions = @(
            @{
                name       = 'taxonomy-editor--deploy-abc1234'
                properties = @{
                    trafficWeight = 100
                    runningState  = 'Running'
                    createdTime   = '2026-06-22T10:00:00Z'
                    template      = @{
                        containers = @(
                            @{ image = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1' }
                        )
                    }
                }
            }
            @{
                name       = 'taxonomy-editor--deploy-def5678'
                properties = @{
                    trafficWeight = 0
                    runningState  = 'Stopped'
                    createdTime   = '2026-06-21T08:00:00Z'
                    template      = @{
                        containers = @(
                            @{ image = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0' }
                        )
                    }
                }
            }
        ) | ConvertTo-Json -Depth 10
    }

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Get-TaxEditorRevision 2>$null } | Should -Throw
    }

    It 'Throws when az CLI is not logged in' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 1; return $null } -ModuleName AITriad
        { Get-TaxEditorRevision 2>$null } | Should -Throw
    }

    It 'Returns typed AcaRevision objects sorted by CreatedAt descending' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return $SampleRevisions
        } -ModuleName AITriad

        $results = @(Get-TaxEditorRevision)
        $results.Count | Should -Be 2
        $results[0].Name | Should -Be 'taxonomy-editor--deploy-abc1234'
        $results[0].Active | Should -BeTrue
        $results[0].TrafficWeight | Should -Be 100
        $results[0].RunningState | Should -Be 'Running'
        $results[1].Active | Should -BeFalse
    }
}

Describe 'Switch-TaxEditorRevision' -Tag 'health' {

    BeforeAll {
        $MockRevisions = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--deploy-abc1234'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1'
                CreatedAt     = '2026-06-22T10:00:00Z'
            }
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--deploy-def5678'
                Active        = $false
                TrafficWeight = 0
                RunningState  = 'Stopped'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0'
                CreatedAt     = '2026-06-21T08:00:00Z'
            }
        )
    }

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Switch-TaxEditorRevision -Revision 'test' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when revision is not found' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad

        { Switch-TaxEditorRevision -Revision 'nonexistent-revision' -Confirm:$false 2>$null } |
            Should -Throw
    }

    It 'Throws when -Previous and no inactive revisions exist' {
        $AllActive = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--deploy-abc1234'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1'
                CreatedAt     = '2026-06-22T10:00:00Z'
            }
        )

        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $AllActive } -ModuleName AITriad

        { Switch-TaxEditorRevision -Previous -Confirm:$false 2>$null } |
            Should -Throw
    }

    It 'WhatIf shows action without executing' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 100 } } -ModuleName AITriad

        $result = Switch-TaxEditorRevision -Previous -WhatIf
        $result | Should -BeNullOrEmpty
        Should -Invoke -CommandName 'az' -Times 1 -ModuleName AITriad
    }

    It 'Happy path: -Previous shifts traffic and runs health check' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 100 } } -ModuleName AITriad

        $result = Switch-TaxEditorRevision -Previous -Confirm:$false
        $result.Action | Should -Be 'RevisionSwitch'
        $result.TargetRevision | Should -Be 'taxonomy-editor--deploy-def5678'
        $result.HealthCheck | Should -Be 'Passed'
        Should -Invoke Test-TaxEditorHealth -Times 1 -ModuleName AITriad
    }

    It 'Happy path: -Revision targets a specific revision' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 100 } } -ModuleName AITriad

        $result = Switch-TaxEditorRevision -Revision 'taxonomy-editor--deploy-def5678' -Confirm:$false
        $result.TargetRevision | Should -Be 'taxonomy-editor--deploy-def5678'
        $result.HealthCheck | Should -Be 'Passed'
    }

    It '-SkipHealthCheck skips post-switch verification' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 0; return '{"id":"sub-123"}' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth -ModuleName AITriad

        $result = Switch-TaxEditorRevision -Previous -Confirm:$false -SkipHealthCheck
        $result.HealthCheck | Should -Be 'Skipped'
        Should -Invoke Test-TaxEditorHealth -Times 0 -ModuleName AITriad
    }
}
