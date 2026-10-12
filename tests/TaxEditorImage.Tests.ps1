# Tag: health (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-TaxEditorImage' -Tag 'health' {

    It 'Throws when GITHUB_TOKEN is not set' {
        Mock Invoke-RestMethod -ModuleName AITriad
        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = $null
            { Get-TaxEditorImage 2>$null } | Should -Throw
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Returns typed GhcrImage objects with tags and known-good detection' {
        $SampleVersionsJson = @(
            @{
                name       = 'sha256:abc123def456789012345678901234567890abcdef1234567890abcdef123456'
                created_at = '2026-06-22T10:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.1', 'latest', 'known-good')
                    }
                }
            }
            @{
                name       = 'sha256:def789012345678901234567890abcdef1234567890abcdef123456789012ab'
                created_at = '2026-06-21T08:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.0')
                    }
                }
            }
            @{
                name       = 'sha256:999888777666555444333222111000aabbccddeeff00112233445566778899aa'
                created_at = '2026-06-20T06:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @()
                    }
                }
            }
        ) | ConvertTo-Json -Depth 5 | ConvertFrom-Json

        Mock Invoke-RestMethod { $SampleVersionsJson } -ModuleName AITriad

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $results = @(Get-TaxEditorImage -Last 3)
            $results.Count | Should -Be 3
            $results[0].IsKnownGood | Should -BeTrue
            $results[0].Digest | Should -BeLike 'sha256:abc*'
            @($results[0].Tags).Count | Should -Be 3
            $results[1].IsKnownGood | Should -BeFalse
            @($results[2].Tags).Count | Should -Be 0
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Validates -Last range' {
        { Get-TaxEditorImage -Last 0 } | Should -Throw
        { Get-TaxEditorImage -Last 101 } | Should -Throw
    }
}

Describe 'Deploy-TaxEditorImage' -Tag 'health' {

    BeforeAll {
        $MockRevisions = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--deploy-old1234'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.0'
                CreatedAt     = '2026-06-21T08:00:00Z'
            }
        )

        $UpdateResultJson = @{
            properties = @{
                latestRevisionName = 'taxonomy-editor--deploy-new5678'
            }
        } | ConvertTo-Json -Depth 5
    }

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Deploy-TaxEditorImage -Tag '0.8.0' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when az CLI is not logged in' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith { $global:LASTEXITCODE = 1; return $null } -ModuleName AITriad
        { Deploy-TaxEditorImage -Tag '0.8.0' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'WhatIf shows action without deploying' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return '{"id":"sub-123"}'
        } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad

        $result = Deploy-TaxEditorImage -Tag '0.8.1' -WhatIf
        $result | Should -BeNullOrEmpty
        Should -Invoke -CommandName 'az' -Times 1 -ModuleName AITriad
    }

    It 'Happy path: -Tag deploys image with blue-green flow' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return $UpdateResultJson
        } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 150 } } -ModuleName AITriad

        $result = Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false
        $result.Action | Should -Be 'ImageDeploy'
        $result.Image | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1'
        $result.NewRevision | Should -Be 'taxonomy-editor--deploy-new5678'
        $result.HealthCheck | Should -Be 'Passed'
        Should -Invoke Test-TaxEditorHealth -Times 1 -ModuleName AITriad
    }

    It 'Happy path: -Digest deploys by exact digest' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return $UpdateResultJson
        } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 100 } } -ModuleName AITriad

        $result = Deploy-TaxEditorImage -Digest 'sha256:abc123def456' -Confirm:$false
        $result.Image | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:abc123def456'
        $result.HealthCheck | Should -Be 'Passed'
    }

    It 'Failed health check triggers auto-rollback' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return $UpdateResultJson
        } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $false; AverageMs = 0 } } -ModuleName AITriad

        $result = Deploy-TaxEditorImage -Tag '0.8.1-bad' -Confirm:$false 3>$null
        $result.HealthCheck | Should -Be 'Failed'
        $result.PreviousRevision | Should -Be 'taxonomy-editor--deploy-old1234'
    }

    It '-SkipHealthCheck skips verification and rollback' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            $global:LASTEXITCODE = 0
            return $UpdateResultJson
        } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Test-TaxEditorHealth -ModuleName AITriad

        $result = Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false -SkipHealthCheck
        $result.HealthCheck | Should -Be 'Skipped'
        Should -Invoke Test-TaxEditorHealth -Times 0 -ModuleName AITriad
    }
}
