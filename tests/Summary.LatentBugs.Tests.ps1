# Tag: summarization (t/4144)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the five latent summary-path bugs the Finalize-Summary characterization (#3186)
    found and pinned (t/4144). Each Describe fails if its fix is reverted.
.DESCRIPTION
    1. Resolve-UnmappedConcepts: the Jaccard (no-embeddings) path threw under StrictMode when a concept had
       no suggested_description (an if/else yielding @() collapsed to $null, then .Count).
    2. Get-TaxonomyNodeIdSet: a bare `return $IdSet` unrolled the OrdinalIgnoreCase HashSet into object[]
       (or a lone string), so the hallucination check became case-sensitive.
    3. New-ContextRotStage flags were [ordered]@{} + <plain @{}>, so their key order varied per process;
       and metadata.json's context_rot.worst_stage could be the mixed-unit extraction (density) stage.
    4. New-SummaryModelInfo labelled the compact-taxonomy RAG fallback taxonomy_filter "full" with 0 nodes.
    5. Invoke-DocumentSummary splatted -IterativeExtraction / -AutoFire into Invoke-ChunkedSummary, which
       does not declare them ("A parameter cannot be found").
    No AI call is made: nothing here reaches Invoke-AIApi.
#>

BeforeAll {
    $script:ModulePsm1 = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue

    # A tiny taxonomy dir: lower-case ids, as the live files store them.
    $script:TaxDir = Join-Path $TestDrive 'taxonomy'
    New-Item -ItemType Directory -Path $script:TaxDir -Force | Out-Null
    $nodes = @{
        'accelerationist.json' = @(@{ id = 'acc-beliefs-001'; category = 'Beliefs'; label = 'Scaling compute delivers gains' },
                                   @{ id = 'acc-desires-002'; category = 'Desires'; label = 'Permissionless open release' })
        'safetyist.json'       = @(@{ id = 'saf-beliefs-003'; category = 'Beliefs'; label = 'Oversight gap' })
        'skeptic.json'         = @(@{ id = 'skp-beliefs-001'; category = 'Beliefs'; label = 'Hype cycle' })
        'situations.json'      = @(@{ id = 'sit-004'; category = 'Situations'; label = 'Audit market' })
    }
    foreach ($f in $nodes.Keys) {
        @{ nodes = $nodes[$f] } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $script:TaxDir $f) -Encoding utf8NoBOM
    }
}

AfterAll {
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
}

Describe 'Resolve-UnmappedConcepts Jaccard path (t/4144 item 1)' -Tag 'summarization' {

    It 'resolves a concept with no suggested_description without throwing' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = $null      # forces the Jaccard fallback
            $script:ContextRotStages = @()
            $tax = @{ accelerationist = [pscustomobject]@{ nodes = @(
                        [pscustomobject]@{ id = 'acc-beliefs-001'; category = 'Beliefs'; label = 'Scaling compute delivers gains' }) } }
            $concepts = @(
                [pscustomobject]@{ suggested_label = 'Scaling compute delivers gains'; concept = 'no suggested_description here' }
                [pscustomobject]@{ suggested_label = 'Incident disclosure clocks' }
            )
            $r = Resolve-UnmappedConcepts -UnmappedConcepts $concepts -TaxonomyData $tax
            @($r.Resolved).Count | Should -Be 1
            $r.Resolved[0].MatchedNodeId | Should -Be 'acc-beliefs-001'
            @($r.Remaining).Count | Should -Be 1
            $r.Remaining[0].suggested_label | Should -Be 'Incident disclosure clocks'
        }
    }

    It 'tolerates labels and descriptions that tokenize to nothing (all stop words)' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = $null
            $script:ContextRotStages = @()
            $tax = @{ skeptic = [pscustomobject]@{ nodes = @([pscustomobject]@{ id = 'skp-beliefs-001'; label = 'The'; category = 'Beliefs' }) } }
            $concepts = @([pscustomobject]@{ suggested_label = 'of the'; suggested_description = 'and the' })
            $r = Resolve-UnmappedConcepts -UnmappedConcepts $concepts -TaxonomyData $tax
            @($r.Resolved).Count | Should -Be 0
            @($r.Remaining).Count | Should -Be 1
        }
    }
}

