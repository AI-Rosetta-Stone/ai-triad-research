# Tag: summarization (t/4482)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Tests for t/4482: the additive "anchors" field on document key_points survives Finalize-Summary
    whether the model returned it or not — it must not be stripped, and its absence must not raise a
    field-missing warning (it is optional, unlike stance/taxonomy_node_id/point).
#>

#Requires -Module Pester

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Finalize-Summary: the key_point "anchors" field (t/4482)' -Tag 'summarization' {

    It 'a key_point WITH anchors keeps the field, unmodified' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            $summaryJson = '{"pov_summaries":{"accelerationist":{"key_points":[' +
                '{"stance":"aligned","taxonomy_node_id":"acc-beliefs-001","point":"p","canonical_proposition":"X","anchors":["EU AI Act Article 62"]}' +
                ']},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}'
            $summary = $summaryJson | ConvertFrom-Json

            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-anchors-present' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) 3>$null

            $r.Success | Should -BeTrue
            $kp = $summary.pov_summaries.accelerationist.key_points[0]
            @($kp.anchors) | Should -Be @('EU AI Act Article 62')
        }
    }

    It 'a key_point with NO anchors is accepted without a field-missing warning (optional, unlike stance/node/point)' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            $summaryJson = '{"pov_summaries":{"accelerationist":{"key_points":[' +
                '{"stance":"aligned","taxonomy_node_id":"acc-beliefs-001","point":"p","canonical_proposition":"X"}' +
                ']},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}'
            $summary = $summaryJson | ConvertFrom-Json

            $wf = Join-Path $TestDrive "warn-anchors-$(Get-Random).txt"
            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-anchors-absent' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) 3> $wf
            $warnText = [string](Get-Content -Raw -LiteralPath $wf -ErrorAction SilentlyContinue)

            $r.Success | Should -BeTrue
            $warnText | Should -Not -Match 'anchors'
        }
    }
}
