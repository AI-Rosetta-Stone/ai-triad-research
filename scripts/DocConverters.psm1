# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Version 5.1
<#
.SYNOPSIS
    Document conversion helpers for AI Triad ingestion pipeline.
.DESCRIPTION
    HTML-to-Markdown, PDF-to-text, DOCX-to-Markdown converters and HTML metadata
    extraction.  Separated into a module to avoid AMSI false-positive detections
    triggered by HTML-parsing regex combined with web-fetch patterns.
#>

# ─────────────────────────────────────────────────────────────────────────────
# Utility: check for an external tool
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Tests whether an external CLI tool is available on the system PATH.
.DESCRIPTION
    Checks if the named executable can be found via Get-Command.  Used by the
    document conversion functions to determine which conversion tool chain is
    available (pandoc, pdftotext, mutool, markitdown).
.PARAMETER Name
    The executable name to check (e.g., 'pandoc', 'pdftotext', 'markitdown').
.EXAMPLE
    if (Test-ExternalTool 'pandoc') { Write-Host 'pandoc is available' }

.EXAMPLE
    Test-ExternalTool 'markitdown'  # Returns $true or $false
#>
function Test-ExternalTool {
    param([string]$Name)
    return ($null -ne (Get-Command $Name -ErrorAction SilentlyContinue))
}

# ─────────────────────────────────────────────────────────────────────────────
# HTML → Markdown converter (pure PowerShell, no dependencies)
# Covers the common structural elements found in policy/academic articles.
# If pandoc is available it is used instead for higher fidelity.
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Converts HTML content to Markdown.
.DESCRIPTION
    Transforms raw HTML into clean Markdown suitable for AI summarization.  If
    pandoc is installed, delegates to it for high-fidelity conversion.  Otherwise,
    uses a built-in pure-PowerShell converter that handles:

    - Block elements: headings (h1-h6), paragraphs, blockquotes, ordered/unordered
      lists, tables, horizontal rules, line breaks.
    - Inline elements: bold, italic, inline code, hyperlinks.
    - Stripping: script, style, nav, footer, header, aside, and other non-content
      elements.
    - Entity decoding: named entities (&amp;, &mdash;, etc.) and numeric entities.
    - Whitespace normalization: tab expansion, blank-line collapsing.
.PARAMETER Html
    The raw HTML string to convert.
.PARAMETER SourceUrl
    Optional source URL, passed through for provenance (not currently used in
    conversion but available for future link resolution).
.EXAMPLE
    $Md = ConvertFrom-Html -Html (Invoke-WebRequest 'https://example.com/article').Content
    $Md | Set-Content -LiteralPath snapshot.md -Encoding utf8NoBOM

    Converts a fetched web page to Markdown.
.EXAMPLE
    $Md = ConvertFrom-Html -Html (Get-Content page.html -Raw)

    Converts a local HTML file to Markdown.
