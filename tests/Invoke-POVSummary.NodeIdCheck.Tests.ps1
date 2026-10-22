# Tag: summary (t/4430)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# The POV-summary path skips Finalize-Summary, so it used to write cited node ids unchecked (t/4430). It now runs
# the document path's rule: an id not in the taxonomy is nulled and its point moves to unmapped_concepts.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    function script:New-Summary {
        [pscustomobject]@{
            pov_summaries     = [pscustomobject]@{
                accelerationist = [pscustomobject]@{ key_points = @(
                        [pscustomobject]@{ point = 'Compute scaling drives capability gains'; taxonomy_node_id = 'acc-beliefs-001'; stance = 'supports' },
                        [pscustomobject]@{ point = 'Open weights speed diffusion'; taxonomy_node_id = 'acc-beliefs-999'; stance = 'supports' }) }
                safetyist       = [pscustomobject]@{ key_points = @() }
                skeptic         = [pscustomobject]@{ key_points = @(
                        [pscustomobject]@{ point = 'Benchmarks overstate progress'; taxonomy_node_id = $null; stance = 'supports' }) }
            }
            unmapped_concepts = @([pscustomobject]@{ suggested_label = 'existing'; concept = 'c'; reason = 'r' })
        }
    }
}

Describe 'Invoke-POVSummaryNodeIdCheck (t/4430)' -Tag 'summary' {
    BeforeAll {
        Mock -ModuleName AITriad Get-TaxonomyNodeIdSet {
            $s = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            [void]$s.Add('acc-beliefs-001')
            , $s
        }
        Mock -ModuleName AITriad Write-Host { }
    }

    It 'moves an unknown cited id to unmapped and counts it' {
        $s = New-Summary
        $n = InModuleScope AITriad -Parameters @{ S = $s } { param($S) Invoke-POVSummaryNodeIdCheck -SummaryObject $S -UnmappedConceptCount 1 }
        $n | Should -Be 2
        $kps = @($s.pov_summaries.accelerationist.key_points)
        $kps[0].taxonomy_node_id | Should -BeExactly 'acc-beliefs-001'
        $kps[1].taxonomy_node_id | Should -BeNullOrEmpty
        @($s.unmapped_concepts).Count | Should -Be 2
        $s.unmapped_concepts[1].reason | Should -Match "acc-beliefs-999"
    }

    It 'leaves a summary whose ids all exist untouched' {
        $s = New-Summary
        $s.pov_summaries.accelerationist.key_points = @($s.pov_summaries.accelerationist.key_points[0])
        $n = InModuleScope AITriad -Parameters @{ S = $s } { param($S) Invoke-POVSummaryNodeIdCheck -SummaryObject $S -UnmappedConceptCount 1 }
        $n | Should -Be 1
        @($s.unmapped_concepts).Count | Should -Be 1
    }

    It 'is wired into Invoke-POVSummary right after the pipeline' {
        $src = Get-Content -Raw (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Public' 'Invoke-POVSummary.ps1')
        $src | Should -Match '\$unmappedConceptCount = Invoke-POVSummaryNodeIdCheck -SummaryObject \$summaryObject'
    }
}
