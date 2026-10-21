# Tag: sources-index (t/4334#18)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    $script:Long = ((1..120 | ForEach-Object { "word$_" }) -join ' ')
    function script:New-Doc([string]$Root, [string]$Id, $Meta, [string]$Snapshot) {
        $d = Join-Path $Root $Id
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        if ($null -ne $Meta) { [IO.File]::WriteAllText((Join-Path $d 'metadata.json'), ($Meta | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
        if ($null -ne $Snapshot) { [IO.File]::WriteAllText((Join-Path $d 'snapshot.md'), $Snapshot, [Text.UTF8Encoding]::new($false)) }
    }
}

Describe 'Export-SourcesIndex (t/4334#18)' -Tag 'sources-index' {

    BeforeEach {
        $script:Root = Join-Path ([IO.Path]::GetTempPath()) "ait-srcidx-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $script:Src = Join-Path $script:Root 'sources'
        $script:Out = Join-Path $script:Root 'sources-index.json'
        New-Item -ItemType Directory -Path $script:Src -Force | Out-Null
        New-Doc $script:Src 'beta-2026' ([ordered]@{
            id = 'beta-2026'; title = 'Beta'; url = 'https://example.org/beta'; authors = 'Solo Author'
            date_published = '2026-01-15'; topic_tags = @('one'); one_liner = 'A beta.'
            import_time = '2026-06-02T06:35:18.2831215+02:00'
            provenance = @([ordered]@{ scheme = 'url'; id = 'https://example.org/beta'; confidence = 'search' })
        }) "# Beta`n`n$script:Long`n"
        New-Doc $script:Src 'alpha-2026' ([ordered]@{ id = 'alpha-2026'; title = 'Alpha'; content_sha256 = ('a' * 64); same_as = 'beta-2026' }) "# Alpha`n`nshort body`n"
        New-Doc $script:Src 'alpha-2026-1' $null "# Alpha copy`n`n$script:Long`n"
        New-Doc $script:Src 'gamma-2026' ([ordered]@{ id = 'gamma-2026'; title = 'Gamma' }) "# Gamma`n`nToo short to hash.`n"
        New-Doc $script:Src '_inbox' $null $null
        New-Doc $script:Src '.claude' $null $null
    }
    AfterEach { if (Test-Path $script:Root) { Remove-Item $script:Root -Recurse -Force } }

    It 'is exported from the module' {
        Get-Command Export-SourcesIndex -Module AITriad | Should -Not -BeNullOrEmpty
    }

    It 'indexes real doc dirs only, sorted ordinally, with a fixed key order and no timestamp' {
        $r = Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out -PassThru 3>$null
        $r.DocCount | Should -Be 4
        $idx = Get-Content $script:Out -Raw | ConvertFrom-Json
        @($idx.docs.id) | Should -Be @('alpha-2026', 'alpha-2026-1', 'beta-2026', 'gamma-2026')
        @($idx.PSObject.Properties.Name) | Should -Be @('schema_version', 'source_commit', 'doc_count', 'docs')
        $raw = Get-Content $script:Out -Raw
        $raw | Should -Not -Match 'generated_at'
        $raw | Should -Not -Match "`r"
    }

    It 'maps the card and identity fields, omitting absent ones' {
        Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out 3>$null | Out-Null
        $beta = (Get-Content $script:Out -Raw | ConvertFrom-Json -AsHashtable).docs | Where-Object { $_.id -eq 'beta-2026' }
        @($beta.Keys) | Should -Be @('id', 'title', 'url', 'authors', 'date_published', 'one_liner', 'topic_tags', 'snapshot_sha256', 'provenance')
        , $beta.authors | Should -BeOfType [object[]]
        $beta.authors[0] | Should -BeExactly 'Solo Author'
        , $beta.topic_tags | Should -BeOfType [object[]]
        $beta.provenance[0].confidence | Should -BeExactly 'search'
        $beta.Keys | Should -Not -Contain 'import_time'
    }

    It 'keeps a recorded content_sha256, puts a computed hash in snapshot_sha256, and omits both under the floor' {
        Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out 3>$null | Out-Null
        $docs = @((Get-Content $script:Out -Raw | ConvertFrom-Json).docs)
        ($docs | Where-Object id -eq 'alpha-2026').content_sha256 | Should -BeExactly ('a' * 64)
        ($docs | Where-Object id -eq 'alpha-2026').same_as | Should -BeExactly 'beta-2026'
        $expected = InModuleScope AITriad -Parameters @{ T = "# Alpha copy`n`n$script:Long`n" } { param($T) Get-SourceContentHash -Text $T }
        ($docs | Where-Object id -eq 'alpha-2026-1').snapshot_sha256 | Should -BeExactly $expected
        ($docs | Where-Object id -eq 'alpha-2026-1').PSObject.Properties.Name | Should -Not -Contain 'content_sha256' -Because 'a computed hash is never reported as recorded (spec 4.4)'
        ($docs | Where-Object id -eq 'alpha-2026').PSObject.Properties.Name | Should -Not -Contain 'snapshot_sha256' -Because 'a recorded hash suppresses the computed one'
        @(($docs | Where-Object id -eq 'gamma-2026').PSObject.Properties.Name) | Should -Not -Contain 'content_sha256'
        @(($docs | Where-Object id -eq 'gamma-2026').PSObject.Properties.Name) | Should -Not -Contain 'snapshot_sha256'
    }

    It 'indexes a dir with no metadata.json by id and hash only, and warns' {
        $w = $null
        Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out -WarningVariable w -WarningAction SilentlyContinue | Out-Null
        $copy = @((Get-Content $script:Out -Raw | ConvertFrom-Json).docs) | Where-Object id -eq 'alpha-2026-1'
        @($copy.PSObject.Properties.Name) | Should -Be @('id', 'snapshot_sha256')
        ($w -join "`n") | Should -Match '1 source dir\(s\) have no readable metadata.json'
    }

    It 'is byte-stable: a rerun reports no change and leaves the file untouched' {
        $first = Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out 3>$null
        $first.Changed | Should -BeTrue
        $bytes = [IO.File]::ReadAllBytes($script:Out); $stamp = (Get-Item $script:Out).LastWriteTimeUtc
        Start-Sleep -Milliseconds 50
        $second = Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out 3>$null
        $second.Changed | Should -BeFalse
        [Linq.Enumerable]::SequenceEqual([byte[]]$bytes, [byte[]][IO.File]::ReadAllBytes($script:Out)) | Should -BeTrue
        (Get-Item $script:Out).LastWriteTimeUtc | Should -Be $stamp
    }

    It '-WhatIf writes nothing but still reports the full index' {
        $r = Export-SourcesIndex -SourcesDir $script:Src -OutputPath $script:Out -WhatIf 3>$null 6>$null
        Test-Path $script:Out | Should -BeFalse
        $r.DocCount | Should -Be 4 -Because 'a dry run must build the same index it would write'
    }

    It 'reproduces the committed sample exactly (the contract fixture the TS reader also parses)' {
        # tests/fixtures/sources-index/{src,expected.json}: Server Storage's reader parses
        # expected.json against lib/sourceIndex/sourcesIndexSchema.ts, so a field rename on either side
        # breaks a test, not prod (review of #3560). Line endings are normalized for Windows checkouts.
        $fx = Join-Path $PSScriptRoot 'fixtures' 'sources-index'
        $r = Export-SourcesIndex -SourcesDir (Join-Path $fx 'src') -OutputPath $script:Out 3>$null
        $r.DocCount | Should -Be 4
        $expected = [IO.File]::ReadAllText((Join-Path $fx 'expected.json')).Replace("`r`n", "`n")
        [IO.File]::ReadAllText($script:Out) | Should -BeExactly $expected
    }

    It 'throws an actionable error when the sources directory is missing' {
        { Export-SourcesIndex -SourcesDir (Join-Path $script:Root 'nope') -OutputPath $script:Out } |
            Should -Throw -ExpectedMessage '*Sources directory not found*'
    }
}
