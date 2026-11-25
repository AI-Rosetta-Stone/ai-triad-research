# Tag: config (t/355)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Legacy chunks in the source resolver and in Build-NodeSourceIndex (t/355 step 4, spec 6.2 and 7).
.DESCRIPTION
    A summary is a chunk only if the legacy-chunk manifest lists it (TL t/355#43). A listed chunk
    resolves to its base, is not selectable, and its links are indexed under the base with `chunk_of`
    (or `via`, for a chunk of a marked copy). An unlisted `<X>-N` id stays its own source. A listed
    chunk whose base does not exist is refused.
#>

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force

    function script:WriteJson($path, $obj) {
        $dir = Split-Path $path -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -LiteralPath $path -Value ($obj | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
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
    function script:Summary($docId, $quote) {
        @{ doc_id = $docId; pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id = 'saf-beliefs-201'; verbatim = $quote; extraction_confidence = 0.8 }) } } }
    }
    function script:NewTree {
        $fx = Join-Path ([System.IO.Path]::GetTempPath()) ("bnsi-chunk-" + [guid]::NewGuid().ToString('N'))
        $t = [pscustomobject]@{ Fx = $fx; Tax = (Join-Path $fx 'taxonomy'); Sum = (Join-Path $fx 'summaries'); Src = (Join-Path $fx 'sources'); Out = (Join-Path $fx 'source_index.json') }
        New-Item -ItemType Directory -Force -Path $t.Tax, $t.Sum, $t.Src | Out-Null
        script:WriteJson (Join-Path $t.Tax 'safetyist.json') @{ pov = 'saf'; nodes = @(@{ id = 'saf-beliefs-201' }) }
        script:WriteJson (Join-Path $t.Tax 'accelerationist.json') @{ pov = 'acc'; nodes = @() }
        script:WriteJson (Join-Path $t.Tax 'skeptic.json') @{ pov = 'skp'; nodes = @() }
        $script:Trees.Add($fx)
        $t
    }
    function script:Build($t) {
        Build-NodeSourceIndex -SummariesDir $t.Sum -TaxonomyDir $t.Tax -SourcesDir $t.Src -OutputPath $t.Out -PassThru -WarningVariable +script:Warnings -WarningAction SilentlyContinue 6>$null
    }
    $script:Trees = [System.Collections.Generic.List[string]]::new()
}

AfterAll {
    & (Get-Module AITriad) { $script:EvidenceLegacyChunkManifest = $null; $script:SourceResolutionCache = @{} }
    foreach ($p in $script:Trees) { if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue } }
}

