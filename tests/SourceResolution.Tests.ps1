# Tag: source-identity (t/4337 C1/C2)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    The module's duplicate_of resolver (docs/specs/source-identity.md section 6) and the evidence and
    selection sites that use it. Each choke point is tested on both arms (SO C2, e/342#2): a duplicate
    pair yields ONE evidence unit, and the marked id still resolves by lookup.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:Long = ((1..120 | ForEach-Object { "word$_" }) -join ' ')
    function script:New-SrcDoc([string]$Root, [string]$Id, [hashtable]$Meta, [string]$Body) {
        $d = Join-Path $Root $Id
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        if ($null -ne $Meta) {
            $m = [ordered]@{ id = $Id }; foreach ($k in $Meta.Keys) { $m[$k] = $Meta[$k] }
            [IO.File]::WriteAllText((Join-Path $d 'metadata.json'), ($m | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        }
        [IO.File]::WriteAllText((Join-Path $d 'snapshot.md'), $Body, [Text.UTF8Encoding]::new($false))
    }
    function script:WriteJson([string]$Path, $Obj) {
        [IO.File]::WriteAllText($Path, ($Obj | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    }
    function script:New-Fixture {
        # A doc, its byte-identical marked copy, and an unrelated doc; summaries for all three,
        # where the doc and its copy cite the same node with the same quote.
        $root = Join-Path ([IO.Path]::GetTempPath()) "ait-srcres-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $src = Join-Path $root 'sources'; $sum = Join-Path $root 'summaries'; $tax = Join-Path $root 'taxonomy'
        New-Item -ItemType Directory -Path $src, $sum, $tax -Force | Out-Null
        $body = "# Report`n`n$script:Long`n"
        script:New-SrcDoc $src 'report-2026'   @{ title = 'Report' } $body
        script:New-SrcDoc $src 'report-2026-1' @{ title = 'Report'; duplicate_of = 'report-2026'; duplicate_of_ref = 't4337-test#1' } $body
        script:New-SrcDoc $src 'other-2026'    @{ title = 'Other' } "# Other`n`n$script:Long other`n"
        script:WriteJson (Join-Path $tax 'safetyist.json') @{ nodes = @(@{ id = 'saf-beliefs-001' }) }
        script:WriteJson (Join-Path $tax 'accelerationist.json') @{ nodes = @(@{ id = 'acc-beliefs-001' }) }
        script:WriteJson (Join-Path $tax 'skeptic.json') @{ nodes = @() }
        foreach ($id in 'report-2026', 'report-2026-1') {
            script:WriteJson (Join-Path $sum "$id.json") @{
                doc_id = $id; generated_at = '2026-10-01T00:00:00Z'
                pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                                   safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; extraction_confidence = 0.8; stance = 'supports'; category = 'Beliefs'; point = 'Same point' }) } }
                factual_claims = @(@{ claim = 'Same claim'; linked_taxonomy_nodes = @('saf-beliefs-001'); extraction_confidence = 0.7 })
            }
        }
        script:WriteJson (Join-Path $sum 'other-2026.json') @{
            doc_id = 'other-2026'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                               safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Other quote'; extraction_confidence = 0.6; stance = 'supports'; category = 'Beliefs'; point = 'Other point' }) } }
        }
        [pscustomobject]@{ Root = $root; Src = $src; Sum = $sum; Tax = $tax; NoIndex = (Join-Path $root 'no-sources-index.json') }
    }
}

