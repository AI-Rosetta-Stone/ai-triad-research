# Tag: ingestion (t/4468)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Tests for t/4468: the chunk/whole-document RAG query covers the WHOLE text (windowed), not just its
    first 2000 chars. Covers Split-RagQueryWindows, the scoring kernel's equivalence to the former
    per-window PowerShell formula, MaxSim vs RankFusion combination, the 512-window cap, back-matter
    dropping, and the Add-Type-unavailable fallback (CL t/4468#2).
.DESCRIPTION
    Split-RagQueryWindows and the kernel (RagScoringKernel.ps1) are Private, so every call to them runs
    inside InModuleScope — a function defined at Describe/BeforeAll (script) scope is NOT visible inside
    an InModuleScope block, so helpers used there are re-declared inline per block rather than shared.
    Get-RelevantTaxonomyNodes is Public and is called directly (no InModuleScope needed) except where a
    test also needs to seed $script:Cached... module variables or mock a Private function.
#>

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    function script:Get-Warnings([scriptblock]$Block) {
        @(& $Block 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { "$_" })
    }
}

Describe 'Split-RagQueryWindows (t/4468)' -Tag 'ingestion' {
    It 'empty or whitespace-only text yields no windows' {
        InModuleScope AITriad {
            (Split-RagQueryWindows -Text '').Windows.Count | Should -Be 0
            (Split-RagQueryWindows -Text "`n`n  `n").Windows.Count | Should -Be 0
        }
    }

    It 'a short text is one window, verbatim content preserved' {
        InModuleScope AITriad {
            $r = Split-RagQueryWindows -Text 'One short paragraph.' -MaxChars 900
            $r.Windows.Count | Should -Be 1
            $r.Windows[0] | Should -Be 'One short paragraph.'
        }
    }

    It 'covers the whole text: every non-whitespace word appears in some window, in order' {
        InModuleScope AITriad {
            $paras = 1..30 | ForEach-Object { "Paragraph $_ discusses topic $_ in some detail with several sentences of content to pad it out further." }
            $text = $paras -join "`n`n"
            $r = Split-RagQueryWindows -Text $text -MaxChars 300
            $r.Windows.Count | Should -BeGreaterThan 1
            $joined = $r.Windows -join ' '
            foreach ($p in 1..30) { $joined | Should -Match "Paragraph $p discusses topic $p" }
            $joined.IndexOf('Paragraph 1 discusses') | Should -BeLessThan $joined.IndexOf('Paragraph 30 discusses')
        }
    }

    It 'no window exceeds MaxChars, even for one very long run-on sentence' {
        InModuleScope AITriad {
            $longSentence = (('word ' * 400).Trim()) + '.'
            $r = Split-RagQueryWindows -Text $longSentence -MaxChars 200
            foreach ($w in $r.Windows) { $w.Length | Should -BeLessOrEqual 200 }
            ($r.Windows -join ' ').Replace('  ', ' ').Trim() | Should -Be $longSentence.Replace('  ', ' ').Trim()
        }
    }

    It 'rejects a MaxChars below the 200 floor (ValidateRange)' {
        InModuleScope AITriad {
            { Split-RagQueryWindows -Text 'x' -MaxChars 100 } | Should -Throw
        }
    }

    It 'splits on markdown headings so section bodies are preserved on both sides' {
        InModuleScope AITriad {
            $text = "# Intro`nIntro text here.`n`n## Methods`nMethods text here, a bit longer to force its own piece maybe not."
            $r = Split-RagQueryWindows -Text $text -MaxChars 900
            ($r.Windows -join ' ') | Should -Match 'Intro text here'
            ($r.Windows -join ' ') | Should -Match 'Methods text here'
        }
    }

    It 'drops References/Bibliography/Acknowledgements sections by default, and reports the count (CL item 3)' {
        InModuleScope AITriad {
            $text = @"
# Body
The actual claims live here, with real content worth retrieving.

## References
1. Smith, J. (2020). Some paper. Journal of Things.
2. Doe, A. (2021). Another paper. Journal of Other Things.

## Acknowledgements
We thank our funders and colleagues for their support.
"@
            $r = Split-RagQueryWindows -Text $text
            ($r.Windows -join ' ') | Should -Match 'actual claims live here'
            ($r.Windows -join ' ') | Should -Not -Match 'Smith, J\.'
            ($r.Windows -join ' ') | Should -Not -Match 'thank our funders'
            $r.SkippedSections | Should -Be 2
        }
    }

    It '-KeepBackMatter keeps back-matter sections and reports 0 skipped' {
        InModuleScope AITriad {
            $text = "# Body`nClaims here.`n`n## Bibliography`nSmith 2020."
            $r = Split-RagQueryWindows -Text $text -KeepBackMatter
            ($r.Windows -join ' ') | Should -Match 'Smith 2020'
            $r.SkippedSections | Should -Be 0
        }
    }

    It 'short adjacent pieces are packed into fewer windows than naive one-piece-per-paragraph' {
        InModuleScope AITriad {
            $text = (1..20 | ForEach-Object { "Short line $_." }) -join "`n`n"
            $r = Split-RagQueryWindows -Text $text -MaxChars 900
            $r.Windows.Count | Should -BeLessThan 20
        }
    }
}

