# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-Snapshot {
    <#
    .SYNOPSIS
        Re-generates snapshot.md for all existing sources using updated conversion logic.

    .DESCRIPTION
        Loops through all sources/ directories that contain a raw/ subdirectory
        and re-runs the appropriate document conversion from DocConverters.psm1.
        Preserves the existing snapshot header and overwrites snapshot.md with
        the newly converted content.

    .PARAMETER DryRun
        Show what would be processed without writing any files.

    .EXAMPLE
        Update-Snapshot
    .EXAMPLE
        Update-Snapshot -DryRun
    .EXAMPLE
        Redo-Snapshots          # backward-compat alias
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-AttributeExtraction
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Save-WaybackUrl
    #>

    [CmdletBinding()]
    param(
        [switch]$DryRun
    )

    # ─────────────────────────────────────────────────────────────────────────
    # Paths (use module-scoped $script:RepoRoot set by AITriad.psm1)
    # ─────────────────────────────────────────────────────────────────────────
    $RepoRoot   = $script:RepoRoot
    $SourcesDir = Get-SourcesDir

    # ─────────────────────────────────────────────────────────────────────────
    # Extract the provenance header from an existing snapshot.md
    # Uses line-by-line scanning (no HTML-comment regex) to stay AMSI-safe.
    # Header = everything up to and including the first line that is exactly "---"
    # ─────────────────────────────────────────────────────────────────────────
    function Get-SnapshotHeader {
        param([string]$SnapshotPath)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

        if (-not (Test-Path $SnapshotPath)) { return '' }

        $Lines       = Get-Content $SnapshotPath -Encoding UTF8
        $HeaderLines = [System.Collections.Generic.List[string]]::new()
        $FoundSep    = $false

        foreach ($Line in $Lines) {
            $HeaderLines.Add($Line)
            # The provenance block ends with a standalone "---" separator
            if ($Line.Trim() -eq '---') {
                $FoundSep = $true
                break
            }
        }

        if ($FoundSep) {
            return ($HeaderLines -join "`n") + "`n"
        }
        return ''
    }

    # ─────────────────────────────────────────────────────────────────────────
    # Re-convert a single raw file via DocConverters (keeps AMSI-sensitive
    # calls inside the module rather than this function).
    # ─────────────────────────────────────────────────────────────────────────
    function Invoke-ReConvert {
        param(
            [string]$FilePath,
            [string]$Extension
        )

        switch ($Extension) {
            '.pdf' {
                return ConvertFrom-Pdf -PdfPath $FilePath
            }
            { $_ -in '.docx', '.doc' } {
                return ConvertFrom-Docx -DocxPath $FilePath
            }
            { $_ -in '.htm', '.html' } {
                $MidMd = ConvertFrom-MarkItDown -FilePath $FilePath
                # markitdown renders blog-chrome widgets as plain markdown instead of dropping
                # them (ConvertFrom-Html's own tag-level strip only fires on real HTML), t/4564.
                if ($MidMd) { return (Remove-BlogChromeTail -Markdown $MidMd) }
                $Raw = Get-Content $FilePath -Raw -Encoding UTF8
                return (Remove-BlogChromeTail -Markdown (ConvertFrom-Html -Html $Raw))
            }
            { $_ -in '.pptx', '.ppt', '.xlsx', '.xls', '.csv', '.epub' } {
                return ConvertFrom-Office -FilePath $FilePath
            }
            { $_ -in '.txt', '.md' } {
                return Get-Content $FilePath -Raw -Encoding UTF8
            }
            Default {
                $MidMd = ConvertFrom-MarkItDown -FilePath $FilePath
                if ($MidMd) { return $MidMd }
            }
        }
        return $null
    }

    # ─────────────────────────────────────────────────────────────────────────
    # Main loop
    # ─────────────────────────────────────────────────────────────────────────
    $DocDirs = Get-ChildItem -Path $SourcesDir -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'raw') }

    $PdfCount    = 0
    $DocxCount   = 0
    $HtmlCount   = 0
    $OfficeCount = 0
    $TxtCount    = 0
    $SkipCount   = 0
    $ErrorCount  = 0

    Write-Host "Update-Snapshot: scanning $($DocDirs.Count) source directories..." -ForegroundColor Cyan

    foreach ($DocDir in $DocDirs) {
        $DocId    = $DocDir.Name
        $RawDir   = Join-Path $DocDir.FullName 'raw'
        $RawFiles = @(Get-ChildItem -Path $RawDir -File -ErrorAction SilentlyContinue)

        if ($RawFiles.Count -eq 0) {
            Write-Host "   [$DocId] No raw files — skipping" -ForegroundColor Yellow
            $SkipCount++
            continue
        }

        # Pick the primary raw file: PDF first, then DOCX, HTML, Office, then text
        $RawFile = $RawFiles | Where-Object { $_.Extension -eq '.pdf' }  | Select-Object -First 1
        if (-not $RawFile) {
            $RawFile = $RawFiles | Where-Object { $_.Extension -in '.docx', '.doc' } | Select-Object -First 1
        }
        if (-not $RawFile) {
            $RawFile = $RawFiles | Where-Object { $_.Extension -in '.html', '.htm' } | Select-Object -First 1
        }
        if (-not $RawFile) {
            $RawFile = $RawFiles | Where-Object { $_.Extension -in '.pptx', '.ppt', '.xlsx', '.xls', '.csv', '.epub' } | Select-Object -First 1
        }
        if (-not $RawFile) {
            $RawFile = $RawFiles | Where-Object { $_.Extension -in '.txt', '.md' }   | Select-Object -First 1
        }
        if (-not $RawFile) {
            # Try the first file regardless — markitdown may handle it
            $RawFile = $RawFiles | Select-Object -First 1
        }

        $Ext = $RawFile.Extension.ToLower()

        if ($DryRun) {
            Write-Host "   [$DocId] Would re-convert: $($RawFile.Name) ($Ext)" -ForegroundColor Gray
            continue
        }

        Write-Host "`n[$DocId] Re-converting: $($RawFile.Name)" -ForegroundColor Cyan

        try {
            # Track counts
            switch ($Ext) {
                '.pdf'                                                            { $PdfCount++    }
                { $_ -in '.docx', '.doc' }                                       { $DocxCount++   }
                { $_ -in '.html', '.htm' }                                       { $HtmlCount++   }
                { $_ -in '.pptx', '.ppt', '.xlsx', '.xls', '.csv', '.epub' }    { $OfficeCount++ }
                { $_ -in '.txt', '.md' }                                         { $TxtCount++    }
            }

            $NewMarkdown = Invoke-ReConvert -FilePath $RawFile.FullName -Extension $Ext

            # Preserve existing provenance header if present
            $SnapshotPath = Join-Path $DocDir.FullName 'snapshot.md'
            $Header = Get-SnapshotHeader -SnapshotPath $SnapshotPath

            if ($Header) { $FinalContent = $Header + "`n" + $NewMarkdown } else { $FinalContent = $NewMarkdown }

            Write-Utf8NoBom -Path $SnapshotPath -Value $FinalContent  -ErrorAction Stop
            Write-Host "   snapshot.md updated ($([int]$FinalContent.Length) chars)" -ForegroundColor Green

        } catch {
            $ErrorCount++
            Write-Host "   [$DocId] Snapshot conversion failed for '$($RawFile.FullName)' ($Ext): $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "   Check that the source file is a valid $Ext document. If the file is corrupt, replace it in the raw/ folder and re-run." -ForegroundColor Yellow
        }
    }

    # ─────────────────────────────────────────────────────────────────────────
    # Summary
    # ─────────────────────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host '  Update-Snapshot complete' -ForegroundColor Green
    Write-Host '  ════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host "    PDF  conversions : $PdfCount"    -ForegroundColor White
    Write-Host "    DOCX conversions : $DocxCount"   -ForegroundColor White
    Write-Host "    HTML conversions : $HtmlCount"   -ForegroundColor White
    Write-Host "    Office/other     : $OfficeCount" -ForegroundColor White
    Write-Host "    Text pass-through: $TxtCount"    -ForegroundColor White
    Write-Host "    Skipped          : $SkipCount"   -ForegroundColor Gray
    Write-Host "    Errors           : $ErrorCount"  -ForegroundColor $(if ($ErrorCount -gt 0) { 'Red' } else { 'Gray' })
    Write-Host ''
}
