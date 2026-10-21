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
                doc_id = $id
                pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                                   safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Same quote'; extraction_confidence = 0.8; stance = 'supports' }) } }
                factual_claims = @(@{ claim = 'Same claim'; linked_taxonomy_nodes = @('saf-beliefs-001'); extraction_confidence = 0.7 })
            }
        }
        script:WriteJson (Join-Path $sum 'other-2026.json') @{
            doc_id = 'other-2026'
            pov_summaries = @{ accelerationist = @{ key_points = @() }; skeptic = @{ key_points = @() }
                               safetyist = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-001'; verbatim = 'Other quote'; extraction_confidence = 0.6 }) } }
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

    It 'Build-NodeSourceIndex: entries only from the canonical, marksHash in the header' {
        $out = Join-Path $script:F.Root 'source_index.json'
        $ix = Build-NodeSourceIndex -SummariesDir $script:F.Sum -TaxonomyDir $script:F.Tax -SourcesDir $script:F.Src -OutputPath $out -PassThru 3>$null 6>$null
        $ids = @($ix.index.'saf-beliefs-001' | ForEach-Object source_id | Sort-Object -Unique)
        $ids | Should -Be @('other-2026', 'report-2026')
        @($ix.index.'saf-beliefs-001' | Where-Object { $_.quote -eq 'Same quote' }).Count | Should -Be 1
        $ix.marksHash | Should -Match '^[0-9a-f]{64}$'
        $ix.builderVersion | Should -Be '1.1.0'
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
