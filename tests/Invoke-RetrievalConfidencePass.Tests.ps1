# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '../scripts/AITriad/AITriad.psm1') -Force
}

Describe 'Invoke-RetrievalConfidencePass' -Tag 'retrieval', 'confidence' {

    # All BeforeEach/It blocks use InModuleScope so they can access private functions
    # and set $script:* module variables. Vectors are defined inline inside each
    # InModuleScope scriptblock — outer-scope variables do not cross that boundary.
    #
    # Vector layout (384-dim, all-MiniLM-L6-v2 dim):
    #   VecA: unit vector at dim 0  (assigned to acc-bel-001)
    #   VecB: unit vector at dim 1  (assigned to saf-bel-001, orthogonal to VecA)
    # cosine(VecA, VecA) = 1.0, cosine(VecA, VecB) = 0.0
    #
    # t/4478: -KeyPoints (bare key_point array) became -KeyPointItems (@{KeyPoint;POV}), since POV
    # scopes the candidate pool. None of these fixture key_points set `category`, so they all take
    # the WARN-fallback-to-POV-only path -- this file is pinning the pre-t/4478 POV-only behavior
    # under the new signature; Invoke-RetrievalConfidencePass.BdiScoping.Tests.ps1 covers the BDI path.

    BeforeEach {
        InModuleScope AITriad {
            $VecA = [double[]]::new(384); $VecA[0] = 1.0
            $VecB = [double[]]::new(384); $VecB[1] = 1.0
            $script:CachedEmbeddings = @{
                'acc-bel-001' = $VecA
                'saf-bel-001' = $VecB
            }
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{
                    nodes = @(
                        [PSCustomObject]@{ id = 'acc-bel-001'; label = 'Accelerationist Belief 1'; category = 'Beliefs' }
                    )
                }
                saf = [PSCustomObject]@{
                    nodes = @(
                        [PSCustomObject]@{ id = 'saf-bel-001'; label = 'Safetyist Belief 1'; category = 'Beliefs' }
                    )
                }
            }
            $script:RetrievalConfidenceThreshold = 0.45
        }
    }

    Context 'happy path — confidence fields written' {
        It 'writes retrieval_confidence, taxonomy_node_candidates, retrieval_low_confidence' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'some text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $kp.PSObject.Properties.Name | Should -Contain 'retrieval_confidence'
                $kp.PSObject.Properties.Name | Should -Contain 'taxonomy_node_candidates'
                $kp.PSObject.Properties.Name | Should -Contain 'retrieval_low_confidence'
            }
        }

        It 'confidence equals cosine similarity of attribution_text vector vs assigned node' {
            InModuleScope AITriad {
                # Query exactly matches acc-bel-001 vector → similarity = 1.0
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'aligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $kp.retrieval_confidence | Should -Be 1.0
            }
        }

        It 'retrieval_low_confidence is false when confidence is at or above threshold' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[0] = 1.0  # aligned with acc-bel-001 → confidence 1.0 ≥ 0.45
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'aligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $kp.retrieval_low_confidence | Should -Be $false
            }
        }

        It 'retrieval_low_confidence is true when confidence is below threshold' {
            InModuleScope AITriad {
                # Query aligned with acc-bel-001 (dim 0); assigned node saf-bel-001 (dim 1) → cosine 0.0 < 0.45
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'saf-bel-001'; attribution_text = 'misaligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'safetyist' }) -Threshold 0.45

                $kp.retrieval_low_confidence | Should -Be $true
                $kp.retrieval_confidence     | Should -Be 0.0
            }
        }
    }

    Context 'taxonomy_node_candidates — top-3 and assigned node inclusion' {
        It 'top-3 candidates are sorted descending by score' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'aligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $candidates = @($kp.taxonomy_node_candidates)
                $candidates.Count | Should -BeLessOrEqual 3
                $candidates[0].score | Should -BeGreaterOrEqual $candidates[-1].score
            }
        }

        It 'includes the assigned node in candidates when it ranks in the top-3' {
            InModuleScope AITriad {
                # acc-bel-001 scores 1.0 → top of ranking → must appear in top-3
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'aligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $candidateIds = @($kp.taxonomy_node_candidates | ForEach-Object { $_.id })
                $candidateIds | Should -Contain 'acc-bel-001'
            }
        }

        It 'candidate labels come from TaxonomyData' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'aligned text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45

                $top = $kp.taxonomy_node_candidates | Where-Object { $_.id -eq 'acc-bel-001' }
                $top.label | Should -Be 'Accelerationist Belief 1'
            }
        }

        It 'emits empty string label for node not found in TaxonomyData (rare fallback)' {
            InModuleScope AITriad {
                # Add cached embedding for a node not in TaxonomyData, with no recognized POV prefix
                # -- POV is unrecognized ('none') so Get-BdiScopedNodeIds applies no POV filter either,
                # matching pre-t/4478 behavior for a node id outside the acc-/saf-/skp- convention.
                $GhostVec = [double[]]::new(384); $GhostVec[2] = 1.0
                $script:CachedEmbeddings['ghost-001'] = $GhostVec

                $QVec = [double[]]::new(384); $QVec[2] = 1.0  # aligns with ghost-001 → score 1.0
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = $QVec } }

                $kp = [PSCustomObject]@{ taxonomy_node_id = 'ghost-001'; attribution_text = 'ghostly text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'none' }) -Threshold 0.45

                $top = @($kp.taxonomy_node_candidates)[0]
                $top.id    | Should -Be 'ghost-001'
                $top.label | Should -Be ''
            }
        }
    }

    Context 'graceful degradation' {
        It 'skips all key_points when CachedEmbeddings is empty' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = @{}
                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'some text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45
                $kp.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
            }
        }

        It 'skips all key_points when CachedEmbeddings is null' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = $null
                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'some text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45
                $kp.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
            }
        }

        It 'skips all key_points when batch-encode subprocess fails' {
            InModuleScope AITriad {
                Mock Invoke-BatchEmbedAttribution { return $null }
                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'some text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45
                $kp.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
            }
        }

        It 'skips key_points with null taxonomy_node_id' {
            InModuleScope AITriad {
                Mock Invoke-BatchEmbedAttribution { @{} }
                $kp = [PSCustomObject]@{ taxonomy_node_id = $null; attribution_text = 'some text'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45
                $kp.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
            }
        }

        It 'skips key_points missing the attribution_text property' {
            InModuleScope AITriad {
                Mock Invoke-BatchEmbedAttribution { @{} }
                $kp = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; point = 'claim' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -Threshold 0.45
                $kp.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
            }
        }

        It 'processes key_points with a vector independently of those without one' {
            InModuleScope AITriad {
                $QVec = [double[]]::new(384); $QVec[0] = 1.0
                # Batch-encode returns only kp_1 (simulating kp_0 missing from response)
                Mock Invoke-BatchEmbedAttribution { @{ 'kp_1' = $QVec } }

                $kp0 = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'text 0'; point = 'claim 0' }
                $kp1 = [PSCustomObject]@{ taxonomy_node_id = 'acc-bel-001'; attribution_text = 'text 1'; point = 'claim 1' }
                Invoke-RetrievalConfidencePass -KeyPointItems @(
                    @{ KeyPoint = $kp0; POV = 'accelerationist' },
                    @{ KeyPoint = $kp1; POV = 'accelerationist' }
                ) -Threshold 0.45

                # kp0 has no vector returned → no confidence fields
                $kp0.PSObject.Properties.Name | Should -Not -Contain 'retrieval_confidence'
                # kp1 has a vector → fields written
                $kp1.PSObject.Properties.Name | Should -Contain 'retrieval_confidence'
            }
        }
    }
}
