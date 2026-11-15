# Tag: summarization (t/389)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    key_points[].verbatim is kept in the source text (t/389): exact quotes stay, near quotes are snapped
    to the source's own text, and paraphrases are dropped with the key point kept.
.DESCRIPTION
    t/358 pilot 2 found verbatim quotes that aren't in the source (grounding 0.42 chunked). The guard
    uses the spec 7.2 key and snaps a quote only when the source span covers >= 0.9 of its characters.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:Snapshot = @'
Acemoglu projects that AI will impact less than 5% of all work tasks, with a productivity increase of 0.5% over the next decade. Briggs argues that the systems are used by a human operator who keeps final control.
'@

    function New-VerbatimSummary([object[]]$Points) {
        [pscustomobject]@{
            pov_summaries = [pscustomobject]@{
                accelerationist = [pscustomobject]@{ key_points = @($Points) }
                safetyist       = [pscustomobject]@{ key_points = @() }
                skeptic         = [pscustomobject]@{ key_points = @() }
            }
        }
    }
}

Describe 'Repair-SummaryKeyPointVerbatim (t/389)' -Tag 'summarization' {

    It 'keeps an exact quote unchanged and counts nothing' {
        $Quote = 'AI will impact less than 5% of all work tasks'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-exact'
        }
        $R.Snapped | Should -Be 0
        $R.Dropped | Should -Be 0
        $Sum.pov_summaries.accelerationist.key_points[0].verbatim | Should -Be $Quote
    }

    It 'snaps a near quote to the source text, not the model text' {
        # The model adds "the" that the source doesn't have. The source span covers the rest.
        $Near = 'AI will impact less than 5% of all the work tasks, with a productivity increase'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Near })
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-near'
        }
        $R.Snapped | Should -Be 1
        $R.Dropped | Should -Be 0
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Be 'AI will impact less than 5% of all work tasks, with a productivity increase'
        $script:Snapshot.Contains($Stored) | Should -BeTrue
    }

    It 'drops a paraphrase quote and keeps the key point' {
        $Point = [pscustomobject]@{ point = 'Kept point'; verbatim = 'Researchers believe automation will barely touch employment in the coming years' }
        $Sum = New-VerbatimSummary @($Point)
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-para'
        }
        $R.Dropped | Should -Be 1
        $R.Snapped | Should -Be 0
        $Kept = $Sum.pov_summaries.accelerationist.key_points[0]
        $Kept.point | Should -Be 'Kept point'
        $Kept.verbatim | Should -BeNullOrEmpty
    }

    It 'handles a list mixing exact, near and paraphrase quotes' {
        $Exact = 'Briggs argues that the systems are used by a human operator'
        $Near = 'the systems are used by a human operator who keeps final control of it'
        $Para = 'people will remain in charge of the machines at all times'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = @($Exact, $Near, $Para) })
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-mix'
        }
        $R.Snapped | Should -Be 1
        $R.Dropped | Should -Be 1
        $Stored = @($Sum.pov_summaries.accelerationist.key_points[0].verbatim)
        $Stored.Count | Should -Be 2
        $Stored[0] | Should -Be $Exact
        $script:Snapshot.Contains($Stored[1]) | Should -BeTrue
    }

    It 'does nothing to a key point without verbatim' {
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'no quote' })
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-none'
        }
        $R.Snapped | Should -Be 0
        $R.Dropped | Should -Be 0
        $Sum.pov_summaries.accelerationist.key_points[0].PSObject.Properties['verbatim'] | Should -BeNullOrEmpty
    }
}