Describe 'Resolve-SourceId and Test-SourceSelectable: legacy chunks (spec 6.2, t/355)' -Tag 'config' {

    BeforeEach { script:SetManifest @{ 'paper-2024-2' = 'paper-2024'; 'copy-2024-1' = 'copy-2024' } }

    It 'a listed chunk resolves to its base and is not selectable; an unlisted <X>-N id is its own document' {
        InModuleScope AITriad {
            $r = New-IdentitySourceResolution
            Resolve-SourceId -Resolution $r -Id 'paper-2024-2' | Should -BeExactly 'paper-2024'
            Test-SourceSelectable -Resolution $r -Id 'paper-2024-2' | Should -BeFalse
            Resolve-SourceId -Resolution $r -Id 'paper-2024-3' | Should -BeExactly 'paper-2024-3'
            Test-SourceSelectable -Resolution $r -Id 'paper-2024-3' | Should -BeTrue
            Test-SourceSelectable -Resolution $r -Id 'paper-2024' | Should -BeTrue
        }
    }

    It 'a chunk of a marked copy resolves to the copy''s canonical, and its role names the copy' {
        InModuleScope AITriad {
            $r = New-IdentitySourceResolution
            $r.Resolved['copy-2024'] = 'paper-2024'; [void]$r.Marked.Add('copy-2024')
            Resolve-SourceId -Resolution $r -Id 'copy-2024-1' | Should -BeExactly 'paper-2024'
            $role = Get-SourceGroupRole -Resolution $r -Id 'copy-2024-1'
            $role.Kind | Should -Be 'chunk_copy'; $role.Via | Should -Be 'copy-2024'; $role.CanonicalId | Should -Be 'paper-2024'
            (Get-SourceGroupRole -Resolution $r -Id 'paper-2024-2').Kind | Should -Be 'chunk_D'
            (Get-SourceGroupRole -Resolution $r -Id 'copy-2024').Kind | Should -Be 'copy'
            Get-SourceGroupRole -Resolution $r -Id 'paper-2024' | Should -BeNullOrEmpty
        }
    }

    It 'a resolution object with no Chunks member behaves as before' {
        InModuleScope AITriad {
            $r = [pscustomobject]@{ Resolved = @{}; Marked = [System.Collections.Generic.HashSet[string]]::new(); MarkPairs = [string[]]@(); Errors = @(); Source = 'none' }
            Resolve-SourceId -Resolution $r -Id 'paper-2024-2' | Should -BeExactly 'paper-2024-2'
            Test-SourceSelectable -Resolution $r -Id 'paper-2024-2' | Should -BeTrue
        }
    }

    It 'a manifest that loops is refused' {
        script:SetManifest @{ 'a-2024-1' = 'a-2024-2'; 'a-2024-2' = 'a-2024-1' }
        InModuleScope AITriad {
            { Resolve-SourceId -Resolution (New-IdentitySourceResolution) -Id 'a-2024-1' } | Should -Throw -ExpectedMessage '*loops*'
        }
    }

    It 'the selection helpers leave chunk summaries alone unless asked (other producers are unchanged)' {
        $t = script:NewTree
        script:WriteJson (Join-Path $t.Sum 'paper-2024.json') (script:Summary 'paper-2024' 'base quote')
        script:WriteJson (Join-Path $t.Sum 'paper-2024-2.json') (script:Summary 'paper-2024-2' 'chunk quote')
        InModuleScope AITriad -Parameters @{ Dir = $t.Sum } {
            param($Dir)
            $r = New-IdentitySourceResolution
            $all = [System.IO.FileInfo[]]@(Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File)
            @(Select-SelectableSummaryFile -Files $all -Resolution $r).Count | Should -Be 2
            @(Select-SelectableSummaryFile -Files $all -Resolution $r -ExcludeChunks).BaseName | Should -Be @('paper-2024')
            @(Get-MarkedCopySummary -Files $all -Resolution $r).Count | Should -Be 0
            $c = @(Get-MarkedCopySummary -Files $all -Resolution $r -IncludeChunks)
            $c.Count | Should -Be 1
            $c[0].CopyId | Should -Be 'paper-2024-2'; $c[0].CanonicalId | Should -Be 'paper-2024'; $c[0].Kind | Should -Be 'chunk_D'
        }
    }
}