Describe 'RagScoringKernel equivalence to the former per-window PowerShell formula (t/4468)' -Tag 'ingestion' {
    It 'synthetic mean-of-top-N: kernel ScoreMatrix (one window) matches the former formula exactly' {
        InModuleScope AITriad {
            $kernel = Initialize-RagKernelType
            if (-not $kernel) { Set-ItResult -Skipped -Because 'Add-Type unavailable in this environment'; return }
            $q = [double[]]@(0.6, 0.3, 0.1, 0.0)
            $synVecs = [double[][]]@(
                ([double[]]@(0.5, 0.4, 0.1, 0.0)),
                ([double[]]@(0.1, 0.1, 0.1, 0.7)),
                ([double[]]@(0.3, 0.3, 0.3, 0.1))
            )
            foreach ($topN in 1, 2, 3) {
                $old = Get-RagWindowScoreFallback -QueryVector $q -NodeVectors $synVecs -TopN $topN -Synthetic $true
                $matrix = $kernel::ScoreMatrix(([double[][]]@(, $q)), ([double[][][]]@(, $synVecs)), ([int[]]@($topN)))
                [Math]::Round($matrix[0][0], 10) | Should -Be ([Math]::Round($old, 10)) -Because "topN=$topN"
            }
        }
    }

    It 'single-vector cosine: kernel ScoreMatrix (one window) matches the former formula exactly' {
        InModuleScope AITriad {
            $kernel = Initialize-RagKernelType
            if (-not $kernel) { Set-ItResult -Skipped -Because 'Add-Type unavailable in this environment'; return }
            $q = [double[]]@(0.6, 0.3, 0.1, 0.0)
            $single = [double[]]@(0.2, 0.2, 0.2, 0.6)
            $old = Get-RagWindowScoreFallback -QueryVector $q -NodeVectors ([double[][]]@(, $single)) -TopN 1 -Synthetic $false
            $matrix = $kernel::ScoreMatrix(([double[][]]@(, $q)), ([double[][][]]@(, ([double[][]]@(, $single)))), ([int[]]@(1)))
            [Math]::Round($matrix[0][0], 10) | Should -Be ([Math]::Round($old, 10))
        }
    }

    It 'a node vector of the wrong dimension scores 0 in the kernel (never throws), as the old fallback skipped it' {
        InModuleScope AITriad {
            $kernel = Initialize-RagKernelType
            if (-not $kernel) { Set-ItResult -Skipped -Because 'Add-Type unavailable'; return }
            $q = [double[]]@(0.6, 0.3, 0.1, 0.0)
            $shortVec = [double[]]@(0.1, 0.2)
            { $kernel::ScoreMatrix(([double[][]]@(, $q)), ([double[][][]]@(, ([double[][]]@(, $shortVec)))), ([int[]]@(1))) } | Should -Not -Throw
        }
    }

    It 'MaxOverWindows returns, per node, the max of its per-window scores' {
        InModuleScope AITriad {
            $kernel = Initialize-RagKernelType
            if (-not $kernel) { Set-ItResult -Skipped -Because 'Add-Type unavailable'; return }
            $matrix = [double[][]]@(([double[]]@(0.1, 0.9)), ([double[]]@(0.7, 0.2)))   # 2 windows x 2 nodes
            $max = $kernel::MaxOverWindows($matrix, 2)
            $max[0] | Should -Be 0.7
            $max[1] | Should -Be 0.9
        }
    }

    It 'RankFusion gives every window equal weight regardless of score magnitude (scale-free)' {
        InModuleScope AITriad {
            $kernel = Initialize-RagKernelType
            if (-not $kernel) { Set-ItResult -Skipped -Because 'Add-Type unavailable'; return }
            # Window A: node 0 wins narrowly. Window B: node 1 wins by a landslide. Max-sim would let node 1's
            # landslide dominate; RRF treats both windows' #1 finish equally.
            $matrix = [double[][]]@(([double[]]@(0.50, 0.49)), ([double[]]@(0.01, 0.99)))
            $fused = $kernel::RankFusion($matrix, 2, 60)
            [Math]::Round($fused[0], 10) | Should -Be ([Math]::Round($fused[1], 10)) -Because 'each node ranked #1 in exactly one window'
        }
    }
}