Describe 'Get-SourceResolution (spec section 6)' -Tag 'source-identity' {
    BeforeEach { $script:F = script:New-Fixture }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'resolves a valid mark to its target, leaves others alone, and reports no errors' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            Resolve-SourceId -Resolution $r -Id 'report-2026-1' | Should -BeExactly 'report-2026'
            Resolve-SourceId -Resolution $r -Id 'report-2026'   | Should -BeExactly 'report-2026'
            Resolve-SourceId -Resolution $r -Id 'not-a-doc'     | Should -BeExactly 'not-a-doc'
            Test-SourceSelectable -Resolution $r -Id 'report-2026-1' | Should -BeFalse
            Test-SourceSelectable -Resolution $r -Id 'report-2026'   | Should -BeTrue
            @($r.Errors).Count | Should -Be 0
            @($r.MarkPairs) | Should -Be @('report-2026-1=>report-2026')
        }
    }

    It 'reads metadata directly (noted on Verbose) without an index, and uses a fresh index otherwise' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $v = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex -Verbose 4>&1 3>$null | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] }
            (@($v) -join "`n") | Should -Match 'not using sources-index.json'
            $r0 = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            $r0.Source | Should -Be 'metadata'
            $ix = Join-Path $F.Root 'sources-index.json'
            Export-SourcesIndex -SourcesDir $F.Src -OutputPath $ix 3>$null | Out-Null
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $ix 3>$null
            $r.Source | Should -Be 'sources-index.json'
            Resolve-SourceId -Resolution $r -Id 'report-2026-1' | Should -BeExactly 'report-2026'
        }
    }

    It 'treats an invalid mark as absent and WARNs (chain)' {
        script:New-SrcDoc $script:F.Src 'other-2026-1' @{ title = 'Other'; duplicate_of = 'report-2026-1' } "# x`n`n$script:Long x`n"
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex -WarningVariable w 3>$null
            Resolve-SourceId -Resolution $r -Id 'other-2026-1' | Should -BeExactly 'other-2026-1'
            Test-SourceSelectable -Resolution $r -Id 'other-2026-1' | Should -BeTrue
            @($r.Errors | ForEach-Object kind) | Should -Be @('chain')
            ($w -join "`n") | Should -Match "invalid duplicate_of on 'other-2026-1'"
        }
    }

    It 'applies no marks and WARNs when the sources directory is missing' {
        InModuleScope AITriad {
            $r = Get-SourceResolution -SourcesDir (Join-Path ([IO.Path]::GetTempPath()) 'no-such-sources-dir') -WarningVariable w 3>$null
            $r.Marked.Count | Should -Be 0
            ($w -join "`n") | Should -Match 'marks are not applied'
        }
    }
}

Describe 'Get-SourceMarksHash (content hash of the mark set)' -Tag 'source-identity' {
    It 'changes when a mark is added, removed, swapped or re-pointed' {
        InModuleScope AITriad {
            function Res([string[]]$Pairs) { $r = New-IdentitySourceResolution; $r.MarkPairs = $Pairs; $r }
            $empty   = Get-SourceMarksHash -Resolution (Res @())
            $one     = Get-SourceMarksHash -Resolution (Res @('a=>b'))
            $two     = Get-SourceMarksHash -Resolution (Res @('a=>b', 'c=>d'))
            $swapped = Get-SourceMarksHash -Resolution (Res @('c=>d'))
            $moved   = Get-SourceMarksHash -Resolution (Res @('a=>z'))
            $one | Should -Not -Be $empty      # added
            $two | Should -Not -Be $one        # added another
            $one | Should -Not -Be $swapped    # one removed, another present
            $moved | Should -Not -Be $one      # same id, new target
            Get-SourceMarksHash -Resolution (Res @('a=>b')) | Should -Be $one   # deterministic
        }
    }
}

