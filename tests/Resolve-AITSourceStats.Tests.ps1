# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# Characterization tests for Resolve-AITSourceStats (behavior-preserving refactor pin).
# Race-safe: dot-sources only the Private function files it needs, never Import-Module.

BeforeAll {
    $PrivateDir = Join-Path $PSScriptRoot '..\scripts\AITriad\Private'
    . (Join-Path $PrivateDir 'Get-AITSourcePropValue.ps1')
    . (Join-Path $PrivateDir 'ConvertTo-AITSourceClaimsByPov.ps1')
    . (Join-Path $PrivateDir 'Resolve-AITSourceStats.ps1')

    function New-Obj { param([hashtable]$H) [PSCustomObject]$H }
}

Describe 'Resolve-AITSourceStats' {
    Context 'metadata-cached branch (total_claims present)' {
        It 'reads cached totals, facts, unmapped and claims-by-pov' {
            $meta = [PSCustomObject]@{
                total_claims      = 7
                total_facts       = 3
                unmapped_concepts = 4
                claims_by_pov     = [PSCustomObject]@{ accelerationist = 2; safetyist = 1; skeptic = 1; situations = 0 }
            }
            $r = Resolve-AITSourceStats -Meta $meta -Summary $null
            $r.TotalClaims                 | Should -Be 7
            $r.TotalFacts                  | Should -Be 3
            $r.UnmappedConcepts            | Should -Be 4
            $r.ClaimsByPov.Accelerationist | Should -Be 2
            $r.ClaimsByPov.Safetyist       | Should -Be 1
            $r.ClaimsByPov.Skeptic         | Should -Be 1
            $r.ClaimsByPov.Situations      | Should -Be 0
        }

        It 'defaults total_facts to 0 when absent' {
            $meta = [PSCustomObject]@{ total_claims = 2 }
            (Resolve-AITSourceStats -Meta $meta -Summary $null).TotalFacts | Should -Be 0
        }

        It 'treats non-int unmapped_concepts as 0' {
            $meta = [PSCustomObject]@{ total_claims = 1; unmapped_concepts = 'nope' }
            (Resolve-AITSourceStats -Meta $meta -Summary $null).UnmappedConcepts | Should -Be 0
        }

        It 'metadata branch wins even when Summary is provided' {
            $meta    = [PSCustomObject]@{ total_claims = 5 }
            $summary = [PSCustomObject]@{ factual_claims = @(1,2,3,4,5,6,7,8,9) }
            (Resolve-AITSourceStats -Meta $meta -Summary $summary).TotalClaims | Should -Be 5
        }
    }

    Context 'summary fallback branch (no total_claims)' {
        It 'counts factual_claims and classifies linked nodes by pov prefix' {
            $summary = [PSCustomObject]@{
                factual_claims = @(
                    [PSCustomObject]@{ linked_taxonomy_nodes = @('acc-x-001','saf-y-002') }
                    [PSCustomObject]@{ linked_taxonomy_nodes = @('skp-z-003','sit-w-004','unknown-000') }
                    [PSCustomObject]@{ linked_taxonomy_nodes = @() }
                    [PSCustomObject]@{ other = 1 }
                )
            }
            $r = Resolve-AITSourceStats -Meta ([PSCustomObject]@{}) -Summary $summary
            $r.TotalClaims                 | Should -Be 4
            $r.ClaimsByPov.Accelerationist | Should -Be 1
            $r.ClaimsByPov.Safetyist       | Should -Be 1
            $r.ClaimsByPov.Skeptic         | Should -Be 1
            $r.ClaimsByPov.Situations      | Should -Be 1
        }

        It 'sums key_points across pov_summaries and counts unmapped_concepts' {
            $summary = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @('a','b') }
                    safetyist       = [PSCustomObject]@{ key_points = @('c') }
                    skeptic         = [PSCustomObject]@{ other = 1 }
                }
                unmapped_concepts = @('u1','u2','u3')
            }
            $r = Resolve-AITSourceStats -Meta ([PSCustomObject]@{}) -Summary $summary
            $r.TotalFacts      | Should -Be 3
            $r.UnmappedConcepts | Should -Be 3
            $r.TotalClaims     | Should -Be 0
        }

        It 'yields zeros for a summary lacking all stat keys' {
            $summary = [PSCustomObject]@{ model_info = 'x' }
            $r = Resolve-AITSourceStats -Meta ([PSCustomObject]@{}) -Summary $summary
            $r.TotalClaims                 | Should -Be 0
            $r.TotalFacts                  | Should -Be 0
            $r.UnmappedConcepts            | Should -Be 0
            $r.ClaimsByPov.Accelerationist | Should -Be 0
        }
    }

    Context 'neither branch (no total_claims, null Summary)' {
        It 'returns all zeros' {
            $r = Resolve-AITSourceStats -Meta ([PSCustomObject]@{}) -Summary $null
            $r.TotalClaims                 | Should -Be 0
            $r.TotalFacts                  | Should -Be 0
            $r.UnmappedConcepts            | Should -Be 0
            $r.ClaimsByPov.Accelerationist | Should -Be 0
        }
    }
}
