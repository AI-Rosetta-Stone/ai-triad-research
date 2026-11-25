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

    It 'drops a near quote: a word the source does not have is not mended by a snap (t/389#56)' {
        # The model adds "the" that the source doesn't have. Storing the source's text would store words the
        # model did not give; storing the model's would store text the source lacks.
        $Near = 'AI will impact less than 5% of all the work tasks, with a productivity increase'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Near })
        $R = InModuleScope AITriad -Parameters @{ S = $script:Snapshot; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-near' 3>$null
        }
        $R.Snapped | Should -Be 0
        $R.Dropped | Should -Be 1
    }

    It 'snaps a quote whose words are the source''s and whose layout is not: a line break and a hyphenated word' {
        $Src = "Acemoglu projects that AI will impact less than 5% of all work`r`ntasks, with a produc-`r`ntivity increase of 0.5% over the next decade."
        $Quote = 'AI will impact less than 5% of all work tasks, with a productivity increase of 0.5%'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-layout' 3>$null
        }
        $R.Dropped | Should -Be 0
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Be $Quote -Because 'where the match holds, the model''s own words are stored (CL t/389#64 (3))'
        $R.Snapped | Should -Be 0 -Because 'the stored text is the quote as written'
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
        # The near quote changes a word, so it drops with the paraphrase (t/389#56); the exact one stays.
        $R.Snapped | Should -Be 0
        $R.Dropped | Should -Be 2
        $Stored = @($Sum.pov_summaries.accelerationist.key_points[0].verbatim)
        $Stored.Count | Should -Be 1
        $Stored[0] | Should -Be $Exact
    }

    It 'snaps a quote across a corrupted word (t/389#5 row 44): the source keeps its own corrupted text' {
        $Src = "We are also investing signi" + [char]0x2229 + [char]0xBC + [char]0xFC + "cantly more compute resources into monitoring."
        $Quote = 'We are also investing significantly more compute resources into monitoring.'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-corrupt'
        }
        $R.Dropped | Should -Be 0
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Be $Quote -Because 'the model''s own words are stored (CL t/389#64 (3))'
    }

    It 'snaps a quote across PDF-glued words (t/389#5 row 54): the source keeps its glued text' {
        $Src = 'safety monitors should be flexible, costs should rise only when inputs are difficult to assess, or when morecomputeisavailable. Toachievethis, weintroduce a method.'
        $Quote = 'or when more compute is available. To achieve this, we introduce a method.'
        $Sum = New-VerbatimSummary @([pscustomobject]@{ point = 'p'; verbatim = $Quote })
        $R = InModuleScope AITriad -Parameters @{ S = $Src; Sum = $Sum } {
            param($S, $Sum)
            Repair-SummaryKeyPointVerbatim -SummaryObject $Sum -SnapshotText $S -ThisDocId 'doc-glue'
        }
        $R.Dropped | Should -Be 0
        $Stored = $Sum.pov_summaries.accelerationist.key_points[0].verbatim
        $Stored | Should -Be $Quote -Because 'the model''s own words are stored (CL t/389#64 (3))'
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
        # Stored as the model's words for each source piece, in order: column A's three lines, none of column B's.
        $Out.Stored | Should -Be @(
            'Developers answer that the evaluations they run',
            'today were never designed to support a licensing',
            'decision, and they ask for a transition period.')
    }

    It 'stores a quote that skips sentences without an elision mark as its source pieces (CL ruling p/70#77)' {
        $Quote = 'Regulators in several countries have begun to ask for evaluation results before a model is released. Independent auditors, for their part, say that access to the model weights is the only way to check such claims.'
        $Out = & $script:Run $script:Long $Quote 'doc-skipped-sentence'
        $Out.R.Interleaved | Should -Be 1
        $Out.R.Snapped | Should -Be 0
        @($Out.Stored).Count | Should -Be 2
        $Out.Stored[0] | Should -Be 'Regulators in several countries have begun to ask for evaluation results before a model is released.'
        $Out.Stored[1] | Should -Be 'Independent auditors, for their part, say that access to the model weights is the only way to check such claims.'
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
        # A corrupted word in the middle fails too (t/389#56 (3)): storing it would store the misspelling.
        $Src3 = 'Constituents are restless. The meteoric emergence of the data-center rebelXion is a response to the speed and scale of building work nearby.'
        (& $script:Run $Src3 'The meteoric emergence of the data-center rebellion is a response to the speed and scale of building work' 'doc-mid-word-corrupt').R.Dropped | Should -Be 1
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
        # Each quote adds a word the source lacks, so each is placed and then dropped (t/389#56); the test is the time.
        $R.Dropped | Should -Be 40
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
            'were never designed to support a licensing decision and say so in every filing they make to the regulator!')
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
            'today were never designed to support a licensing decision.')
    }

    It 'a piece gives up a word split by a hyphenated line break with other text after it (t/389#20, I13)' {
        $Src = "Why has predicting downstream capabilities of fron- ijcnn55064.2022.9891914. URL http://dx.doi.org`ntier ai models with scale remained elusive?, 2024a. /10.1109/IJCNN55064.2022.9891914.`n"
        $Quote = 'Why has predicting downstream capabilities of frontier ai models with scale remained elusive?, 2024a.'
        $Out = & $script:Run $Src $Quote 'doc-hyphen'
        $Out.R.Interleaved | Should -Be 1
        $Out.Stored | Should -Be @('Why has predicting downstream capabilities of', 'ai models with scale remained elusive?, 2024a.')
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

    It 'a one-piece snapped quote must be the model''s words: a left-out word or a damaged source word fails (t/389#54 (2), #56 (3))' {
        $Src = "Taking note of this trend, Meta CEO Mark Zuckerberg expects that a lot of the code`r`nin apps will be built by AI in 2025, as reported.`r`n"
        # The model left out "Meta CEO" and marked nothing.
        (& $script:Run $Src 'Taking note of this trend, Mark Zuckerberg expects that a lot of the code in apps will be built by AI in 2025' 'doc-snap-deletion').R.Dropped | Should -Be 1
        # The model's words are the source's; only the line break differs: stored (the words match exactly).
        $Same = & $script:Run $Src 'Taking note of this trend, Meta CEO Mark Zuckerberg expects that a lot of the code in apps will be built by AI in 2025' 'doc-snap-same-words'
        $Same.R.Dropped | Should -Be 0
        # A word damaged in the source ("bilt"): not stored as the misspelling, and not replaced by the model's.
        $Bad = $Src.Replace('built', 'bilt')
        (& $script:Run $Bad 'Taking note of this trend, Meta CEO Mark Zuckerberg expects that a lot of the code in apps will be built by AI in 2025' 'doc-snap-damaged-word').R.Dropped | Should -Be 1
    }

    It 'footnote references glued inside a passage come out of the stored piece; digits the model wrote stay (t/389#56 (1))' {
        $Src = "Developers warn of serious harms.12 Regulators have begun to ask for the evaluation results,7 and auditors`r`nwant access to the weights by 2027.`r`n"
        $Refs = & $script:Run $Src 'Developers warn of serious harms. Regulators have begun to ask for the evaluation results, and auditors want access to the weights by 2027' 'doc-snap-glued-refs'
        $Refs.R.Dropped | Should -Be 0
        $Refs.Stored | Should -Be 'Developers warn of serious harms. Regulators have begun to ask for the evaluation results, and auditors want access to the weights by 2027'
        # The model copied the reference "12" into its quote: that one stays, the other still comes out.
        $Kept = & $script:Run $Src 'Developers warn of serious harms.12 Regulators have begun to ask for the evaluation results, and auditors want access to the weights by 2027' 'doc-snap-kept-ref'
        $Kept.R.Dropped | Should -Be 0
        "$($Kept.Stored)" | Should -Match 'harms\.12 Regulators'
        "$($Kept.Stored)" | Should -Not -Match 'results,7'
    }

    It 'digits-only extra text is a reference wherever it sits; a year and digits the model wrote are not (t/389#61 (1))' {
        $Quote = 'This is a practical problem rather than a fundamental issue. AI unpredictability does not undermine liability, and Aquilian liability performs a two-fold function once the model has been trained.'
        $Src = "This is a practical problem rather than a fundamental issue. 252 AI unpredictability does not undermine liability, and Aquilian liability18-performs a two-fold function once the model has been trained [8]. By monitoring it.`r`n"
        $Out = & $script:Run $Src $Quote 'doc-ref-anywhere'
        $Out.R.Dropped | Should -Be 0
        "$($Out.Stored)" | Should -Not -Match '252|18|\[8\]'
        # A four-digit number is not a reference: the source has a year the quote lacks, so a word is left out.
        $Src2 = "Regulators have begun to ask for the evaluation results in 2024 and auditors want access to the weights of the model.`r`n"
        (& $script:Run $Src2 'Regulators have begun to ask for the evaluation results in and auditors want access to the weights of the model.' 'doc-year-not-ref').R.Dropped | Should -Be 1
    }

    It 'extra text on lines of its own splits the piece: stored as two pieces, the stray line is not stored (t/389#61 (2))' {
        $A = 'I suggest that a much faster rate of sustained annual growth'
        $B = 'may be possible once these systems are widely deployed across the economy.'
        $Src = "Earlier text. $A`r`nContents`r`n$B More text.`r`n"
        $Out = & $script:Run $Src "$A $B" 'doc-extra-line'
        $Out.R.Dropped | Should -Be 0
        $Out.R.Interleaved | Should -Be 1
        $Out.Stored | Should -Be @($A, $B)
        # Chart cells on lines of their own inside the passage.
        $Src2 = "Earlier text. $A`r`n51`r`n33`r`n15`r`n$B More text.`r`n"
        $Cells = & $script:Run $Src2 "$A $B" 'doc-extra-cells'
        $Cells.R.Dropped | Should -Be 0
        # The cells are digits only, so they are references under (1): taken out, and the passage stays one piece.
        "$($Cells.Stored)" | Should -Match 'annual growth\s+may be possible'
        "$($Cells.Stored)" | Should -Not -Match '\d'
        # The same word inside a line of the passage's own prose is a word the model left out.
        (& $script:Run "Earlier text. $A Contents $B More text.`r`n" "$A $B" 'doc-extra-inline').R.Dropped | Should -Be 1
    }

    It 'mojibake in the model''s own quote is folded, and a converter symbol in the source is blanked (t/389#61 (3))' {
        $Src = "Students fear being left behind if they don't use AI tools in their studies, and the firm would comply with DMCA $([char]0x00BA)1202 in its strictest form.`r`n"
        # The model's quote carries a doubly damaged apostrophe: a-circumflex, euro sign, trade mark sign.
        $Quote = "Students fear being left behind if they don$([char]0x00E2)$([char]0x20AC)$([char]0x2122)t use AI tools in their studies, and the firm would comply with DMCA 1202 in its strictest form."
        $Out = & $script:Run $Src $Quote 'doc-quote-mojibake'
        $Out.R.Dropped | Should -Be 0
    }

    It 'the a-acute that is a no-break space, between two letters, matches as a space; the model''s words are stored (t/389#63 (1), #64 (3))' {
        $Nb = [string][char]0x00E1
        $Src = "Evaluators describe a${Nb}pattern termed sandbagging that has been observed in several of the recent model evaluations.`r`n"
        $Out = & $script:Run $Src 'Evaluators describe a pattern termed sandbagging that has been observed in several of the recent model evaluations.' 'doc-nbsp-between'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'Evaluators describe a pattern termed sandbagging that has been observed in several of the recent model evaluations.'
        # A real a-acute that the model also wrote is a letter of the word and must match as one.
        $Src2 = "The report from Panam${Nb}city describes how regulators have begun to ask for the evaluation results of each lab.`r`n"
        (& $script:Run $Src2 "The report from Panam${Nb}city describes how regulators have begun to ask for the evaluation results of each lab." 'doc-real-a-acute').R.Dropped | Should -Be 0
    }

    It 'a source word that lost a ligature fails, and is named as its own class (t/389#63 (2))' {
        $Src = "A central barrier to e?ective AI agent security monitoring is doctrinal, and the reporting ?elds are not standardized across regimes.`r`n"
        $Quote = 'A central barrier to effective AI agent security monitoring is doctrinal, and the reporting fields are not standardized across regimes.'
        $Diag = InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
            param($S, $Q)
            $script:VerbatimDiag.Clear()
            $R = Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q
            [pscustomobject]@{ Decision = $R.Decision; Diag = @($script:VerbatimDiag.ToArray()) }
        }
        $Diag.Decision | Should -Be 'dropped'
        $Diag.Diag | Should -Contain 'word differs: lost ligature (one piece)'
    }

    It 'the quote''s first word before a reference is part of the passage (t/389#63, edge-word check)' {
        $Src = "D. Causation`r`n`r`nCausation 344 poses a significant challenge in applying tort law to harm caused by AI agents. 345 This difficulty is pronounced.`r`n"
        $Out = & $script:Run $Src 'Causation poses a significant challenge in applying tort law to harm caused by AI agents.' 'doc-head-across-ref'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'Causation poses a significant challenge in applying tort law to harm caused by AI agents.'
    }

    It 'a ligature character the converter kept matches the quote''s letters (NFKC on the source, t/389#64 (1))' {
        $Fi = [string][char]0xFB01; $Ff = [string][char]0xFB00
        $Src = "The o${Ff}icial report found that arti${Fi}cial systems were classi${Fi}ed by e${Ff}ect, and that the ${Fi}rst ${Fi}ndings were con${Fi}rmed.`r`n"
        $Quote = 'The official report found that artificial systems were classified by effect, and that the first findings were confirmed.'
        $Out = & $script:Run $Src $Quote 'doc-nfkc'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be $Quote
        # The map from the folded letters back to the text: a piece that starts on a folded word starts at that word.
        $At = InModuleScope AITriad -Parameters @{ S = $Src } {
            param($S)
            $Source = Get-VerbatimSource -Text $S
            $P = $Source.Chars.IndexOf('firstfindings', [System.StringComparison]::Ordinal)
            @{ Start = (Get-VerbatimTextOffset -Source $Source -Position $P); Next = (Get-VerbatimTextOffset -Source $Source -Position ($P + 5)) }
        }
        $Src.Substring($At.Start, 4) | Should -Be "${Fi}rst"
        $Src.Substring($At.Next, 7) | Should -Be "${Fi}ndings"
    }

    It 'a space is never deleted: a source space inside a word of the quote fails it (t/389#64 (2))' {
        $Fi = [string][char]0xFB01
        $Src = "Evaluators say that arti ${Fi} cial systems were tested by the lab before the release of the model to the public.`r`n"
        $Quote = 'Evaluators say that artificial systems were tested by the lab before the release of the model to the public.'
        $Diag = InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
            param($S, $Q)
            $script:VerbatimDiag.Clear()
            $R = Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q
            [pscustomobject]@{ Decision = $R.Decision; Diag = @($script:VerbatimDiag.ToArray()) }
        }
        $Diag.Decision | Should -Be 'dropped'
        $Diag.Diag | Should -Contain 'source splits a word (one piece)'
        # White-space runs count as one space, and a word broken over a line end with a hyphen is one word.
        $Src2 = "Evaluators say that   artificial systems were`r`ntested by the lab before the re-`r`nlease of the model to the public.`r`n"
        $Out = & $script:Run $Src2 $Quote 'doc-space-runs'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be $Quote
        # The padding left by a repaired mojibake mark is not a space of the source: "EU's" with a damaged apostrophe is one word.
        $Apos = [string][char]0x393 + [char]0xC7 + [char]0xD6
        $Src4 = "Regulators range from the EU${Apos}s precautionary approach to the lighter rules that other states have adopted.`r`n"
        (& $script:Run $Src4 'Regulators range from the EUs precautionary approach to the lighter rules that other states have adopted.' 'doc-mojibake-padding').R.Dropped | Should -Be 0
        # A hyphen where the source has a space is not a deleted space.
        $Src3 = "Evaluators say that the long term effects were tested by the lab before the release of the model.`r`n"
        (& $script:Run $Src3 'Evaluators say that the long-term effects were tested by the lab before the release of the model.' 'doc-hyphen-for-space').R.Dropped | Should -Be 0
    }

    It 'source words printed with no space between them: stored as the model wrote them, and counted (t/389#64 (2))' {
        $Src = 'costs should rise only when inputs are difficult to assess, or when morecomputeisavailable. Toachievethis, weintroduce a method.'
        $Quote = 'or when more compute is available. To achieve this, we introduce a method.'
        $Got = InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
            param($S, $Q)
            $script:VerbatimDiag.Clear()
            $R = Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q
            $Kept = [pscustomobject]@{ Decision = $R.Decision; Texts = @($R.Texts); Diag = @($script:VerbatimDiag.ToArray()) }
            $script:VerbatimNoSpaceDeletion = 'both'
            try { $Strict = (Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q).Decision } finally { $script:VerbatimNoSpaceDeletion = 'source' }
            [pscustomobject]@{ Kept = $Kept; Strict = $Strict }
        }
        $Got.Kept.Decision | Should -Be 'snapped'
        $Got.Kept.Texts | Should -Be @($Quote)
        $Got.Kept.Diag | Should -Contain 'source glues words, stored'
        $Got.Strict | Should -Be 'dropped' -Because 'the switch set to both fails glued source words too'
    }

    It 'the a-acute no-break space at a word''s start or end matches as a space, but not at the quote''s own start or end (t/389#67 (1))' {
        $Nb = [string][char]0x00E1
        $Rest = 'termed sandbagging that has been observed in several of the recent model evaluations'
        $Quote = "Evaluators describe a pattern $Rest."
        # word start (after a space), and word end (before a line end)
        (& $script:Run "Evaluators describe a ${Nb}pattern $Rest.`r`n" $Quote 'doc-nbsp-word-start').Stored | Should -Be $Quote
        (& $script:Run "Evaluators describe a${Nb}`r`npattern $Rest.`r`n" $Quote 'doc-nbsp-word-end').Stored | Should -Be $Quote
        # the quote's own start and end: the quote has no space there, so the character still fails it
        # (before a capital the character has been blanked as a space since t/389#20, so the case is a lowercase word)
        (& $script:Run "They say that ${Nb}evaluators describe a pattern $Rest.`r`n" "evaluators describe a pattern $Rest." 'doc-nbsp-quote-start').R.Dropped | Should -Be 1
        (& $script:Run "Evaluators describe a pattern $Rest${Nb} and more.`r`n" "Evaluators describe a pattern $Rest" 'doc-nbsp-quote-end').R.Dropped | Should -Be 1
        # a real a-acute the model wrote stays a letter
        $Src = "The report from Panam${Nb} describes how regulators have begun to ask for the evaluation results of each lab.`r`n"
        (& $script:Run $Src "The report from Panam${Nb} describes how regulators have begun to ask for the evaluation results of each lab." 'doc-real-a-acute-end').R.Dropped | Should -Be 0
        (& $script:Run $Src 'The report from Panam describes how regulators have begun to ask for the evaluation results of each lab.' 'doc-a-acute-not-written').Stored |
            Should -Be 'The report from Panam describes how regulators have begun to ask for the evaluation results of each lab.' -Because 'at a word end the character reads as the converter''s space'
    }

    It 'pieces of an interleaved quote are stored as the model''s words, cut at the pieces (t/389#64 (3))' {
        InModuleScope AITriad {
            $Q = 'The lab said: "we tested it (twice)," and then released the $5 model. Nobody objected.'
            $L = (ConvertTo-EvidenceKey -Quote $Q) -replace ' ', ''
            $A = $L.IndexOf('andthen'); $B = $L.IndexOf('nobody')
            Get-VerbatimQuoteCut -Quote $Q -QuoteLetters $L -From 0 -To $A | Should -Be 'The lab said: "we tested it (twice),"'
            Get-VerbatimQuoteCut -Quote $Q -QuoteLetters $L -From $A -To $B | Should -Be 'and then released the $5 model.'
            Get-VerbatimQuoteCut -Quote $Q -QuoteLetters $L -From $L.IndexOf('5model') -To $B | Should -Be '$5 model.'
            Get-VerbatimQuoteCut -Quote $Q -QuoteLetters $L -From $B -To $L.Length | Should -Be 'Nobody objected.'
            Get-VerbatimQuoteCut -Quote $Q -QuoteLetters $L -From -1 -To 5 | Should -BeNullOrEmpty
        }
    }

    Context 'case (CL t/389#70, #72): matching lower-cases both sides, so a case-only difference is judged apart' {
        BeforeAll {
            $script:Decide = {
                param($Src, $Quote)
                InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
                    param($S, $Q)
                    $script:VerbatimDiag.Clear()
                    $R = Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q
                    [pscustomobject]@{ Decision = $R.Decision; Texts = @($R.Texts); Diag = @($script:VerbatimDiag.ToArray()) }
                }
            }
            $script:CaseSrc = "In the report, our internal leak rate was measured by the lab before the release of the model.`r`n`r`nINTRODUCTION TO THE METHOD`r`n`r`nThe method rests on three assumptions about the evaluation. A model is tested twice.`r`n"
        }

        It 'the first letter of the quote may differ in case, in a quote kept as written' {
            $R = & $script:Decide $script:CaseSrc 'Our internal leak rate was measured by the lab before the release of the model.'
            $R.Decision | Should -Be 'exact'
            $R.Diag | Should -Contain 'case: first letter of the quote, permitted'
        }

        It 'a case difference anywhere else fails a quote kept as written' {
            $R = & $script:Decide $script:CaseSrc 'our Internal leak rate was measured by the lab before the release of the model.'
            $R.Decision | Should -Be 'dropped'
            $R.Diag | Should -Contain 'case differs (as written)'
            $R.Diag | Should -Contain 'case word: internal | Internal'
        }

        It 'a source word in capitals may be written in any capitalisation; lower case and others are counted apart' {
            $Lower = & $script:Decide $script:CaseSrc 'introduction to the method'
            $Lower.Decision | Should -Be 'exact'
            $Lower.Diag | Should -Contain 'case: capitals in the source, lower case in the quote, permitted'
            $Title = & $script:Decide $script:CaseSrc 'Introduction to the Method'
            $Title.Decision | Should -Be 'exact'
            $Title.Diag | Should -Contain 'case: capitals in the source, other capitalisation in the quote, permitted'
        }

        It 'a one-letter source word in capitals does not permit a lower-case letter' {
            $R = & $script:Decide $script:CaseSrc 'The method rests on three assumptions about the evaluation. a model is tested twice.'
            $R.Decision | Should -Be 'dropped'
        }

        It 'the same quote with the source''s case has nothing to report' {
            $R = & $script:Decide $script:CaseSrc 'our internal leak rate was measured by the lab before the release of the model.'
            $R.Decision | Should -Be 'exact'
            @($R.Diag | Where-Object { $_ -match '^case' }).Count | Should -Be 0
        }

        It 'only the first segment of an elided quote begins the quote; a capital the model put in brackets is a marked change' {
            $R = & $script:Decide $script:CaseSrc 'Our internal leak rate was measured by the lab [...] A Model is tested twice.'
            $R.Decision | Should -Be 'dropped' -Because 'the second segment has a capital the source lacks'
            $B = & $script:Decide $script:CaseSrc 'Our internal leak rate was measured by the lab [...] [t]he method rests on three assumptions about the evaluation.'
            $B.Decision | Should -Not -Be 'dropped'
            $B.Diag | Should -Contain 'case: letter the model put in brackets, permitted'
        }

        It 'the rule holds for a stored snap: a line break mends, a changed capital fails' {
            $Src = "Evaluators say that the systems were tested`r`nby the lab before the release of the model to the public.`r`n"
            (& $script:Decide $Src 'Evaluators say that the systems were tested by the lab before the release of the model to the public.').Decision | Should -Be 'exact'
            $Src2 = "Evaluators say that the sys-`r`ntems were tested by the lab before the release of the model to the public.`r`n"
            (& $script:Decide $Src2 'evaluators say that the systems were tested by the lab before the release of the model to the public.').Decision | Should -Be 'snapped'
            $R = & $script:Decide $Src2 'Evaluators say that the Systems were tested by the lab before the release of the model to the public.'
            $R.Decision | Should -Be 'dropped'
            $R.Diag | Should -Contain 'case differs (one piece)'
        }
    }

    Context 'CL t/389#74: extra lines with the model''s own digits, glued sidebar words, numeral lists, case on every path' {
        BeforeAll {
            $script:Decide74 = {
                param($Src, $Quote)
                InModuleScope AITriad -Parameters @{ S = $Src; Q = $Quote } {
                    param($S, $Q)
                    $script:VerbatimDiag.Clear()
                    $R = Resolve-VerbatimQuote -Source (Get-VerbatimSource -Text $S) -Quote $Q
                    [pscustomobject]@{ Decision = $R.Decision; Texts = @($R.Texts); Diag = @($script:VerbatimDiag.ToArray()) }
                }
            }
        }

        It 'a label on a line of its own splits the piece when the quote has digits of its own after it' {
            $Src = "Foxconn, the largest contract electronics`n`nDemo`n`nmanufacturer, reported July revenue that`n`nexceeded 900 billion New Taiwan dollars for the first`n`ntime, a 54 percent year-over-year increase.`n"
            $R = & $script:Decide74 $Src 'Foxconn, the largest contract electronics manufacturer, reported July revenue that exceeded 900 billion New Taiwan dollars for the first time, a 54 percent year-over-year increase.'
            $R.Decision | Should -Be 'interleaved'
            $R.Texts | Should -Be @('Foxconn, the largest contract electronics', 'manufacturer, reported July revenue that exceeded 900 billion New Taiwan dollars for the first time, a 54 percent year-over-year increase.')
            $R.Diag | Should -Contain 'split at extra line'
        }

        It 'two extra stretches in one piece both split it; an extra word inside a line still fails' {
            $Src = "Regulators in several countries have begun to ask`n`nDemo`n`nfor evaluation results before a model is released,`n`nVolume 30, Issue 2`n`nand developers answer that the tests were never designed for it.`n"
            $R = & $script:Decide74 $Src 'Regulators in several countries have begun to ask for evaluation results before a model is released, and developers answer that the tests were never designed for it.'
            $R.Decision | Should -Be 'interleaved'
            @($R.Texts).Count | Should -Be 3
            ($R.Texts -join ' ') | Should -Not -Match 'Demo|Volume'
            $Src2 = "Regulators in several countries have recently begun to ask for evaluation results before a model is released.`n"
            (& $script:Decide74 $Src2 'Regulators in several countries have begun to ask for evaluation results before a model is released.').Decision | Should -Be 'dropped'
        }

        It 'the extra stretch is laid on its own line when its letters could be read two ways' {
            $Src = "Foxconn is the largest contract electronics man`n`nmany`n`nmanufacturer in the world and reported record revenue for the month of July.`n"
            $R = & $script:Decide74 $Src 'Foxconn is the largest contract electronics man manufacturer in the world and reported record revenue for the month of July.'
            $R.Decision | Should -Be 'interleaved'
            ($R.Texts -join ' ') | Should -Not -Match 'many'
        }

        It 'a sidebar word glued to the end of a line splits the piece there' {
            $Src = "When a corporation breaches a duty, the corporation`ncouldLaw`nbe held liable or its employee, if the employee acted outside the scope of authority.`n"
            $R = & $script:Decide74 $Src 'When a corporation breaches a duty, the corporation could be held liable or its employee, if the employee acted outside the scope of authority.'
            $R.Decision | Should -Be 'interleaved'
            $R.Diag | Should -Contain 'split at a sidebar word glued to the line end'
            ($R.Texts -join ' ') | Should -Not -Match 'Law'
            # A capital inside a line with the quote's words after it is not a sidebar word.
            $Src2 = "When a corporation breaches a duty, the corporation couldLaw be held liable or its employee, if the employee acted outside the scope.`n"
            (& $script:Decide74 $Src2 'When a corporation breaches a duty, the corporation could be held liable or its employee, if the employee acted outside the scope.').Decision | Should -Be 'dropped'
        }

        It 'a parenthesised list of numerals is a reference; a single year in parentheses is not' {
            $Src = "However, benchmarks significantly vary in quality and scope (998, 1003), and it can be difficult to judge their validity.`n"
            $R = & $script:Decide74 $Src 'However, benchmarks significantly vary in quality and scope, and it can be difficult to judge their validity.'
            $R.Decision | Should -Be 'snapped'
            $R.Diag | Should -Contain 'reference digits removed'
            $Kept = & $script:Decide74 $Src 'However, benchmarks significantly vary in quality and scope (998, 1003), and it can be difficult to judge their validity.'
            $Kept.Decision | Should -Be 'exact'
            $Year = "However, benchmarks significantly vary in quality and scope (2024), and it can be difficult to judge their validity.`n"
            (& $script:Decide74 $Year 'However, benchmarks significantly vary in quality and scope, and it can be difficult to judge their validity.').Decision | Should -Be 'dropped'
        }

        It 'the case rule runs on a quote stored across a page-marker line' {
            $A = 'Regulators in several countries have begun to ask for evaluation results before'
            $B = 'a model is released to the public, and developers answer that the tests were not designed for it.'
            $Src = "Opening text of the page that runs on for a line.`r`n`r`n$A`r`n`r`n27`r`n`r`n$B`r`n"
            $Same = & $script:Decide74 $Src "$A $B"
            $Same.Decision | Should -Not -Be 'dropped'
            @($Same.Diag | Where-Object { $_ -match 'case not checked' }).Count | Should -Be 0
            $Changed = & $script:Decide74 $Src "$A $($B -replace 'developers', 'Developers')"
            $Changed.Decision | Should -Be 'dropped'
            $Changed.Diag | Should -Contain 'case word: developers | Developers'
        }

        It 'a letter the source has in brackets is a marked change; a case drop at a later segment''s start is counted apart' {
            $Src = "The court held that `"[i]ndividual citizens may have a hard time finding out who they should turn to`" in such cases. Later text follows here for the second part.`n"
            $R = & $script:Decide74 $Src 'The court held that Individual citizens may have a hard time finding out who they should turn to'
            $R.Decision | Should -Not -Be 'dropped'
            $R.Diag | Should -Contain 'case: letter the model put in brackets, permitted'
            $L = & $script:Decide74 $Src 'The court held that [...] Later Text follows here for the second part.'
            $L.Decision | Should -Be 'dropped'
            $L2 = & $script:Decide74 $Src 'The court held that [...] Citizens may have a hard time finding out who they should turn to'
            $L2.Decision | Should -Be 'dropped'
            $L2.Diag | Should -Contain 'case differs at the start of a later segment or piece'
        }
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
        $Src = "Earlier text ends here.125Large-scale AI training is highly resource`r`nintensive and needs caps and subsidized insurance for SMEs3 (Figure 2).`r`n"
        $Out = & $script:Run $Src 'Large-scale AI training is highly resource intensive and needs caps and subsidized insurance for SMEs.' 'doc-glued-footnote'
        $Out.R.Dropped | Should -Be 0
        $Out.Stored | Should -Be 'Large-scale AI training is highly resource intensive and needs caps and subsidized insurance for SMEs.'
    }

    It 'a snapped quote whose first or last word is not the source''s is dropped, not stored with the source''s word (t/389#47 (3), H07)' {
        $Src = "Brundage et al., Towards Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Framework for audits.`r`n"
        # The model wrote "Toward"; the source has "Towards".
        (& $script:Run $Src 'Toward Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Framework' 'doc-first-word').R.Dropped | Should -Be 1
        # The model changed the last word.
        (& $script:Run $Src 'Publicly Accountable Frontier LLMs: Building an External Scrutiny Ecosystem under the ASPIRE Frameworks' 'doc-last-word').R.Dropped | Should -Be 1
        # A changed word in the middle fails as well (t/389#56 (3)).
        (& $script:Run $Src 'Publicly Accountable Frontier LLMs: Building the External Scrutiny Ecosystem under the ASPIRE Framework' 'doc-mid-word').R.Dropped | Should -Be 1
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
        $Out.Stored | Should -Be @('Lawmakers should enforce existing laws to prohibit', 'harms and punish bad actors in every case.')
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
