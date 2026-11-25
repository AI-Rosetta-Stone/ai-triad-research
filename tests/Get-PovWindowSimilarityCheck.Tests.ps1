# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# Characterization tests for Get-PovWindowSimilarityCheck (t/4477 forensic cross-check).
# Race-safe: dot-sources ONLY the Private file under test, never Import-Module.

BeforeAll {
    . (Join-Path $PSScriptRoot '..\scripts\AITriad\Private\Get-PovWindowSimilarityCheck.ps1')
}

Describe 'Get-PovWindowSimilarityCheck (characterization)' {
    BeforeEach { $script:CachedEmbeddings = $null }

    It 'returns $null when the cache is unavailable (never throws)' {
        $script:CachedEmbeddings = $null
        { Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0)) } | Should -Not -Throw
        Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0)) | Should -BeNullOrEmpty
    }

    It 'returns $null when the cache has no recognizable camp nodes' {
        $script:CachedEmbeddings = @{ 'cc-foo-001' = [double[]]@(1, 0, 0) }
        Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0)) | Should -BeNullOrEmpty
    }

    It 'scores each window against each camp mean, perfect match at cosine 1.0' {
        $script:CachedEmbeddings = @{
            'acc-beliefs-001' = [double[]]@(1, 0, 0)
            'saf-beliefs-001' = [double[]]@(0, 1, 0)
            'skp-beliefs-001' = [double[]]@(0, 0, 1)
        }
        $r = Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0), [double[]]@(0, 1, 0))
        $r | Should -BeOfType hashtable
        $r.Keys | Should -Contain 'accelerationist'
        $r.Keys | Should -Contain 'safetyist'
        $r.Keys | Should -Contain 'skeptic'
        $r['accelerationist'][0] | Should -BeGreaterThan 0.99
        $r['accelerationist'][1] | Should -BeLessThan 0.01
        $r['safetyist'][1] | Should -BeGreaterThan 0.99
    }

    It 'averages multiple nodes in a camp into its mean' {
        $script:CachedEmbeddings = @{
            'acc-beliefs-001' = [double[]]@(1, 0, 0)
            'acc-beliefs-002' = [double[]]@(0, 1, 0)
        }
        # mean of (1,0,0) and (0,1,0) normalized is (0.707,0.707,0); window (1,1,0) aligns perfectly.
        # Two windows are used because a single window triggers PowerShell's lone-element unwrap.
        $r = Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 1, 0), [double[]]@(0, 0, 1))
        $r['accelerationist'][0] | Should -BeGreaterThan 0.99
        $r['accelerationist'][1] | Should -BeLessThan 0.01
    }

    It 'returns a score array matching window count and order' {
        $script:CachedEmbeddings = @{ 'acc-beliefs-001' = [double[]]@(1, 0, 0) }
        $r = Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0), [double[]]@(0, 1, 0), [double[]]@(0, 0, 1))
        @($r['accelerationist']).Count | Should -Be 3
    }
}

Describe 'Get-PovCampVectorGroups / Get-PovCampMeanVectors (extracted helpers)' {
    It 'groups node embeddings by camp prefix' {
        $groups = Get-PovCampVectorGroups -Embeddings @{
            'acc-a-001' = [double[]]@(1, 0)
            'saf-b-001' = [double[]]@(0, 1)
            'cc-x-001'  = [double[]]@(9, 9)
        }
        @($groups['accelerationist']).Count | Should -Be 1
        @($groups['safetyist']).Count | Should -Be 1
        @($groups['skeptic']).Count | Should -Be 0
    }

    It 'computes L2-normalized means and skips empty camps' {
        $means = Get-PovCampMeanVectors -CampVectors @{
            accelerationist = @(, [double[]]@(3, 4))
            safetyist       = @()
        }
        $means.Keys | Should -Contain 'accelerationist'
        $means.Keys | Should -Not -Contain 'safetyist'
        [Math]::Sqrt(($means['accelerationist'] | ForEach-Object { $_ * $_ } | Measure-Object -Sum).Sum) | Should -BeGreaterThan 0.999
    }
}
