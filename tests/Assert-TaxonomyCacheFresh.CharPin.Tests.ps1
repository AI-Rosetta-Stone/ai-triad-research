# Tag: taxonomy (refactor characterization pin)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Race-safe characterization pins for Assert-TaxonomyCacheFresh.
.DESCRIPTION
    Loads ONLY the Private file under test by dot-sourcing it (never
    Import-Module of the batch worktree module) so it is safe to run while
    peers edit sibling files in the same worktree. Module-level dependencies
    (Get-TaxonomyDir, Test-IsPovTaxonomyBytes, Test-IsPovTaxonomyData,
    Update-TaxonomySupersessionCache) are stubbed in-scope. Pins the stale /
    not-stale / reload branches the refactor must preserve.
#>

BeforeAll {
    $script:FileUnderTest = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Assert-TaxonomyCacheFresh.ps1'

    # In-scope stubs for the module dependencies this Private file calls.
    function Get-TaxonomyDir { $script:TestTaxDir }
    function Update-TaxonomySupersessionCache { }
    function Test-IsPovTaxonomyBytes { param($Bytes, $FileName) $true }
    function Test-IsPovTaxonomyData {
        param($Json)
        if (-not $Json.nodes) { return $false }
        foreach ($n in $Json.nodes) {
            if ($n.PSObject.Properties.Name -contains 'id') { return $true }
        }
        return $false
    }

    . $script:FileUnderTest
}

Describe 'Assert-TaxonomyCacheFresh characterization pins' -Tag 'taxonomy' {

    BeforeEach {
        $script:TestTaxDir = Join-Path ([System.IO.Path]::GetTempPath()) "cache-pin-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        New-Item -ItemType Directory -Path $script:TestTaxDir -Force | Out-Null
        Set-Content -Path (Join-Path $script:TestTaxDir 'accelerationist.json') -Value '{"nodes":[{"id":"acc-desires-001"}]}'
        Set-Content -Path (Join-Path $script:TestTaxDir 'safetyist.json')       -Value '{"nodes":[{"id":"saf-beliefs-001"}]}'

        $script:TaxonomyData = @{}
        $script:TaxonomyFileTimestamps = @{}
        $script:TaxonomyCacheLastCheck = $null
        $script:PillarNodeIds = 'stale'
        $script:CachedEmbeddings = $null
        $script:EmbeddingsTimestamp = $null
        $script:CachedSyntheticVectors = $null
        $script:SyntheticTimestamp = $null
        $script:PolicyRegistry = $null
    }

    AfterEach {
        Remove-Item -Path $script:TestTaxDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'Empty cache reloads from disk and registers POV files' {
        $run = Assert-TaxonomyCacheFresh -Verbose 4>&1
        @($run | Where-Object { $_ -match 'reloading from disk' }).Count | Should -BeGreaterThan 0
        $script:TaxonomyData.ContainsKey('accelerationist') | Should -BeTrue
        $script:TaxonomyData.ContainsKey('safetyist') | Should -BeTrue
        $script:PillarNodeIds | Should -BeNullOrEmpty -Because 'reload invalidates PillarNodeIds'
    }

    It 'Stamps a non-POV aux file so it does not re-trigger reload' {
        $AuxFile = Join-Path $script:TestTaxDir 'aggregated-cruxes.json'
        Set-Content -Path $AuxFile -Value '{"cruxes":[]}'

        Assert-TaxonomyCacheFresh | Out-Null
        $script:TaxonomyFileTimestamps.ContainsKey($AuxFile) | Should -BeTrue
        $script:TaxonomyData.ContainsKey('aggregated-cruxes') | Should -BeFalse

        $script:TaxonomyCacheLastCheck = $null
        $run = Assert-TaxonomyCacheFresh -Verbose 4>&1
        @($run | Where-Object { $_ -match 'reloading from disk' }).Count | Should -Be 0
    }

    It 'Reloads again when a POV file is genuinely modified' {
        Assert-TaxonomyCacheFresh | Out-Null
        $Pov = Join-Path $script:TestTaxDir 'safetyist.json'
        Set-Content -Path $Pov -Value '{"nodes":[{"id":"saf-beliefs-002"}]}'
        (Get-Item $Pov).LastWriteTime = (Get-Date).AddSeconds(5)

        $script:TaxonomyCacheLastCheck = $null
        $run = Assert-TaxonomyCacheFresh -Verbose 4>&1
        @($run | Where-Object { $_ -match 'reloading from disk' }).Count | Should -BeGreaterThan 0
    }

    It 'Honors the 30s cooldown when cache is populated and recently checked' {
        Assert-TaxonomyCacheFresh | Out-Null
        $script:TaxonomyCacheLastCheck = [DateTime]::UtcNow
        # Modify a POV file but stay inside cooldown: must NOT reload.
        $Pov = Join-Path $script:TestTaxDir 'safetyist.json'
        Set-Content -Path $Pov -Value '{"nodes":[{"id":"saf-beliefs-003"}]}'
        (Get-Item $Pov).LastWriteTime = (Get-Date).AddSeconds(5)
        $run = Assert-TaxonomyCacheFresh -Verbose 4>&1
        @($run | Where-Object { $_ -match 'reloading from disk' }).Count | Should -Be 0
    }

    It 'Skips a sidecar log whose nodes are keyed by node_id, not id' {
        Set-Content -Path (Join-Path $script:TestTaxDir 'entity_extraction_log.json') `
            -Value '{"node_count":1,"nodes":[{"node_id":"acc-beliefs-003"}]}'
        Assert-TaxonomyCacheFresh | Out-Null
        $script:TaxonomyData.ContainsKey('accelerationist') | Should -BeTrue
        $script:TaxonomyData.ContainsKey('entity_extraction_log') | Should -BeFalse
    }

    It 'Invalidates the embeddings cache when embeddings.json is newer' {
        $Emb = Join-Path $script:TestTaxDir 'embeddings.json'
        Set-Content -Path $Emb -Value '{"nodes":{}}'
        $script:CachedEmbeddings = @{ some = 'data' }
        $script:EmbeddingsTimestamp = (Get-Date).AddMinutes(-10)
        (Get-Item $Emb).LastWriteTime = (Get-Date)

        Assert-TaxonomyCacheFresh | Out-Null
        $script:CachedEmbeddings | Should -BeNullOrEmpty
        $script:EmbeddingsTimestamp | Should -BeNullOrEmpty
    }

    It 'Returns without error when the taxonomy dir does not exist' {
        $script:TestTaxDir = Join-Path ([System.IO.Path]::GetTempPath()) "cache-pin-missing-$([guid]::NewGuid().ToString('N'))"
        { Assert-TaxonomyCacheFresh } | Should -Not -Throw
    }
}