Describe 'Build-NodeSourceIndex: legacy chunks (spec 6.2 and 7, t/355)' -Tag 'config' {

    BeforeEach { $script:Warnings = [System.Collections.ArrayList]::new() }

    It 'a listed chunk''s links are indexed under its base with chunk_of; the chunk is not a source of its own' {
        script:SetManifest @{ 'paper-2024-2' = 'paper-2024' }
        $t = script:NewTree
        script:WriteJson (Join-Path $t.Src 'paper-2024/metadata.json') @{ id = 'paper-2024'; title = 'Paper' }
        script:WriteJson (Join-Path $t.Sum 'paper-2024.json') (script:Summary 'paper-2024' 'The base document says one thing about oversight.')
        script:WriteJson (Join-Path $t.Sum 'paper-2024-2.json') (script:Summary 'paper-2024-2' 'The second chunk says something else about audits.')
        $ix = script:Build $t
        $ix.builderVersion | Should -Be '1.3.0'
        $e = @($ix.index.'saf-beliefs-201')
        $e.Count | Should -Be 2
        @($e.source_id | Sort-Object -Unique) | Should -Be @('paper-2024')
        $own = @($e | Where-Object { -not $_.PSObject.Properties['chunk_of'] })
        $chunk = @($e | Where-Object { $_.PSObject.Properties['chunk_of'] })
        $own.Count | Should -Be 1
        $chunk.Count | Should -Be 1
        $chunk[0].chunk_of | Should -Be 'paper-2024-2'
        $chunk[0].quote | Should -Be 'The second chunk says something else about audits.'
        $chunk[0].PSObject.Properties['via'] | Should -BeNullOrEmpty
    }

    It 'a chunk link that repeats the base''s own quote adds nothing (the canonical wins)' {
        script:SetManifest @{ 'paper-2024-2' = 'paper-2024' }
        $t = script:NewTree
        script:WriteJson (Join-Path $t.Src 'paper-2024/metadata.json') @{ id = 'paper-2024' }
        script:WriteJson (Join-Path $t.Sum 'paper-2024.json') (script:Summary 'paper-2024' 'The base document says one thing about oversight.')
        script:WriteJson (Join-Path $t.Sum 'paper-2024-2.json') (script:Summary 'paper-2024-2' 'The base document says one thing about oversight.')
        $e = @((script:Build $t).index.'saf-beliefs-201')
        $e.Count | Should -Be 1
        $e[0].PSObject.Properties['chunk_of'] | Should -BeNullOrEmpty
    }

    It 'a real <X>-N document that is not listed stays its own source, with one WARN when its folder is missing' {
        script:SetManifest @{}
        $t = script:NewTree
        script:WriteJson (Join-Path $t.Src 'paper-2024/metadata.json') @{ id = 'paper-2024' }
        script:WriteJson (Join-Path $t.Sum 'paper-2024.json') (script:Summary 'paper-2024' 'The base document says one thing about oversight.')
        script:WriteJson (Join-Path $t.Sum 'paper-2024-7.json') (script:Summary 'paper-2024-7' 'A different document with a similar name.')
        & (Get-Module AITriad) { $script:EvidenceUnlistedChunkWarned.Clear() }
        $e = @((script:Build $t).index.'saf-beliefs-201')
        @($e.source_id | Sort-Object) | Should -Be @('paper-2024', 'paper-2024-7')
        @($e | Where-Object { $_.PSObject.Properties['chunk_of'] }).Count | Should -Be 0
        @($script:Warnings | Where-Object { "$_" -match "paper-2024-7.*not in the legacy-chunk manifest" }).Count | Should -Be 1
    }

    It 'a listed chunk whose base exists neither as a summary nor as a source folder is refused, naming the id' {
        script:SetManifest @{ 'gone-2024-1' = 'gone-2024' }
        $t = script:NewTree
        script:WriteJson (Join-Path $t.Sum 'gone-2024-1.json') (script:Summary 'gone-2024-1' 'A chunk with no base.')
        { script:Build $t } | Should -Throw -ExpectedMessage "*gone-2024-1*"
        Test-Path $t.Out | Should -BeFalse
    }

    It 'a chunk of a marked copy is indexed under the canonical with via naming the copy, never chunk_of' {
        script:SetManifest @{ 'copy-2024-1' = 'copy-2024' }
        $t = script:NewTree
        $text = 'Identical snapshot text for the two folders, long enough to hash.'
        foreach ($id in 'paper-2024', 'copy-2024') {
            $meta = @{ id = $id; title = 'Paper'; url = 'https://example.org/paper' }
            if ($id -eq 'copy-2024') { $meta['duplicate_of'] = 'paper-2024' }
            script:WriteJson (Join-Path $t.Src "$id/metadata.json") $meta
            Set-Content -LiteralPath (Join-Path $t.Src "$id/snapshot.md") -Value $text -Encoding utf8NoBOM
        }
        script:WriteJson (Join-Path $t.Sum 'paper-2024.json') (script:Summary 'paper-2024' 'The base document says one thing about oversight.')
        script:WriteJson (Join-Path $t.Sum 'copy-2024-1.json') (script:Summary 'copy-2024-1' 'The copy''s chunk says something else about audits.')
        $e = @((script:Build $t).index.'saf-beliefs-201')
        @($e.source_id | Sort-Object -Unique) | Should -Be @('paper-2024')
        $added = @($e | Where-Object { $_.quote -like 'The copy*' })
        $added.Count | Should -Be 1
        $added[0].via | Should -Be 'copy-2024'
        $added[0].PSObject.Properties['chunk_of'] | Should -BeNullOrEmpty
    }

    It 'PowerShell and TypeScript read the same manifest file' {
        $repo = (Resolve-Path "$PSScriptRoot/..").Path
        $file = Join-Path $repo 'docs/specs/source-identity-legacy-chunks.json'
        & (Get-Module AITriad) { $script:EvidenceLegacyChunkManifest = $null }
        $ps = InModuleScope AITriad { Get-EvidenceLegacyChunkManifest -Force }
        $doc = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        $ps.Count | Should -Be @($doc.chunks.PSObject.Properties).Count
        foreach ($p in $doc.chunks.PSObject.Properties) { $ps[$p.Name] | Should -BeExactly ([string]$p.Value) }
        InModuleScope AITriad -Parameters @{ File = $file } { param($File) (Resolve-Path $script:EvidenceLegacyChunkManifestPath).Path | Should -Be (Resolve-Path $File).Path }
        # The TypeScript loader names the same file (lib, t/572), so the two builders can't hold different lists.
        $ts = @(Get-ChildItem -LiteralPath (Join-Path $repo 'lib') -Recurse -File -Include '*.ts' | Where-Object { $_.FullName -notmatch 'node_modules' } |
            Select-String -SimpleMatch 'source-identity-legacy-chunks.json' -List)
        $ts.Count | Should -BeGreaterThan 0 -Because 'the TypeScript reader must load docs/specs/source-identity-legacy-chunks.json, not a list of its own'
    }
}
