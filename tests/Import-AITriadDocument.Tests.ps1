# Tag: ingestion (t/1186, t/4337)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# End-to-end ingestion duplicate detection (t/4337). Real Import-AITriadDocument runs against a
# temp sources directory, ingesting local .md files (no AI, network, Wayback or summary calls).

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    function script:New-TempSources {
        $d = Join-Path ([System.IO.Path]::GetTempPath()) "ait-dedupe-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path (Join-Path $d '_inbox') -Force | Out-Null
        $d
    }
    function script:New-MdFile([string]$Dir, [string]$Name, [string]$Text) {
        $p = Join-Path $Dir $Name
        [System.IO.File]::WriteAllText($p, $Text, [System.Text.UTF8Encoding]::new($false))
        $p
    }
    function script:Get-DocDirs([string]$Sources) {
        @(Get-ChildItem -LiteralPath $Sources -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' } | Select-Object -ExpandProperty Name)
    }
    # Runs the real cmdlet inside the module with the sources dir redirected and side calls
    # stubbed. -File does not output the doc id, so the new doc is found by diffing the folder.
    # Warnings land in $script:LastWarnings.
    function script:Invoke-TestIngest([string]$Sources, [hashtable]$Params) {
        $before = @(Get-DocDirs $Sources)
        $script:LastWarnings = InModuleScope AITriad -Parameters @{ Sources = $Sources; P = $Params } {
            param($Sources, $P)
            Mock Get-SourcesDir { $Sources }
            Mock Update-AITSourceIndex { }
            Mock Add-ToSummaryQueue { }
            Mock Submit-ToWaybackMachine { }
            $w = $null
            $null = Import-AITriadDocument @P -SkipAiMeta -SkipWayback -NoSummaryQueue -NoSummarize -WarningVariable w -WarningAction SilentlyContinue 6>$null
            , @($w | ForEach-Object { [string]$_ })
        }
        $new = @(Get-DocDirs $Sources | Where-Object { $before -notcontains $_ })
        if ($new.Count -ne 1) { throw "expected exactly one new doc dir, found $($new.Count): $($new -join ', ')" }
        $new[0]
    }

    $script:Body = "# A Study of Ingestion`n`nFirst paragraph about duplicate documents.`n`nSecond paragraph.`n"
}

