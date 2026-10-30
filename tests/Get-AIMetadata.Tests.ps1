# Tag: ingestion (t/1186)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Get-AIMetadata validation — date_published format (gap 2.1),
    title/one_liner length (gap 2.2), and author deduplication (gap 2.3).
#>

BeforeAll {
    # t/4582 (GH #3978): the tests mock Invoke-AIByUsage, which AITriad exports, so load it here
    # rather than depending on an earlier file in the shard having done it (order-dependent heal).
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-AIMetadata date_published validation (gap 2.1)' -Tag 'ingestion' {

    It 'Accepts YYYY format' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -Be '2024'
    }

    It 'Accepts YYYY-MM format' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024-03","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -Be '2024-03'
    }

    It 'Accepts YYYY-MM-DD format' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024-03-15","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -Be '2024-03-15'
    }

    It 'Normalizes "March 2024" to YYYY-MM-DD' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"March 2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -Be '2024-03-01'
    }

    It 'Normalizes "March 15, 2024" to YYYY-MM-DD' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"March 15, 2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -Be '2024-03-15'
    }

    It 'Clears unrecognised date format' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"sometime last year","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -BeNullOrEmpty
    }

    It 'Returns $null when date_published is absent' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.date_published | Should -BeNullOrEmpty
    }
}

Describe 'Get-AIMetadata title/one_liner length limits (gap 2.2)' -Tag 'ingestion' {

    It 'Truncates title exceeding 200 chars' {
        $longTitle = 'A' * 250
        $mockResponse = [PSCustomObject]@{
            Text    = "{`"title`":`"$longTitle`",`"authors`":[],`"date_published`":`"2024`",`"pov_tags`":[],`"topic_tags`":[],`"one_liner`":`"O`"}"
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.title.Length | Should -Be 200
        $result.title | Should -BeLike '*...'
    }

    It 'Leaves title under 200 chars unchanged' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"Normal Title","authors":[],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.title | Should -Be 'Normal Title'
    }

    It 'Uses FallbackTitle when AI returns empty title' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"","authors":[],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' -FallbackTitle 'Fallback' 3>$null 6>$null
        $result.title | Should -Be 'Fallback'
    }

    It 'Truncates one_liner exceeding 300 chars' {
        $longOneLiner = 'B' * 350
        $mockResponse = [PSCustomObject]@{
            Text    = "{`"title`":`"T`",`"authors`":[],`"date_published`":`"2024`",`"pov_tags`":[],`"topic_tags`":[],`"one_liner`":`"$longOneLiner`"}"
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.one_liner.Length | Should -Be 300
        $result.one_liner | Should -BeLike '*...'
    }
}

Describe 'Get-AIMetadata whole-document sampling (t/4655)' -Tag 'ingestion' {

    BeforeAll {
        # A >6000-word document with a unique marker sentence placed well past word 6000, inside a
        # late section Split-RagQueryWindows would keep -- proves the classifier sees past the old
        # flat-prefix cutoff, not just that a WARN fired.
        $script:LongDocMarker = 'MARKER-SENTENCE-UNIQUE-TOKEN-ZZYZX appears only near the end.'
        $filler = (1..6500 | ForEach-Object { "word$_" }) -join ' '
        $script:LongDoc = "## Introduction`n`n$filler`n`n## Conclusion`n`n$($script:LongDocMarker) The document concludes here."
    }

    It 'samples across the whole document and WARNs with word/window counts' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024","pov_tags":["accelerationist"],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        $script:capturedPrompt = $null
        Mock Invoke-AIApi -ModuleName AIEnrich -MockWith {
            $script:capturedPrompt = $Prompt
            $mockResponse
        }
        Mock Invoke-AIByUsage -ModuleName AIEnrich -MockWith {
            $script:capturedPrompt = $Values.prompt
            $mockResponse
        }

        $warnings = $null
        $null = Get-AIMetadata -MarkdownText $script:LongDoc -WarningVariable warnings -WarningAction SilentlyContinue 6>$null

        $script:capturedPrompt | Should -Match 'MARKER-SENTENCE-UNIQUE-TOKEN-ZZYZX'
        ($warnings -join '|') | Should -Match 'sampled \d+ words from a \d+-word document across \d+ windows'
    }

    It 'does not sample or WARN for a document at or under the 6000-word budget' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        $script:capturedPrompt = $null
        Mock Invoke-AIApi -ModuleName AIEnrich -MockWith {
            $script:capturedPrompt = $Prompt
            $mockResponse
        }
        Mock Invoke-AIByUsage -ModuleName AIEnrich -MockWith {
            $script:capturedPrompt = $Values.prompt
            $mockResponse
        }
        $shortDoc = "## Doc`n`nMARKER-SENTENCE-UNIQUE-TOKEN-ZZYZX is right here, well under budget."

        $warnings = $null
        $null = Get-AIMetadata -MarkdownText $shortDoc -WarningVariable warnings -WarningAction SilentlyContinue 6>$null

        $script:capturedPrompt | Should -Match 'MARKER-SENTENCE-UNIQUE-TOKEN-ZZYZX'
        ($warnings -join '|') | Should -Not -Match 'sampled \d+ words'
    }
}