Describe 'Evidence producers count a duplicate pair once (C2)' -Tag 'source-identity' {
    BeforeEach { $script:F = script:New-Fixture }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Build-NodeSourceIndex: a copy repeating the canonical adds nothing; marksHash in the header' {
        $out = Join-Path $script:F.Root 'source_index.json'
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath $out -PassThru 3>$null 6>$null
        $ids = @($ix.index.'saf-beliefs-001' | ForEach-Object source_id | Sort-Object -Unique)
        $ids | Should -Be @('other-2026', 'report-2026')
        @($ix.index.'saf-beliefs-001' | Where-Object { $_.quote -eq 'Same quote' }).Count | Should -Be 1
        @($ix.index.'saf-beliefs-001' | Where-Object { $_.PSObject.Properties['via'] }).Count | Should -Be 0 -Because 'every copy link is near-equal to a canonical one'
        $ix.marksHash | Should -Match '^[0-9a-f]{64}$'
        $ix.builderVersion | Should -Be '1.2.0'
    }

    It 'Build-NodeSourceIndex: the union adds a copy''s distinct links to the canonical with via (spec 7.4)' {
        # The copy's own model run found one more claim on the shared node, and a node the canonical never linked.
        script:WriteJson (Join-Path $script:F.Sum 'report-2026-1.json') @{
            doc_id = 'report-2026-1'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @(@{ taxonomy_node_id = 'acc-beliefs-001'; verbatim = 'Only the copy saw this'; extraction_confidence = 0.5 }) }; skeptic = @{ key_points = @() }
                               safetyist = @{ key_points = @(
                                   @{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; extraction_confidence = 0.99 }   # near-equal: dropped, canonical kept even at higher confidence
                                   @{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'A distinct claim from the copy run'; extraction_confidence = 0.6 }) } }
            factual_claims = @(@{ claim = 'Same claim'; linked_taxonomy_nodes = @('saf-beliefs-001'); extraction_confidence = 0.7 })
        }
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath (Join-Path $script:F.Root 'si.json') -PassThru 3>$null 6>$null
        $saf = @($ix.index.'saf-beliefs-001')
        $added = @($saf | Where-Object { $_.PSObject.Properties['via'] })
        $added.Count | Should -Be 1
        $added[0].quote | Should -BeExactly 'A distinct claim from the copy run'
        $added[0].source_id | Should -BeExactly 'report-2026' -Because 'attributed to the canonical (spec 7.4 step 3)'
        $added[0].via | Should -BeExactly 'report-2026-1'
        $same = @($saf | Where-Object { $_.quote -eq 'Same quote' })
        $same.Count | Should -Be 1
        $same[0].extraction_confidence | Should -Be 0.8 -Because 'the canonical wins ties'
        $same[0].PSObject.Properties.Name | Should -Not -Contain 'via'
        $acc = @($ix.index.'acc-beliefs-001')
        $acc.Count | Should -Be 1 -Because 'a node only the copy linked keeps its (node, group) attribution'
        $acc[0].source_id | Should -BeExactly 'report-2026'
        @($ix.index.PSObject.Properties | ForEach-Object { @($_.Value) } | ForEach-Object source_id | Sort-Object -Unique) | Should -Not -Contain 'report-2026-1'
    }

    It 'Build-NodeSourceIndex: a union entry never displaces the canonical''s own on an exact-key collision' {
        # Key points without verbatim: the union compares their points (distinct, so the copy's is
        # kept), but both are written with quote '' and collide on the exact de-dup key. The copy's
        # higher confidence must not replace the canonical's entry (spec 7.4: the canonical wins).
        foreach ($p in @(@('report-2026', 'Canonical point about compute governance', 0.4), @('report-2026-1', 'A wholly different point about export controls', 0.95))) {
            script:WriteJson (Join-Path $script:F.Sum "$($p[0]).json") @{
                doc_id = $p[0]; generated_at = '2026-10-01T00:00:00Z'
                pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                                   safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; point = $p[1]; extraction_confidence = $p[2] }) } }
            }
        }
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath (Join-Path $script:F.Root 'si.json') -PassThru 3>$null 6>$null
        $mine = @($ix.index.'saf-beliefs-001' | Where-Object source_id -eq 'report-2026')
        $mine.Count | Should -Be 1
        $mine[0].extraction_confidence | Should -Be 0.4
        $mine[0].PSObject.Properties.Name | Should -Not -Contain 'via'
    }

    It 'Build-NodeSourceIndex: a marked copy''s summary is skipped even when its file name differs from its doc_id' {
        Move-Item (Join-Path $script:F.Sum 'report-2026-1.json') (Join-Path $script:F.Sum 'renamed-summary.json')
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath (Join-Path $script:F.Root 'si.json') -PassThru 3>$null 6>$null
        @($ix.index.'saf-beliefs-001' | ForEach-Object source_id | Sort-Object -Unique) | Should -Be @('other-2026', 'report-2026')
    }

    It 'Build-NodeSourceIndex: with no marks, the copy contributes its own entries (control arm)' {
        $meta = Join-Path $script:F.Src 'report-2026-1' 'metadata.json'
        [IO.File]::WriteAllText($meta, (@{ id = 'report-2026-1'; title = 'Report' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath (Join-Path $script:F.Root 'si.json') -PassThru 3>$null 6>$null
        @($ix.index.'saf-beliefs-001' | ForEach-Object source_id | Sort-Object -Unique) | Should -Be @('other-2026', 'report-2026', 'report-2026-1')
    }

    It 'Test-CitationLinkIntegrity leg c: current marks pass, a new mark is stale-marks' {
        $out = Join-Path $script:F.Root 'source_index.json'
        Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath $out 3>$null 6>$null | Out-Null
        $c = { (Test-CitationLinkIntegrity -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourceIndexPath $out -SourcesRoot $script:F.Src 3>$null 6>$null).results | Where-Object leg -eq 'c' }
        $before = & $c
        $before | Should -Not -BeNullOrEmpty
        $before.pass | Should -BeTrue
        @($before.offenders | Where-Object kind -eq 'stale-marks').Count | Should -Be 0
        $meta = Join-Path $script:F.Src 'other-2026' 'metadata.json'
        [IO.File]::WriteAllText($meta, (@{ id = 'other-2026'; title = 'Other'; duplicate_of = 'report-2026' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        @((& $c).offenders | Where-Object kind -eq 'stale-marks').Count | Should -Be 1
    }

    It 'Read-TaxonomySummaryCorpus: citations and DocIds count the pair once' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{ 'saf-beliefs-001' = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $scan = Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null
            $ni['saf-beliefs-001'].Citations | Should -Be 2
            @($ni['saf-beliefs-001'].DocIds | Sort-Object) | Should -Be @('other-2026', 'report-2026')
            @($scan.SummaryStats).Count | Should -Be 2
        }
    }

    It 'Get-SourceEvidenceDocCounts: a doc and its marked copy are one doc; lookup ids are unchanged' {
        $sei = Join-Path $script:F.Root 'sei.json'
        script:WriteJson $sei @{ 'saf-beliefs-001' = @{ facts = @(@{ doc_id = 'report-2026'; claim = 'x' }, @{ doc_id = 'report-2026-1'; claim = 'x' }, @{ doc_id = 'other-2026'; claim = 'y' }) } }
        InModuleScope AITriad -Parameters @{ F = $script:F; Sei = $sei } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            (Get-SourceEvidenceDocCounts -Path $Sei -Resolution $r 6>$null)['saf-beliefs-001'] | Should -Be 2
            (Get-SourceEvidenceDocCounts -Path $Sei 6>$null)['saf-beliefs-001'] | Should -Be 3   # without a resolution: unchanged behaviour
        }
    }

    It 'entity extraction work item: a marked copy''s fact is left out of the AI facts and source_refs' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            $entry = @{ facts = @(@{ doc_id = 'report-2026'; claim = 'Shared claim' }, @{ doc_id = 'report-2026-1'; claim = 'Shared claim' }) }
            $w = ConvertTo-EntityExtractionWorkItem -NodeId 'saf-beliefs-001' -Entry $entry -Resolution $r
            @($w.DocIds) | Should -Be @('report-2026')
            @($w.FactsText -split "`n").Count | Should -Be 1
        }
    }
}

Describe 'Listings skip a marked copy; an exact id still finds it (PR 2)' -Tag 'source-identity' {
    BeforeEach {
        $script:F = script:New-Fixture
        Mock Get-SourcesDir   -ModuleName AITriad { $script:F.Src }
        Mock Get-SummariesDir -ModuleName AITriad { $script:F.Sum }
    }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Get-AITSource: listing leaves the copy out; exact -DocId and -IncludeDuplicates find it' {
        @(Get-AITSource 3>$null | ForEach-Object DocId | Sort-Object) | Should -Be @('other-2026', 'report-2026')
        @(Get-AITSource 'report*' 3>$null | ForEach-Object DocId) | Should -Be @('report-2026')
        @(Get-AITSource 'report-2026-1' 3>$null | ForEach-Object DocId) | Should -Be @('report-2026-1')
        @(Get-AITSource -IncludeDuplicates 3>$null).Count | Should -Be 3
    }

    It 'Get-Summary: listing leaves the copy out; exact -DocId and -IncludeDuplicates find it' {
        @(Get-Summary 3>$null | ForEach-Object DocId | Sort-Object) | Should -Be @('other-2026', 'report-2026')
        @(Get-Summary 'report-2026-1' 3>$null | ForEach-Object DocId) | Should -Be @('report-2026-1')
        @(Get-Summary -IncludeDuplicates 3>$null).Count | Should -Be 3
    }

    It 'Get-AITClaim: a copy''s claims aren''t returned twice' {
        @(Get-AITClaim -Type FactualClaim 3>$null | Where-Object DocId -like 'report*').Count | Should -Be 1
        @(Get-AITClaim -Type FactualClaim -IncludeDuplicates 3>$null | Where-Object DocId -like 'report*').Count | Should -Be 2
    }

    It 'Find-AITSource: the copy isn''t listed beside its canonical' {
        $ids = @(Find-AITSource -Id 'saf-beliefs-001' 3>$null 6>$null | ForEach-Object DocId | Sort-Object -Unique)
        $ids | Should -Not -Contain 'report-2026-1'
        $ids | Should -Contain 'report-2026'
    }

    It 'Update-AITSourceIndex records the raw mark in _index.json' {
        Update-AITSourceIndex -Quiet 3>$null 6>$null | Out-Null
        $ix = Get-Content (Join-Path $script:F.Src '_index.json') -Raw | ConvertFrom-Json
        ($ix.sources | Where-Object id -eq 'report-2026-1').duplicate_of | Should -BeExactly 'report-2026'
        ($ix.sources | Where-Object id -eq 'report-2026').duplicate_of | Should -BeNullOrEmpty
    }
}

