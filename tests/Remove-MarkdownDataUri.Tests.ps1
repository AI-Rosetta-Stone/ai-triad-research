# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Remove-MarkdownDataUri (t/4385): inline base64 images are stripped from snapshot text
    before a reader truncates it to a character window.
#>

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force -WarningAction SilentlyContinue
    $script:B64 = ('QUJD' * 4500)   # 18,000 chars of base64
}

Describe 'Remove-MarkdownDataUri (t/4385)' -Tag 'unit' {

    It 'strips an 18,000-char inline image so a 20,000-char window starts with the text' {
        InModuleScope AITriad -Parameters @{ B64 = $script:B64 } {
            param($B64)
            $snap = "![](data:image/svg+xml;base64,$B64)`n`n# Executive Order`n`nSection 1. Purpose. The policy of the United States is..."
            $r = Remove-MarkdownDataUri -Text $snap
            $r.UriCount | Should -Be 1
            $r.StrippedChars | Should -BeGreaterThan 18000
            $window = $r.Text.TrimStart()
            if ($window.Length -gt 20000) { $window = $window.Substring(0, 20000) }
            $window | Should -Match '^# Executive Order'
            $window | Should -Not -Match 'base64'
        }
    }

    It 'strips a bare data URI (an HTML img) and leaves the surrounding prose intact' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text 'Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="x"> after the image.'
            $r.Text | Should -Be 'Before <img src="" alt="x"> after the image.'
            $r.UriCount | Should -Be 1
        }
    }

    It 'stops a bare URI at whitespace so the next words survive' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text 'see data:image/gif;base64,R0lGODlh The policy text follows'
            $r.Text | Should -Be 'see  The policy text follows'
        }
    }

    It 'counts several images and handles a title and media-type parameters' {
        InModuleScope AITriad {
            $t = "a ![one](data:image/png;base64,AAAA) b ![two](data:image/svg+xml;charset=utf-8;base64,BBBB `"t`") c"
            $r = Remove-MarkdownDataUri -Text $t
            $r.Text | Should -Be 'a  b  c'
            $r.UriCount | Should -Be 2
        }
    }

    It 'leaves text with no data URI, and ordinary image links, unchanged' {
        InModuleScope AITriad {
            $t = 'Plain text with ![a chart](https://example.org/c.png) and the word data: in prose.'
            $r = Remove-MarkdownDataUri -Text $t
            $r.Text | Should -Be $t
            $r.StrippedChars | Should -Be 0
            $r.UriCount | Should -Be 0
        }
    }

    It 'returns an empty result for empty input' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text ''
            $r.Text | Should -Be ''
            $r.StrippedChars | Should -Be 0
        }
    }
}

Describe 'Invoke-OrgStanceExtraction strips data URIs before truncating (t/4385)' -Tag 'unit' {

    It 'reads the snapshot through Read-SnapshotForModel before applying MaxDocChars' {
        $src = Get-Content -Raw "$PSScriptRoot/../scripts/AITriad/Public/Invoke-OrgStanceExtraction.ps1"
        $strip = $src.IndexOf('Read-SnapshotForModel -Path')
        $trunc = $src.IndexOf('$docText.Substring(0, $MaxDocChars)')
        $strip | Should -BeGreaterThan 0
        $trunc | Should -BeGreaterThan $strip -Because 'the window must be cut from the stripped text'
    }
}

Describe 'Guard: no PowerShell reader feeds snapshot text to a model unstripped (t/4385#3)' -Tag 'unit' {
    # Every file under scripts/ that touches a snapshot must either strip (it uses one of the
    # helpers below) or be listed here with the reason it never sends snapshot text to a model.
    # A NEW reader fails this test until it is classified. A listed file that starts calling a
    # model fails too: the allowlist only covers files with no model call.
    BeforeAll {
        $script:Helpers = 'Read-SnapshotForModel', 'Remove-MarkdownDataUri', 'Read-POVSummarySnapshot'
        $script:NoModel = @{
            'AITriad/Private/Get-SourcesIndexEntry.ps1'      = 'index metadata and content hash: must read the file as written'
            'AITriad/Private/SourceIdentity.ps1'             = 'content_sha256 is over the snapshot as written (spec 1.1)'
            'AITriad/Private/SourceDedupe.ps1'               = 'dedupe hashes: must read the file as written'
            'AITriad/Public/Export-SourcesIndex.ps1'         = 'writes sources-index.json (hashes), no model'
            'AITriad/Private/New-AITSourceFromMetadata.ps1'  = 'builds the source object (path only), no model'
            'AITriad/Private/New-BatchDocEntry.ps1'          = 'existence/emptiness check; the summarizer reads via Read-SnapshotForModel'
            'AITriad/Private/Split-DocumentChunks.ps1'       = 'pure chunker over text it is given (callers strip)'
            'AITriad/Private/Measure-DensityDistribution.ps1' = 'word counts for a density report, no model'
            'AITriad/Public/Get-ImportReport.ps1'            = 'import report display, no model'
            'AITriad/Public/Get-TaxonomySnapshot.ps1'        = 'downloads taxonomy snapshots (unrelated "snapshot")'
            'AITriad/Public/Export-TriadDebateBrief.ps1'     = 'brief export, no model'
            'AITriad/Public/Invoke-AITDebate.ps1'            = 'passes -DocPath to the TS debate CLI; the TS stack strips (lib/debate)'
            'AITriad/Public/Invoke-DebateAB.ps1'             = 'passes -DocPath to the TS debate CLI; the TS stack strips (lib/debate)'
            'AITriad/Public/Repair-Markdown.ps1'             = 'snapshot text repair (writes the file), no model'
            'AITriad/Public/Update-Snapshot.ps1'             = 're-converts and writes the snapshot; must stay as converted'
            'DocConverters.psm1'                             = 'converters write the snapshot; must stay as converted'
            'PdfOptimizer.psm1'                              = 'PDF compression, no model'
            'New-SourceIdentityFixture.ps1'                  = 'test-fixture hashes over the file as written'
            'data-mutations/t4337/Invoke-T4337DuplicateMark.ps1' = 't/4337 mark writer: hashes snapshots as written (spec 1.1) for grouping, no model'
            'data-mutations/t4405/Invoke-T4405DuplicateMark.ps1' = 't/4405 mark writer: hashes and length-compares snapshots for the duplicate guards, no model'
        }
        $script:ScriptsRoot = (Resolve-Path "$PSScriptRoot/../scripts").Path
        $script:Readers = @(Get-ChildItem $script:ScriptsRoot -Recurse -File -Include *.ps1, *.psm1 |
            Where-Object { $_.FullName -notmatch '[\\/]archive[\\/]' -and $_.Name -ne 'Remove-MarkdownDataUri.ps1' } |
            Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'snapshot\.md|SnapshotFile|SnapshotPath|SnapPath|\.Snapshot\b' -Quiet } |
            ForEach-Object {
                $rel = $_.FullName.Substring($script:ScriptsRoot.Length + 1) -replace '\\', '/'
                $src = Get-Content -Raw -LiteralPath $_.FullName
                [pscustomobject]@{
                    Rel       = $rel
                    Strips    = [bool]($script:Helpers | Where-Object { $src -match [regex]::Escape($_) })
                    CallsModel = $src -match 'Invoke-AIApi|Get-AIMetadata|Invoke-SummaryPipeline|Get-Prompt\s'
                }
            })
    }

    It 'finds the known snapshot readers (the scan works)' {
        @($script:Readers).Count | Should -BeGreaterThan 10
        @($script:Readers.Rel) | Should -Contain 'AITriad/Public/Invoke-OrgStanceExtraction.ps1'
    }

    It 'every snapshot reader either strips or is listed as never feeding a model' {
        $unclassified = @($script:Readers | Where-Object { -not $_.Strips -and -not $script:NoModel.ContainsKey($_.Rel) } | ForEach-Object Rel)
        $unclassified | Should -BeNullOrEmpty -Because 'a new snapshot reader must use Read-SnapshotForModel, or be added to the allowlist with a reason'
    }

    It 'no snapshot reader that calls a model goes without the strip helper' {
        $unguarded = @($script:Readers | Where-Object { $_.CallsModel -and -not $_.Strips } | ForEach-Object Rel)
        $unguarded | Should -BeNullOrEmpty
    }

    It 'the allowlist has no stale entries' {
        $stale = @($script:NoModel.Keys | Where-Object { $_ -notin @($script:Readers.Rel) })
        $stale | Should -BeNullOrEmpty -Because 'remove an entry when its file no longer touches snapshots'
    }
}

Describe 'The POV summarizer reads snapshots with data URIs stripped (t/4386)' -Tag 'unit' {

    BeforeAll {
        $script:B64 = ('QUJD' * 4500)
        $script:Snap = Join-Path $TestDrive 'snapshot.md'
        Set-Content -LiteralPath $script:Snap -Encoding utf8NoBOM -Value "![](data:image/svg+xml;base64,$($script:B64))`n`n# The Real Title`n`nThe argument of the essay begins here."
    }

    It 'Read-SnapshotForModel returns the text without the image, WARNs, and leaves the file unchanged' {
        $before = Get-FileHash -LiteralPath $script:Snap
        InModuleScope AITriad -Parameters @{ P = $script:Snap } {
            param($P)
            $t = Read-SnapshotForModel -Path $P -CallerName 'Test' -WarningVariable w 3>$null
            $t.TrimStart() | Should -Match '^# The Real Title'
            $t | Should -Not -Match 'base64'
            ($w -join "`n") | Should -Match 'Test: stripped \d+ chars of inline data: URIs'
        }
        (Get-FileHash -LiteralPath $script:Snap).Hash | Should -Be $before.Hash -Because 'content_sha256 is over the file as written'
    }

    It 'a doc whose first 2,000 chars are base64 reaches the pipeline (and its RAG query) as text' {
        InModuleScope AITriad -Parameters @{ P = $script:Snap } {
            param($P)
            $script:CapturedSnapshot = $null
            Mock Invoke-SummaryPipeline { $script:CapturedSnapshot = $SnapshotText; throw 'stop-after-capture' }
            $doc = @{ DocId = 'fixture-doc'; SnapshotFile = $P; PovTags = @(); Meta = [pscustomobject]@{ title = 'T'; pov_tags = @() } }
            try {
                $null = Invoke-DocumentSummary -Doc $doc -ApiKey 'k' -Model 'gemini-3.5-flash-lite' -Temperature 0.1 `
                    -TaxonomyVersion 'v' -TaxonomyJson '{}' -SystemPromptTemplate 's' -OutputSchema '{}' `
                    -SummariesDir $TestDrive -Now '2026-10-21T00:00:00Z' 3>$null
            } catch { if ($_.Exception.Message -notmatch 'stop-after-capture') { throw } }
            $script:CapturedSnapshot | Should -Not -BeNullOrEmpty
            $query = $script:CapturedSnapshot.TrimStart()
            if ($query.Length -gt 2000) { $query = $query.Substring(0, 2000) }
            $query | Should -Match '^# The Real Title'
            $query | Should -Not -Match 'base64'
        }
    }

    It 'every summarizer snapshot load goes through Read-SnapshotForModel' {
        $files = 'Private/Invoke-DocumentSummary.ps1', 'Private/InvokePOVSummarySteps.ps1' |
            ForEach-Object { Get-Content -Raw "$PSScriptRoot/../scripts/AITriad/$_" }
        ($files -join "`n") | Should -Not -Match 'SnapshotText\s*=\s*Get-Content'
        ([regex]::Matches(($files -join "`n"), 'Read-SnapshotForModel -Path')).Count | Should -Be 3
    }
}