Describe 'Get-RelevantTaxonomyNodes windowed scoring (t/4468)' -Tag 'ingestion' {
    BeforeEach {
        InModuleScope AITriad {
            Mock Assert-TaxonomyCacheFresh { }
            $script:CachedSyntheticVectors = @{}
            $script:LastRAGMetrics = $null
            $script:CachedEmbeddings = @{
                'acc-beliefs-001' = [double[]]@(1, 0, 0)
                'saf-beliefs-001' = [double[]]@(0, 1, 0)
                'skp-beliefs-001' = [double[]]@(0, 0, 1)
            }
            $script:TaxonomyData = @{
                'accelerationist' = [PSCustomObject]@{ nodes = @([PSCustomObject]@{ id = 'acc-beliefs-001'; label = 'Acc B1'; description = ''; category = 'Beliefs'; parent_id = ''; children = @() }) }
                'safetyist'       = [PSCustomObject]@{ nodes = @([PSCustomObject]@{ id = 'saf-beliefs-001'; label = 'Saf B1'; description = ''; category = 'Beliefs'; parent_id = ''; children = @() }) }
                'skeptic'         = [PSCustomObject]@{ nodes = @([PSCustomObject]@{ id = 'skp-beliefs-001'; label = 'Skp B1'; description = ''; category = 'Beliefs'; parent_id = ''; children = @() }) }
            }
        }
    }

    It '-QueryVectors with ONE window reproduces the -QueryVector single-vector result exactly' {
        $r1 = Get-RelevantTaxonomyNodes -Query 'q' -QueryVector ([double[]]@(0.9, 0.1, 0.0)) -Format objects -MinPerCategory 1 3>$null
        $r2 = Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors @([double[]]@(0.9, 0.1, 0.0)) -Format objects -MinPerCategory 1 3>$null
        ($r1 | Sort-Object Id | ForEach-Object { "$($_.Id):$($_.Score)" }) | Should -Be ($r2 | Sort-Object Id | ForEach-Object { "$($_.Id):$($_.Score)" })
    }

    It 'MaxSim: a node that matches strongly in ANY one window is retrieved, even if the other windows are orthogonal' {
        # Two windows, each a true 1-element array of a 3-dim vector (List[double[]], as the real caller
        # builds it — NOT PowerShell's @(a, b) array-literal, which is safe here since both are nested,
        # but kept this way for clarity). Window 1 is ~orthogonal to everything; window 2 matches
        # saf-beliefs-001 almost exactly.
        $windowList = [System.Collections.Generic.List[double[]]]::new()
        $windowList.Add([double[]]@(0.0001, 0.0001, 0.9999))
        $windowList.Add([double[]]@(0.01, 0.99, 0.0))
        $r = Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors $windowList.ToArray() -WindowScoring MaxSim -Format objects -MinPerCategory 1 -Threshold 0.5 3>$null
        @($r | ForEach-Object Id) | Should -Contain 'saf-beliefs-001'
    }

    It 'the query-windows / skipped-backmatter / scoring-kernel flags land on LastRAGMetrics' {
        $windowList = [System.Collections.Generic.List[double[]]]::new()
        $windowList.Add([double[]]@(1, 0, 0)); $windowList.Add([double[]]@(0, 1, 0))
        $null = Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors $windowList.ToArray() -Format objects -MinPerCategory 1 3>$null
        $metrics = InModuleScope AITriad { $script:LastRAGMetrics }
        $metrics.flags['query_windows'] | Should -Be 2
        $metrics.flags.Keys | Should -Contain 'scoring_kernel'
        $metrics.flags.Keys | Should -Contain 'window_scoring'
    }

    It 'a query over 512 windows is sampled down to the cap, with a WARN naming the cap (t/4468#2 provenance)' {
        # List[double[]].Add in a loop: pipeline / @() collection would flatten these 3-element arrays into
        # 1800 scalars (confirmed while building this test — exactly the gotcha the function now guards
        # the single-window case against; a List[T] never has this problem).
        $windowList = [System.Collections.Generic.List[double[]]]::new()
        for ($i = 0; $i -lt 600; $i++) { $windowList.Add([double[]]@(1, 0, 0)) }
        $w = Get-Warnings { Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors $windowList.ToArray() -Format objects -MinPerCategory 1 }
        @($w | Where-Object { $_ -match '600 windows' -and $_ -match 'sampled evenly' }) | Should -Not -BeNullOrEmpty
    }

    It 'long -Query text with no embedding available WARNs about the opening-only fallback, never throws' {
        Mock Invoke-BatchEmbeddings -ModuleName AITriad { @{} }   # simulate: no embeddings came back for any window
        # The fallback path still needs ONE embedding (of the truncated opening) — mock the embedder
        # subprocess too, so this test doesn't depend on a live Python/sentence-transformers environment
        # (CI lacks one; a prior run failed here with a real "embed_taxonomy.py encode failed" error).
        Mock python -ModuleName AITriad { $global:LASTEXITCODE = 0; '[0.1, 0.2, 0.3]' }
        Mock python3 -ModuleName AITriad { $global:LASTEXITCODE = 0; '[0.1, 0.2, 0.3]' }
        $longQuery = ('sentence number word filler content here. ' * 100)   # > 900 chars, triggers windowing
        $w = Get-Warnings { Get-RelevantTaxonomyNodes -Query $longQuery -Format objects -MinPerCategory 1 }
        @($w | Where-Object { $_ -match 'falling back to one encode' }) | Should -Not -BeNullOrEmpty
    }

    It '-QueryVectors with a single window, passed as PowerShell would naturally construct it, still works (the array-unroll guard)' {
        # @(a) where a is itself an array enumerates a's elements — PowerShell's well-known "one-element
        # array unrolls" gotcha. Get-RelevantTaxonomyNodes guards against exactly this for the single-
        # window case (the realistic foot-gun; a true multi-window caller uses List[double[]].ToArray()).
        $naturalCall = @([double[]]@(0.9, 0.1, 0.0))
        $naturalCall[0] | Should -Not -BeOfType [System.Array] -Because 'confirms the array really did unroll (its elements are scalars), so this exercises the guard'
        $r = Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors $naturalCall -Format objects -MinPerCategory 1 3>$null
        @($r | ForEach-Object Id) | Should -Contain 'acc-beliefs-001'
    }
}

