# Tag: ingestion (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Merge-ChunkSummaries resilience to malformed chunk summaries.
.DESCRIPTION
    Regression coverage for the StrictMode crash where a truncated /
    repair-salvaged chunk whose pov_summaries camp lacked a 'key_points'
    property (or whose claims lacked 'claim_label'/'claim') aborted the entire
    document merge with "The property 'key_points' cannot be found on this
    object." A single malformed chunk must degrade gracefully, not throw.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Merge-ChunkSummaries malformed-chunk resilience' -Tag 'ingestion' {

    It 'Does not throw when a chunk camp is missing key_points and still merges valid chunks' {
        InModuleScope AITriad {
            $Good = '{"pov_summaries":{"accelerationist":{"key_points":[{"point":"Automation raises productivity","taxonomy_node_id":"acc-beliefs-001"}]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[{"claim_label":"gdp-up","claim":"GDP rose"}],"unmapped_concepts":[{"suggested_label":"new-idea"}]}' | ConvertFrom-Json

            # Truncation-salvaged shapes: camp without key_points, claim with no
            # label/text, concept with no label, and a chunk with no
            # pov_summaries at all.
            $BadCamp   = '{"pov_summaries":{"safetyist":{}},"factual_claims":[{}],"unmapped_concepts":[{}]}' | ConvertFrom-Json
            $BadEmpty  = '{}' | ConvertFrom-Json

            { Merge-ChunkSummaries -ChunkResults @($Good, $BadCamp, $BadEmpty) } |
                Should -Not -Throw

            $Merged = Merge-ChunkSummaries -ChunkResults @($Good, $BadCamp, $BadEmpty)

            @($Merged['pov_summaries']['accelerationist']['key_points']).Count |
                Should -Be 1 -Because 'the one valid key_point must survive the merge'
            @($Merged['factual_claims']).Count |
                Should -BeGreaterThan 0 -Because 'the valid factual claim must survive'
        }
    }

    It 'drops a bare null unmapped_concepts entry from a chunk and still merges the valid concept (t/3907)' {
        InModuleScope AITriad {
            # Real-incident shape (when-ai-builds-itself-2026): a chunk's
            # unmapped_concepts array contains a bare null alongside real
            # entries, so it never collapses to a scalar null and the null
            # must be filtered here, not carried into the written file.
            $ChunkWithNull = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[null,{"suggested_label":"real-concept","concept":"A genuinely new concept."}]}' | ConvertFrom-Json

            { Merge-ChunkSummaries -ChunkResults @($ChunkWithNull) -WarningAction SilentlyContinue } |
                Should -Not -Throw

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkWithNull) -WarningAction SilentlyContinue

            @($Merged['unmapped_concepts']).Count |
                Should -Be 1 -Because 'the null entry must be dropped, the real concept kept'
            @($Merged['unmapped_concepts'] | Where-Object { $null -eq $_ }).Count |
                Should -Be 0 -Because 'no null element may survive into the merged/written structure'
        }
    }
}

Describe 'Merge-ChunkSummaries empty_cells merge (t/4473/t/4519/t/4601)' -Tag 'ingestion' {

    It 'carries a cell into merged empty_cells when every chunk declared it empty' {
        InModuleScope AITriad {
            $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk A reason"}]}' | ConvertFrom-Json
            $ChunkB = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk B reason"}]}' | ConvertFrom-Json

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB)

            $Cell = @($Merged['empty_cells']) | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }
            @($Cell).Count | Should -Be 1 -Because 'every chunk declared this cell empty and no chunk has a key_point in it'
            $Cell.reason | Should -Be 'chunk A reason' -Because 'the first chunk to declare it wins the reason'
        }
    }

    It 'STILL carries a cell into merged empty_cells when only SOME chunks declared it empty, the rest silent (t/4601)' {
        InModuleScope AITriad {
            $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk A reason"}]}' | ConvertFrom-Json
            # Chunk B says nothing about the cell (neither a key_point nor an empty_cells entry) --
            # silent, not an explicit claim the camp is non-empty.
            $ChunkB = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}' | ConvertFrom-Json

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningVariable warnings -WarningAction SilentlyContinue

            $Cell = @($Merged['empty_cells']) | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }
            @($Cell).Count | Should -Be 1 -Because 'chunk A declared it empty; a silent chunk B is not evidence the camp is non-empty (t/4601)'
            $Cell.reason | Should -Be 'chunk A reason'
            $disagreeWarn = @($warnings | Where-Object { "$_" -match 't/4601' })
            $disagreeWarn.Count | Should -Be 1 -Because 'chunks disagreeing on emptiness still fires a visibility WARN'
        }
    }

    It 'does NOT carry a cell into merged empty_cells when the merged key_points have a point in that category' {
        InModuleScope AITriad {
            $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[{"point":"a skeptic point","category":"Intentions"}]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"stale"}]}' | ConvertFrom-Json

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA)

            @($Merged['empty_cells'] | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }).Count |
                Should -Be 0 -Because 'the merged key_points have a point in that cell, so it is not empty regardless of the stale declaration'
        }
    }
}
