# Tag: ingestion (t/1646, t/4473, t/4519)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for Test-SummaryDensity: the t/1646 dictionary-blindness
    false positive, and its t/4473/t/4519 redesign (WARN-only, no floors, no
    retry — only a tagged camp with 0 key_points and no empty_cells rationale).
.DESCRIPTION
    Merge-ChunkSummaries returns an [ordered] hashtable whose pov_summaries →
    camp → key_points entries are NOT visible via $x.PSObject.Properties[...].
    Test-SummaryDensity reads camp data through the shared Get-SummaryProp
    accessor + $script:AITriadPovCamps constant, so it and the merge writer can
    never disagree about the structure (the t/1646 fix). These tests feed the
    checker the exact dictionary shape the writer emits.

    t/4473/t/4519 removed the total-key_points floor and the unmapped_concepts
    floor entirely (the data showed the floor was unreachable: 281/288
    single-shot documents still failed it after a retry). The one surviving
    check is scoped to camps named in the document's pov_tags — untagged camps
    are never flagged for being empty.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-SummaryDensity dictionary-shape density accounting' -Tag 'ingestion' {

    It 'Does not warn when a dictionary-shaped merged object holds dense per-camp key_points' {
        InModuleScope AITriad {
            # Build the exact structure Merge-ChunkSummaries returns: an [ordered]
            # hashtable whose camps are [ordered] hashtables — keys invisible to
            # PSObject.Properties. Mirrors the t/1646 ground truth 9 / 6 / 8.
            function New-Points {
                param([int]$N, [string]$Prefix)
                $list = for ($i = 1; $i -le $N; $i++) {
                    [ordered]@{ point = "$Prefix point $i"; taxonomy_node_id = "$Prefix-$i" }
                }
                @($list)
            }

            $Merged = [ordered]@{
                pov_summaries = [ordered]@{
                    accelerationist = [ordered]@{ key_points = New-Points -N 9 -Prefix 'acc' }
                    safetyist       = [ordered]@{ key_points = New-Points -N 6 -Prefix 'saf' }
                    skeptic         = [ordered]@{ key_points = New-Points -N 8 -Prefix 'skp' }
                }
                factual_claims    = @()
                unmapped_concepts = @(
                    [ordered]@{ suggested_label = 'novel-concept-a' }
                    [ordered]@{ suggested_label = 'novel-concept-b' }
                )
            }

            $Result = Test-SummaryDensity -SummaryObject $Merged -PovTags @('accelerationist', 'safetyist', 'skeptic')

            $Result.Pass | Should -BeTrue -Because 'every tagged camp is non-empty'
            @($Result.Shortfalls).Count | Should -Be 0 -Because 'a dense dictionary-shaped summary must not trip any shortfall (the t/1646 false positive)'
        }
    }

    It 'Flags a genuinely empty TAGGED camp with no empty_cells rationale' {
        InModuleScope AITriad {
            $Merged = [ordered]@{
                pov_summaries = [ordered]@{
                    accelerationist = [ordered]@{ key_points = @([ordered]@{ point = 'only one' }) }
                    safetyist       = [ordered]@{ key_points = @() }
                    skeptic         = [ordered]@{ key_points = @() }
                }
                factual_claims    = @()
                unmapped_concepts = @()
            }

            $Result = Test-SummaryDensity -SummaryObject $Merged -PovTags @('accelerationist', 'safetyist', 'skeptic')

            $Result.Pass | Should -BeFalse -Because 'two tagged camps are empty with no empty_cells rationale'
            @($Result.Shortfalls | Where-Object { $_ -like "tagged camp 'safetyist' has 0 key_points*" }).Count |
                Should -Be 1 -Because 'a truly empty tagged camp with no empty_cells declaration must still be reported'
        }
    }

    It 'Never flags an UNTAGGED camp for being empty' {
        InModuleScope AITriad {
            $Merged = [ordered]@{
                pov_summaries = [ordered]@{
                    accelerationist = [ordered]@{ key_points = @([ordered]@{ point = 'one point' }) }
                    safetyist       = [ordered]@{ key_points = @() }
                    skeptic         = [ordered]@{ key_points = @() }
                }
                factual_claims    = @()
                unmapped_concepts = @()
            }

            # Document is tagged accelerationist only — safetyist/skeptic are untagged.
            $Result = Test-SummaryDensity -SummaryObject $Merged -PovTags @('accelerationist')

            $Result.Pass | Should -BeTrue -Because 'untagged camps being empty is a correct answer, not a shortfall'
            @($Result.Shortfalls).Count | Should -Be 0
        }
    }

    It 'Treats every camp as tagged when the document carries no pov_tags' {
        InModuleScope AITriad {
            $Merged = [ordered]@{
                pov_summaries = [ordered]@{
                    accelerationist = [ordered]@{ key_points = @([ordered]@{ point = 'one point' }) }
                    safetyist       = [ordered]@{ key_points = @() }
                    skeptic         = [ordered]@{ key_points = @() }
                }
                factual_claims    = @()
                unmapped_concepts = @()
            }

            $Result = Test-SummaryDensity -SummaryObject $Merged -PovTags @()

            $Result.Pass | Should -BeFalse -Because 'with no pov_tags given, every camp counts as tagged'
            @($Result.Shortfalls).Count | Should -Be 2 -Because 'safetyist and skeptic are both empty with no rationale'
        }
    }

    It 'Honors an empty_cells rationale on a dictionary-shaped object (licensed emptiness)' {
        InModuleScope AITriad {
            $Merged = [ordered]@{
                pov_summaries = [ordered]@{
                    accelerationist = [ordered]@{ key_points = @(1..5 | ForEach-Object { [ordered]@{ point = "acc $_" } }) }
                    safetyist       = [ordered]@{ key_points = @(1..4 | ForEach-Object { [ordered]@{ point = "saf $_" } }) }
                    skeptic         = [ordered]@{ key_points = @() }
                }
                empty_cells       = @([ordered]@{ camp = 'skeptic'; category = 'Intentions'; reason = 'no skeptic argument in this document' })
                factual_claims    = @()
                unmapped_concepts = @([ordered]@{ suggested_label = 'x' })
            }

            $Result = Test-SummaryDensity -SummaryObject $Merged -PovTags @('accelerationist', 'safetyist', 'skeptic')

            @($Result.Shortfalls | Where-Object { $_ -like "tagged camp 'skeptic' has 0 key_points*" }).Count |
                Should -Be 0 -Because 'a single empty_cells entry naming the camp is a rationale for the whole camp'
        }
    }
}
