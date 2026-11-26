# Tag: config (t/596)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    The summary producers other than Build-NodeSourceIndex fold a listed legacy chunk into its base
    (t/596, spec 6.2 and 7.4/7.5).
.DESCRIPTION
    A summary the legacy-chunk manifest lists is part of its base document. It is not read as a document
    of its own, and its key points and claims count under the base, once per document: taxonomy health
    (Read-TaxonomySummaryCorpus), Get-TopicFrequency, Get-AITClaim and Invoke-QbafConflictAnalysis.
    The control arm is the same tree with an empty manifest: the chunk is then its own document.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:Long = ((1..120 | ForEach-Object { "word$_" }) -join ' ')
    function script:WriteJson([string]$Path, $Obj) {
        [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    }
    function script:SetManifest([hashtable]$Entries) {
        & (Get-Module AITriad) {
            param($Entries)
            $m = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
            foreach ($k in $Entries.Keys) { $m[[string]$k] = [string]$Entries[$k] }
            $script:EvidenceLegacyChunkManifest = $m
            $script:SourceResolutionCache = @{}
        } $Entries
    }
    function script:New-SrcDoc([string]$Root, [string]$Id, [string]$Body) {
        $d = Join-Path $Root $Id
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $d 'metadata.json'), (@{ id = $Id; title = $Id } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $d 'snapshot.md'), $Body, [Text.UTF8Encoding]::new($false))
    }
    function script:New-ChunkFixture {
        # paper-2026 has a source folder and a summary. paper-2026-2 is a legacy chunk: a summary with no source
        # folder. other-2026 is an unrelated document.
        $root = Join-Path ([IO.Path]::GetTempPath()) "ait-chunkfold-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $src = Join-Path $root 'sources'; $sum = Join-Path $root 'summaries'; $tax = Join-Path $root 'taxonomy'
        New-Item -ItemType Directory -Path $src, $sum, $tax -Force | Out-Null
        script:New-SrcDoc $src 'paper-2026' "# Paper`n`n$script:Long`n"
        script:New-SrcDoc $src 'other-2026' "# Other`n`n$script:Long other`n"
        script:WriteJson (Join-Path $tax 'safetyist.json') @{ nodes = @(@{ id = 'saf-beliefs-001' }) }
        script:WriteJson (Join-Path $tax 'accelerationist.json') @{ nodes = @(@{ id = 'acc-beliefs-001' }) }
        script:WriteJson (Join-Path $tax 'skeptic.json') @{ nodes = @() }
        script:WriteJson (Join-Path $sum 'paper-2026.json') @{
            doc_id = 'paper-2026'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; point = 'Same point'; stance = 'supports' }) } }
            factual_claims = @(@{ claim = 'Same claim'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'supports'; extraction_confidence = 0.7 })
            unmapped_concepts = @(@{ concept = 'Shared concept' })
        }
        # The chunk repeats the base's node, claim and concept, and adds a node, a claim and a concept of its own
        # (the node and the concept twice, to prove repetition inside one document does not count).
        script:WriteJson (Join-Path $sum 'paper-2026-2.json') @{
            doc_id = 'paper-2026-2'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ skeptic = @{ key_points = @() }
                accelerationist = @{ key_points = @(
                        @{ taxonomy_node_id = 'acc-beliefs-001'; point = 'chunk-only node'; stance = 'supports' }
                        @{ taxonomy_node_id = 'acc-beliefs-001'; point = 'chunk-only node again'; stance = 'supports' }) }
                safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; point = 'Same point'; stance = 'supports' }) } }
            factual_claims = @(
                @{ claim = 'Same claim.'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'supports'; extraction_confidence = 0.95 }
                @{ claim = 'A different claim only the chunk has'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'disputes'; extraction_confidence = 0.8 })
            unmapped_concepts = @(@{ concept = 'Shared Concept' }, @{ concept = 'Chunk-only concept' }, @{ concept = 'chunk-only   CONCEPT' })
        }
        script:WriteJson (Join-Path $sum 'other-2026.json') @{
            doc_id = 'other-2026'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Other quote'; point = 'Other point'; stance = 'supports' }) } }
        }
        [pscustomobject]@{ Root = $root; Src = $src; Sum = $sum; Tax = $tax }
    }
}

AfterAll {
    & (Get-Module AITriad) { $script:EvidenceLegacyChunkManifest = $null; $script:SourceResolutionCache = @{} }
}