Describe 'Get-TaxonomyNodeIdSet keeps its case-insensitive HashSet (t/4144 item 2)' -Tag 'summarization' {

    BeforeEach {
        # The mock body runs in this test file's scope, so it reads the test's $script:TaxDir.
        Mock Get-TaxonomyDir -ModuleName AITriad { $script:TaxDir }
        InModuleScope AITriad {
            $script:TaxonomyNodeIdSet = $null
            $script:TaxonomyNodeIdSetTimestamp = [datetime]::MinValue
        }
    }

    It 'returns the HashSet itself, fresh and cached' {
        InModuleScope AITriad {
            foreach ($pass in 'fresh', 'cached') {
                $set = Get-TaxonomyNodeIdSet
                $set.GetType().Name | Should -Be 'HashSet`1' -Because "the $pass result must not be unrolled"
                $set.Comparer | Should -Be ([System.StringComparer]::OrdinalIgnoreCase)
                $set.Contains('ACC-Beliefs-001') | Should -BeTrue
            }
        }
    }

    It 'Test-TaxonomyNodeId accepts a mixed-case id and still rejects an unknown one' {
        InModuleScope AITriad {
            Test-TaxonomyNodeId -NodeId 'ACC-Beliefs-001' | Should -BeTrue
            Test-TaxonomyNodeId -NodeId 'saf-beliefs-999' | Should -BeFalse
        }
    }

    It 'the hallucination check (real node-ID set) keeps ACC-Beliefs-001 and moves only the unknown id' {
        InModuleScope AITriad {
            $summary = '{ "pov_summaries": {
                "accelerationist": { "key_points": [ { "taxonomy_node_id": "ACC-Beliefs-001", "point": "Case differs." } ] },
                "safetyist": { "key_points": [ { "taxonomy_node_id": "saf-beliefs-999", "point": "Unknown id." } ] },
                "skeptic": { "key_points": [] } }, "unmapped_concepts": [] }' | ConvertFrom-Json
            $bad = Move-HallucinatedNodeIdsToUnmapped -SummaryObject $summary 6>$null
            @($bad) | Should -Be @('safetyist/saf-beliefs-999')
            $summary.pov_summaries.accelerationist.key_points[0].taxonomy_node_id | Should -Be 'ACC-Beliefs-001'
        }
    }
}

Describe 'context_rot determinism and worst_stage (t/4144 item 3)' -Tag 'summarization' {

    It 'stage flags come out in ordinal key order, identically across 3 processes' {
        $src = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'New-ContextRotStage.ps1'
        $cmd = ". '$src'; New-ContextRotStage -Stage s -InUnits a -InCount 10 -OutUnits a -OutCount 5 -Flags @{ " +
               "zeta = 1; alpha = 2; mid_one = 3; beta = 4; omega = 5; kappa = 6; delta = 7; gamma = 8; epsilon = 9 } | ConvertTo-Json -Compress"
        $outs = foreach ($i in 1..3) { & pwsh -NoProfile -NonInteractive -Command $cmd }
        @($outs | Select-Object -Unique).Count | Should -Be 1 -Because 'the bytes must not depend on the process'
        $flags = ($outs[0] | ConvertFrom-Json -AsHashtable).flags
        @($flags.Keys) | Should -Be @('alpha', 'beta', 'delta', 'epsilon', 'gamma', 'kappa', 'mid_one', 'omega', 'zeta')
    }

    It 'worst_stage is chosen only from retention (same-unit) stages' {
        InModuleScope AITriad -Parameters @{ Root = $TestDrive } {
            param($Root)
            $metaFile = Join-Path $Root 'worst-stage-meta.json'
            '{ "title": "t" }' | Set-Content -LiteralPath $metaFile -Encoding utf8NoBOM
            $stages = @(
                (New-ContextRotStage -Stage 'rag_filtering' -InUnits 'nodes' -InCount 400 -OutUnits 'nodes' -OutCount 100)
                (New-ContextRotStage -Stage 'extraction' -InUnits 'prompt_chars' -InCount 20000 -OutUnits 'items' -OutCount 12)
                (New-ContextRotStage -Stage 'unmapped_resolution' -InUnits 'concepts' -InCount 4 -OutUnits 'still_unmapped' -OutCount 0)
                (New-ContextRotStage -Stage 'dedup' -InUnits 'items' -InCount 10 -OutUnits 'items' -OutCount 8)
            )
            $rot = New-ContextRotMetrics -Pipeline 'summary' -DocId 'd' -Stages $stages
            Update-SummaryMetadata -Doc @{ MetaFile = $metaFile } -TaxonomyVersion 'v' -Now 'n' -FactualClaims @() `
                -FactualCount 0 -TotalPoints 0 -UnmappedCount 0 -ContextRot $rot -ContextRotStages $stages
            $m = Get-Content -Raw -LiteralPath $metaFile | ConvertFrom-Json
            $m.context_rot.worst_stage | Should -Be 'rag_filtering'
            $m.context_rot.worst_ratio | Should -Be 0.25
        }
    }

    It 'worst_stage is null when no retention stage exists' {
        InModuleScope AITriad -Parameters @{ Root = $TestDrive } {
            param($Root)
            $metaFile = Join-Path $Root 'worst-stage-none-meta.json'
            '{ "title": "t" }' | Set-Content -LiteralPath $metaFile -Encoding utf8NoBOM
            $stages = @((New-ContextRotStage -Stage 'extraction' -InUnits 'prompt_chars' -InCount 20000 -OutUnits 'items' -OutCount 12))
            $rot = New-ContextRotMetrics -Pipeline 'summary' -DocId 'd' -Stages $stages
            Update-SummaryMetadata -Doc @{ MetaFile = $metaFile } -TaxonomyVersion 'v' -Now 'n' -FactualClaims @() `
                -FactualCount 0 -TotalPoints 0 -UnmappedCount 0 -ContextRot $rot -ContextRotStages $stages
            $m = Get-Content -Raw -LiteralPath $metaFile | ConvertFrom-Json
            $m.context_rot.worst_stage | Should -BeNullOrEmpty
            $m.context_rot.worst_ratio | Should -BeNullOrEmpty
        }
    }
}

