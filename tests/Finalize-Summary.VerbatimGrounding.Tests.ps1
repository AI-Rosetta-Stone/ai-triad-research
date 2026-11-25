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

    It 'snaps a quote across a corrupted word (t/389#5 row 44): the source keeps its own corrupted text' {
        $Src = "We are also investing signi" + [char]0x2229 + [char]0xBC + [char]0xFC + "cantly more compute resources into monitoring."
        $Quote = 'We are also investing significantly more compute resources into monitoring.'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-corrupt'
        }
        $R.Snapped | Should -Be 1
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Match 'signi'
        $Src.Contains($Stored) | Should -BeTrue
    }

    It 'snaps a quote across PDF-glued words (t/389#5 row 54): the source keeps its glued text' {
        $Src = 'safety monitors should be flexible, costs should rise only when inputs are difficult to assess, or when morecomputeisavailable. Toachievethis, weintroduce a method.'
        $Quote = 'or when more compute is available. To achieve this, we introduce a method.'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-glue'
        }
        $R.Snapped | Should -Be 1
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Match 'morecomputeisavailable'
        $Src.Contains($Stored) | Should -BeTrue
    }

    It 'a page footer repeated on every page is not matched as quote text' {
        $Footer = 'Preprint under review at the venue'
        $Src = "Body text on page 1 about models.`n$Footer`n$([char]12)Body text on page 2 about models.`n$Footer`n$([char]12)Body text on page 3 about models.`n$Footer`n"
        $Quote = $Footer
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-footer' 3>$null
        }
        $R.Dropped | Should -Be 1
        $Sum.pov_summaries.accelerationist.key_points[0].verbatim | Should -BeNullOrEmpty
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

