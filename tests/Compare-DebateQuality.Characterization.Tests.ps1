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
    # $PSScriptRoot is tests/, so go up one level to repo root
    $repoRoot = Split-Path $PSScriptRoot
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
    
}

Describe "Compare-DebateQuality.Characterization" {
    It "CSV output matches golden exactly (byte-for-byte string comparison)" {
        # Load golden CSV output
        $goldenCsvPath = Join-Path $PSScriptRoot 'golden-csv-output.csv'
        if (-not (Test-Path $goldenCsvPath)) {
            throw "Missing golden CSV: $goldenCsvPath"
        }
        $goldenCsv = (Get-Content $goldenCsvPath -Raw).Trim()
        
        # Capture actual output
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Csv)
        $result = @($result | Where-Object { $_ })
        $actualCsv = ($result -join "`n").Trim()
        
        # Normalize line endings (CRLF -> LF)
        $goldenCsv = $goldenCsv -replace "`r`n", "`n"
        $actualCsv = $actualCsv -replace "`r`n", "`n"
        
        # Exact string comparison - fails if ANY field or row differs
        $actualCsv | Should -Be $goldenCsv -Because "CSV output must match golden byte-for-byte with all fields, quotes, and row ordering exactly preserved"
    }
    
    It "JSON output matches golden exactly (byte-for-byte string comparison)" {
        # Load golden JSON output
        $goldenJsonPath = Join-Path $PSScriptRoot 'golden-json-output.json'
        if (-not (Test-Path $goldenJsonPath)) {
            throw "Missing golden JSON: $goldenJsonPath"
        }
        $goldenJson = (Get-Content $goldenJsonPath -Raw).Trim()
        
        # Capture actual output
        $result = Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Json
        $actualJson = $result.Trim()
        
        # Normalize line endings (CRLF -> LF) for comparison
        $goldenJson = $goldenJson -replace "`r`n", "`n"
        $actualJson = $actualJson -replace "`r`n", "`n"
        
        # Exact string comparison - fails if ANY formatting or value differs
        $actualJson | Should -Be $goldenJson -Because "JSON output must match golden byte-for-byte (paths may differ, but structure and all values must match exactly)"
    }
    
    It "Table output matches golden exactly (byte-for-byte, CRLF normalized)" {
        # Load golden table output
        $goldenTablePath = Join-Path $PSScriptRoot 'golden-table-output.txt'
        if (-not (Test-Path $goldenTablePath)) {
            throw "Missing golden table: $goldenTablePath"
        }
        $goldenTable = (Get-Content $goldenTablePath -Raw).Trim()
        
        # Capture actual output (6>&1 to include host messages)
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Table 6>&1)
        $actualTable = ($result -join "`n").Trim()
        
        # Normalize line endings (CRLF -> LF) for cross-platform compatibility
        $goldenTable = $goldenTable -replace "`r`n", "`n"
        $actualTable = $actualTable -replace "`r`n", "`n"
        
        # Exact string comparison - fails if ANY line or column alignment differs
        $actualTable | Should -Be $goldenTable -Because "Table output must match golden byte-for-byte with all columns, headers, and metrics exactly aligned"
    }
}