Describe 'Ingest identity index names the canonical doc (PR 2)' -Tag 'source-identity' {
    It 'prefers an unmarked doc over a marked copy enumerated first, for hash and URL' {
        $root = Join-Path ([IO.Path]::GetTempPath()) "ait-ingidx-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        try {
            $body = "# Twin`n`n$script:Long`n"
            script:New-SrcDoc $root 'aaa-copy-2026' @{ title = 'Twin'; url = 'https://example.org/twin'; duplicate_of = 'twin-2026' } $body
            script:New-SrcDoc $root 'twin-2026'     @{ title = 'Twin'; url = 'https://example.org/twin' } $body
            InModuleScope AITriad -Parameters @{ Root = $root } {
                $ix = Get-SourceIdentityIndex -SourcesDir $Root
                @($ix.ByHash.Values) | Should -Be @('twin-2026')
                $ix.ByUrl['example.org/twin'] | Should -BeExactly 'twin-2026'
                $ix.Marked['aaa-copy-2026'] | Should -BeExactly 'twin-2026'
            }
        } finally { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Selection sites skip a marked copy (C1)' -Tag 'source-identity' {
    BeforeEach { $script:F = script:New-Fixture }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Get-BatchSourceMetaFile leaves the marked copy out of the batch' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Write-Info {}
            $files = @(Get-BatchSourceMetaFile -SourcesDir $F.Src 3>$null)
            @($files | ForEach-Object { $_.Directory.Name } | Sort-Object) | Should -Be @('other-2026', 'report-2026')
        }
    }

    It 'Select-SelectableSummaryFile drops only the marked copy''s summary' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            $all = [System.IO.FileInfo[]]@(Get-ChildItem $F.Sum -Filter *.json)
            @(Select-SelectableSummaryFile -Files $all -Resolution $r | ForEach-Object BaseName | Sort-Object) | Should -Be @('other-2026', 'report-2026')
        }
    }
}

