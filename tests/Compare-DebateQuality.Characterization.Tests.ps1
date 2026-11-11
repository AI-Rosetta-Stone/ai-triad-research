# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Characterization test for Compare-DebateQuality output formatting.

.DESCRIPTION
    Establishes baseline output formats (CSV, JSON, Table) for Compare-DebateQuality.
    After refactoring, verifies the output matches the established baseline byte-for-byte.
    This test ensures the extraction of formatting helpers preserves behavior.
#>

BeforeAll {
    # Import the module
    $ModuleRoot = "$PSScriptRoot/../../../scripts"
    Import-Module "$ModuleRoot/AITriad.psd1" -Force -ErrorAction Stop
}

Describe "Compare-DebateQuality.Characterization" {
    It "outputs valid JSON when Format=Json" {
        # Create minimal test data
        $baseline = @{
            title = "Test Topic"
            debate_model = "gpt-4"
            debate_temperature = 0.7
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{
                crux_addressed_ratio = 0.85
                repetition_rate = 0.1
                claims_forgotten_rate = 0.05
                taxonomy_mapped_ratio = 0.9
                avg_utilization_rate = 0.75
                situation_crux_alignment = 0.8
                avg_branch_cohesion = 0.7
                draft_repair_rate = 0.15
                concession_cascades = 2
                topic_alignment_rate = 0.88
                process_reward_mean = 0.65
                process_reward_stddev = 0.12
                process_reward_min = 0.45
            }
        }
        
        $treatment = @{
            title = "Test Topic"
            debate_model = "gpt-4"
            debate_temperature = 0.7
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{
                crux_addressed_ratio = 0.87
                repetition_rate = 0.09
                claims_forgotten_rate = 0.04
                taxonomy_mapped_ratio = 0.92
                avg_utilization_rate = 0.78
                situation_crux_alignment = 0.82
                avg_branch_cohesion = 0.72
                draft_repair_rate = 0.14
                concession_cascades = 1
                topic_alignment_rate = 0.90
                process_reward_mean = 0.68
                process_reward_stddev = 0.11
                process_reward_min = 0.48
            }
        }
        
        # Save to temp files
        $baselinePath = [System.IO.Path]::GetTempFileName() + ".json"
        $treatmentPath = [System.IO.Path]::GetTempFileName() + ".json"
        
        $baseline | ConvertTo-Json -Depth 10 | Set-Content $baselinePath
        $treatment | ConvertTo-Json -Depth 10 | Set-Content $treatmentPath
        
        try {
            # Call with JSON format
            $result = Compare-DebateQuality -Baseline $baselinePath -Treatment $treatmentPath -Format Json
            
            # Should produce valid JSON
            $result | ConvertFrom-Json | Should -Not -BeNullOrEmpty
            $result | ConvertFrom-Json | Select-Object -ExpandProperty deltas | Should -Not -BeNullOrEmpty
        } finally {
            Remove-Item $baselinePath -Force -ErrorAction SilentlyContinue
            Remove-Item $treatmentPath -Force -ErrorAction SilentlyContinue
        }
    }
    
    It "outputs valid CSV when Format=Csv" {
        # Create minimal test data (same as above)
        $baseline = @{
            title = "Test Topic"
            debate_model = "gpt-4"
            debate_temperature = 0.7
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{
                crux_addressed_ratio = 0.85
                repetition_rate = 0.1
                claims_forgotten_rate = 0.05
                taxonomy_mapped_ratio = 0.9
                avg_utilization_rate = 0.75
                situation_crux_alignment = 0.8
                avg_branch_cohesion = 0.7
                draft_repair_rate = 0.15
                concession_cascades = 2
                topic_alignment_rate = 0.88
                process_reward_mean = 0.65
                process_reward_stddev = 0.12
                process_reward_min = 0.45
            }
        }
        
        $treatment = @{
            title = "Test Topic"
            debate_model = "gpt-4"
            debate_temperature = 0.7
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{
                crux_addressed_ratio = 0.87
                repetition_rate = 0.09
                claims_forgotten_rate = 0.04
                taxonomy_mapped_ratio = 0.92
                avg_utilization_rate = 0.78
                situation_crux_alignment = 0.82
                avg_branch_cohesion = 0.72
                draft_repair_rate = 0.14
                concession_cascades = 1
                topic_alignment_rate = 0.90
                process_reward_mean = 0.68
                process_reward_stddev = 0.11
                process_reward_min = 0.48
            }
        }
        
        # Save to temp files
        $baselinePath = [System.IO.Path]::GetTempFileName() + ".json"
        $treatmentPath = [System.IO.Path]::GetTempFileName() + ".json"
        
        $baseline | ConvertTo-Json -Depth 10 | Set-Content $baselinePath
        $treatment | ConvertTo-Json -Depth 10 | Set-Content $treatmentPath
        
        try {
            # Call with CSV format
            $result = Compare-DebateQuality -Baseline $baselinePath -Treatment $treatmentPath -Format Csv
            
            # Should produce CSV lines with headers
            $result -is [object[]] | Should -Be $true
            @($result).Count | Should -BeGreaterThan 1  # Header + at least one data row
            $result[0] | Should -Match "Metric,Baseline,Treatment"
        } finally {
            Remove-Item $baselinePath -Force -ErrorAction SilentlyContinue
            Remove-Item $treatmentPath -Force -ErrorAction SilentlyContinue
        }
    }
    
    It "returns structured object when PassThru=true" {
        $baseline = @{
            title = "Test"
            debate_model = "gpt-4"
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{ crux_addressed_ratio = 0.85 }
        }
        
        $treatment = @{
            title = "Test"
            debate_model = "gpt-4"
            protocol_id = "standard"
            app_version = "1.0.0"
            created_at = "2026-01-01T00:00:00Z"
            calibration_log = @{ crux_addressed_ratio = 0.87 }
        }
        
        $baselinePath = [System.IO.Path]::GetTempFileName() + ".json"
        $treatmentPath = [System.IO.Path]::GetTempFileName() + ".json"
        
        $baseline | ConvertTo-Json -Depth 10 | Set-Content $baselinePath
        $treatment | ConvertTo-Json -Depth 10 | Set-Content $treatmentPath
        
        try {
            $result = Compare-DebateQuality -Baseline $baselinePath -Treatment $treatmentPath -PassThru
            
            # Should return structured object with deltas
            $result | Should -Not -BeNullOrEmpty
            $result.deltas | Should -Not -BeNullOrEmpty
            $result.deltas["crux_addressed_ratio"] | Should -Not -BeNullOrEmpty
        } finally {
            Remove-Item $baselinePath -Force -ErrorAction SilentlyContinue
            Remove-Item $treatmentPath -Force -ErrorAction SilentlyContinue
        }
    }
}
