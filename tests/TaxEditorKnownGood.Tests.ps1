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

    It 'Throws when the serving revision has neither a tag nor a digest' {
        $NoRefRevision = @(
            [PSCustomObject]@{
                PSTypeName    = 'AcaRevision'
                Name          = 'taxonomy-editor--rev-xyz'
                Active        = $true
                TrafficWeight = 100
                RunningState  = 'Running'
                ImageTag      = 'ghcr.io/ai-rosetta-stone/taxonomy-editor'
                CreatedAt     = '2026-06-22T10:00:00Z'
            }
        )
        Mock Get-TaxEditorRevision { $NoRefRevision } -ModuleName AITriad

        { Set-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw '*neither a tag nor a digest*'
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

Describe 'Set-TaxEditorKnownGood: serving revision and digest refs (p/682#28)' -Tag 'health' {
    BeforeAll {
        $script:Hex = 'a' * 64
        $script:Digest = "sha256:$($script:Hex)"
        function script:New-Rev([string]$Name, [int]$Weight, [string]$Image) {
            [pscustomobject]@{ PSTypeName = 'AcaRevision'; Name = $Name; Active = $true   # ACA reports a 0% revision as active (provisioned) too
                TrafficWeight = $Weight; RunningState = 'Running'; ImageTag = $Image; CreatedAt = '2026-10-16T00:00:00Z' }
        }
        $script:NoKnownGood = @() | ConvertTo-Json | ConvertFrom-Json
    }
    BeforeEach {
        Mock Invoke-RestMethod -ModuleName AITriad -MockWith { if ($Uri -like '*/orgs/*/packages/*') { return @() } }
        Mock Get-GhcrAuthToken { 'fake-ghcr-token' } -ModuleName AITriad
        Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
            [pscustomobject]@{ Content = '{"schemaVersion":2}'
                Headers = @{ 'Content-Type' = 'application/vnd.oci.image.index.v1+json'; 'Docker-Content-Digest' = "sha256:$('a' * 64)" } }
        }
    }

    It 'tags the 100% revision when a 0% revision is listed FIRST' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith {
            @((New-Rev 'old' 0 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.9.0'), (New-Rev 'new' 100 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0'))
        }
        $r = Set-TaxEditorKnownGood -Confirm:$false
        $r.Image | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0'
        Should -Invoke Invoke-WebRequest -ModuleName AITriad -Times 1 -ParameterFilter { $Uri -like '*/manifests/1.0.0' }
    }

    It 'tags the 100% revision when a 0% revision is listed SECOND' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith {
            @((New-Rev 'new' 100 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0'), (New-Rev 'old' 0 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.9.0'))
        }
        $r = Set-TaxEditorKnownGood -Confirm:$false
        $r.Image | Should -Be 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0'
    }

    It 'refuses with an actionable error when traffic is split' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith {
            @((New-Rev 'a' 50 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0'), (New-Rev 'b' 50 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.9.0'))
        }
        { Set-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw '*Traffic is split*'
        Should -Invoke Invoke-WebRequest -ModuleName AITriad -Times 0
    }

    It 'a digest ref is fetched BY digest, PUT as known-good, and the digest is returned' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith {
            @((New-Rev 'old' 0 'ghcr.io/ai-rosetta-stone/taxonomy-editor:0.9.0'),
              (New-Rev 'new' 100 "ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:$('a' * 64)"))
        }
        $r = Set-TaxEditorKnownGood -Confirm:$false
        $r.Digest | Should -Be $script:Digest
        $r.Tag | Should -BeNullOrEmpty
        Should -Invoke Invoke-WebRequest -ModuleName AITriad -Times 1 -ParameterFilter { $Uri -like "*/manifests/sha256:$('a' * 64)" }
        Should -Invoke Invoke-RestMethod -ModuleName AITriad -Times 1 -ParameterFilter { $Method -eq 'PUT' -and $Uri -like '*/manifests/known-good' }
    }

    It 'a tag ref returns the manifest digest from Docker-Content-Digest' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith { @(New-Rev 'new' 100 'ghcr.io/ai-rosetta-stone/taxonomy-editor:1.0.0') }
        $r = Set-TaxEditorKnownGood -Confirm:$false
        $r.Tag | Should -Be '1.0.0'
        $r.Digest | Should -Be $script:Digest
    }

    It 'refuses when GHCR returns a different manifest than the pinned digest' {
        Mock Get-TaxEditorRevision -ModuleName AITriad -MockWith {
            @(New-Rev 'new' 100 "ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:$('b' * 64)")
        }
        { Set-TaxEditorKnownGood -Confirm:$false 2>$null } | Should -Throw '*refusing to tag a different image*'
        Should -Invoke Invoke-RestMethod -ModuleName AITriad -Times 0 -ParameterFilter { $Method -eq 'PUT' }
    }
}

Describe 'ConvertFrom-TaxEditorImageRef / Get-OciManifestDigest' -Tag 'health' {
    It 'parses <Ref>' -ForEach @(
        @{ Ref = "ghcr.io/o/r@sha256:$('c' * 64)"; Reference = "sha256:$('c' * 64)"; Tag = $null }
        @{ Ref = "ghcr.io/o/r:1.2@sha256:$('c' * 64)"; Reference = "sha256:$('c' * 64)"; Tag = '1.2' }
        @{ Ref = 'ghcr.io/o/r:1.2'; Reference = '1.2'; Tag = '1.2' }
        @{ Ref = 'localhost:5000/o/r:dev'; Reference = 'dev'; Tag = 'dev' }
    ) {
        $p = & (Get-Module AITriad) { param($x) ConvertFrom-TaxEditorImageRef -ImageRef $x } $Ref
        $p.Reference | Should -Be $Reference
        $p.Tag | Should -Be $Tag
    }
    It 'returns $null for a ref with neither tag nor digest, including a registry port alone' {
        & (Get-Module AITriad) { ConvertFrom-TaxEditorImageRef -ImageRef 'localhost:5000/o/r' } | Should -BeNullOrEmpty
        & (Get-Module AITriad) { ConvertFrom-TaxEditorImageRef -ImageRef '' } | Should -BeNullOrEmpty
    }
    It 'computes sha256 over the body when the digest header is absent' {
        $d = & (Get-Module AITriad) { Get-OciManifestDigest -Response ([pscustomobject]@{ Content = 'abc'; Headers = @{} }) }
        $d | Should -Be 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    }
}