Describe 'Import-AITriadDocument duplicate detection (t/4337)' -Tag 'ingestion' {

    BeforeEach {
        $script:Sources = New-TempSources
        $script:Work = Join-Path $script:Sources '_work'
        New-Item -ItemType Directory -Path $script:Work -Force | Out-Null
        $script:First = Invoke-TestIngest $script:Sources @{ File = (New-MdFile $script:Work 'study.md' $script:Body) }
    }
    AfterEach {
        if (Test-Path $script:Sources) { Remove-Item $script:Sources -Recurse -Force }
    }

    It 'records content_sha256 equal to the spec hash of the written snapshot' {
        $dir = Join-Path $script:Sources $script:First
        $meta = Get-Content (Join-Path $dir 'metadata.json') -Raw | ConvertFrom-Json
        $expected = InModuleScope AITriad -Parameters @{ S = (Join-Path $dir 'snapshot.md') } {
            param($S) Get-SourceContentHash -Text ([System.IO.File]::ReadAllText($S))
        }
        $meta.content_sha256 | Should -Match '^[0-9a-f]{64}$'
        $meta.content_sha256 | Should -BeExactly $expected
        @($meta.PSObject.Properties.Name) | Should -Not -Contain 'same_as'
        @($meta.PSObject.Properties.Name) | Should -Not -Contain 'parent_doc_id'
    }

    It 'refuses the same file again and writes nothing' {
        { Invoke-TestIngest $script:Sources @{ File = (Join-Path $script:Work 'study.md') } } |
            Should -Throw -ExpectedMessage "*Duplicate source: identical content (content_sha256) already ingested as '$($script:First)'*"
        @(Get-DocDirs $script:Sources) | Should -Be @($script:First)
    }

    It 'refuses identical content under a different file name (the old -N path)' {
        $copy = New-MdFile $script:Work 'study-copy.md' $script:Body.Replace("`n", "`r`n") # CRLF must not matter
        { Invoke-TestIngest $script:Sources @{ File = $copy } } | Should -Throw -ExpectedMessage '*identical content*'
        @(Get-DocDirs $script:Sources).Count | Should -Be 1
    }

    It '-Force no longer bypasses duplicate detection, and says so' {
        $copy = New-MdFile $script:Work 'study-force.md' $script:Body
        { Invoke-TestIngest $script:Sources @{ File = $copy; Force = $true } } | Should -Throw -ExpectedMessage '*-Force no longer bypasses duplicate detection*'
        @(Get-DocDirs $script:Sources).Count | Should -Be 1
    }

    It 'ingests different content with the same title as a new -N doc, with a title warning' {
        $other = New-MdFile $script:Work 'study-v2.md' ("# A Study of Ingestion`n`nA genuinely different text.`n")
        $id = Invoke-TestIngest $script:Sources @{ File = $other }
        $id | Should -BeExactly "$($script:First)-1"
        ($script:LastWarnings -join "`n") | Should -Match 'Possible duplicate: same title'
        $m1 = Get-Content (Join-Path $script:Sources "$($script:First)\metadata.json") -Raw | ConvertFrom-Json
        $m2 = Get-Content (Join-Path $script:Sources "$id\metadata.json") -Raw | ConvertFrom-Json
        $m2.content_sha256 | Should -Not -Be $m1.content_sha256
    }

    It 'ingests a different document whose file name matches an existing raw file, with a warning' {
        $sub = Join-Path $script:Work 'other-folder'
        New-Item -ItemType Directory -Path $sub -Force | Out-Null
        $same = New-MdFile $sub 'study.md' "# Unrelated Paper`n`nNothing to do with the first study.`n"
        $id = Invoke-TestIngest $script:Sources @{ File = $same }
        $id | Should -Not -Be $script:First
        ($script:LastWarnings -join "`n") | Should -Match "raw file name 'study.md' already exists"
    }

    It 'refuses content that matches a legacy doc with no recorded hash (computed from snapshot.md)' {
        $legacy = Join-Path $script:Sources 'legacy-doc-2026'
        New-Item -ItemType Directory -Path $legacy -Force | Out-Null
        '{"id":"legacy-doc-2026","title":"Legacy"}' | Set-Content (Join-Path $legacy 'metadata.json') -Encoding utf8NoBOM
        $legacySnap = "<!--`r`n  AI Triad Research Project — Document Snapshot`r`n  Captured   : 2026-04-11`r`n-->`r`n`r`n# Legacy`r`n`r`n---`r`n`r`n" + "Only in the legacy doc.`n"
        [System.IO.File]::WriteAllText((Join-Path $legacy 'snapshot.md'), $legacySnap)
        $f = New-MdFile $script:Work 'legacy-again.md' "Only in the legacy doc.`n"
        { Invoke-TestIngest $script:Sources @{ File = $f } } | Should -Throw -ExpectedMessage "*already ingested as 'legacy-doc-2026'*"
    }

    It 'refuses a URL whose trusted key matches an existing doc, before any download' {
        $byUrl = Join-Path $script:Sources 'by-url-2026'
        New-Item -ItemType Directory -Path $byUrl -Force | Out-Null
        '{"id":"by-url-2026","title":"By URL","url":"https://www.example.org/report/?utm_source=feed"}' | Set-Content (Join-Path $byUrl 'metadata.json') -Encoding utf8NoBOM
        # Network calls are stubbed to throw a distinctive message: if the early check failed to
        # refuse, the error would be the stub's, not the duplicate refusal.
        $message = InModuleScope AITriad -Parameters @{ Sources = $script:Sources } {
            param($Sources)
            Mock Get-SourcesDir { $Sources }; Mock Update-AITSourceIndex { }; Mock Add-ToSummaryQueue { }
            Mock Invoke-WebRequest { throw 'network must not be reached' }
            Mock Invoke-RestMethod { throw 'network must not be reached' }
            try { Import-AITriadDocument -Url 'http://example.org/report' -SkipAiMeta -SkipWayback -NoSummaryQueue -NoSummarize 6>$null; 'NO THROW' }
            catch { [string]$_ }
        }
        $message | Should -Match "same source URL \(example\.org/report\) already ingested as 'by-url-2026'"
        $message | Should -Not -Match 'network must not be reached'
        @(Get-DocDirs $script:Sources).Count | Should -Be 2   # the study + the hand-made by-url doc; nothing new
    }

    It '-SameAs writes same_as for a reprint with different content' {
        $reprint = New-MdFile $script:Work 'reprint.md' "# A Study of Ingestion (reprint)`n`nThe reprint has an editor's note and different wording.`n"
        $id = Invoke-TestIngest $script:Sources @{ File = $reprint; SameAs = $script:First }
        (Get-Content (Join-Path $script:Sources "$id\metadata.json") -Raw | ConvertFrom-Json).same_as | Should -BeExactly $script:First
    }

    It '-ParentDocId writes parent_doc_id' {
        $part = New-MdFile $script:Work 'appendix.md' "# Appendix B`n`nTables for the study.`n"
        $id = Invoke-TestIngest $script:Sources @{ File = $part; ParentDocId = $script:First }
        (Get-Content (Join-Path $script:Sources "$id\metadata.json") -Raw | ConvertFrom-Json).parent_doc_id | Should -BeExactly $script:First
    }

    It '-SameAs does not bypass an identical-content refusal' {
        $copy = New-MdFile $script:Work 'same-text.md' $script:Body
        { Invoke-TestIngest $script:Sources @{ File = $copy; SameAs = $script:First } } | Should -Throw -ExpectedMessage '*identical content*'
    }

    It 'refuses -SameAs to a doc id that does not exist' {
        $f = New-MdFile $script:Work 'x.md' "# X`n`nx`n"
        { Invoke-TestIngest $script:Sources @{ File = $f; SameAs = 'no-such-doc-2026' } } | Should -Throw -ExpectedMessage "*-SameAs 'no-such-doc-2026' is not an existing source document*"
        @(Get-DocDirs $script:Sources).Count | Should -Be 1
    }

    It 'refuses -SameAs together with -ParentDocId' {
        $f = New-MdFile $script:Work 'y.md' "# Y`n`ny`n"
        { Invoke-TestIngest $script:Sources @{ File = $f; SameAs = $script:First; ParentDocId = $script:First } } | Should -Throw -ExpectedMessage '*-SameAs and -ParentDocId were both given*'
    }

    It '-Inbox catches a duplicate within the same batch and leaves it in the inbox' {
        $inbox = Join-Path $script:Sources '_inbox'
        $null = New-MdFile $inbox 'batch-a.md' "# Batch item`n`nSame text twice in one batch.`n"
        $null = New-MdFile $inbox 'batch-b.md' "# Batch item`n`nSame text twice in one batch.`n"
        $null = InModuleScope AITriad -Parameters @{ Sources = $script:Sources } {
            param($Sources)
            Mock Get-SourcesDir { $Sources }; Mock Update-AITSourceIndex { }; Mock Add-ToSummaryQueue { }
            Import-AITriadDocument -Inbox -SkipAiMeta -SkipWayback -NoSummaryQueue -NoSummarize 6>$null
        }
        @(Get-DocDirs $script:Sources).Count | Should -Be 2   # the first study + one batch item
        @(Get-ChildItem $inbox -File).Count | Should -Be 1    # the duplicate stays for a human
    }
}

