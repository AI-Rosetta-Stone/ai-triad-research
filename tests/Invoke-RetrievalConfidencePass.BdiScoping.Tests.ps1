# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4478: POV+BDI-scoped candidate retrieval for Invoke-RetrievalConfidencePass and
    Invoke-Mechanism5RetrievalPass.
.DESCRIPTION
    Per the t/4469 spike: scoping the candidate pool to a key_point's POV + BDI category
    (instead of POV alone) raises Hit@5 of the assigned node 5-11 points, at the cost of
    0.7% of assigned nodes becoming unreachable in the pool -- retrieval_confidence (the
    assigned node's own score) is unaffected by the pool, since it's always measured
    directly against the assigned node (never from the scoped candidate list).

    Covers: the BDI-filter path, the WARN-fallback-to-POV-only path (missing/invalid
    category), and the CL-flagged case (t/4478#2/#3, e/386#2) of a VALID category that
    doesn't match the assigned node's actual BDI -- a real mismatch, which must take the
    BDI-filter path (and therefore can legitimately exclude the assigned node from the
    pool), not the WARN fallback.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '../scripts/AITriad/AITriad.psm1') -Force
}

Describe 'Invoke-RetrievalConfidencePass -- POV+BDI scoping (t/4478)' -Tag 'retrieval', 'confidence' {

    BeforeEach {
        InModuleScope AITriad {
            # Three nodes, same POV (accelerationist), different BDI categories, mutually
            # orthogonal vectors so pool membership is the only thing that can change the
            # top candidate.
            $VecBeliefs   = [double[]]::new(384); $VecBeliefs[0] = 1.0
            $VecDesires   = [double[]]::new(384); $VecDesires[1] = 1.0
            $VecIntention = [double[]]::new(384); $VecIntention[2] = 1.0
            $script:CachedEmbeddings = @{
                'acc-beliefs-001'    = $VecBeliefs
                'acc-desires-001'    = $VecDesires
                'acc-intentions-001' = $VecIntention
            }
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-001';    label = 'B'; category = 'Beliefs' }
                    [PSCustomObject]@{ id = 'acc-desires-001';    label = 'D'; category = 'Desires' }
                    [PSCustomObject]@{ id = 'acc-intentions-001'; label = 'I'; category = 'Intentions' }
                ) }
            }
            $script:RetrievalConfidenceThreshold = 0.45
        }
    }

    Context 'BDI-filter path: valid category narrows the pool' {
        It 'excludes a same-POV, different-category node from taxonomy_node_candidates' {
            InModuleScope AITriad {
                # Query aligned with Desires AND Intentions equally is impossible with orthogonal
                # vectors, so query exactly matches the Desires vector -- Intentions (dim 2) scores 0.
                $QVec = [double[]]::new(384); $QVec[1] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-desires-001'; category = 'Desires'; attribution_text = 'x' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $ids = @($kp.taxonomy_node_candidates | ForEach-Object { $_.id })
                $ids | Should -Contain 'acc-desires-001'
                $ids | Should -Not -Contain 'acc-beliefs-001' -Because 'different BDI category, excluded by the scoped pool'
                $ids | Should -Not -Contain 'acc-intentions-001' -Because 'different BDI category, excluded by the scoped pool'
            }
        }

        It 'retrieval_confidence (the assigned node''s own score) is unaffected by the scoped pool' {
            InModuleScope AITriad {
                # Query orthogonal to the assigned node (Beliefs) -- confidence must read the
                # assigned node's real (low) score, not get inflated or dropped by pool scoping.
                $QVec = [double[]]::new(384); $QVec[1] = 1.0  # aligned with Desires, not Beliefs
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-beliefs-001'; category = 'Beliefs'; attribution_text = 'x' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $kp.retrieval_confidence | Should -Be 0.0
            }
        }
    }

    Context 'WARN-fallback path: missing or invalid category' {
        It 'falls back to POV-only (no category) with no WARN, and the pool includes other-category nodes' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[1] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-desires-001'; attribution_text = 'x' }  # no category field
                $warnings = $null
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45 -WarningVariable warnings -WarningAction SilentlyContinue

                $ids = @($kp.taxonomy_node_candidates | ForEach-Object { $_.id })
                $ids | Should -Contain 'acc-desires-001'
                $ids | Should -Contain 'acc-intentions-001' -Because 'POV-only pool keeps other-category, same-POV nodes'
                @($warnings).Count | Should -Be 0 -Because 'a missing category is the expected default, not a WARN-worthy anomaly'
            }
        }

        It 'falls back to POV-only WITH a WARN when category is present but not a valid B/D/I value' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[1] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-desires-001'; category = 'Situations'; attribution_text = 'x' }
                $warnings = $null
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45 -WarningVariable warnings -WarningAction SilentlyContinue

                $ids = @($kp.taxonomy_node_candidates | ForEach-Object { $_.id })
                $ids | Should -Contain 'acc-intentions-001' -Because 'POV-only fallback keeps other-category nodes'
                @($warnings).Count | Should -BeGreaterThan 0
                "$($warnings[0])" | Should -Match "not a valid BDI value"
            }
        }
    }

    Context 'CL-flagged case (t/4478#2/#3): a VALID category that mismatches the assigned node''s real BDI' {
        It 'takes the BDI-filter path (not the WARN fallback) and can exclude the assigned node from the pool' {
            InModuleScope AITriad {
                # acc-beliefs-001's real category is 'Beliefs', but this key_point is mislabeled
                # 'Desires' -- a real mismatch (CL: 4/663, 0.6%), distinct from an invalid value.
                $QVec = [double[]]::new(384); $QVec[0] = 1.0  # aligned with the assigned (Beliefs) node
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-beliefs-001'; category = 'Desires'; attribution_text = 'x' }
                $warnings = $null
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45 -WarningVariable warnings -WarningAction SilentlyContinue

                @($warnings).Count | Should -Be 0 -Because '''Desires'' is a valid BDI value -- this is the filter path, not the fallback'
                $ids = @($kp.taxonomy_node_candidates | ForEach-Object { $_.id })
                $ids | Should -Not -Contain 'acc-beliefs-001' -Because 'the mislabeled category filters the pool to Desires nodes only, excluding the (Beliefs) assigned node'
                $ids | Should -Contain 'acc-desires-001'
                # retrieval_confidence still reads the assigned node's real, high score -- the
                # key_point is never penalized for its own mislabeled category.
                $kp.retrieval_confidence | Should -Be 1.0
            }
        }
    }
}

Describe 'Invoke-Mechanism5RetrievalPass -- POV+BDI scoping (t/4478)' -Tag 'retrieval', 'mechanism5' {

    BeforeEach {
        InModuleScope AITriad {
            $VecBeliefs = [double[]]::new(384); $VecBeliefs[0] = 1.0
            $VecDesires = [double[]]::new(384); $VecDesires[1] = 1.0
            $script:CachedEmbeddings = @{
                'acc-beliefs-001' = $VecBeliefs
                'acc-desires-001' = $VecDesires
            }
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-001'; label = 'B'; category = 'Beliefs' }
                    [PSCustomObject]@{ id = 'acc-desires-001'; label = 'D'; category = 'Desires' }
                ) }
            }
        }
    }

    It 'mechanism5_candidates excludes a same-POV, different-category node when the flagged key_point has a valid category' {
        InModuleScope AITriad {
            $QVec = [double[]]::new(384); $QVec[1] = 1.0
            Mock Invoke-BatchEmbedAttribution { @{ 'm5_0' = $QVec } }

            $kp = [PSCustomObject]@{
                taxonomy_node_id        = 'acc-beliefs-001'
                category                 = 'Beliefs'
                attribution_text         = 'surfacing query text'
                retrieval_confidence     = 0.0
                taxonomy_node_candidates = @([PSCustomObject]@{ id = 'acc-desires-001'; label = 'D'; score = 1.0 })
            }
            Invoke-Mechanism5RetrievalPass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.mechanism5_flag | Should -BeTrue
            $ids = @($kp.mechanism5_candidates | ForEach-Object { $_.id })
            $ids | Should -Not -Contain 'acc-desires-001' -Because 'Beliefs-scoped pool excludes the Desires node'
        }
    }
}