Describe 'Get-AIMetadata non-ASCII author round-trip through the full write path (t/4658)' -Tag 'ingestion' {
    # t/4658: 20 corpus docs have a "LeÃ³n"-style mojibake author (UTF-8 bytes mis-decoded as
    # Latin-1, then correctly re-encoded -- the on-disk bytes for 'ó' end up C3 83 C2 B3 instead
    # of the correct C3 B3). Not reproducible against the live Get-AIMetadata call alone (verified
    # separately), but Quality's design review (t/4658, p/678#216) asked this test to go past the
    # in-memory object and exercise the actual ConvertTo-Json -> Write-Utf8NoBom write path, since
    # that's the layer a future regression is most likely to reappear in.

    It 'writes a non-ASCII author name to disk as correct UTF-8, not a double-encoded mojibake' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":["Esteban Ponce de León"],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi -ModuleName AIEnrich -MockWith { $mockResponse }
        Mock Invoke-AIByUsage -ModuleName AIEnrich -MockWith { $mockResponse }

        $meta = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null

        # Simulate Import-AITriadDocument's metadata.json assembly and write (same two calls,
        # ConvertTo-Json then Write-Utf8NoBom), not just inspecting the in-memory object.
        # Write-Utf8NoBom is AITriad-Private, so the actual write happens via InModuleScope.
        $outPath = Join-Path $TestDrive 'metadata.json'
        $authorsJson = $meta.authors | ConvertTo-Json -Depth 5 -AsArray
        InModuleScope AITriad -Parameters @{ AuthorsJson = $authorsJson; OutPath = $outPath } {
            param($AuthorsJson, $OutPath)
            $Metadata = [ordered]@{ id = 'test-doc'; authors = ($AuthorsJson | ConvertFrom-Json) }
            $Metadata | ConvertTo-Json -Depth 5 | Write-Utf8NoBom -Path $OutPath
        }

        $bytes = [System.IO.File]::ReadAllBytes($outPath)
        $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

        $hex | Should -Match 'c3b3'       # correct single UTF-8 encoding of 'ó'
        $hex | Should -Not -Match 'c383c2b3'   # the double-encoded mojibake pattern ("Ã³")

        # Confirm readback matches the pre-write codepoints exactly. Compared as codepoints,
        # not a literal string, so this doesn't depend on this source FILE's own encoding.
        # @(...)[0] guards against the single-element authors array round-tripping as a bare
        # string (PowerShell's ConvertTo-Json/-From-Json unwrap single-element arrays by default),
        # which would otherwise index into its first CHAR instead of the author string.
        $readBack = @((Get-Content -LiteralPath $outPath -Raw -Encoding utf8 | ConvertFrom-Json).authors)[0]
        $originalAuthor = @($meta.authors)[0]
        $readBackCodepoints = $readBack.ToCharArray() | ForEach-Object { [int]$_ }
        $originalCodepoints = $originalAuthor.ToCharArray() | ForEach-Object { [int]$_ }
        ($readBackCodepoints -join ',') | Should -Be ($originalCodepoints -join ',')
    }
}

Describe 'Get-AIMetadata author deduplication (gap 2.3)' -Tag 'ingestion' {

    It 'Removes exact duplicates' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":["John Smith","John Smith"],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.authors.Count | Should -Be 1
        $result.authors[0] | Should -Be 'John Smith'
    }

    It 'Removes case-variant duplicates keeping first occurrence' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":["John Smith","john smith","JOHN SMITH"],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.authors.Count | Should -Be 1
        $result.authors[0] | Should -Be 'John Smith'
    }

    It 'Preserves distinct authors' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":["Alice","Bob","Charlie"],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.authors.Count | Should -Be 3
    }

    It 'Returns empty array when no authors' {
        $mockResponse = [PSCustomObject]@{
            Text    = '{"title":"T","authors":[],"date_published":"2024","pov_tags":[],"topic_tags":[],"one_liner":"O"}'
            Backend = 'gemini'
            Model   = 'gemini-2.5-flash-lite'
            Truncated = $false
            Usage   = $null
            RawResponse = @{}
        }
        Mock Invoke-AIApi { $mockResponse } -ModuleName AIEnrich
        Mock Invoke-AIByUsage { $mockResponse } -ModuleName AIEnrich

        $result = Get-AIMetadata -MarkdownText 'test doc' 3>$null 6>$null
        $result.authors.Count | Should -Be 0
    }
}