Describe 'Compact-taxonomy fallback label (t/4144 item 4)' -Tag 'summarization' {

    It 'labels the compact taxonomy "compact" with its real node count' {
        Mock Get-TaxonomyDir -ModuleName AITriad { $script:TaxDir }
        InModuleScope AITriad {
            $compact = Build-CompactTaxonomy
            $info = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson $compact -ChunkCount 0 -FireStats $null
            $info.taxonomy_filter | Should -Be 'compact'
            $info.taxonomy_nodes | Should -Be 5
        }
    }

    It 'still labels RAG and full contexts as before' {
        InModuleScope AITriad {
            $rag = "=== RELEVANT TAXONOMY NODES ===`n  acc-beliefs-001: Scale`n  saf-beliefs-003: Audits"
            (New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson $rag -ChunkCount 0 -FireStats $null).taxonomy_filter | Should -Be 'rag'
            $full = '{"nodes":[{"id":"acc-beliefs-001"},{"id":"saf-beliefs-003"}]}'
            $i = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson $full -ChunkCount 0 -FireStats $null
            $i.taxonomy_filter | Should -Be 'full'
            $i.taxonomy_nodes | Should -Be 2
        }
    }
}

Describe 'Chunked-path parameter binding (t/4144 item 5)' -Tag 'summarization' {

    BeforeAll {
        $script:BigSnapshot = Join-Path $TestDrive 'big-snapshot.md'
        # > 20,000 estimated tokens (chars / 4) so Invoke-DocumentSummary takes the chunked path.
        Set-Content -LiteralPath $script:BigSnapshot -Value ('word ' * 20000) -Encoding utf8NoBOM
    }

    It 'accepts -<Switch> on a chunked document, drops it with a WARN, and forwards everything else' -ForEach @(
        @{ Switch = 'IterativeExtraction' }
        @{ Switch = 'AutoFire' }
    ) {
        Mock Invoke-ChunkedSummary -ModuleName AITriad { @{ Success = $true; DocId = $Doc.DocId; Gate = $EnablePolarityGate } }
        $p = @{
            Doc = @{ DocId = 'big-doc'; PovTags = @('safetyist'); SnapshotFile = $script:BigSnapshot; Meta = [pscustomobject]@{ title = 'Big' } }
            ApiKey = 'fixture-not-a-real-key'; Model = 'gemini-3.5-flash-lite'; Temperature = 0.1; TaxonomyVersion = 'v'
            TaxonomyJson = '{}'; SystemPromptTemplate = 'x'; OutputSchema = '{}'; SummariesDir = $TestDrive; Now = 'n'
            EnablePolarityGate = $false
        }
        $p[$Switch] = $true
        $out = @(& (Get-Module AITriad) { param($P) Invoke-DocumentSummary @P 3>&1 6>$null } $p)
        $warn = @($out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
        $r = @($out | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] })[0]
        $r.Success | Should -BeTrue
        $r.Gate | Should -BeFalse -Because '-EnablePolarityGate is still forwarded'
        Should -Invoke Invoke-ChunkedSummary -ModuleName AITriad -Times 1 -Exactly
        @($warn | Where-Object { $_.Message -match "-$Switch ignored for big-doc" }).Count | Should -Be 1
    }

    It 'does not warn when the switches are not set' {
        Mock Invoke-ChunkedSummary -ModuleName AITriad { @{ Success = $true } }
        $p = @{
            Doc = @{ DocId = 'big-doc'; PovTags = @('safetyist'); SnapshotFile = $script:BigSnapshot; Meta = [pscustomobject]@{ title = 'Big' } }
            ApiKey = 'k'; Model = 'gemini-3.5-flash-lite'; Temperature = 0.1; TaxonomyVersion = 'v'
            TaxonomyJson = '{}'; SystemPromptTemplate = 'x'; OutputSchema = '{}'; SummariesDir = $TestDrive; Now = 'n'
            AutoFire = $false
        }
        $out = @(& (Get-Module AITriad) { param($P) Invoke-DocumentSummary @P 3>&1 6>$null } $p)
        $warn = @($out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
        $r = @($out | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] })[0]
        $r.Success | Should -BeTrue
        @($warn | Where-Object { $_.Message -match 'ignored for' }).Count | Should -Be 0
    }
}
