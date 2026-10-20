# Tag: taxonomy (t/4180)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-TaxEditorLoadTest's prod guard (t/4180).
.DESCRIPTION
    The guard is the one behavior this cmdlet must get right under every circumstance —
    it throws before touching az or node, so it's testable with no mocking and no
    network. The ramp itself (az monitor metrics, the node driver, scale restore) is
    integration behavior exercised by actually running against staging, per
    operations/devops/load-test/README.md — not unit-tested here.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-TaxEditorLoadTest (t/4180)' -Tag 'taxonomy' {

    It 'Refuses a URL that does not contain "staging"' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://taxonomy-editor.example.io' } |
            Should -Throw -ErrorId '*'
    }

    It 'Refuses the bare prod URL' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io' } |
            Should -Throw
    }

    It 'The guard is case-insensitive, so a different-cased prod host is still refused' {
        { Invoke-TaxEditorLoadTest -BaseUrl 'https://Taxonomy-Editor.EXAMPLE.io' } | Should -Throw
    }
}

Describe 'Get-AzMetricPeak (t/4282)' -Tag 'taxonomy' {

    It 'Returns the max of the points that carry the field, skipping points without it, under StrictMode' {
        # The 10-19 run (t/4263#4): Azure omits the aggregation field for an empty minute, and
        # reading it under StrictMode threw "The property 'average' cannot be found".
        $json = '{"value":[{"timeseries":[{"data":[{"timeStamp":"t0"},{"timeStamp":"t1","maximum":1170000000},{"timeStamp":"t2","maximum":980000000}]}]}]}'
        InModuleScope AITriad -Parameters @{ Json = $json } {
            param($Json)
            Set-StrictMode -Version Latest
            Get-AzMetricPeak -MetricResponse ($Json | ConvertFrom-Json) -Aggregation maximum | Should -Be 1170000000
        }
    }

    It 'Returns $null when no point carries the requested aggregation (ingestion lag; the caller retries)' {
        InModuleScope AITriad {
            Get-AzMetricPeak -MetricResponse ('{"value":[{"timeseries":[{"data":[{"timeStamp":"t0","average":5}]}]}]}' | ConvertFrom-Json) -Aggregation maximum | Should -BeNullOrEmpty
            Get-AzMetricPeak -MetricResponse ('{"value":[{"timeseries":[]}]}' | ConvertFrom-Json) | Should -BeNullOrEmpty
            Get-AzMetricPeak -MetricResponse ('{"value":[]}' | ConvertFrom-Json) | Should -BeNullOrEmpty
        }
    }

    It 'Returns $null for a non-metrics body instead of throwing' {
        InModuleScope AITriad {
            Get-AzMetricPeak -MetricResponse 'ERROR: not json' | Should -BeNullOrEmpty
            Get-AzMetricPeak -MetricResponse $null | Should -BeNullOrEmpty
        }
    }
}
