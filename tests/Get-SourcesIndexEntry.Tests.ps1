# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Characterization tests for Get-SourcesIndexEntry (t/5339, t/5334). Race-safe: dot-source ONLY
# this one Private file and stub its two module-internal dependencies so no batch-worktree module
# import is needed. The stubs are deterministic, so they pin behavior identically before/after the
# refactor; the assertions exercise every emission branch (scalars, lists, hashes, provenance, marks).

BeforeAll {
    $script:File = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Get-SourcesIndexEntry.ps1'
    . $script:File

    # Deterministic stubs for the module-internal dependencies.
    function ConvertFrom-JsonPreserveShape { param([string]$Json) $Json | ConvertFrom-Json }
    function Get-SourceContentHash { param([string]$Text) 'HASH(' + $Text.Length + ')' }

    function New-DocDir {
        param([hashtable]$Meta, [string]$Snapshot)
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir | Out-Null
        if ($null -ne $Meta) {
            ($Meta | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath (Join-Path $dir 'metadata.json') -Encoding utf8
        }
        if ($PSBoundParameters.ContainsKey('Snapshot')) {
            Set-Content -LiteralPath (Join-Path $dir 'snapshot.md') -Value $Snapshot -Encoding utf8 -NoNewline
        }
        $dir
    }
}

Describe 'Get-SourcesIndexEntry characterization' {
    It 'emits only id when no metadata.json and no snapshot.md' {
        $dir = New-DocDir -Meta $null
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-1'
        @($e.Keys) | Should -Be @('id')
        $e['id'] | Should -Be 'doc-1'
    }

    It 'computes snapshot_sha256 when no recorded hash and snapshot.md present' {
        $dir = New-DocDir -Meta $null -Snapshot 'hello world'
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-2'
        @($e.Keys) | Should -Be @('id', 'snapshot_sha256')
        $e['snapshot_sha256'] | Should -Be 'HASH(11)'
    }

    It 'prefers recorded content_sha256 over computed snapshot hash' {
        $dir = New-DocDir -Meta @{ content_sha256 = 'REC' } -Snapshot 'hello world'
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-3'
        $e.Contains('snapshot_sha256') | Should -BeFalse
        $e['content_sha256'] | Should -Be 'REC'
    }

    It 'maps scalar and list fields in fixed order, omitting empties' {
        $meta = [ordered]@{
            title          = 'T'
            url            = 'http://x'
            resolved_url   = ''
            authors        = @('A', '', 'B')
            date_published = '2026-01-02'
            one_liner      = 'ol'
            topic_tags     = @('t1', '  ', 't2')
        }
        $dir = New-DocDir -Meta $meta
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-4'
        @($e.Keys) | Should -Be @('id', 'title', 'url', 'authors', 'date_published', 'one_liner', 'topic_tags')
        $e['title'] | Should -Be 'T'
        $e['authors'] | Should -Be @('A', 'B')
        $e['topic_tags'] | Should -Be @('t1', 't2')
    }

    It 'maps provenance items keeping only non-empty scheme/id/confidence' {
        $meta = [ordered]@{
            provenance = @(
                [ordered]@{ scheme = 'doi'; id = '10.1/x'; confidence = 'high' },
                [ordered]@{ scheme = ''; id = '' },
                [ordered]@{ scheme = 'url'; id = 'http://y' }
            )
        }
        $dir = New-DocDir -Meta $meta
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-5'
        $e['provenance'].Count | Should -Be 2
        $e['provenance'][0]['scheme'] | Should -Be 'doi'
        $e['provenance'][0]['confidence'] | Should -Be 'high'
        $e['provenance'][1]['scheme'] | Should -Be 'url'
        $e['provenance'][1].Contains('confidence') | Should -BeFalse
    }

    It 'copies mark fields verbatim when present' {
        $meta = [ordered]@{
            same_as          = 'doc-x'
            parent_doc_id    = 'doc-p'
            duplicate_of     = ''
            duplicate_of_ref = 'ref-1'
        }
        $dir = New-DocDir -Meta $meta
        $e = Get-SourcesIndexEntry -DocDir $dir -DocId 'doc-6'
        @($e.Keys) | Should -Be @('id', 'same_as', 'parent_doc_id', 'duplicate_of_ref')
    }
}
