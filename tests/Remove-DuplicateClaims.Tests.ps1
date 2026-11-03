# Tag: ingestion (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Remove-DuplicateClaims' -Tag 'ingestion' {

    It 'Returns unchanged summary when fewer than 2 items' {
        InModuleScope AITriad {
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{
                        key_points = @(
                            [PSCustomObject]@{ point = 'AI should be open-sourced'; taxonomy_node_id = 'acc-desires-001'; extraction_confidence = 0.9 }
                        )
                    }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @()
            }

            Mock Get-TextEmbedding { return $null }

            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.points_removed | Should -Be 0
            $Result.Metrics.points_before | Should -Be 1
            $Result.Metrics.points_after | Should -Be 1
        }
    }

    It 'Removes string-prefix duplicates when embeddings unavailable' {
        InModuleScope AITriad {
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{
                        key_points = @(
                            [PSCustomObject]@{ point = 'Open-source AI democratizes access to cognitive tools and reduces monopolistic control over AI systems'; taxonomy_node_id = 'acc-desires-001'; extraction_confidence = 0.9 }
                            [PSCustomObject]@{ point = 'Open-source AI democratizes access to cognitive tools and reduces monopolistic control over AI systems'; taxonomy_node_id = 'acc-desires-001'; extraction_confidence = 0.8 }
                        )
                    }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @()
            }

            Mock Get-TextEmbedding { return $null }

            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.points_removed | Should -Be 1
            $Result.Metrics.points_after | Should -Be 1
            $Result.Metrics.used_embeddings | Should -BeFalse
        }
    }

    It 'Does not crash under StrictMode when an untagged camp is omitted entirely (t/4553)' {
        InModuleScope AITriad {
            Set-StrictMode -Version Latest
            # #3867/t/4519 license the model to omit an untagged camp's key from pov_summaries
            # outright, not just return it empty. accelerationist is absent here, not @().
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    safetyist = [PSCustomObject]@{
                        key_points = @(
                            [PSCustomObject]@{ point = 'p1'; taxonomy_node_id = 'saf-beliefs-001'; extraction_confidence = 0.9 }
                        )
                    }
                    skeptic = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @()
            }

            Mock Get-TextEmbedding { return $null }

            { Remove-DuplicateClaims -SummaryObject $Summary } | Should -Not -Throw
            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.points_before | Should -Be 1
        }
    }

    It 'Removes embedding-based duplicates and keeps higher-confidence version' {
        InModuleScope AITriad {
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{
                        key_points = @(
                            [PSCustomObject]@{ point = 'AI should be open sourced for security'; taxonomy_node_id = 'acc-desires-001'; extraction_confidence = 0.7 }
                            [PSCustomObject]@{ point = 'Open sourcing AI is a security imperative'; taxonomy_node_id = 'acc-desires-001'; extraction_confidence = 0.95 }
                        )
                    }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @()
            }

            # Return near-identical embeddings for the two semantically similar claims
            $Vec1 = [double[]](@(0.5) * 384)
            $Vec2 = [double[]](@(0.5) * 383 + @(0.51))  # cosine > 0.99
            Mock Get-TextEmbedding {
                return @{
                    'kp-accelerationist-0' = $Vec1
                    'kp-accelerationist-1' = $Vec2
                }
            }

            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.points_removed | Should -Be 1
            $Result.Metrics.points_after | Should -Be 1
            $Result.Metrics.used_embeddings | Should -BeTrue
            # Should keep the higher-confidence version (0.95)
            $Result.Summary.pov_summaries.accelerationist.key_points[0].extraction_confidence | Should -Be 0.95
        }
    }

    It 'Deduplicates factual_claims by embedding similarity' {
        InModuleScope AITriad {
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @() }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @(
                    [PSCustomObject]@{ claim = 'GPT-4 scored 90th percentile on the bar exam'; claim_label = 'bar-exam-score'; extraction_confidence = 0.9 }
                    [PSCustomObject]@{ claim = 'GPT-4 achieved 90th percentile performance on the bar examination'; claim_label = 'bar-exam-performance'; extraction_confidence = 0.85 }
                    [PSCustomObject]@{ claim = 'AI systems consume significant energy resources'; claim_label = 'energy-use'; extraction_confidence = 0.8 }
                )
            }

            $VecBar1 = [double[]](@(0.7) * 384)
            $VecBar2 = [double[]](@(0.7) * 383 + @(0.71))   # near-identical to VecBar1
            # Orthogonal vector — genuinely different direction, not just different magnitude
            $VecEnergy = [double[]](@(1.0) + @(0.0) * 383)
            Mock Get-TextEmbedding {
                return @{
                    'fc-0' = $VecBar1
                    'fc-1' = $VecBar2
                    'fc-2' = $VecEnergy
                }
            }

            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.claims_removed | Should -Be 1
            $Result.Metrics.claims_after | Should -Be 2
        }
    }

    It 'Keeps distinct claims that happen to share taxonomy node' {
        InModuleScope AITriad {
            $Summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    safetyist = [PSCustomObject]@{
                        key_points = @(
                            [PSCustomObject]@{ point = 'AI alignment requires interpretability research'; taxonomy_node_id = 'saf-beliefs-001'; extraction_confidence = 0.9 }
                            [PSCustomObject]@{ point = 'Current neural networks are opaque black boxes'; taxonomy_node_id = 'saf-beliefs-001'; extraction_confidence = 0.85 }
                        )
                    }
                    accelerationist = [PSCustomObject]@{ key_points = @() }
                    skeptic = [PSCustomObject]@{ key_points = @() }
                }
                factual_claims = @()
            }

            # Orthogonal embeddings — different claims despite same taxonomy node
            $Vec1 = [double[]](@(1.0) + @(0.0) * 383)
            $Vec2 = [double[]](@(0.0) + @(1.0) + @(0.0) * 382)
            Mock Get-TextEmbedding {
                return @{
                    'kp-safetyist-0' = $Vec1
                    'kp-safetyist-1' = $Vec2
                }
            }

            $Result = Remove-DuplicateClaims -SummaryObject $Summary
            $Result.Metrics.points_removed | Should -Be 0
            $Result.Metrics.points_after | Should -Be 2
        }
    }
}
