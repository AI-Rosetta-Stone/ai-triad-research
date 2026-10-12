# Tag: summarization (t/3915)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for t/3915: unmapped_concepts[].suggested_label must never
    be a node-ID-shaped string -- it's a free-text field the editor offers
    verbatim as a new node's name.
.DESCRIPTION
    Two writers could produce an ID-shaped label:
    1. The hallucinated-node-id reroute (Finalize-Summary, Gap 3.1): a
       key_point's taxonomy_node_id that doesn't exist in the live taxonomy is
       nulled and the concept moved into unmapped_concepts -- the fix is that
       the new entry's suggested_label must be derived from the point text, not
       be the dead ID itself (confirmed root cause for all 17 real-data
       offenders, t/3915).
    2. A direct model-emitted unmapped_concepts entry whose own suggested_label
       happens to be node-ID-shaped (defensive general catch, same fix site).
    A normal free-text label must pass through unchanged in both paths.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Finalize-Summary: suggested_label must never be node-ID-shaped (t/3915)' -Tag 'summarization' {

    It 'derives a free-text suggested_label from the point text when rerouting a hallucinated node ID, preserving the ID in reason' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            # Polarity gate disabled via -EnablePolarityGate $false below (an explicit
            # parameter since t/4136) -- the directional-stance re-judging is unrelated
            # to this fix and out of scope here, same as the sibling t/3434 test's
            # documented boundary.
            # 2+ entries -- a function `return`ing a 1-element IEnumerable auto-
            # unwraps to the bare scalar element (PowerShell pipeline semantics),
            # which would make this mock hand back the string "saf-beliefs-014"
            # instead of the HashSet. Harmless second entry avoids that collapse.
            $LiveIds = [System.Collections.Generic.HashSet[string]]::new()
            $null = $LiveIds.Add('saf-beliefs-014')
            $null = $LiveIds.Add('acc-beliefs-001')
            Mock Get-TaxonomyNodeIdSet { $LiveIds }
            Mock Write-Utf8NoBom { }

            $summary = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[{"stance":"aligned","taxonomy_node_id":"saf-intentions-000","category":"Intentions","point":"The document advocates for global coordination to enable a credible slowdown in frontier AI development if necessary.","verbatim":null,"excerpt_context":"test","extraction_confidence":0.8,"vocabulary_terms":[]}]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}' | ConvertFrom-Json

            $wf = Join-Path $TestDrive "warn-halluc-$(Get-Random).txt"
            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-hallucinated-id' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) -EnablePolarityGate $false 3> $wf
            $warnText = [string](Get-Content -Raw -LiteralPath $wf -ErrorAction SilentlyContinue)

            $r.Success | Should -BeTrue
            $summary.pov_summaries.safetyist.key_points[0].taxonomy_node_id | Should -BeNullOrEmpty -Because 'the dead ID is nulled on the key_point'
            @($summary.unmapped_concepts).Count | Should -Be 1
            $Moved = $summary.unmapped_concepts[0]
            $Moved.suggested_label | Should -Not -Be 'saf-intentions-000' -Because 'the dead node ID must never land in the free-text label field'
            $Moved.suggested_label | Should -Match '^The document advocates' -Because 'the label is derived from the point text'
            $Moved.reason | Should -Match "saf-intentions-000" -Because 'the dead ID stays traceable in reason'
        }
    }

    It 'replaces an already node-ID-shaped suggested_label (direct model output) with a text fallback derived from concept' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            $summary = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[{"suggested_label":"skp-intentions-003","concept":"A fresh concept never seen before in the taxonomy at all.","suggested_pov":"skeptic","suggested_category":"Intentions","reason":"novel concept"}]}' | ConvertFrom-Json

            $wf = Join-Path $TestDrive "warn-idshape-$(Get-Random).txt"
            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-idshaped-label' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) 3> $wf
            $warnText = [string](Get-Content -Raw -LiteralPath $wf -ErrorAction SilentlyContinue)

            $r.Success | Should -BeTrue
            $summary.unmapped_concepts[0].suggested_label | Should -Not -Be 'skp-intentions-003'
            $summary.unmapped_concepts[0].suggested_label | Should -Match '^A fresh concept'
            $warnText | Should -Match "node-ID-shaped"
        }
    }

    It 'leaves a normal free-text suggested_label unchanged' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            $summary = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[{"suggested_label":"Companies End Up Controlling Their Regulators","concept":"Regulatory capture concern.","suggested_pov":"skeptic","suggested_category":"Beliefs","reason":"novel concept"}]}' | ConvertFrom-Json

            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-normal-label' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) -WarningAction SilentlyContinue

            $r.Success | Should -BeTrue
            $summary.unmapped_concepts[0].suggested_label | Should -Be 'Companies End Up Controlling Their Regulators'
        }
    }
}
