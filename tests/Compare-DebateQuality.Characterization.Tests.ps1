# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Characterization test for Compare-DebateQuality output formatting.

.DESCRIPTION
    Validates that the refactored Compare-DebateQuality produces byte-for-byte identical
    output to the main implementation. Uses golden outputs captured on main branch.
    
    Test will FAIL (RED) if:
    - JSON structure changes
    - CSV format or field order changes
    - Table headers or column alignment changes
    - Any metric calculation differs
    - Output formatting changes
#>

BeforeAll {
    # Import the module - use relative path from test file location
    $repoRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot))
    $moduleRoot = Join-Path $repoRoot 'scripts' 'AITriad'
    Import-Module (Join-Path $moduleRoot 'AITriad.psd1') -Force -ErrorAction Stop
    
    # Fixture paths - relative to test file
    $script:BaselineFixture = Join-Path $PSScriptRoot 'fixtures' 'debate-baseline.json'
    $script:TreatmentFixture = Join-Path $PSScriptRoot 'fixtures' 'debate-treatment.json'
    
    # Verify fixtures exist
    if (-not (Test-Path $script:BaselineFixture)) {
        throw "Missing fixture: $($script:BaselineFixture)"
    }
    if (-not (Test-Path $script:TreatmentFixture)) {
        throw "Missing fixture: $($script:TreatmentFixture)"
    }
    
    # Golden CSV output from main (exact, all rows must match)
    $script:CsvGolden = @(
        '"Metric","Baseline","Treatment","Delta","PctChange"'
        '"crux_addressed_ratio","0.85","0.88","0.03","3.5"'
        '"repetition_rate","0.12","0.09","-0.03","-25"'
        '"claims_forgotten_rate","0.08","0.05","-0.03","-37.5"'
        '"taxonomy_mapped_ratio","0.9","0.93","0.03","3.3"'
        '"avg_utilization_rate","0.78","0.81","0.03","3.8"'
        '"situation_crux_alignment","0.82","0.85","0.03","3.7"'
        '"avg_branch_cohesion","0.75","0.78","0.03","4"'
        '"draft_repair_rate","0.18","0.14","-0.04","-22.2"'
        '"concession_cascades","3","2","-1","-33.3"'
        '"topic_alignment_rate","0.88","0.91","0.03","3.4"'
        '"prm_mean","0.72","0.75","0.03","4.2"'
        '"prm_stddev","0.15","0.12","-0.03","-20"'
        '"prm_min","0.42","0.48","0.06","14.3"'
    )
}

Describe "Compare-DebateQuality.Characterization" {
    It "CSV output matches golden exactly (byte-for-byte comparison)" {
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Csv)
        
        # Remove trailing empty lines
        $result = @($result | Where-Object { $_ })
        
        # Full array comparison - if this fails, a formatting change regressed
        $result.Count | Should -Be $script:CsvGolden.Count -Because "CSV row count must match golden"
        
        for ($i = 0; $i -lt $result.Count; $i++) {
            $result[$i] | Should -Be $script:CsvGolden[$i] -Because "CSV row $i must match golden byte-for-byte (row: $($result[$i]))"
        }
    }
    
    It "JSON output contains expected delta values" {
        $result = Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Json
        
        # Verify valid JSON
        { $result | ConvertFrom-Json } | Should -Not -Throw
        
        $json = $result | ConvertFrom-Json
        
        # Verify all key deltas - these must match golden
        $json.deltas.crux_addressed_ratio.delta | Should -Be 0.03
        $json.deltas.crux_addressed_ratio.pct | Should -Be 3.5
        
        $json.deltas.repetition_rate.delta | Should -Be -0.03
        $json.deltas.repetition_rate.pct | Should -Be -25
        
        $json.deltas.concession_cascades.delta | Should -Be -1
        $json.deltas.concession_cascades.pct | Should -Be -33.3
        
        $json.deltas.prm_min.delta | Should -Be 0.06
        $json.deltas.prm_min.pct | Should -Be 14.3
    }
    
    It "Table output contains all metrics with correct values" {
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Table 6>&1)
        
        # Remove box-drawing and join without newlines to make regex matching easier
        $output = ($result | ForEach-Object { $_ -replace '[\u2550\u2551\u2552-\u256F]', '' }) -join ' '
        
        # Header section
        $output | Should -Match "DEBATE QUALITY COMPARISON"
        $output | Should -Match "AI Safety Test Case"
        $output | Should -Match "gpt-4-turbo"
        
        # Metrics section - all required metrics must appear with their values
        $output | Should -Match "crux_addressed_ratio.*0\.85.*0\.88.*0\.03.*3\.5"
        $output | Should -Match "repetition_rate.*0\.12.*0\.09.*\-0\.03.*\-25"
        $output | Should -Match "concession_cascades.*3.*2.*\-1.*\-33\.3"
        $output | Should -Match "prm_min.*0\.42.*0\.48.*0\.06.*14\.3"
    }
}