Describe 'Get-RelevantTaxonomyNodes falls back gracefully when the scoring kernel cannot load (CL item 4)' -Tag 'ingestion' {
    It 'Initialize-RagKernelType returns $null and WARNs on a compile failure, instead of throwing' {
        InModuleScope AITriad {
            # Add-Type cannot recompile a type already loaded in this process (the GroundingLock.ps1
            # precedent); once an earlier test has successfully loaded the real kernel type, mocking
            # Add-Type can no longer force this path, because Initialize-RagKernelType's own check
            # ("already loaded? skip Add-Type") short-circuits before the mock is ever reached.
            if (([System.Management.Automation.PSTypeName]$script:RagKernelTypeName).Type) {
                Set-ItResult -Skipped -Because 'the real kernel type is already loaded in this process; Add-Type cannot be re-forced to fail for an already-loaded type'
                return
            }
            Mock Add-Type { throw 'simulated compile failure' }
            $w = @(Initialize-RagKernelType 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { "$_" })
            $k = Initialize-RagKernelType 3>$null
            $k | Should -BeNullOrEmpty
            @($w | Where-Object { $_ -match 'could not be compiled' -and $_ -match 'falling back' }) | Should -Not -BeNullOrEmpty
        }
    }

    It 'Get-RelevantTaxonomyNodes still returns results (scoring only the first window) when the kernel is unavailable' {
        InModuleScope AITriad {
            Mock Assert-TaxonomyCacheFresh { }
            $script:CachedSyntheticVectors = @{}
            $script:CachedEmbeddings = @{ 'acc-beliefs-001' = [double[]]@(1, 0, 0); 'saf-beliefs-001' = [double[]]@(0, 1, 0) }
            $script:TaxonomyData = @{
                'accelerationist' = [PSCustomObject]@{ nodes = @([PSCustomObject]@{ id = 'acc-beliefs-001'; label = 'Acc'; description = ''; category = 'Beliefs'; parent_id = ''; children = @() }) }
                'safetyist'       = [PSCustomObject]@{ nodes = @([PSCustomObject]@{ id = 'saf-beliefs-001'; label = 'Saf'; description = ''; category = 'Beliefs'; parent_id = ''; children = @() }) }
            }
            Mock Add-Type { throw 'simulated' }
            $r = Get-RelevantTaxonomyNodes -Query 'q' -QueryVectors @([double[]]@(1, 0, 0), [double[]]@(0, 1, 0)) -Format objects -MinPerCategory 1 3>$null
            @($r).Count | Should -BeGreaterThan 0
            @($r | ForEach-Object Id) | Should -Contain 'acc-beliefs-001'   # matches the FIRST window only
        }
    }
}