Describe 'A listed legacy chunk counts under its base, once per document (t/596, spec 7.5)' -Tag 'config' {
    BeforeEach {
        $script:F = script:New-ChunkFixture
        script:SetManifest @{ 'paper-2026-2' = 'paper-2026' }
    }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'health: a node only the chunk cites counts once for the base; a shared node is unchanged; no stats row for the chunk' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{}
            foreach ($n in 'saf-beliefs-001', 'acc-beliefs-001') { $ni[$n] = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $scan = Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null
            $ni['saf-beliefs-001'].Citations | Should -Be 2 -Because 'paper-2026 and other-2026; the chunk repeats a node its base already counts'
            @($ni['saf-beliefs-001'].DocIds | Sort-Object) | Should -Be @('other-2026', 'paper-2026')
            $ni['acc-beliefs-001'].Citations | Should -Be 1 -Because 'the chunk cites it twice, but the base and its chunk are one document'
            @($ni['acc-beliefs-001'].DocIds) | Should -Be @('paper-2026')
            @($scan.SummaryStats).Count | Should -Be 2
            @($scan.SummaryStats.DocId) | Should -Not -Contain 'paper-2026-2'
        }
    }

    It 'health: an unmapped concept only the chunk names counts once, under the base' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{ 'saf-beliefs-001' = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $agg = (Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null).UnmappedAgg
            $agg['shared concept'].Frequency | Should -Be 1
            @($agg['shared concept'].ContributingDocs) | Should -Be @('paper-2026')
            $agg['chunk-only concept'].Frequency | Should -Be 1 -Because 'named twice by one chunk of one document'
            @($agg['chunk-only concept'].ContributingDocs) | Should -Be @('paper-2026')
        }
    }

    It 'health, control arm: with an empty manifest the chunk is a document of its own' {
        script:SetManifest @{}
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{ 'acc-beliefs-001' = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $scan = Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null
            @($ni['acc-beliefs-001'].DocIds) | Should -Be @('paper-2026-2')
            @($scan.SummaryStats).Count | Should -Be 3
        }
    }

    It 'topic frequency: a node only the chunk cites counts once for the base; the chunk is not a summary of its own' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-SummariesDir { $F.Sum }; Mock Get-SourcesDir { $F.Src }; Mock Get-TaxonomyDir { Join-Path $F.Root 'no-taxonomy' }
            $r = Get-TopicFrequency -NoAI 6>$null 3>$null
            $j = $r | ConvertTo-Json -Depth 8 | ConvertFrom-Json
            $nodes = @($j.topics_by_pov.PSObject.Properties | ForEach-Object { @($_.Value) } | ForEach-Object { @($_.member_nodes) })
            @($nodes | Where-Object id -eq 'acc-beliefs-001').citations | Should -Be 1
            @($nodes | Where-Object id -eq 'saf-beliefs-001').citations | Should -Be 2 -Because 'paper-2026 and other-2026, not 3'
            ($r | ConvertTo-Json -Depth 8) | Should -Not -Match 'paper-2026-2'
            $r.summary_count | Should -Be 2
        }
    }
}

Describe 'Claim listing and conflict analysis take a chunk''s distinct claims under its base (t/596, spec 7.4/7.5)' -Tag 'config' {
    BeforeEach {
        $script:F = script:New-ChunkFixture
        script:SetManifest @{ 'paper-2026-2' = 'paper-2026' }
        Mock Get-SourcesDir   -ModuleName AITriad { $script:F.Src }
        Mock Get-SummariesDir -ModuleName AITriad { $script:F.Sum }
    }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Get-AITClaim lists the chunk''s distinct claim under the base with Via, and not its near-duplicate' {
        $c = @(Get-AITClaim -Type FactualClaim 3>$null | Where-Object DocId -like 'paper*')
        @($c.Text | Sort-Object) | Should -Be @('A different claim only the chunk has', 'Same claim')
        ($c | Where-Object Text -eq 'A different claim only the chunk has').DocId | Should -BeExactly 'paper-2026'
        ($c | Where-Object Text -eq 'A different claim only the chunk has').Via | Should -BeExactly 'paper-2026-2'
        ($c | Where-Object Text -eq 'Same claim').Via | Should -BeNullOrEmpty
    }

    It 'Get-AITClaim: a filter can''t let the chunk''s near-duplicate through' {
        @(Get-AITClaim -Type FactualClaim -MinConfidence 0.9 3>$null | Where-Object DocId -like 'paper*').Count | Should -Be 0
    }

    It 'Get-AITClaim: an exact -DocId still returns the chunk''s own claims as itself' {
        $own = @(Get-AITClaim -DocId 'paper-2026-2' -Type FactualClaim 3>$null)
        $own.Count | Should -Be 2
        @($own | Where-Object { $_.Via }).Count | Should -Be 0
    }

    It 'Get-AITClaim, control arm: with an empty manifest the chunk''s claims are listed under the chunk' {
        script:SetManifest @{}
        @(Get-AITClaim -Type FactualClaim 3>$null | Where-Object DocId -eq 'paper-2026-2').Count | Should -Be 2
    }

    It 'QBAF: the chunk''s distinct claim is loaded under the base and never conflicts with its own base' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-DataRoot      { $F.Root }
            Mock Get-TextEmbedding { $null }
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null 3>$null
            $r.ClaimCount | Should -Be 2 -Because 'the base''s claim and the chunk''s distinct one; the near-duplicate is dropped'
            $r.AttackCount | Should -Be 0 -Because 'a supports/disputes pair inside one document is not a conflict between documents (spec 7.5)'
        }
    }

    It 'QBAF, control arm: with an empty manifest the chunk is its own document and the pair is an attack' {
        script:SetManifest @{}
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-DataRoot      { $F.Root }
            Mock Get-TextEmbedding { $null }
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null 3>$null
            $r.ClaimCount | Should -Be 3
            $r.AttackCount | Should -Be 1
        }
    }
}
