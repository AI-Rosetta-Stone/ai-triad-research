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
        # Near: one word changed in the middle ("a" for the source's "by a"): snapped to the source's text.
        $Near = 'the systems are used by the human operator who keeps final control'
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

    It 'drops an elided quote when the segment the source has is under 0.9 of it (t/389#50)' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results [...] and every lab has already agreed to publish them in full.'
        $Out = & $script:Run $script:Long $Quote 'doc-elide-partial'
        # t/389#50: the found segment is about half the quote; a part under 0.9 misstates the claim, so the
        # quote is dropped (it was stored under t/389#11, S23).
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'stores an elided quote that loses only a small fragment: what is kept is 0.9 of it or more (t/389#50)' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results [...] says he'
        $Out = & $script:Run $script:Long $Quote 'doc-elide-small-loss'
        $Out.R.Dropped | Should -Be 0
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
        # The fragment is never stored; without it the rest is 0.887 of the quote, under 0.9, so the quote drops (t/389#50).
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
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

    It 'a quote whose first or last word is not a whole word of the source is dropped (t/389#47 (3); it was trimmed under t/389#20)' {
        # The source's first word is corrupted ("Xhe" for "The"): the quote's first word is not in the source.
        $Src = 'Constituents are restless. Xhe meteoric emergence of the data-center rebellion is a response to the speed and scale of building work nearby.'
        (& $script:Run $Src 'The meteoric emergence of the data-center rebellion is a response to the speed and scale of building work' 'doc-first-word-corrupt').R.Dropped | Should -Be 1
        # "constructionwork" is glued text: the quote's last word ends inside a source word.
        $Src2 = 'Constituents are restless. The meteoric emergence of the data-center rebellion is a response to the speed and scale of constructionwork nearby.'
        (& $script:Run $Src2 'The meteoric emergence of the data-center rebellion is a response to the speed and scale of construction' 'doc-last-word-glued').R.Dropped | Should -Be 1
        # A corrupted word in the middle is still a snap, and the source keeps its own text.
        $Src3 = 'Constituents are restless. The meteoric emergence of the data-center rebelXion is a response to the speed and scale of building work nearby.'
        $Mid = & $script:Run $Src3 'The meteoric emergence of the data-center rebellion is a response to the speed and scale of building work' 'doc-mid-word-corrupt'
        $Mid.R.Snapped | Should -Be 1
        $Mid.Stored | Should -Be 'The meteoric emergence of the data-center rebelXion is a response to the speed and scale of building work'
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

    It 'a label and the chart values printed on their own lines after it are not a passage (p/70#93, sample 5 D18)' {
        # The source prints them in this order, so the words match exactly. It is still a label and two
        # cells, not a sentence.
        $Label = 'Skills gaps in the labour market'
        $Src = "ECONOMY GLOBAL`n`n$Label`n`n72%`n`n63%`n`n47%`n`n46%`n`nGrowing`n`nMore text about the survey of employers.`n"
        $Out = & $script:Run $Src "$Label 72% 63%" 'doc-chart-label'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'the chart-label rule holds with CRLF line ends, as the corpus snapshots have (p/70#93)' {
        $Label = 'Skills gaps in the labour market'
        $Src = "ECONOMY GLOBAL`r`n`r`n$Label`r`n`r`n72%`r`n`r`n63%`r`n`r`n47%`r`n`r`n46%`r`n`r`nGrowing`r`n`r`nMore text about the survey of employers.`r`n"
        $Out = & $script:Run $Src "$Label 72% 63%" 'doc-chart-label-crlf'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'a label and its one value on the next line are kept whole: the figure is never cut out (t/389#40 (1), F02)' {
        $Src = "Risks students report`r`n`r`nGetting biased results`r`n`r`n32%`r`n`r`nGetting inaccurate results`r`n`r`n51%`r`n`r`nMore text about the survey of students.`r`n"
        $Out = & $script:Run $Src 'Getting biased results (32%)' 'doc-label-value'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Snapped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be 'Getting biased results (32%)'
    }

    It 'prose that ends with its figure on a line of its own is kept whole, figure included (t/389#40 (1))' {
        $Prose = 'Employers surveyed expect that skills gaps in the labour market will hinder their transformation over the next five years'
        $Src = "Some other text about the survey.`n`n$Prose`n`n63%`n`nMore text about the survey of employers.`n"
        $Out = & $script:Run $Src "$Prose 63%" 'doc-prose-figure'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be "$Prose 63%"
    }

    It 'quote text that goes on after a figure line is a chart row, not a passage (t/389#40 (1), F06)' {
        $Src = "Labour-market churn`r`n`r`nFive-year structural labour-force churn`r`n`r`n97%`r`n`r`nGlobal 39%`r`n`r`nSkill disruption`r`n`r`nMore text about the survey of employers.`r`n"
        $Out = & $script:Run $Src 'Five-year structural labour-force churn 97% Global 39%' 'doc-chart-row'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'a page number between two lines of the quote is not matched and not stored: the quote is kept as written, one piece (t/389#40 (2), F01)' {
        $Src = "Lermen, Simon, Charlie Rogers-Smith, and Jeffrey Ladish (Oct. 2023). LoRA Fine-Tuning`r`nEfficiently Undoes Safety Training in Llama 2-Chat 70B. arXiv. DOI: 10.48550/arXi`r`n`r`n91`r`n`r`n$([char]12)v.2310.20624. URL: http://arxiv.org/abs/2310.20624 (visited on 01/13/2024).`r`n"
        $Quote = 'Lermen, Simon, Charlie Rogers-Smith, and Jeffrey Ladish (Oct. 2023). LoRA Fine-Tuning Efficiently Undoes Safety Training in Llama 2-Chat 70B. arXiv. DOI: 10.48550/arXi v.2310.20624.'
        $Out = & $script:Run $Src $Quote 'doc-page-number-marker'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be $Quote
        "$($Out.Stored)" | Should -Not -Match '91'
    }

    It 'an elided quote whose segments are close together in the source is kept as its segments (t/389#40 (4))' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        $Src = "$A A short sentence sits between the two in the source. $B`n"
        $Out = & $script:Run $Src "$A [...] $B" 'doc-elision-near'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be @($A, $B)
    }

    It 'an elided quote that joins text more than 1,000 letters apart is dropped (t/389#40 (4), F07)' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        $Filler = (1..40 | ForEach-Object { "Unrelated sentence number $_ about some other matter entirely." }) -join ' '
        $Src = "$A $Filler $B`n"
        $Out = & $script:Run $Src "$A [...] $B" 'doc-elision-far'
        $Out.R.Dropped | Should -Be 1
        $Out.Stored | Should -BeNullOrEmpty
    }

    It 'a list numeral on a line of its own is a word of the quote, not a chart value (t/389#42, G05)' {
        $Src = "We recommend that you:`r`n`r`n1.`r`n`r`nInventory AI assets across your organization. You cannot govern what you do not know.`r`n`r`n2.`r`n`r`nAssign an owner for each system.`r`n"
        $Quote = 'We recommend that you: 1. Inventory AI assets across your organization. You cannot govern what you do not know.'
        $Out = & $script:Run $Src $Quote 'doc-list-numeral'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be $Quote
    }

    It 'one page number between two sentences of an elided quote is still running prose; a chart is not (t/389#47 (1))' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        $Prose = 'A full line of running prose that carries on over the page break without ending its sentence in'
        # One bare page number between prose lines: kept.
        $One = & $script:Run "$A $Prose`r`n`r`n17`r`n`r`nthe next page, where the paragraph goes on for a while. $B`r`n" "$A [...] $B" 'doc-elision-page-number'
        $One.R.Dropped | Should -Be 0
        $One.Stored | Should -Be @($A, $B)
        # Two numbers-only lines, or a value that is not a bare number: a chart.
        (& $script:Run "$A`r`n`r`n64%`r`n`r`n39%`r`n`r`nSome text between the two.`r`n$B`r`n" "$A [...] $B" 'doc-elision-two-numbers').R.Dropped | Should -Be 1
        (& $script:Run "$A $Prose`r`n`r`n64%`r`n`r`nthe next page. $B`r`n" "$A [...] $B" 'doc-elision-percent').R.Dropped | Should -Be 1
        # Two footnote markers on one line inside a sentence are still one numbers-only line of bare numbers (J10).
        (& $script:Run "$A It was documented in an election where generative AI`r`n`r`n5 5`r`n`r`nrobocalls aimed to discourage voters. $B`r`n" "$A [...] $B" 'doc-elision-footnote-markers').R.Dropped | Should -Be 0
    }

    It 'a page number with the running header beside it is one page boundary, not a chart (t/389#47, H06)' {
        $A = 'A significant amount of recent work has focused on the AI alignment problem, broadly defined.'
        $B = 'Broadly, our proposal can be thought of as contributing to better alignment with law and policy.'
        $Head = 'Foundation Models and Fair Use'
        $Body = (1..3 | ForEach-Object { "Text of page $_ that runs on for a full line of ordinary prose here.`r`n`r`n$_`r`n`r`n$Head`r`n`r`nA PREPRINT`r`n`r`n" }) -join ''
        $Src = $Body + "$A Hendrycks et al. provide a survey of the unsolved challenges that remain in AI`r`n`r`n27`r`n`r`n$Head`r`n`r`nA PREPRINT`r`n`r`nSafety, including alignment. $B`r`n"
        $Out = & $script:Run $Src "$A [...] $B" 'doc-elision-running-header'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be @($A, $B)
    }

    It 'a doubly damaged quote mark at the end of the model''s quote is a quote mark, not a letter (t/389#50, i406)' {
        $Src = "I am excited about the mundane tasks being automated`r`n`r`nby AI.$([char]0x00F6)`r`n`r`nMore text follows here.`r`n"
        $Quote = "I am excited about the mundane tasks being automated by AI.$([char]0x00C3)$([char]0x00B6)"
        $Out = & $script:Run $Src $Quote 'doc-double-mojibake'
        $Out.R.Dropped | Should -Be 0
    }

    It 'the quote''s last word printed after a footnote in mid-sentence is found; the quote is stored as written (t/389#52 (1))' {
        $Body = 'This Article expands on the debate as AI entities become an even more integral part of our commercial'
        $Note = '25. For more on this Act, see Section IV.C.3 of the earlier discussion.'
        $Src = "$Body`r`n`r`n$Note`r`n`r`nlives.26 Thus, the solution is a new framework.`r`n"
        $Out = & $script:Run $Src "$Body lives." 'doc-footnote-between'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be "$Body lives."
        # Not when the text between is long (over 500 letters), or does not start with a footnote number.
        $Long = '25. ' + (('A long footnote sentence that goes on about other cases and statutes. ' * 10).Trim())
        (& $script:Run "$Body`r`n`r`n$Long`r`n`r`nlives.26 Thus.`r`n" "$Body lives." 'doc-footnote-long').R.Dropped | Should -Be 1
        (& $script:Run "$Body`r`n`r`nSome other paragraph of the text.`r`n`r`nlives.26 Thus.`r`n" "$Body lives." 'doc-not-footnote').R.Dropped | Should -Be 1
    }

    It 'an interleaved piece with a word the model left out, with no elision mark, fails the quote (t/389#52 (4), i37)' {
        # Two-column layout: a line of the other column sits between the quote's two halves, and the source
        # has "Meta CEO" where the model wrote only the name.
        $Src = "Taking note of this trend, Meta CEO Mark Zuckerberg expects that a lot of the code will be built by AI in 2025`r`n`r`nOffice of Population Health, New York City Health and Hospitals, a line of the other column here`r`n`r`nwhile Salesforce CEO Marc Benioff proclaims that Salesforce will no longer hire software engineers.`r`n"
        $Quote = 'Taking note of this trend, Mark Zuckerberg expects that a lot of the code will be built by AI in 2025 while Salesforce CEO Marc Benioff proclaims that Salesforce will no longer hire software engineers.'
        (& $script:Run $Src $Quote 'doc-piece-deletion').R.Dropped | Should -Be 1
        # The same layout with the model's words equal to the source's: stored as its two pieces.
        $Src2 = $Src.Replace('Meta CEO Mark', 'Mark')
        $Ok = & $script:Run $Src2 $Quote 'doc-piece-no-deletion'
        $Ok.R.Dropped | Should -Be 0
        $Ok.R.Interleaved | Should -Be 1
    }

    It 'a footnote reference glued to the quote''s first or last word is not part of the word (t/389#47 (3))' {
        # "125Large-scale" and "SMEs3": the reference number is glued on by the converter. The quote's words are
        # whole words of the source, so the edge rule does not reject it; the stored text is the source's.
        $Src = "Earlier text ends here.125Large-scale AI training is highly resource intenxive and needs caps and subsidized insurance for SMEs3 (Figure 2).`r`n"
        $Out = & $script:Run $Src 'Large-scale AI training is highly resource intensive and needs caps and subsidized insurance for SMEs.' 'doc-glued-footnote'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Snapped | Should -Be 1
        $Out.Stored | Should -Be 'Large-scale AI training is highly resource intenxive and needs caps and subsidized insurance for SMEs'
    }

    It 'a snapped quote whose first or last word is not the source''s is dropped, not stored with the source''s word (t/389#47 (3), H07)' {
        $Src = "Brundage et al., Towards Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Framework for audits.`r`n"
        # The model wrote "Toward"; the source has "Towards".
        (& $script:Run $Src 'Toward Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Framework' 'doc-first-word').R.Dropped | Should -Be 1
        # The model changed the last word.
        (& $script:Run $Src 'Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Frameworks' 'doc-last-word').R.Dropped | Should -Be 1
        # A changed word in the middle is still a snap to the source's text.
        $Mid = & $script:Run $Src 'Publicly Accountable Frontier LLMs: Building the External Scrutiny Ecosystem under the ASPIRE Framework' 'doc-mid-word'
        $Mid.R.Dropped | Should -Be 0
        $Mid.R.Snapped | Should -Be 1
    }

    It 'two bibliography entries joined by an ellipsis are not one passage (t/389#45 (a), G08, H04, H10)' {
        $E1 = 'Nathan E. Sanders and Bruce Schneier, AI Will Write Complex Laws, Lawfare, January 16, 2025'
        $E2 = 'Agencia Brasil, Brazilian City Enacts an Ordinance That Was Written by ChatGPT, AP News, January 11, 2025'
        # A numbered entry: the next entry's number starts a paragraph in the gap.
        (& $script:Run "116 $E1, https://www.example.org/article.`r`n`r`n117 $E2.`r`n" "$E1... $E2" 'doc-bib-number').R.Dropped | Should -Be 1
        # Number and period, then an author with initials.
        $F1 = 'Evaluating Large Language Models Capability to Launch Fully Automated Spear Phishing Campaigns'
        $F2 = 'Conversational AI: The Convergence of Language Models and Customer Service in Practice'
        $Src = "349. F. Heiding, S. Lermen, $F1, arXiv (2024).`r`n`r`n350. E. Hermann, S. Puntoni, $F2, Journal (2025).`r`n"
        (& $script:Run $Src "$F1... $F2" 'doc-bib-number-period').R.Dropped | Should -Be 1
        # No number: an entry that starts with an author and initials.
        $Src2 = "Heiding, F., Lermen, S. $F1. arXiv, 2024.`r`n`r`nHermann, E., Puntoni, S. $F2. Journal, 2025.`r`n"
        (& $script:Run $Src2 "$F1... $F2" 'doc-bib-author').R.Dropped | Should -Be 1
        # A bracketed tag.
        $Src3 = "[industry] OpenAI, $F1 (2025).`r`n`r`n[industry] Oracle, $F2 (2025).`r`n"
        (& $script:Run $Src3 "$F1... $F2" 'doc-bib-tag').R.Dropped | Should -Be 1
    }

    It 'sentences of running prose joined by an ellipsis are kept, across a paragraph break and a footnote reference (t/389#45, H01, H03)' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        $Out = & $script:Run "$A`r`n`r`nSystem forces human approval of agent actions by default.`r`n`r`n$B`r`n" "$A [...] $B" 'doc-elision-paragraphs'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be @($A, $B)
        $A2 = 'Insurers argue that the impracticability of pricing such risk is the central obstacle'
        $Out2 = & $script:Run "$A2.180`r`n`r`nAccording to this argument, $B`r`n" "$A2 [...] $B" 'doc-elision-footnote-ref'
        $Out2.R.Dropped | Should -Be 0
    }

    It 'a ligature whose bytes were misread in the snapshot still matches the word (t/389#45, H06)' {
        $Bad = "A signi$([char]0x2229)$([char]0x00BC)$([char]0x00FC)cant amount of recent work has focused on the AI alignment problem, broadly de$([char]0x2229)$([char]0x00BC)$([char]0x00FC)ned."
        $Quote = "A signi$([char]0xFB01)cant amount of recent work has focused on the AI alignment problem, broadly de$([char]0xFB01)ned."
        $Out = & $script:Run "Alignment. $Bad More text follows here.`r`n" $Quote 'doc-ligature-mojibake'
        $Out.R.Dropped | Should -Be 0
        "$($Out.Stored)" | Should -Match '^A signi' -Because 'the first word must not be trimmed off the stored text'
    }

    It 'a segment whose text occurs before and after the previous segment is placed after it (t/389#42 (2))' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        # B is printed first in an abstract, then again after A in the body.
        $Src = "$B An abstract sentence follows it here.`r`n`r`nThe body begins. $A A short sentence sits between them. $B`r`n"
        $Out = & $script:Run $Src "$A [...] $B" 'doc-elision-later-occurrence'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be @($A, $B)
    }

    It 'an elided quote whose segments are out of source order, or two page breaks apart, is dropped (t/389#40 (4), t/389#47)' {
        $A = 'Developers answer that the evaluations they run today were never designed for licensing.'
        $B = 'Auditors therefore ask for access to the weights and to the training data.'
        (& $script:Run "$B Some text between. $A`n" "$A [...] $B" 'doc-elision-order').R.Dropped | Should -Be 1
        # One page break inside a paragraph is still running prose (t/389#47 (1)); two are not.
        (& $script:Run "$A`n$([char]12)$B`n" "$A [...] $B" 'doc-elision-pagebreak').R.Dropped | Should -Be 0
        (& $script:Run "$A`n$([char]12)A page of other text.`n$([char]12)$B`n" "$A [...] $B" 'doc-elision-two-pagebreaks').R.Dropped | Should -Be 1
    }

    It 'a figure inside a line of prose is part of the passage' {
        $Prose = 'Employers report that 63% of firms see skills gaps in the labour market as the main barrier.'
        $Src = "Some other text.`n`n$Prose`n`nMore text about the survey of employers.`n"
        $Out = & $script:Run $Src $Prose 'doc-inline-figure'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Snapped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be $Prose
    }

    It 'a numbered paragraph after a blank line is not a figure line' {
        $Src = "The framework has two commitments, stated in the first section of the text.`n`n1. Developers will publish their evaluation results before deployment.`n"
        $Quote = 'The framework has two commitments, stated in the first section of the text. 1. Developers will publish their evaluation results before deployment.'
        $Out = & $script:Run $Src $Quote 'doc-numbered'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 0
        $Out.Stored | Should -Be $Quote
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