Describe 'Repair-SummaryKeyPointVerbatim: elided, interleaved and noisy quotes (t/389#8, t/389#11)' -Tag 'summarization' {

    BeforeAll {
        $script:Run = {
            param([string]$Src, [object]$Verbatim, [string]$Id)
            $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Verbatim })
            $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum; Id = $Id } {
                param($S, $Sum, $Id)
                Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId $Id 3>$null
            }
            [pscustomobject]@{ R = $R; Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim }
        }
        $script:Long = 'Regulators in several countries have begun to ask for evaluation results before a model is released. ' +
            'Developers answer that the evaluations they run today were never designed to support a licensing decision. ' +
            'Independent auditors, for their part, say that access to the model weights is the only way to check such claims.'
    }

    It 'stores an elided quote as its segments, each a source span, with no elision mark' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results [...] access to the model weights is the only way to check such claims.'
        $Out = & $script:Run $script:Long $Quote 'doc-elide'
        $Out.R.Snapped | Should -Be 1
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        @($Out.Stored).Count | Should -Be 2
        $Out.Stored[0] | Should -Be 'Regulators in several countries have begun to ask for evaluation results'
        $Out.Stored[1] | Should -Be 'access to the model weights is the only way to check such claims.'
        foreach ($S in $Out.Stored) { $script:Long.Contains($S.TrimEnd('.')) | Should -BeTrue; $S | Should -Not -Match '\[' }
    }

    It 'treats three dots and the ellipsis character as elision marks too' {
        foreach ($Mark in '...', [string][char]0x2026) {
            $Quote = "Regulators in several countries have begun to ask for evaluation results $Mark never designed to support a licensing decision."
            $Out = & $script:Run $script:Long $Quote 'doc-elide-marks'
            $Out.R.Dropped | Should -Be 0
            @($Out.Stored).Count | Should -Be 2
            ($Out.Stored -join '|') | Should -Not -Match ([regex]::Escape($Mark))
        }
    }

    It 'keeps the segment the source has, as a string, and removes the one it does not' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results [...] and every lab has already agreed to publish them in full.'
        $Out = & $script:Run $script:Long $Quote 'doc-elide-partial'
        $Out.R.Snapped | Should -Be 1
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -BeOfType [string]
        $Out.Stored | Should -Be 'Regulators in several countries have begun to ask for evaluation results'
    }

    It 'drops an elided quote when no segment is in the source' {
        $Quote = 'Every lab has already agreed to publish its results in full [...] and the auditors have declared themselves entirely satisfied.'
        $Out = & $script:Run $script:Long $Quote 'doc-elide-none'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'never keeps a fragment shorter than one run, even when the source has those words' {
        $Quote = 'the model [...] Regulators in several countries have begun to ask for evaluation results'
        $Out = & $script:Run $script:Long $Quote 'doc-elide-short'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'Regulators in several countries have begun to ask for evaluation results'
    }

    It 'keeps a list a list, and adds the segments of an elided entry in place' {
        $Verbatim = @(
            'Developers answer that the evaluations they run today',
            'Regulators in several countries have begun to ask for evaluation results [...] access to the model weights is the only way to check such claims.'
        )
        $Out = & $script:Run $script:Long $Verbatim 'doc-elide-list'
        @($Out.Stored).Count | Should -Be 3
        $Out.Stored[0] | Should -Be 'Developers answer that the evaluations they run today'
        $Out.R.Quotes | Should -Be 2
    }

    It 'stores a quote as its source pieces when a two-column layout puts other text between its lines, in order' {
        # Column A is the quote's sentence; column B's lines sit between column A's lines in the snapshot.
        $Src = "Developers answer that the evaluations they run`nTable 3 reports the share of respondents in each income group`ntoday were never designed to support a licensing`nwho said they had used a chatbot in the past month, by region`ndecision, and they ask for a transition period.`n"
        $Quote = 'Developers answer that the evaluations they run today were never designed to support a licensing decision, and they ask for a transition period.'
        $Out = & $script:Run $Src $Quote 'doc-columns'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        $Out.R.Dropped | Should -Be 0
        # Stored as the source's own pieces, in order: column A's three lines, none of column B's.
        $Out.Stored | Should -Be @(
            'Developers answer that the evaluations they run',
            'today were never designed to support a licensing',
            'decision, and they ask for a transition period')
        foreach ($S in $Out.Stored) { $Src.Contains($S) | Should -BeTrue }
    }

    It 'stores a quote that skips sentences without an elision mark as its source pieces (CL ruling p/70#77)' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results before a model is released. Independent auditors, for their part, say that access to the model weights is the only way to check such claims.'
        $Out = & $script:Run $script:Long $Quote 'doc-skipped-sentence'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        @($Out.Stored).Count | Should -Be 2
        $Out.Stored[0] | Should -Be 'Regulators in several countries have begun to ask for evaluation results before a model is released'
        $Out.Stored[1] | Should -Be 'Independent auditors, for their part, say that access to the model weights is the only way to check such claims'
    }

    It 'drops a quote whose lines are in the source out of order (CL ruling t/389#11: in order only)' {
        $Src = "decision, and they ask for a transition period of two years.`n`nDevelopers answer that the evaluations they run today were never designed to support a licensing`n`nTable 3 reports the share of respondents in each income group.`n"
        $Quote = 'Developers answer that the evaluations they run today were never designed to support a licensing decision, and they ask for a transition period of two years.'
        $Out = & $script:Run $Src $Quote 'doc-out-of-order'
        $Out.R.Interleaved | Should -Be 0
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'drops a quote whose lines are in order but spread beyond one window' {
        $Filler = (1..120 | ForEach-Object { "Paragraph $_ describes an unrelated survey question about household internet access and its wording." }) -join "`n"
        $Src = "Developers answer that the evaluations they run today`n$Filler`nwere never designed to support a licensing decision.`n$Filler`nThey ask for a transition period of two years.`n"
        $Quote = 'Developers answer that the evaluations they run today were never designed to support a licensing decision. They ask for a transition period of two years.'
        $Out = & $script:Run $Src $Quote 'doc-scattered'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'matches the right passage when the quote opens with words that also appear later (no greedy jump)' {
        # The model put "Internal audit documents" before the quoted passage; those words occur again after it.
        $Src = 'The filings suggest that the minimum viable product goal for the feature was to have something the company could point regulators and parents to. Figure 5. Internal audit documents, Exhibit 12.'
        $Quote = 'Internal audit documents: the minimum viable product goal for the feature was to have something the company could point regulators and parents to.'
        $Best = InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
            param($S, $Q)
            Find-VerbatimSnap -Source (Get-VerbatimSource -Text $S) -Quote $Q
        }
        $Src.Substring($Best.Start, $Best.End - $Best.Start) | Should -Match '^the minimum viable product goal'
        $Best.Coverage | Should -BeGreaterThan 0.75
    }

    It 'a snapped span begins and ends on a word of the quote, not on part of one' {
        # The source's first word is corrupted ("Xhe" for "The"), so the quote's "The" is only partly
        # matched and is given up. "constructionwork" is glued text: the span ends with the quote's word.
        $Src = 'Constituents are restless. Xhe meteoric emergence of the data-center rebellion is a response to the speed and scale of constructionwork nearby.'
        $Quote = 'The meteoric emergence of the data-center rebellion is a response to the speed and scale of construction'
        $Out = & $script:Run $Src $Quote 'doc-word-boundary'
        $Out.R.Snapped | Should -Be 1
        $Out.Stored | Should -Be 'meteoric emergence of the data-center rebellion is a response to the speed and scale of construction'
    }

    It 'ignores a page header and a URL that the model copied into the quote' {
        $Header = 'Journal of Applied Policy 14(2)'
        $Body = 'Developers answer that the evaluations they run today were never designed to support a licensing decision.'
        $Src = "$Header`nRegulators have begun to ask for results.`n$([char]12)$Header`n$Body`n$([char]12)$Header`nAuditors want access to the weights.`n"
        $Quote = "Developers answer that the evaluations they run today $Header https://example.org/vol14/issue2 were never designed to support a licensing decision."
        $Out = & $script:Run $Src $Quote 'doc-header-url'
        $Out.R.Snapped | Should -Be 1
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'Developers answer that the evaluations they run today were never designed to support a licensing decision.'
    }

    It 'counts the quotes it examined' {
        $Out = & $script:Run $script:Long @('Developers answer that the evaluations they run today', 'A sentence the source does not have at all, about something else.') 'doc-count'
        $Out.R.Quotes | Should -Be 2
        $Out.R.Dropped | Should -Be 1
    }

    It 'decides 40 near quotes against a 300,000-character snapshot in under 20 seconds' {
        $Sentences = 1..3500 | ForEach-Object { "Sentence $_ of the report says that group $($_ * 7) answered question $($_ * 3) with option $($_ % 5) in wave $($_ % 11)." }
        $Src = $Sentences -join ' '
        $Src.Length | Should -BeGreaterThan 300000
        $Quotes = 1..40 | ForEach-Object { ($Sentences[$_ * 70] -replace 'answered', 'had answered') }
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = @($Quotes) })
        $Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-speed' 3>$null
        }
        $Sw.Stop()
        $R.Snapped | Should -Be 40
        $Sw.Elapsed.TotalSeconds | Should -BeLessThan 20
    }

    It 'a repeated page header inside the sentence makes the quote interleaved, and the header is not stored' {
        $Header = 'Journal of Applied Policy 14(2)'
        $Src = "$Header`nRegulators have begun to ask for results.`n$([char]12)$Header`nDevelopers answer that the evaluations they run today`n$([char]12)$Header`nwere never designed to support a licensing decision.`n"
        $Quote = 'Developers answer that the evaluations they run today were never designed to support the licensing decision.'
        $Out = & $script:Run $Src $Quote 'doc-header-inside'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        $Out.Stored | Should -Be @(
            'Developers answer that the evaluations they run today',
            'were never designed to support a licensing decision')
        ($Out.Stored -join ' ') | Should -Not -Match 'Journal'
    }

    It 'other text inside the sentence makes the quote interleaved, even when the span is short' {
        $Src = 'Developers answer that the evaluations they run today (see Table 3 overleaf) were never designed to support a licensing decision and say so in every filing they make to the regulator.'
        $Quote = 'Developers answer that the evaluations they run today were never designed to support a licensing decision and say so in every filing they make to the regulator!'
        $Out = & $script:Run $Src $Quote 'doc-insert-inside'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        $Out.Stored | Should -Be @(
            'Developers answer that the evaluations they run today',
            'were never designed to support a licensing decision and say so in every filing they make to the regulator')
    }

    It 'an elided quote with one interleaved segment is counted as interleaved, not snapped' {
        $Src = "Regulators in several countries have begun to ask for evaluation results before release.`nDevelopers answer that the evaluations they run`nTable 3 reports the share of respondents in each income group`ntoday were never designed to support a licensing decision.`n"
        $Quote = 'Regulators in several countries have begun to ask for evaluation results [...] Developers answer that the evaluations they run today were never designed to support a licensing decision.'
        $Out = & $script:Run $Src $Quote 'doc-elide-interleaved'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        $Out.Stored | Should -Be @(
            'Regulators in several countries have begun to ask for evaluation results',
            'Developers answer that the evaluations they run',
            'today were never designed to support a licensing decision')
    }

    It 'a piece gives up a word split by a hyphenated line break with other text after it (t/389#20, I13)' {
        $Src = "Why has predicting downstream capabilities of fron- ijcnn55064.2022.9891914. URL http://dx.doi.org`ntier ai models with scale remained elusive?, 2024a. /10.1109/IJCNN55064.2022.9891914.`n"
        $Quote = 'Why has predicting downstream capabilities of frontier ai models with scale remained elusive?, 2024a.'
        $Out = & $script:Run $Src $Quote 'doc-hyphen'
        $Out.R.Interleaved | Should -Be 1
        $Out.Stored | Should -Be @('Why has predicting downstream capabilities of', 'ai models with scale remained elusive?, 2024a')
    }

    It 'drops a quote when the pieces that can be stored cover less than 0.9 of it (t/389#20)' {
        # A hyphenated break costs the quote its longest word, so what can be stored covers 38 of 53 letters.
        $Src = "The committee adopted interna- (see the annex for the full list of members)`ntionally recognised standards (2024).`n"
        $Quote = 'The committee adopted internationally recognised standards.'
        $Out = & $script:Run $Src $Quote 'doc-low-stored'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'a repeated one-word line is document text, not a page header (t/389#20, S07)' {
        $Src = "Pretrained`nML libraries`nor packages`nembedded`nwith`nmalicious`npayloads`ncould`ncorrupt`ndispatch or`nmonitoring`nsystems at`nscale.`n`nPretrained`nmodels reused.`n`nMonitoring`ncosts rise.`n`nPretrained`nweights.`n`nmonitoring`ngaps.`n"
        $Quote = 'Pretrained ML libraries or packages embedded with malicious payloads could corrupt dispatch or monitoring systems at scale.'
        $Out = & $script:Run $Src $Quote 'doc-sidebar'
        $Out.R.Snapped | Should -Be 0
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be $Quote
    }

    It 'finds in-order sentences about 1,800 letters apart (t/389#20, D03)' {
        $Filler = (1..22 | ForEach-Object { "Paragraph $_ describes an unrelated survey question about household internet access and its wording." }) -join "`n"
        $Src = "Developers answer that the evaluations they run today were never designed for this.`n$Filler`nThey ask for a transition period of two full years before any licence is required.`n"
        $Quote = 'Developers answer that the evaluations they run today were never designed for this. They ask for a transition period of two full years before any licence is required.'
        $Out = & $script:Run $Src $Quote 'doc-far'
        $Out.R.Interleaved | Should -Be 1
        @($Out.Stored).Count | Should -Be 2
    }

    It 'matches across HTML tags and a spaced ellipsis, and reads a bracketed letter as the letter (t/389#20)' {
        $Src = 'As the report says, <figcaption><b>AI Danger:</b> Lazy overreliance on AI. Go hybrid instead.</figcaption> However, more capable models may come with greater risk. Other text here. In short, future models may pose catastrophic risks as capabilities improve.'
        $Out = & $script:Run $Src 'AI Danger: Lazy overreliance on AI. Go hybrid instead.' 'doc-html'
        $Out.R.Dropped | Should -Be 0
        $Out2 = & $script:Run $Src 'However, more capable models may come with greater risk. . . . [F]uture models may pose catastrophic risks as capabilities improve.' 'doc-spaced'
        $Out2.R.Dropped | Should -Be 0
        @($Out2.Stored).Count | Should -Be 2
        ($Out2.Stored -join '|') | Should -Not -Match '\. \. \.'
    }

    It 'a line that repeats away from any page boundary is document text, not a header (t/389#30)' {
        # A row label printed in every section: no form feed and no page-number line next to it.
        $Label = 'Skills gaps in the labour market'
        $Src = "$Label`n72% 63%`nOther barriers to transformation`n$Label`n51% 40%`nMore text about the survey.`n$Label`n"
        $Out = & $script:Run $Src "$Label 72% 63%" 'doc-row-label'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Snapped | Should -Be 0
        $Out.Stored | Should -Be "$Label 72% 63%"
    }

    It 'a repeated line next to a page-number line is a header even with no form feed' {
        $Header = 'Journal of Applied Policy 14(2)'
        $Src = "Developers answer that the evaluations they run today`n$Header`nPage 2 of 9`nwere never designed to support a licensing decision.`n$Header`nPage 3 of 9`nOther text.`n$Header`nPage 4 of 9`n"
        $Out = & $script:Run $Src 'Developers answer that the evaluations they run today were never designed to support the licensing decision.' 'doc-page-number'
        $Out.R.Interleaved | Should -Be 1
        ($Out.Stored -join ' ') | Should -Not -Match 'Journal'
    }

    It 'a one- or two-word repeated line is never a header: a quote across it is stored as pieces' {
        $Src = "Lawmakers should enforce existing laws to prohibit`nErik Torenberg`n`nharms and punish bad actors in every case.`n" + (("More text $([guid]::NewGuid().ToString('N')).`n$([char]12)Erik Torenberg`n") * 6)
        $Quote = 'Lawmakers should enforce existing laws to prohibit harms and punish bad actors in every case.'
        $Out = & $script:Run $Src $Quote 'doc-short-header'
        $Out.R.Interleaved | Should -Be 1
        $Out.Stored | Should -Be @('Lawmakers should enforce existing laws to prohibit', 'harms and punish bad actors in every case')
    }

    It 'leaves code in angle brackets alone: only HTML tags are blanked' {
        $Src = 'The listing declares std::vector<int> to_activate; before the loop that fills it.'
        $Out = & $script:Run $Src 'std::vector<int> to_activate;' 'doc-code'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'std::vector<int> to_activate;'
    }

    It 'a short line repeated six times away from any page boundary is text, not a header (t/389#24)' {
        # "Yes" is a table label: it repeats, but no header or page number is next to it.
        $Rows = (1..7 | ForEach-Object { "Question $_ about the survey wording for this group.`nYes`n" }) -join ''
        $Src = "The respondents were asked whether they agreed.`nYes`nwas the answer most of them gave to the interviewer.`n$Rows"
        $Quote = 'The respondents were asked whether they agreed. Yes was the answer most of them gave to the interviewer.'
        $Out = & $script:Run $Src $Quote 'doc-table-label'
        $Out.R.Snapped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be $Quote
    }

    It 'gives up both halves of a word split by a hyphen at a line end (t/389#24, I25)' {
        $Src = "downward pressure on code quality, https://www. gitclear. com/cod- pooling for proxy caching`ning on copilot data shows ais downward pressure on code quality/, https://github.com/sup`n"
        $Quote = 'downward pressure on code quality, https://www. gitclear. com/cod- ing on copilot data shows ais downward pressure on code quality/'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $Texts = InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
            param($S, $Q)
            $Source = Get-VerbatimSource -Text $S
            @((Find-VerbatimSnap -Source $Source -Quote $Q).Pieces | ForEach-Object { $S.Substring($_.Start, $_.End - $_.Start) })
        }
        $Texts[0] | Should -Match 'gitclear\. com$'
        $Texts[1] | Should -Match '^on copilot data shows'
    }

    It 'does not store a piece that runs across markdown table cells (t/389#24, I04)' {
        $Src = "The data is often`n|     | sourced | without | explicit | user consent |`n| --- | --- | --- | --- | --- |`nand this raises ethical and privacy concerns for everyone involved.`n"
        $Quote = 'The data is often sourced without explicit user consent and this raises ethical and privacy concerns for everyone involved.'
        $Out = & $script:Run $Src $Quote 'doc-table-cells'
        foreach ($S in @($Out.Stored)) { $S | Should -Not -Match '\|' }
    }

    It 'reads the mojibake no-break space next to a symbol as a space (t/389#24, D27)' {
        $Src = 'OpenAI, A' + [char]0xE1 + '$50 Million Fund to Build with Communities (2025); the announcement.'
        $Out = & $script:Run $Src 'OpenAI, A $50 Million Fund to Build with Communities (2025)' 'doc-mojibake-space'
        $Out.R.Dropped | Should -Be 0
    }
}
