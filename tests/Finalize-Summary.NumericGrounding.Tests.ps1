# Tag: summary (t/375)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Finalize-Summary drops factual claims citing numbers the snapshot doesn't contain (t/375).
.DESCRIPTION
    The t/358 pilot found summaries inventing figures where a PDF's text layer had none
    ("less than of all work tasks" -> "less than 5%"). The guard drops any claim with a number absent
    from the snapshot and WARNs. The real-repro case uses a short excerpt of
    epistemic-boundaries-macroeconomic-realities-technical-2026's snapshot (lines 243-264), not the
    whole document, because this repo is public and the sources repo isn't.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Excerpt = Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures' 'numeric-grounding' 'epistemic-boundaries.excerpt.txt')
}

Describe 'Remove-NumericallyUngroundedClaims (t/375)' -Tag 'summary' {

    It 'drops a claim with a number absent from the snapshot, WARNs naming it, and keeps the rest' {
        InModuleScope AITriad {
            $s = [pscustomobject]@{ factual_claims = @(
                [pscustomobject]@{ claim = 'Output rose 12% in 2025.' }
                [pscustomobject]@{ claim = 'Output rose 40% in 2025.' }
                [pscustomobject]@{ claim = 'Regulators are cautious.' }
            ) }
            $w = @(Remove-NumericallyUngroundedClaims -SummaryObject $s -SnapshotText 'In 2025 output rose 12 percent.' -ThisDocId 'doc-x' 3>&1)
            $warn = @($w | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            $count = @($w | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] })[0]
            $count | Should -Be 1
            @($s.factual_claims.claim) | Should -Be @('Output rose 12% in 2025.', 'Regulators are cautious.')
            $warn.Count | Should -Be 1
            "$($warn[0])" | Should -Match 'doc-x.*\[40\]'
        }
    }

    It 'normalizes numbers: 4.0% = 4, 1,000 = 1000, and both ends of a range must be grounded' {
        InModuleScope AITriad {
            $s = [pscustomobject]@{ factual_claims = @(
                [pscustomobject]@{ claim = 'Growth of 4.0% on 1,000 firms.' }
                [pscustomobject]@{ claim = 'Between 0.5–0.7% gains.' }
                [pscustomobject]@{ claim = 'Between 0.5–0.9% gains.' }
            ) }
            $null = Remove-NumericallyUngroundedClaims -SummaryObject $s -SnapshotText 'growth of 4 percent across 1000 firms; gains of 0.5 to 0.7 percent' -ThisDocId 'd' 3>&1
            @($s.factual_claims.claim) | Should -Be @('Growth of 4.0% on 1,000 firms.', 'Between 0.5–0.7% gains.')
        }
    }

    It 'leaves the summary untouched when every claim is grounded or has no numbers' {
        InModuleScope AITriad {
            $s = [ordered]@{ factual_claims = @([ordered]@{ claim = 'No numbers here.' }, [ordered]@{ claim = 'Exactly 7 steps.' }) }
            $r = @(Remove-NumericallyUngroundedClaims -SummaryObject $s -SnapshotText 'there are 7 steps' -ThisDocId 'd' 3>&1)
            @($r | Where-Object { $_ -is [System.Management.Automation.WarningRecord] }).Count | Should -Be 0
            $r[-1] | Should -Be 0
            @($s['factual_claims']).Count | Should -Be 2
        }
    }

    It 'drops the invented Acemoglu and Briggs figures against the real snapshot excerpt (the t/358 repro)' {
        InModuleScope AITriad -Parameters @{ Snap = $script:Excerpt } {
            param($Snap)
            $s = [pscustomobject]@{ factual_claims = @(
                [pscustomobject]@{ claim = 'Acemoglu projects that AI will impact less than 5% of all work tasks, implying a highly marginal cumulative U.S. productivity increase of 0.5% and a cumulative GDP growth boost of only 0.9% over the next decade.' }
                [pscustomobject]@{ claim = 'Briggs forecasts that generative AI will ultimately automate 40% of all work tasks, raising U.S. productivity by 1.5% and cumulative GDP growth by 7% over the next decade.' }
                [pscustomobject]@{ claim = 'Acemoglu argues that only a fraction of AI-exposed tasks can be cost-effectively automated within the next ten years.' }
            ) }
            $out = @(Remove-NumericallyUngroundedClaims -SummaryObject $s -SnapshotText $Snap -ThisDocId 'epistemic-boundaries-macroeconomic-realities-technical-2026' 3>&1)
            $out[-1] | Should -Be 2
            @($s.factual_claims).Count | Should -Be 1
            $s.factual_claims[0].claim | Should -Match '^Acemoglu argues'
        }
    }
}

Describe 'Finalize-Summary records numeric_ungrounded_dropped (t/375)' -Tag 'summary' {

    It 'is the drop count when a snapshot is passed, and null with a WARN when none is available' {
        InModuleScope AITriad {
            $mi = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson '' -ChunkCount 0 -FireStats $null -NumericUngroundedDropped 3
            $mi['numeric_ungrounded_dropped'] | Should -Be 3
            $mi2 = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson '' -ChunkCount 0 -FireStats $null
            $mi2['numeric_ungrounded_dropped'] | Should -BeNullOrEmpty
        }
    }
}