#>
function ConvertFrom-Html {
    param(
        [Parameter(Mandatory)][string]$Html,
        [string]$SourceUrl = ''
    )

    if (Test-ExternalTool 'pandoc') {
        Write-Host "   →  Using pandoc for HTML → Markdown conversion" -ForegroundColor Gray
        $TempIn  = [System.IO.Path]::GetTempFileName() + '.html'
        $TempOut = [System.IO.Path]::GetTempFileName() + '.md'
        try {
            Set-Content -LiteralPath $TempIn -Value $Html -Encoding utf8NoBOM -NoNewline
            & pandoc $TempIn -f html -t markdown_strict --wrap=none -o $TempOut 2>$null
            if (Test-Path $TempOut) {
                $md = Get-Content $TempOut -Raw
                return $md
            }
        } finally {
            Remove-Item $TempIn, $TempOut -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "   →  Using built-in HTML → Markdown converter" -ForegroundColor Gray

    # ── 1. Strip <script>, <style>, <nav>, <footer>, <header>, <aside> blocks ─
    $NoScript = [regex]::Replace($Html,
        '(?is)<(script|style|nav|footer|header|aside|noscript|iframe|form|button|svg|figure)[^>]*>.*?</\1>',
        '')

    # ── 2. Block-level structural elements ────────────────────────────────────
    $Md = $NoScript

    # Headings
    for ($i = 6; $i -ge 1; $i--) {
        $Hashes = '#' * $i
        $Md = [regex]::Replace($Md, "(?is)<h$i[^>]*>(.*?)</h$i>",
            { param($m) "`n$Hashes " + [regex]::Replace($m.Groups[1].Value, '<[^>]+>', '').Trim() + "`n" })
    }

    # Paragraphs
    $Md = [regex]::Replace($Md, '(?is)<p[^>]*>(.*?)</p>',
        { param($m) "`n" + $m.Groups[1].Value.Trim() + "`n" })

    # Blockquote
    $Md = [regex]::Replace($Md, '(?is)<blockquote[^>]*>(.*?)</blockquote>',
        { param($m) "`n> " + [regex]::Replace($m.Groups[1].Value.Trim(), '\n', "`n> ") + "`n" })

    # Unordered lists
    $Md = [regex]::Replace($Md, '(?is)<ul[^>]*>(.*?)</ul>',
        { param($m)
            $inner = [regex]::Replace($m.Groups[1].Value, '(?is)<li[^>]*>(.*?)</li>',
                { param($li) "- " + [regex]::Replace($li.Groups[1].Value, '<[^>]+>', '').Trim() + "`n" })
            "`n$inner"
        })

    # Ordered lists
    $counter = 0
    $Md = [regex]::Replace($Md, '(?is)<ol[^>]*>(.*?)</ol>',
        { param($m)
            $counter = 0
            $inner = [regex]::Replace($m.Groups[1].Value, '(?is)<li[^>]*>(.*?)</li>',
                { param($li) $counter++; "$counter. " + [regex]::Replace($li.Groups[1].Value, '<[^>]+>', '').Trim() + "`n" })
            "`n$inner"
        })

    # Tables — simplified: just extract cell text row by row
    $Md = [regex]::Replace($Md, '(?is)<table[^>]*>(.*?)</table>',
        { param($m)
            $rows  = [regex]::Matches($m.Groups[1].Value, '(?is)<tr[^>]*>(.*?)</tr>')
            $lines = foreach ($row in $rows) {
                $cells = [regex]::Matches($row.Groups[1].Value, '(?is)<t[dh][^>]*>(.*?)</t[dh]>')
                '| ' + ($cells | ForEach-Object { [regex]::Replace($_.Groups[1].Value, '<[^>]+>', '').Trim() } | Join-String -Separator ' | ') + ' |'
            }
            "`n" + ($lines -join "`n") + "`n"
        })

    # Horizontal rule
    $Md = [regex]::Replace($Md, '(?i)<hr[^>]*/?>',   "`n---`n")

    # Line breaks
    $Md = [regex]::Replace($Md, '(?i)<br[^>]*/?>',   "  `n")

    # ── 3. Inline elements ────────────────────────────────────────────────────
    # Bold
    $Md = [regex]::Replace($Md, '(?is)<(strong|b)[^>]*>(.*?)</\1>', '**$2**')
    # Italic
    $Md = [regex]::Replace($Md, '(?is)<(em|i)[^>]*>(.*?)</\1>',    '*$2*')
    # Inline code
    $Md = [regex]::Replace($Md, '(?is)<code[^>]*>(.*?)</code>',     '`$1`')
    # Links — preserve href
    $Md = [regex]::Replace($Md, '(?is)<a\s[^>]*href=["\x27]([^"\x27]+)["\x27][^>]*>(.*?)</a>',
        { param($m)
            $href  = $m.Groups[1].Value
            $label = [regex]::Replace($m.Groups[2].Value, '<[^>]+>', '').Trim()
            if ([string]::IsNullOrWhiteSpace($label)) { $href } else { "[$label]($href)" }
        })

    # ── 4. Strip all remaining tags ───────────────────────────────────────────
    $Md = [regex]::Replace($Md, '<[^>]+>', '')

    # ── 5. Decode common HTML entities ────────────────────────────────────────
    $Entities = @{
        '&amp;'   = '&';  '&lt;'    = '<';  '&gt;'  = '>';
        '&quot;'  = '"';  '&apos;'  = "'";  '&nbsp;' = ' ';
        '&#8220;' = '"';  '&#8221;' = '"';  '&#8216;' = "'";  '&#8217;' = "'";
        '&#8211;' = '–';  '&#8212;' = '—';  '&#8230;' = '…';
        '&#160;'  = ' ';  '&mdash;' = '—';  '&ndash;' = '–';
        '&ldquo;' = '"';  '&rdquo;' = '"';  '&lsquo;' = "'";  '&rsquo;' = "'"
    }
    foreach ($e in $Entities.GetEnumerator()) {
        $Md = $Md.Replace($e.Key, $e.Value)
    }

    # Decode numeric entities &#NNN; and &#xHHH;
    $Md = [regex]::Replace($Md, '&#(\d+);',
        { param($m) [char][int]$m.Groups[1].Value })
    $Md = [regex]::Replace($Md, '&#x([0-9a-fA-F]+);',
        { param($m) [char][Convert]::ToInt32($m.Groups[1].Value, 16) })

    # ── 6. Clean up whitespace ────────────────────────────────────────────────
    $Md = $Md -replace '\t', '    '
    # Collapse 3+ blank lines to 2
    $Md = [regex]::Replace($Md, '(\r?\n){3,}', "`n`n")
    $Md = $Md.Trim()

    return $Md
}

<#
.SYNOPSIS
    Truncates converted markdown at the first blog-footer-widget marker (t/4564).
.DESCRIPTION
    ConvertFrom-Html's tag-level strip (<aside>/<nav>/<footer>/<figure>) only works
    when the chrome is still real HTML. markitdown (ConvertFrom-MarkItDown, used for
    local .html ingestion) renders unknown blocks -- share buttons, a related-posts
    widget, comment forms, "Subscribe"/"Search" sidebar widgets, embedded-video
    galleries -- as plain markdown instead of dropping them, so they survive into
    snapshot.md and get read as article content (t/4564: 4 sidebar-caption/
    archive-link key_points extracted from one blog post).
    Fix is a markdown-level cut, not another HTML-level strip: once the article body
    ends, Jetpack-style WordPress themes emit a fixed, highly regular footer sequence
    ("Share this:" -> like/related/post-nav/comments/sidebar widgets) with no reliable
    way to tell "legitimate Related Work section" from "WordPress related-posts widget"
    except that the widget sequence always starts at one of these markers. Everything
    from the EARLIEST matching marker onward is cut; text before it is untouched.
    Markers are matched case-insensitively anywhere in the text (not anchored to line
    start -- markitdown's own indentation of these headings is irregular), so this is
    deliberately conservative: a false negative (chrome survives) costs what t/4564
    already costs; a false positive (real content cut) would be worse, so the marker
    list stays narrow to phrases that are WordPress plugin boilerplate, never
    legitimate article prose.
#>
function Remove-BlogChromeTail {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Markdown)
    # Jetpack Sharedaddy ("Share this:"), its "Post navigation" / "Leave a Reply"
    # footer, and the Jetpack subscribe-by-email widget heading -- in practice the
    # earliest of these always precedes every other widget (related posts, search,
    # archive/recent-posts lists, tag clouds, embedded-video sidebars) on the same page.
    $Markers = 'Share this:', 'Post navigation', 'Leave a Reply', 'Subscribe to Blog Notice'
    $CutAt = -1
    foreach ($Marker in $Markers) {
        $Idx = $Markdown.IndexOf($Marker, [System.StringComparison]::OrdinalIgnoreCase)
        if ($Idx -ge 0 -and ($CutAt -lt 0 -or $Idx -lt $CutAt)) { $CutAt = $Idx }
    }
    if ($CutAt -lt 0) { return $Markdown }
    # Back up to the start of the marker's own line, so a heading's leading '#'s
    # (and the bullet/indent markitdown sometimes wraps it in) are cut too, not left
    # dangling as an empty heading.
    $LineStart = $Markdown.LastIndexOf("`n", [Math]::Max($CutAt - 1, 0)) + 1
    return $Markdown.Substring(0, $LineStart).TrimEnd()
}

# ─────────────────────────────────────────────────────────────────────────────
# Extract the <title> and a best-effort author from raw HTML
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Extracts title and author metadata from raw HTML.
.DESCRIPTION
    Parses HTML for metadata using a priority chain:
    - Title: og:title meta tag → <title> element.
    - Author: name="author" meta tag → property="article:author" meta tag.

    Returns a hashtable with Title (string) and Author (string array).  Both
    default to empty if no metadata is found.  Used during document ingestion
    as a fast heuristic before AI metadata extraction.
.PARAMETER Html
    The raw HTML string to parse for metadata.
.EXAMPLE
    $Meta = Get-HtmlMeta -Html $RawHtml
    Write-Host "Title: $($Meta.Title), Authors: $($Meta.Author -join ', ')"

.EXAMPLE
    $Meta = Get-HtmlMeta -Html (Get-Content page.html -Raw)
    if ($Meta.Title) { $FallbackTitle = $Meta.Title }
#>
function Get-HtmlMeta {
    param([string]$Html)

    $Result = @{ Title = ''; Author = @() }

    # Title: prefer og:title, then <title>
    $OgTitle = [regex]::Match($Html, '(?i)<meta[^>]+property=["\x27]og:title["\x27][^>]+content=["\x27]([^"\x27]+)["\x27]')
    if ($OgTitle.Success) {
        $Result.Title = $OgTitle.Groups[1].Value.Trim()
    } else {
        $TitleTag = [regex]::Match($Html, '(?is)<title[^>]*>(.*?)</title>')
        if ($TitleTag.Success) {
            $Result.Title = [regex]::Replace($TitleTag.Groups[1].Value, '<[^>]+>', '').Trim()
        }
    }

    # Author: try meta name=author, og:article:author, schema.org
    $AuthorMeta = [regex]::Match($Html, '(?i)<meta[^>]+name=["\x27]author["\x27][^>]+content=["\x27]([^"\x27]+)["\x27]')
    if ($AuthorMeta.Success) {
        $Result.Author = @($AuthorMeta.Groups[1].Value.Trim())
    } else {
        $AuthorOg = [regex]::Match($Html, '(?i)<meta[^>]+property=["\x27]article:author["\x27][^>]+content=["\x27]([^"\x27]+)["\x27]')
        if ($AuthorOg.Success) {
            $Result.Author = @($AuthorOg.Groups[1].Value.Trim())
        }
    }

    return $Result
}

# ─────────────────────────────────────────────────────────────────────────────
# PDF post-processing (separate module to stay under AMSI pattern threshold)
# ─────────────────────────────────────────────────────────────────────────────
Import-Module (Join-Path $PSScriptRoot 'PdfOptimizer.psm1') -Force

# ─────────────────────────────────────────────────────────────────────────────
# markitdown — Microsoft's universal file → Markdown converter (Python CLI)
# Handles PDF, DOCX, PPTX, XLSX, HTML, CSV, JSON, XML, images, EPubs, and more.
# Install: pip install 'markitdown[all]'
# ─────────────────────────────────────────────────────────────────────────────
function ConvertFrom-MarkItDown {
    <#
    .SYNOPSIS
        Convert any supported file to Markdown using Microsoft's markitdown CLI.
    .DESCRIPTION
        Runs the markitdown Python CLI and returns Markdown text. Returns $null if
        markitdown is not installed or the conversion fails, so callers can fall
        back to other tools.
    .PARAMETER FilePath
        Absolute path to the file to convert.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath
    )

    if (-not (Test-ExternalTool 'markitdown')) { return $null }

    Write-Host "   →  Using markitdown for conversion" -ForegroundColor Gray
    # t/4394: write to a file and read it back as UTF-8. Capturing markitdown's stdout decoded it through
    # the console code page (cp437 on Windows): U+2019 came out as U+00C6 when Python wrote cp1252, or as
    # U+0393 U+00C7 U+00D6 when it wrote UTF-8 -- 500+ snapshots. PYTHONIOENCODING keeps any text Python
    # still prints UTF-8 too. Existing snapshots are repaired on read (Repair-SnapshotMojibake).
    $TempOut   = Join-Path ([System.IO.Path]::GetTempPath()) ('markitdown-{0}.md' -f [guid]::NewGuid().ToString('N'))
    $PrevPyEnc = $env:PYTHONIOENCODING
    try {
        $env:PYTHONIOENCODING = 'utf-8'
        & markitdown $FilePath -o $TempOut 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $TempOut) -and (Get-Item -LiteralPath $TempOut).Length -gt 0) {
            $Result = Get-Content -LiteralPath $TempOut -Raw -Encoding utf8
            # LF line endings, as the old stdout capture produced, so snapshots keep their shape.
            return ($Result -replace "`r`n", "`n").Trim()
        }
    }
    catch {
        Write-Warning "markitdown threw for '$(Split-Path $FilePath -Leaf)': $($_.Exception.Message)"
    }
    finally {
        $env:PYTHONIOENCODING = $PrevPyEnc
        Remove-Item -LiteralPath $TempOut -Force -ErrorAction SilentlyContinue
    }

    Write-Host "   ⚠  markitdown failed for '$(Split-Path $FilePath -Leaf)'" -ForegroundColor Yellow
    return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# PDF → Markdown