Describe 'Find-SourceDuplicate strength rules (t/4337)' -Tag 'ingestion' {
    It 'treats a search-provenance URL as weak, never a refusal' {
        InModuleScope AITriad {
            $index = [pscustomobject]@{ Ids = [System.Collections.Generic.HashSet[string]]::new(); ByHash = @{}; ByUrl = @{}; ByTitle = @{}; ByRawName = @{} }
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) "ait-fsd-$([guid]::NewGuid().ToString('N').Substring(0, 8))\guessed-2026"
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            try {
                '{"title":"Guessed","url":"https://x.org/p","provenance":[{"scheme":"url","id":"https://x.org/p","confidence":"search"}]}' | Set-Content (Join-Path $dir 'metadata.json') -Encoding utf8NoBOM
                Add-SourceIdentityIndexEntry -Index $index -DocDir $dir
                (Find-SourceDuplicate -Index $index -Url 'https://x.org/p').Strong | Should -BeNullOrEmpty
            } finally { Remove-Item (Split-Path $dir) -Recurse -Force }
        }
    }

    It 'treats a shared raw file name as weak, never a refusal' {
        InModuleScope AITriad {
            $index = [pscustomobject]@{ Ids = [System.Collections.Generic.HashSet[string]]::new(); ByHash = @{}; ByUrl = @{}; ByTitle = @{}; ByRawName = @{ 'paper.pdf' = [System.Collections.Generic.List[string]]@('a-2026') } }
            $r = Find-SourceDuplicate -Index $index -RawFileName 'Paper.PDF'
            $r.Strong | Should -BeNullOrEmpty
            @($r.Weak | Where-Object Kind -eq 'filename').Count | Should -Be 1
        }
    }

    It 'skips dot and underscore directories when building the index' {
        $root = Join-Path ([System.IO.Path]::GetTempPath()) "ait-idx-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        foreach ($n in '.claude', '_inbox', 'real-doc-2026') { New-Item -ItemType Directory -Path (Join-Path $root $n) -Force | Out-Null }
        try {
            $ids = InModuleScope AITriad -Parameters @{ R = $root } { param($R) @((Get-SourceIdentityIndex -SourcesDir $R).Ids) }
            @($ids) | Should -Be @('real-doc-2026')
        } finally { Remove-Item $root -Recurse -Force }
    }
}

Describe 'Remove-VerticalTextArtifact (extracted unchanged, t/4337)' -Tag 'ingestion' {
    It 'strips a run of 10+ one- or two-character lines and keeps a shorter run' {
        InModuleScope AITriad {
            $long  = (@('a') * 12) -join "`n"
            $short = (@('b') * 3) -join "`n"
            $md = "Intro`n$long`nMiddle`n$short`nEnd"
            $out = Remove-VerticalTextArtifact -Markdown $md 6>$null
            $out | Should -BeExactly "Intro`nMiddle`n$short`nEnd"
        }
    }
}