Describe 'Duplicate-group evidence union: per-node document counts take a copy at most once (spec 7.5, t/4337)' -Tag 'source-identity' {
    BeforeEach {
        $script:F = script:New-Fixture
        # The copy's model run repeats the canonical's node and concept, and adds a node and a concept
        # the canonical's run missed (twice each, to prove repetition doesn't count).
        script:WriteJson (Join-Path $script:F.Sum 'report-2026-1.json') @{
            doc_id = 'report-2026-1'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ skeptic = @{ key_points = @() }
                               accelerationist = @{ key_points = @(
                                   @{ taxonomy_node_id = 'acc-beliefs-001'; point = 'copy-only node'; stance = 'supports' }
                                   @{ taxonomy_node_id = 'acc-beliefs-001'; point = 'copy-only node again'; stance = 'supports' }) }
                               safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; point = 'Same point'; stance = 'supports' }) } }
            unmapped_concepts = @(@{ concept = 'Shared Concept' }, @{ concept = 'Copy-only concept' }, @{ concept = 'copy-only   CONCEPT' })
        }
        $canon = Get-Content -Raw (Join-Path $script:F.Sum 'report-2026.json') | ConvertFrom-Json -AsHashtable
        $canon['unmapped_concepts'] = @(@{ concept = 'Shared concept' })
        script:WriteJson (Join-Path $script:F.Sum 'report-2026.json') $canon
    }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'health: a node only the copy cites counts once for the canonical; a shared node is unchanged; one stats row per doc' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{}
            foreach ($n in 'saf-beliefs-001', 'acc-beliefs-001') { $ni[$n] = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $scan = Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null
            $ni['saf-beliefs-001'].Citations | Should -Be 2 -Because 'report-2026 and other-2026; the copy repeats a node its canonical already counts'
            @($ni['saf-beliefs-001'].DocIds | Sort-Object) | Should -Be @('other-2026', 'report-2026')
            $ni['acc-beliefs-001'].Citations | Should -Be 1 -Because 'the copy cites it twice, but it is one resolved doc'
            @($ni['acc-beliefs-001'].DocIds) | Should -Be @('report-2026')
            $ni['acc-beliefs-001'].Stances.Count | Should -Be 0 -Because 'stances stay the canonical''s own'
            @($scan.SummaryStats).Count | Should -Be 2
            @($scan.SummaryStats.DocId) | Should -Not -Contain 'report-2026-1'
        }
    }

    It 'health: an unmapped concept only the copy names counts once; a shared one is unchanged (Frequency >= 3 bar)' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{ 'saf-beliefs-001' = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            $agg = (Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null).UnmappedAgg
            $agg['shared concept'].Frequency | Should -Be 1
            @($agg['shared concept'].ContributingDocs) | Should -Be @('report-2026')
            $agg['copy-only concept'].Frequency | Should -Be 1 -Because 'named twice by one copy of one doc'
            @($agg['copy-only concept'].ContributingDocs) | Should -Be @('report-2026')
        }
    }

    It 'topic frequency: a node only the copy cites counts once for the canonical; a shared node isn''t doubled' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-SummariesDir { $F.Sum }; Mock Get-SourcesDir { $F.Src }; Mock Get-TaxonomyDir { Join-Path $F.Root 'no-taxonomy' }
            $r = Get-TopicFrequency -NoAI 6>$null 3>$null
            # Round-trip through JSON: topics_by_pov is a dictionary, so normalise to objects first.
            $j = $r | ConvertTo-Json -Depth 8 | ConvertFrom-Json
            $nodes = @($j.topics_by_pov.PSObject.Properties | ForEach-Object { @($_.Value) } | ForEach-Object { @($_.member_nodes) })
            @($nodes | Where-Object id -eq 'acc-beliefs-001').citations | Should -Be 1
            @($nodes | Where-Object id -eq 'saf-beliefs-001').citations | Should -Be 2 -Because 'report-2026 and other-2026, not 3'
            ($r | ConvertTo-Json -Depth 8) | Should -Not -Match 'report-2026-1'
            $r.summary_count | Should -Be 2
        }
    }

    It 'control arm: with the mark removed, the copy counts as its own doc again' {
        [IO.File]::WriteAllText((Join-Path $script:F.Src 'report-2026-1' 'metadata.json'), (@{ id = 'report-2026-1'; title = 'Report' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $ni = @{ 'acc-beliefs-001' = @{ Citations = 0; DocIds = [System.Collections.Generic.List[string]]::new(); Stances = [System.Collections.Generic.List[string]]::new() } }
            [void](Read-TaxonomySummaryCorpus -SummariesDir $F.Sum -SourcesDir $F.Src -NodeIndex $ni 3>$null)
            $ni['acc-beliefs-001'].Citations | Should -Be 2
            @($ni['acc-beliefs-001'].DocIds) | Should -Be @('report-2026-1')
        }
    }
}

Describe 'Entity extraction never re-extracts a copy''s fact (TL e/347#7, spec 7.6)' -Tag 'source-identity' {
    BeforeEach { $script:F = script:New-Fixture }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'skips a copy fact under the copy''s doc_id, and one re-attributed to the canonical with via; keeps the canonical''s own' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            $r = Get-SourceResolution -SourcesDir $F.Src -IndexPath $F.NoIndex 3>$null
            $entry = @{ facts = @(
                @{ doc_id = 'report-2026';   claim = 'Canonical claim' }
                @{ doc_id = 'report-2026-1'; claim = 'Copy claim, today''s index' }
                @{ doc_id = 'report-2026';   claim = 'Copy claim, union index'; via = 'report-2026-1' }) }
            $w = ConvertTo-EntityExtractionWorkItem -NodeId 'saf-beliefs-001' -Entry $entry -Resolution $r
            @($w.FactsText -split "`n") | Should -Be @('- Canonical claim')
            @($w.DocIds) | Should -Be @('report-2026')
        }
    }

    It 'a fact with via is skipped even with no resolution available' {
        InModuleScope AITriad {
            $w = ConvertTo-EntityExtractionWorkItem -NodeId 'n' -Entry @{ facts = @(@{ doc_id = 'c'; claim = 'x'; via = 'c-1' }) } -Resolution $null
            $w | Should -BeNullOrEmpty
        }
    }
}