# Priority: markitdown → pdftotext → mutool → placeholder
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Converts a PDF file to Markdown text.
.DESCRIPTION
    Extracts text from a PDF using the best available tool, in priority order:

    1. markitdown (Microsoft's universal converter) — best quality, handles
       complex layouts.  Install: pip install 'markitdown[all]'
    2. pdftotext (from poppler-utils) — good for text-heavy PDFs.  Output is
       post-processed by Optimize-PdfText to strip layout artifacts.
    3. mutool (from MuPDF) — fallback text extractor.
    4. Placeholder — if no tool is found, returns instructions for installing one.

    The output Markdown is ready for Add-SnapshotHeader and AI summarization.
.PARAMETER PdfPath
    Absolute path to the PDF file to convert.
.EXAMPLE
    $Md = ConvertFrom-Pdf -PdfPath '/path/to/document.pdf'
    $Md | Set-Content -LiteralPath snapshot.md -Encoding utf8NoBOM

.EXAMPLE
    $Md = ConvertFrom-Pdf -PdfPath $RawFile
    if ($Md -match 'PDF EXTRACTION FAILED') { Write-Warning 'Install a PDF tool' }
#>
function ConvertFrom-Pdf {
    param(
        [Parameter(Mandatory)][string]$PdfPath
    )

    $md = ConvertFrom-MarkItDown -FilePath $PdfPath
    if ($md) { return $md }

    if (Test-ExternalTool 'pdftotext') {
        Write-Host "   →  Using pdftotext for PDF extraction" -ForegroundColor Gray
        $TempOut = [System.IO.Path]::GetTempFileName() + '.txt'
        try {
            # -enc UTF-8: the output encoding is otherwise poppler-version dependent (t/4394).
            & pdftotext -enc UTF-8 $PdfPath $TempOut 2>$null
            if ((Test-Path $TempOut) -and (Get-Item $TempOut).Length -gt 0) {
                $RawText = Get-Content $TempOut -Raw -Encoding UTF8
                return (Optimize-PdfText -RawText $RawText)
            }
        } finally {
            Remove-Item $TempOut -Force -ErrorAction SilentlyContinue
        }
    }

    if (Test-ExternalTool 'mutool') {
        Write-Host "   →  Using mutool for PDF extraction" -ForegroundColor Gray
        # t/4394: file output read as UTF-8, not stdout decoded through the console code page.
        $TempOut = Join-Path ([System.IO.Path]::GetTempPath()) ('mutool-{0}.txt' -f [guid]::NewGuid().ToString('N'))
        try {
            & mutool draw -F txt -o $TempOut $PdfPath 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $TempOut) -and (Get-Item -LiteralPath $TempOut).Length -gt 0) {
                return ((Get-Content -LiteralPath $TempOut -Raw -Encoding utf8) -replace "`r`n", "`n")
            }
        }
        finally {
            Remove-Item -LiteralPath $TempOut -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "   ⚠  No PDF extraction tool found. Install markitdown ('pip install markitdown[all]'), pdftotext, or mutool." -ForegroundColor Yellow
    Write-Host "   ⚠  Snapshot will contain placeholder text — re-run after installing a tool." -ForegroundColor Yellow
    return "# PDF EXTRACTION FAILED`n`nSource: $PdfPath`n`nInstall markitdown ('pip install markitdown[all]') or pdftotext and re-run Import-AITriadDocument -File '$PdfPath'."
}

# ─────────────────────────────────────────────────────────────────────────────
# DOCX → Markdown
# Priority: markitdown → pandoc → ZIP/XML fallback
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Converts a DOCX file to Markdown text.
.DESCRIPTION
    Extracts text from a Word document using the best available tool:

    1. markitdown — best quality, preserves formatting.
    2. pandoc — high-fidelity DOCX-to-Markdown conversion.
    3. ZIP/XML fallback — extracts document.xml from the DOCX archive (which is
       a ZIP file) and strips XML tags to produce plain-text paragraphs.

    Returns a placeholder message if no tool succeeds.
.PARAMETER DocxPath
    Absolute path to the DOCX file to convert.
.EXAMPLE
    $Md = ConvertFrom-Docx -DocxPath '/path/to/report.docx'

.EXAMPLE
    $Md = ConvertFrom-Docx -DocxPath $File.FullName
    if ($Md -notmatch 'EXTRACTION FAILED') { Set-Content -LiteralPath snapshot.md -Value $Md -Encoding utf8NoBOM }
#>
function ConvertFrom-Docx {
    param(
        [Parameter(Mandatory)][string]$DocxPath
    )

    $md = ConvertFrom-MarkItDown -FilePath $DocxPath
    if ($md) { return $md }

    if (Test-ExternalTool 'pandoc') {
        Write-Host "   →  Using pandoc for DOCX → Markdown conversion" -ForegroundColor Gray
        $TempOut = [System.IO.Path]::GetTempFileName() + '.md'
        try {
            & pandoc $DocxPath -f docx -t markdown_strict --wrap=none -o $TempOut 2>$null
            if ((Test-Path $TempOut) -and (Get-Item $TempOut).Length -gt 0) {
                return Get-Content $TempOut -Raw -Encoding UTF8
            }
        } finally {
            Remove-Item $TempOut -Force -ErrorAction SilentlyContinue
        }
    }

    # Fallback: extract XML from the ZIP and strip tags
    Write-Host "   →  Using ZIP/XML fallback for DOCX" -ForegroundColor Gray
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
        [System.IO.Compression.ZipFile]::ExtractToDirectory($DocxPath, $TempDir)
        $DocXml = Get-Content (Join-Path (Join-Path $TempDir 'word') 'document.xml') -Raw
        Remove-Item $TempDir -Recurse -Force

        $Paragraphs = [regex]::Matches($DocXml, '(?is)<w:p\b[^>]*>(.*?)</w:p>')
        $Lines = foreach ($para in $Paragraphs) {
            $Text = [regex]::Replace($para.Groups[1].Value, '<[^>]+>', '').Trim()
            if ($Text) { $Text }
        }
        return $Lines -join "`n`n"
    } catch {
        Write-Host "   ⚠  DOCX fallback extraction failed: $_" -ForegroundColor Yellow
        return "# DOCX EXTRACTION FAILED`n`nSource: $DocxPath`n`nInstall markitdown ('pip install markitdown[all]') or pandoc and re-run."
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# PPTX / XLSX / generic office → Markdown via markitdown
# ─────────────────────────────────────────────────────────────────────────────
function ConvertFrom-Office {
    <#
    .SYNOPSIS
        Convert PowerPoint, Excel, or other Office files to Markdown via markitdown.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath
    )

    $md = ConvertFrom-MarkItDown -FilePath $FilePath
    if ($md) { return $md }

    $Leaf = Split-Path $FilePath -Leaf
    Write-Host "   ⚠  markitdown not available — cannot convert '$Leaf'. Install with 'pip install markitdown[all]'." -ForegroundColor Yellow
    return "# CONVERSION FAILED`n`nSource: $FilePath`n`nInstall markitdown ('pip install markitdown[all]') and re-run Import-AITriadDocument -File '$FilePath'."
}

Export-ModuleMember -Function ConvertFrom-Html, Get-HtmlMeta, ConvertFrom-Pdf, ConvertFrom-Docx, ConvertFrom-Office, ConvertFrom-MarkItDown, Test-ExternalTool, Remove-BlogChromeTail
