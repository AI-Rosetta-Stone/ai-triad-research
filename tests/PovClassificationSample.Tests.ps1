# Tag: ingestion (t/4477)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Tests for t/4477: CHESS's classification input covers the WHOLE document (an evenly spaced,
    section-stratified sample), not just its opening 500 words. Covers Get-PovClassificationSample,
    Get-PovWindowSimilarityCheck (the forensic-only cross-check), and Invoke-SummaryPipeline's wiring.
#>

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-PovClassificationSample (t/4477)' -Tag 'ingestion' {
    It 'empty windows yields an empty sample' {
        InModuleScope AITriad {
            Get-PovClassificationSample -Windows @() | Should -Be ''
        }
    }

    It 'a single short window is returned whole' {
        InModuleScope AITriad {
            Get-PovClassificationSample -Windows @('One short window of text.') | Should -Be 'One short window of text.'
        }
    }

    It 'spans windows from across the WHOLE document, not just the opening ones' {
        InModuleScope AITriad {
            $windows = 1..40 | ForEach-Object { "Window $_ discusses topic $_ with its own claim and some padding text to fill it out a little further." }
            $sample = Get-PovClassificationSample -Windows $windows -WordBudget 500 -MaxWindowsSampled 40
            $sample | Should -Match 'Window 1 discusses'
            $sample | Should -Match 'Window 40 discusses'
            $sample | Should -Match 'Window 20 discusses'
        }
    }

    It 'never exceeds the word budget by more than one piece' {
        InModuleScope AITriad {
            $windows = 1..100 | ForEach-Object { "Sentence number $_ here with several words of padding to make it longer than usual." }
            $sample = Get-PovClassificationSample -Windows $windows -WordBudget 100
            $wordCount = @($sample -split '\s+').Count
            $wordCount | Should -BeLessOrEqual 130   # budget + ~1 piece's worth of slack
        }
    }

    It 'takes only the first sentence or two of each sampled window, not the whole window' {
        InModuleScope AITriad {
            $longWindow = 'First sentence here. Second sentence here. Third sentence that should not appear. Fourth sentence that should not appear either.'
            $sample = Get-PovClassificationSample -Windows @($longWindow) -WordBudget 500
            $sample | Should -Match 'First sentence here'
            $sample | Should -Match 'Second sentence here'
            $sample | Should -Not -Match 'Third sentence'
        }
    }

    It 'MaxWindowsSampled bounds how many windows contribute, independent of the word budget' {
        InModuleScope AITriad {
            $windows = 1..20 | ForEach-Object { "Window $_ text." }
            $sample = Get-PovClassificationSample -Windows $windows -WordBudget 5000 -MaxWindowsSampled 3
            @($sample -split '\s+' | Where-Object { $_ -match 'Window' }).Count | Should -BeLessOrEqual 3
        }
    }
}

Describe 'Get-PovWindowSimilarityCheck (t/4477, forensic-only cross-check)' -Tag 'ingestion' {
    It 'returns $null when the node embeddings cache is unavailable (never throws)' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = $null
            { Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0)) } | Should -Not -Throw
            Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0)) | Should -BeNullOrEmpty
        }
    }

    It 'scores each window against each camp mean, with a perfect match at cosine 1.0' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{
                'acc-beliefs-001' = [double[]]@(1, 0, 0)
                'saf-beliefs-001' = [double[]]@(0, 1, 0)
                'skp-beliefs-001' = [double[]]@(0, 0, 1)
            }
            $r = Get-PovWindowSimilarityCheck -WindowVectors @([double[]]@(1, 0, 0), [double[]]@(0, 1, 0))
            $r.Keys | Should -Contain 'accelerationist'
            $r['accelerationist'][0] | Should -BeGreaterThan 0.99   # window 0 == acc's only (and mean) vector
            $r['accelerationist'][1] | Should -BeLessThan 0.01      # window 1 is orthogonal to acc
            $r['safetyist'][1] | Should -BeGreaterThan 0.99
        }
    }
}

Describe 'Invoke-SummaryPipeline: CHESS sees the whole document (t/4477)' -Tag 'ingestion' {
    It 'passes CHESS a query built from windows spread across the whole document, not just the first 500 words' {
        InModuleScope AITriad {
            # A document whose first 500 words never mention "safety-conscious-term", but whose tail does.
            $opening = (('filler word ' * 520)).Trim()
            $closing = 'This later section is safety-conscious-term heavy and discusses the matter at length.'
            $snapshot = "# Intro`n$opening`n`n## Later Section`n$closing"

            Mock Test-FireRequired { @{ ShouldFire = $false; Reason = 'test' } }
            Mock Invoke-AIApi { @{ Text = '{}'; Backend = 'gemini-test' } }
            Mock Get-RelevantTaxonomyNodes { '{}' }
            Mock Invoke-BatchEmbeddings { @{} }   # no local embedding model in this test — exercises the windowing-produced-nothing fallback path too, indirectly; CHESS sample still built from window TEXT, not vectors
            $CapturedQuery = $null
            Mock Get-DocumentPovClassification { param($QueryText, $ApiKey) $script:CapturedQuery = $QueryText; @('safetyist') }

            $null = Invoke-SummaryPipeline -SnapshotText $snapshot -DocId 'test-doc' `
                -Metadata ([PSCustomObject]@{ title = 'Test Doc' }) -ApiKey '' -Model 'gemini-3.5-flash-lite' `
                -TaxonomyVersion '1.0' -SystemPromptTemplate '{density}' -OutputSchema '{}' 3>$null

            $script:CapturedQuery | Should -Match 'safety-conscious-term'
        }
    }
}
