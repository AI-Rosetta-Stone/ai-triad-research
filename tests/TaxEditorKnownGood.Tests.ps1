# Tag: health (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Set-TaxEditorKnownGood' -Tag 'health' {

    BeforeAll {
        $MockRevisions = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--rev-abc123'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1'
                CreatedAt     = '2026-06-22T10:00:00Z'
            }
        )

        $MockImages = @(
            @{
                name       = 'sha256:olddigest000111222333444555666777888999'
                created_at = '2026-06-21T08:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.0', 'known-good')
                    }
                }
            }
            @{
                name       = 'sha256:newdigest111222333444555666777888999aaa'
                created_at = '2026-06-22T10:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.1', 'latest')
                    }
                }
            }
        ) | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    }

    It 'Throws when no active revision found' {
        Mock Get-TaxEditorRevision { @() } -ModuleName AITriad

        { Set-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when active revision has no tag (digest-only deploy)' {
        $DigestOnlyRevision = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--rev-xyz'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:abc123'
                CreatedAt     = '2026-06-22T10:00:00Z'
            }
        )
        Mock Get-TaxEditorRevision { $DigestOnlyRevision } -ModuleName AITriad

        { Set-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw
    }

    It 'WhatIf shows action without tagging' {
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Invoke-RestMethod { $MockImages } -ModuleName AITriad
        Mock Get-GhcrAuthToken { 'fake-ghcr-token' } -ModuleName AITriad
        Mock Invoke-WebRequest -ModuleName AITriad

        $result = Set-TaxEditorKnownGood -WhatIf
        $result | Should -BeNullOrEmpty
        Should -Invoke Invoke-WebRequest -Times 0 -ModuleName AITriad
    }

    It 'Happy path: tags current production image as known-good' {
        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Invoke-RestMethod -ModuleName AITriad -MockWith {
            if ($Uri -like '*/orgs/*/packages/*') {
                return $MockImages
            }
            return $null
        }
        Mock Get-GhcrAuthToken { 'fake-ghcr-token' } -ModuleName AITriad
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            [PSCustomObject]@{
                Content = '{"schemaVersion":2}'
                Headers = @{ 'Content-Type' = 'application/vnd.docker.distribution.manifest.v2+json' }
            }
        }

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Set-TaxEditorKnownGood -Confirm:$false
            $result.Action | Should -Be 'SetKnownGood'
            $result.Tag | Should -Be '0.8.1'
            $result.Image | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.8.1'
            $result.PreviousKnownGood | Should -Be '0.8.0'
            Should -Invoke Invoke-WebRequest -Times 1 -ModuleName AITriad
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Reports (none) when no previous known-good exists' {
        $NoPriorKgImages = @(
            @{
                name       = 'sha256:newdigest111222333444555666777888999aaa'
                created_at = '2026-06-22T10:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.1', 'latest')
                    }
                }
            }
        ) | ConvertTo-Json -Depth 5 | ConvertFrom-Json

        Mock Get-TaxEditorRevision { $MockRevisions } -ModuleName AITriad
        Mock Invoke-RestMethod -ModuleName AITriad -MockWith {
            if ($Uri -like '*/orgs/*/packages/*') {
                return $NoPriorKgImages
            }
            return $null
        }
        Mock Get-GhcrAuthToken { 'fake-ghcr-token' } -ModuleName AITriad
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            [PSCustomObject]@{
                Content = '{"schemaVersion":2}'
                Headers = @{ 'Content-Type' = 'application/vnd.docker.distribution.manifest.v2+json' }
            }
        }

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Set-TaxEditorKnownGood -Confirm:$false
            $result.PreviousKnownGood | Should -Be '(none)'
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }
}

