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

Describe 'Deploy-TaxEditorImage deactivates only after a fresh t/4242 verdict (t/4308)' -Tag 'health' {
    # An az mock that routes by sub-command: `revision show` reports $script:RevWeight[<rev>],
    # `containerapp show` reports ingress traffic $script:Ingress, and `revision deactivate` is
    # recorded in $script:Deactivated so each test can assert exactly what was deactivated.
    BeforeAll {
        $script:Old = 'taxonomy-editor--deploy-old1234'
        $script:New = 'taxonomy-editor--deploy-new5678'
        $script:OldRevisions = @([PSCustomObject]@{ PSTypeName = 'AcaRevision'; Name = $script:Old; Active = $true; TrafficWeight = 100 })
    }
    BeforeEach {
        $script:RevWeight = @{}
        $script:Ingress = @()
        $script:Deactivated = [System.Collections.Generic.List[string]]::new()
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock Get-TaxEditorRevision { $script:OldRevisions } -ModuleName AITriad
        Mock -CommandName 'az' -ModuleName AITriad -MockWith {
            $global:LASTEXITCODE = 0
            $a = @($args)
            $rev = $null; $i = [array]::IndexOf($a, '--revision'); if ($i -ge 0) { $rev = $a[$i + 1] }
            if ($a -contains 'deactivate') { $script:Deactivated.Add($rev); return $null }
            if ($a -contains 'update') { return (@{ properties = @{ latestRevisionName = $script:New } } | ConvertTo-Json -Depth 5) }
            if ($a -contains 'revision' -and $a -contains 'show') {
                return (@{ name = $rev; properties = @{ trafficWeight = $script:RevWeight[$rev]; active = $true } } | ConvertTo-Json -Depth 5)
            }
            if ($a[0] -eq 'containerapp' -and $a[1] -eq 'show') {
                return (@{ properties = @{ latestRevisionName = $script:New; configuration = @{ ingress = @{ traffic = @($script:Ingress) } } } } | ConvertTo-Json -Depth 8)
            }
            return '{"id":"sub-123"}'
        }
    }

    It 'skips (WARN) an old revision whose revision-show weight is still > 0' {
        $script:RevWeight[$script:Old] = 100
        $script:Ingress = @(@{ revisionName = $script:New; weight = 100 })
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 1 } } -ModuleName AITriad
        $null = Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false -WarningVariable w 3>$null
        @($script:Deactivated) | Should -Not -Contain $script:Old
        ($w -join "`n") | Should -Match 'nonzero-traffic-weight'
    }

    It 'skips (WARN) when the ingress config still routes weight to the old revision' {
        $script:RevWeight[$script:Old] = 0
        $script:Ingress = @(@{ revisionName = $script:Old; weight = 50 }, @{ revisionName = $script:New; weight = 50 })
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 1 } } -ModuleName AITriad
        $null = Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false -WarningVariable w 3>$null
        @($script:Deactivated) | Should -Not -Contain $script:Old
        ($w -join "`n") | Should -Match 'nonzero-ingress-weight'
    }

    It 'deactivates the old revision when both sources read 0' {
        $script:RevWeight[$script:Old] = 0
        $script:Ingress = @(@{ revisionName = $script:New; weight = 100 })
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $true; AverageMs = 1 } } -ModuleName AITriad
        $null = Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false 3>$null
        @($script:Deactivated) | Should -Be @($script:Old)
    }

    It 'rollback path: does not deactivate the failed new revision while it still holds weight' {
        $script:RevWeight[$script:Old] = 0
        $script:RevWeight[$script:New] = 100
        $script:Ingress = @(@{ revisionName = $script:New; weight = 100 })
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $false; AverageMs = 0 } } -ModuleName AITriad
        $r = Deploy-TaxEditorImage -Tag '0.8.1-bad' -Confirm:$false -WarningVariable w 3>$null
        $r.HealthCheck | Should -Be 'Failed'
        @($script:Deactivated) | Should -Not -Contain $script:New
        ($w -join "`n") | Should -Match "not deactivating revision '$([regex]::Escape($script:New))'"
    }

    It 'rollback path: deactivates the failed new revision once it reads 0 on both sources' {
        $script:RevWeight[$script:Old] = 100     # the rollback target: never deactivated
        $script:RevWeight[$script:New] = 0
        $script:Ingress = @(@{ revisionName = $script:Old; weight = 100 })
        Mock Test-TaxEditorHealth { [PSCustomObject]@{ Healthy = $false; AverageMs = 0 } } -ModuleName AITriad
        $null = Deploy-TaxEditorImage -Tag '0.8.1-bad' -Confirm:$false 3>$null
        @($script:Deactivated) | Should -Be @($script:New)
    }

    It 'fails closed before deploying when the shared guard predicate cannot be found' {
        InModuleScope AITriad {
            $savedRoot = $script:RepoRoot
            $savedLoaded = Get-Variable -Name RevisionVerdictLoaded -Scope Script -ValueOnly -ErrorAction SilentlyContinue
            try {
                # Forget the cached predicate and point the repo root at a directory without it.
                $script:RevisionVerdictLoaded = $false
                $script:RepoRoot = Join-Path ([IO.Path]::GetTempPath()) "no-repo-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
                { Deploy-TaxEditorImage -Tag '0.8.1' -Confirm:$false 3>$null } | Should -Throw -ExpectedMessage '*guard predicate was not found*'
            } finally {
                $script:RepoRoot = $savedRoot
                $script:RevisionVerdictLoaded = $savedLoaded
            }
        }
        Should -Invoke -CommandName 'az' -ModuleName AITriad -ParameterFilter { @($args) -contains 'update' } -Times 0 -Exactly
    }
}
