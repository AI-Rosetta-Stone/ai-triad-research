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

Describe 'Merge-ChunkSummaries semantic clustering + evidence folding (t/4472)' -Tag 'ingestion' {
    # Mock vectors are 2D unit vectors so cosine similarity is exact and
    # deterministic: cos(a, b) where a=(1,0), b=(cosTheta, sinTheta) is
    # cosTheta. Computed inline inside each Mock -MockWith block (not via a
    # helper function -- a function defined in the test script's scope is
    # NOT resolvable from inside InModuleScope's altered command lookup,
    # confirmed empirically here: CommandNotFoundException).

    It 'clusters two same-category key_points above threshold and folds the duplicate into evidence_spans, keeping the primary''s own verbatim/excerpt_context untouched (backward compat)' {
        InModuleScope AITriad {
            $TextA = 'Automation will raise aggregate productivity across the economy.'
            $TextB = 'Automation increases productivity economy-wide.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{
                    $TextA = @(1.0, 0.0)
                    $TextB = @(0.95, [Math]::Sqrt(1 - 0.95 * 0.95))   # above the 0.90 fold threshold
                }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'short point A'; canonical_proposition = $TextA; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001'; verbatim = 'VERBATIM A'; excerpt_context = 'CONTEXT A' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'a much longer point B that restates the same thesis in different words'; canonical_proposition = $TextB; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001'; verbatim = 'VERBATIM B'; excerpt_context = 'CONTEXT B' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
            $Points.Count | Should -Be 1 -Because 'the two near-duplicate points must fold into one, not two'
            $Primary = $Points[0]
            $Primary.point | Should -Match 'longer point B' -Because 'the longer point is the representativeness proxy and becomes primary'
            $Primary.verbatim | Should -Be 'VERBATIM B' -Because 'the primary''s OWN verbatim stays a plain string -- existing consumers (nodeSourceIndex.ts) read it directly'
            $Primary.excerpt_context | Should -Be 'CONTEXT B'
            @($Primary.evidence_spans).Count | Should -Be 1 -Because 'the folded duplicate''s evidence must be retained, not discarded'
            $Folded = @($Primary.evidence_spans)[0]
            $Folded.verbatim | Should -Be 'VERBATIM A' -Because 'the folded entry keeps its OWN verbatim, so a false fold stays visible'
            $Folded.canonical_proposition | Should -Be $TextA
        }
    }

    It 'does NOT cluster two key_points in different categories, even with identical text' {
        InModuleScope AITriad {
            $Text = 'Identical proposition text for both.'
            Mock Invoke-BatchEmbeddings -MockWith { @{ $Text = @(1.0, 0.0) } }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'p'; canonical_proposition = $Text; category = 'Beliefs' },
                        [PSCustomObject]@{ point = 'p'; canonical_proposition = $Text; category = 'Desires' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA) -WarningAction SilentlyContinue

            @($Merged['pov_summaries']['accelerationist']['key_points']).Count |
                Should -Be 2 -Because 'clustering is scoped within one (camp, BDI category) cell -- Beliefs and Desires never merge regardless of text similarity'
        }
    }

    It 'vetoes a fold when both key_points carry non-empty, disjoint anchors (t/4472 anchors veto)' {
        InModuleScope AITriad {
            $TextA = 'Shared thesis text.'
            $TextB = 'Shared thesis restated.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{ $TextA = @(1.0, 0.0); $TextB = @(0.98, [Math]::Sqrt(1 - 0.98 * 0.98)) }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'point A'; canonical_proposition = $TextA; category = 'Beliefs'; anchors = @('EU AI Act Article 6') }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'point B'; canonical_proposition = $TextB; category = 'Beliefs'; anchors = @('NIST AI RMF 1.1') }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            @($Merged['pov_summaries']['accelerationist']['key_points']).Count |
                Should -Be 2 -Because 'disjoint non-empty anchors mean these are treated as genuinely different claims, never folded, regardless of cosine'
        }
    }

    It 'unions anchors onto the primary when a fold DOES happen and anchors overlap or only one side has them' {
        InModuleScope AITriad {
            $TextA = 'Shared thesis text.'
            $TextB = 'Shared thesis restated.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{ $TextA = @(1.0, 0.0); $TextB = @(0.98, [Math]::Sqrt(1 - 0.98 * 0.98)) }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'point A, much shorter'; canonical_proposition = $TextA; category = 'Beliefs'; anchors = @('EU AI Act Article 6') }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'point B, the much longer restatement that becomes primary'; canonical_proposition = $TextB; category = 'Beliefs' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
            $Points.Count | Should -Be 1 -Because 'only one side carrying anchors is not a veto condition -- they fold'
            @($Points[0].anchors) | Should -Be @('EU AI Act Article 6') -Because 'the lone anchor set is unioned onto the primary even though the primary itself had none'
        }
    }

    It 'folds factual_claims on a genuine numeric superset (one side restates the other plus more detail)' {
        InModuleScope AITriad {
            $ClaimA = 'Adoption reached 57% among surveyed firms.'
            $ClaimB = 'Adoption reached 57% among surveyed firms in the 2026 cohort.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{ $ClaimA = @(1.0, 0.0); $ClaimB = @(0.92, [Math]::Sqrt(1 - 0.92 * 0.92)) }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimA; claim_label = 'adoption-rate' })
                unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimB; claim_label = 'adoption-rate-detailed' })
                unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            $Claims = @($Merged['factual_claims'])
            $Claims.Count | Should -Be 1 -Because 'claim B''s numbers are a superset of claim A''s, so they fold'
            $Claims[0].claim | Should -Be $ClaimB -Because 'the numeric-superset side becomes primary'
            @($Claims[0].evidence_spans).Count | Should -Be 1
            @($Claims[0].evidence_spans)[0].claim | Should -Be $ClaimA
        }
    }

    It 'does NOT fold two factual_claims whose numbers differ non-subset, even above the cosine bar (templated-statistic false positive, t/4472)' {
        InModuleScope AITriad {
            $ClaimA = 'Asian adults report usage at 57%.'
            $ClaimB = 'Asian adults report usage at 36%.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{ $ClaimA = @(1.0, 0.0); $ClaimB = @(0.987, [Math]::Sqrt(1 - 0.987 * 0.987)) }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimA })
                unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimB })
                unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            @($Merged['factual_claims']).Count |
                Should -Be 2 -Because '57% and 36% are different, non-subset numbers -- cosine alone (0.987) must never fold them (t/4472 calibration finding)'
        }
    }

    It 'requires >= 0.95 cosine (not 0.90) to fold two factual_claims that carry no numbers at all' {
        InModuleScope AITriad {
            $ClaimA = 'The report emphasizes long-term structural risk.'
            $ClaimB = 'The report stresses long-run structural danger.'
            Mock Invoke-BatchEmbeddings -MockWith {
                @{ $ClaimA = @(1.0, 0.0); $ClaimB = @(0.93, [Math]::Sqrt(1 - 0.93 * 0.93)) }
            }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimA })
                unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{}
                factual_claims = @([PSCustomObject]@{ claim = $ClaimB })
                unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue

            @($Merged['factual_claims']).Count |
                Should -Be 2 -Because '0.93 clears the 0.90 key_point-style bar but not the stricter 0.95 no-number factual_claim bar'
        }
    }

    It 'falls back to first-occurrence dedup with NO evidence_spans when the embedding model is unavailable' {
        InModuleScope AITriad {
            Mock Invoke-BatchEmbeddings -MockWith { @{} }

            $ChunkA = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'Automation raises productivity'; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }
            $ChunkB = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'Automation raises productivity'; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(); unmapped_concepts = @()
            }

            $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningVariable w -WarningAction SilentlyContinue

            $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
            $Points.Count | Should -Be 1 -Because 'exact-prefix match still dedups in fallback mode'
            $Points[0].PSObject.Properties['evidence_spans'] | Should -BeNullOrEmpty -Because 'no clustering happened, so no evidence_spans field is added'
            @($w | Where-Object { "$_" -match 'embedding model unavailable' }).Count | Should -BeGreaterThan 0
        }
    }
}