Describe 'Claim listing and conflict analysis take a copy''s distinct claims under the canonical (spec 7.4/7.5, t/4337)' -Tag 'source-identity' {
    BeforeEach {
        $script:F = script:New-Fixture
        # The canonical supports a claim; the copy repeats it (near-equal, more confident) and adds
        # a distinct claim that disputes the same node.
        script:WriteJson (Join-Path $script:F.Sum 'report-2026.json') @{
            doc_id = 'report-2026'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }; safetyist = @{ key_points = @() } }
            factual_claims = @(@{ claim = 'Same claim'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'supports'; extraction_confidence = 0.7 })
        }
        script:WriteJson (Join-Path $script:F.Sum 'report-2026-1.json') @{
            doc_id = 'report-2026-1'; generated_at = '2026-10-01T00:00:00Z'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }; safetyist = @{ key_points = @() } }
            factual_claims = @(
                @{ claim = 'Same claim.'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'supports'; extraction_confidence = 0.95 }
                @{ claim = 'A different claim the copy run found'; linked_taxonomy_nodes = @('saf-beliefs-001'); doc_position = 'disputes'; extraction_confidence = 0.8 })
        }
        Mock Get-SourcesDir   -ModuleName AITriad { $script:F.Src }
        Mock Get-SummariesDir -ModuleName AITriad { $script:F.Sum }
    }
    AfterEach { Remove-Item $script:F.Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Get-AITClaim lists a copy''s distinct claim under the canonical with Via, and not its near-duplicate' {
        $c = @(Get-AITClaim -Type FactualClaim 3>$null | Where-Object DocId -like 'report*')
        @($c.Text | Sort-Object) | Should -Be @('A different claim the copy run found', 'Same claim')
        ($c | Where-Object Text -eq 'A different claim the copy run found').DocId | Should -BeExactly 'report-2026'
        ($c | Where-Object Text -eq 'A different claim the copy run found').Via | Should -BeExactly 'report-2026-1'
        ($c | Where-Object Text -eq 'Same claim').Via | Should -BeNullOrEmpty
    }

    It 'Get-AITClaim: a filter can''t let a copy''s near-duplicate through' {
        # Only the copy's version clears -MinConfidence 0.9, but it is near-equal to the canonical's claim.
        @(Get-AITClaim -Type FactualClaim -MinConfidence 0.9 3>$null | Where-Object DocId -like 'report*').Count | Should -Be 0
    }

    It 'Get-AITClaim -IncludeDuplicates and an exact -DocId still return the copy as itself' {
        @(Get-AITClaim -Type FactualClaim -IncludeDuplicates 3>$null | Where-Object DocId -eq 'report-2026-1').Count | Should -Be 2
        $own = @(Get-AITClaim -DocId 'report-2026-1' -Type FactualClaim 3>$null)
        $own.Count | Should -Be 2
        @($own | Where-Object { $_.Via }).Count | Should -Be 0
    }

    It 'QBAF: the copy''s distinct claim is loaded under the canonical and never conflicts with its own canonical' {
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-DataRoot      { $F.Root }
            Mock Get-TextEmbedding { $null }
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null 3>$null
            $r.ClaimCount | Should -Be 2 -Because 'the canonical''s claim and the copy''s distinct one; the near-duplicate is dropped'
            $r.AttackCount | Should -Be 0 -Because 'a supports/disputes pair inside one group is the same document (spec 7.5)'
        }
    }

    It 'QBAF control arm: with the mark removed, the copy is its own doc and the pair is an attack' {
        [IO.File]::WriteAllText((Join-Path $script:F.Src 'report-2026-1' 'metadata.json'), (@{ id = 'report-2026-1'; title = 'Report' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        InModuleScope AITriad -Parameters @{ F = $script:F } {
            Mock Get-DataRoot      { $F.Root }
            Mock Get-TextEmbedding { $null }
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null 3>$null
            $r.ClaimCount | Should -Be 3
            $r.AttackCount | Should -Be 1
        }
    }
}
