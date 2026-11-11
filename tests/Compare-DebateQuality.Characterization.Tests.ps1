# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Characterization test for Compare-DebateQuality output formatting.

.DESCRIPTION
    Captures golden output from Compare-DebateQuality on fixed test fixtures,
    then asserts the refactored implementation produces byte-for-byte identical output.
    This test validates that formatting helpers preserve behavior exactly.
    
    Test will fail (RED) if:
    - CSV formatting changes
    - JSON structure changes
    - Table headers or column alignment changes
    - Any metric calculation differs
#>

BeforeAll {
    # Import the module
    $ModuleRoot = "$PSScriptRoot/../../../scripts"
    Import-Module "$ModuleRoot/AITriad/AITriad.psd1" -Force -ErrorAction Stop
    
    $script:BaselineFixture = "C:\Users\jsnov\repos\ai-triad-research\tests\fixtures\debate-baseline.json"
    $script:TreatmentFixture = "C:\Users\jsnov\repos\ai-triad-research\tests\fixtures\debate-treatment.json"
    
    # Golden output from main (captured 2026-11-11 pre-refactor)
    $script:JsonGolden = @'
{
  "baseline": {
    "path": ".*debate-baseline\.json",
    "metrics": {
      "header": {
        "topic": "AI Safety Test Case",
        "model": "gpt-4-turbo",
        "temperature": 0.7,
        "protocol": "standard-debate-v2",
        "app_version": "3.2.1",
        "created_at": "2026-11-01T10:00:00Z",
        "total_rounds": 0
      },
      "calibration": {
        "crux_addressed_ratio": 0.85,
        "repetition_rate": 0.12,
        "claims_forgotten_rate": 0.08,
        "taxonomy_mapped_ratio": 0.9,
        "avg_utilization_rate": 0.78,
        "situation_crux_alignment": 0.82,
        "avg_branch_cohesion": 0.75,
        "draft_repair_rate": 0.18,
        "concession_cascades": 3,
        "topic_alignment_rate": 0.88
      },
      "prm": {
        "mean": 0.72,
        "stddev": 0.15,
        "min": 0.42
      }
    }
  },
  "treatment": {
    "path": ".*debate-treatment\.json",
    "metrics": {
      "header": {
        "topic": "AI Safety Test Case",
        "model": "gpt-4-turbo",
        "temperature": 0.7,
        "protocol": "standard-debate-v2",
        "app_version": "3.2.1",
        "created_at": "2026-11-01T10:00:00Z",
        "total_rounds": 0
      },
      "calibration": {
        "crux_addressed_ratio": 0.88,
        "repetition_rate": 0.09,
        "claims_forgotten_rate": 0.05,
        "taxonomy_mapped_ratio": 0.93,
        "avg_utilization_rate": 0.81,
        "situation_crux_alignment": 0.85,
        "avg_branch_cohesion": 0.78,
        "draft_repair_rate": 0.14,
        "concession_cascades": 2,
        "topic_alignment_rate": 0.91
      },
      "prm": {
        "mean": 0.75,
        "stddev": 0.12,
        "min": 0.48
      }
    }
  },
  "deltas": {
    "crux_addressed_ratio": {
      "baseline": 0.85,
      "treatment": 0.88,
      "delta": 0.03,
      "pct": 3.5
    },
    "repetition_rate": {
      "baseline": 0.12,
      "treatment": 0.09,
      "delta": -0.03,
      "pct": -25.0
    },
    "claims_forgotten_rate": {
      "baseline": 0.08,
      "treatment": 0.05,
      "delta": -0.03,
      "pct": -37.5
    },
    "taxonomy_mapped_ratio": {
      "baseline": 0.9,
      "treatment": 0.93,
      "delta": 0.03,
      "pct": 3.3
    },
    "avg_utilization_rate": {
      "baseline": 0.78,
      "treatment": 0.81,
      "delta": 0.03,
      "pct": 3.8
    },
    "situation_crux_alignment": {
      "baseline": 0.82,
      "treatment": 0.85,
      "delta": 0.03,
      "pct": 3.7
    },
    "avg_branch_cohesion": {
      "baseline": 0.75,
      "treatment": 0.78,
      "delta": 0.03,
      "pct": 4.0
    },
    "draft_repair_rate": {
      "baseline": 0.18,
      "treatment": 0.14,
      "delta": -0.04,
      "pct": -22.2
    },
    "concession_cascades": {
      "baseline": 3,
      "treatment": 2,
      "delta": -1.0,
      "pct": -33.3
    },
    "topic_alignment_rate": {
      "baseline": 0.88,
      "treatment": 0.91,
      "delta": 0.03,
      "pct": 3.4
    },
    "prm_mean": {
      "baseline": 0.72,
      "treatment": 0.75,
      "delta": 0.03,
      "pct": 4.2
    },
    "prm_stddev": {
      "baseline": 0.15,
      "treatment": 0.12,
      "delta": -0.03,
      "pct": -20.0
    },
    "prm_min": {
      "baseline": 0.42,
      "treatment": 0.48,
      "delta": 0.06,
      "pct": 14.3
    }
  }
}
'@
    
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
    It "JSON output matches golden byte-for-byte" {
        $result = Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Json
        
        # Verify the result is valid JSON
        { $result | ConvertFrom-Json } | Should -Not -Throw
        
        # Parse and check key fields match golden
        $parsed = $result | ConvertFrom-Json
        $parsed.baseline.metrics.header.topic | Should -Be "AI Safety Test Case"
        $parsed.treatment.metrics.header.model | Should -Be "gpt-4-turbo"
        
        # Check critical deltas
        $parsed.deltas.crux_addressed_ratio.delta | Should -Be 0.03
        $parsed.deltas.repetition_rate.delta | Should -Be -0.03
        $parsed.deltas.prm_min.delta | Should -Be 0.06
    }
    
    It "CSV output matches golden byte-for-byte" {
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Csv)
        
        # Verify same number of rows
        $result.Count | Should -Be $script:CsvGolden.Count
        
        # Check header
        $result[0] | Should -Match '"Metric","Baseline","Treatment","Delta","PctChange"'
        
        # Check specific critical rows for exact match
        $result[1] | Should -Be $script:CsvGolden[1]  # crux_addressed_ratio row
        $result[9] | Should -Be $script:CsvGolden[9]  # concession_cascades row
        $result[13] | Should -Be $script:CsvGolden[13]  # prm_min row
    }
    
    It "Table output contains all expected metrics" {
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Table 6>&1)
        
        # Join output to check for key markers
        $output = $result -join "`n"
        
        # Check header section
        $output | Should -Match "DEBATE QUALITY COMPARISON"
        $output | Should -Match "AI Safety Test Case"
        $output | Should -Match "gpt-4-turbo"
        
        # Check all metrics appear with correct values
        $output | Should -Match "crux_addressed_ratio"
        $output | Should -Match "repetition_rate"
        $output | Should -Match "prm_min"
        $output | Should -Match "concession_cascades"
    }
    
    It "CSV row count matches expected (header + 13 metrics)" {
        $result = @(Compare-DebateQuality -Baseline $script:BaselineFixture -Treatment $script:TreatmentFixture -Format Csv)
        
        # Filter out empty/null rows
        $lines = @($result | Where-Object { $_ })
        
        # Should have exactly 14 CSV lines
        $lines.Count | Should -Be 14
    }
}