Describe 'Restore-TaxEditorKnownGood' -Tag 'health' {

    BeforeAll {
        $MockImages = @(
            @{
                name       = 'sha256:kgdigest000111222333444555666777888999aaa'
                created_at = '2026-06-21T08:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.0', 'known-good')
                    }
                }
            }
            @{
                name       = 'sha256:currentdigest111222333444555666777888999'
                created_at = '2026-06-22T10:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.1', 'latest')
                    }
                }
            }
        ) | ConvertTo-Json -Depth 5 | ConvertFrom-Json

        $MockDeployResult = [PSCustomObject]@{
            Action           = 'ImageDeploy'
            Image            = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:known-good'
            NewRevision      = 'taxonomy-editor--restore-new789'
            PreviousRevision = 'taxonomy-editor--rev-abc123'
            HealthCheck      = 'Passed'
            AppName          = 'taxonomy-editor'
            ResourceGroup    = 'ai-triad'
            Timestamp        = '2026-06-22T12:00:00Z'
        }
    }

    It 'Throws when no known-good image exists' {
        $NoKgImages = @(
            @{
                name       = 'sha256:currentdigest111222333444555666777888999'
                created_at = '2026-06-22T10:00:00Z'
                metadata   = @{
                    container = @{
                        tags = @('0.8.1', 'latest')
                    }
                }
            }
        ) | ConvertTo-Json -Depth 5 | ConvertFrom-Json

        Mock Invoke-RestMethod { $NoKgImages } -ModuleName AITriad
        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            { Restore-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'WhatIf shows action without deploying' {
        Mock Invoke-RestMethod { $MockImages } -ModuleName AITriad
        Mock Deploy-TaxEditorImage -ModuleName AITriad

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Restore-TaxEditorKnownGood -WhatIf
            $result | Should -BeNullOrEmpty
            Should -Invoke Deploy-TaxEditorImage -Times 0 -ModuleName AITriad
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Happy path: deploys known-good image via blue-green flow' {
        Mock Invoke-RestMethod { $MockImages } -ModuleName AITriad
        Mock Deploy-TaxEditorImage { $MockDeployResult } -ModuleName AITriad

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Restore-TaxEditorKnownGood -Confirm:$false
            $result.Action | Should -Be 'RestoreKnownGood'
            $result.KnownGoodLabel | Should -Be '0.8.0'
            $result.KnownGoodDigest | Should -BeLike 'sha256:kgdigest*'
            $result.NewRevision | Should -Be 'taxonomy-editor--restore-new789'
            $result.HealthCheck | Should -Be 'Passed'
            Should -Invoke Deploy-TaxEditorImage -Times 1 -ModuleName AITriad -ParameterFilter {
                $Tag -eq 'known-good'
            }
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Passes -SkipHealthCheck through to Deploy-TaxEditorImage' {
        Mock Invoke-RestMethod { $MockImages } -ModuleName AITriad
        Mock Deploy-TaxEditorImage { $MockDeployResult } -ModuleName AITriad

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Restore-TaxEditorKnownGood -Confirm:$false -SkipHealthCheck
            Should -Invoke Deploy-TaxEditorImage -Times 1 -ModuleName AITriad -ParameterFilter {
                $SkipHealthCheck -eq $true
            }
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }

    It 'Returns health check failure from Deploy-TaxEditorImage' {
        $FailedDeploy = [PSCustomObject]@{
            Action           = 'ImageDeploy'
            Image            = 'ghcr.io/ai-rosetta-stone/taxonomy-editor:known-good'
            NewRevision      = 'taxonomy-editor--restore-fail'
            PreviousRevision = 'taxonomy-editor--rev-abc123'
            HealthCheck      = 'Failed'
            AppName          = 'taxonomy-editor'
            ResourceGroup    = 'ai-triad'
            Timestamp        = '2026-06-22T12:00:00Z'
        }

        Mock Invoke-RestMethod { $MockImages } -ModuleName AITriad
        Mock Deploy-TaxEditorImage { $FailedDeploy } -ModuleName AITriad

        $OrigToken = $env:GITHUB_TOKEN
        try {
            $env:GITHUB_TOKEN = 'test-token-placeholder'
            $result = Restore-TaxEditorKnownGood -Confirm:$false
            $result.HealthCheck | Should -Be 'Failed'
            $result.Action | Should -Be 'RestoreKnownGood'
        }
        finally {
            $env:GITHUB_TOKEN = $OrigToken
        }
    }
}
