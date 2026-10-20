# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Export-SourcesIndex {
    <#
    .SYNOPSIS
        Builds sources-index.json: one compact record per source document, for hosts that cannot
        read ai-triad-sources (t/4334#18).
    .DESCRIPTION
        Hosted (github-api mode) reads only ai-triad-data, so it has no source metadata. This
        cmdlet reads ai-triad-sources and writes a precomputed index into ai-triad-data holding,
        per document, the source-card fields, content_sha256 (recorded, else computed from
        snapshot.md under docs/specs/source-identity.md section 1, so it can be absent) and the URL
        and provenance fields the identity grouping needs.

        The output is byte-stable: documents sorted ordinally by id, a fixed key order, LF line
        endings and no generation timestamp (source_commit identifies the input instead). The file is
        only written when its content changes, so a scheduled run commits nothing when nothing
        changed. Directories whose names start with '.' or '_' (.git, .claude, _inbox) are skipped.
    .PARAMETER SourcesDir
        The ai-triad-sources directory. Defaults to Get-SourcesDir.
    .PARAMETER OutputPath
        Where to write the index. Defaults to <taxonomy dir>/sources-index.json.
    .PARAMETER PassThru
        Also return the index object.
    .EXAMPLE
        Export-SourcesIndex
    .EXAMPLE
        Export-SourcesIndex -WhatIf
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [string]$SourcesDir,
        [string]$OutputPath,
        [switch]$PassThru
    )
    Set-StrictMode -Version Latest

    if (-not $SourcesDir) { $SourcesDir = Get-SourcesDir }
    if (-not $OutputPath) { $OutputPath = Join-Path (Get-TaxonomyDir) 'sources-index.json' }
    if (-not (Test-Path -LiteralPath $SourcesDir -PathType Container)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal      'Build sources-index.json' `
            -Problem   "Sources directory not found: $SourcesDir" `
            -Location  'Export-SourcesIndex' `
            -NextSteps @('Check .aitriad.json sources_root or $env:AI_TRIAD_SOURCES_ROOT', 'Or pass -SourcesDir <path to ai-triad-sources>'))
    }

    $sourceCommit = $null
    if (Test-Path -LiteralPath (Join-Path $SourcesDir '.git')) {
        $sourceCommit = (git -C $SourcesDir rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $sourceCommit) { $sourceCommit = $null }
    }
    if (-not $sourceCommit) {
        Write-Warning "Export-SourcesIndex: '$SourcesDir' is not a git checkout with a resolvable HEAD; source_commit will be null, so the index cannot be tied to a source revision."
    }

    $dirs = @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })
    # Property access, not `ForEach-Object Name`: the member-name form honours -WhatIf
    # (ShouldProcess) and returns nothing under it, which built an empty index on a dry run.
    $ids = [string[]]@(foreach ($d in $dirs) { $d.Name })
    [Array]::Sort($ids, [System.StringComparer]::Ordinal)

    $docs = [System.Collections.Generic.List[object]]::new()
    $hashed = 0; $noMetadata = 0
    foreach ($id in $ids) {
        $entry = Get-SourcesIndexEntry -DocDir (Join-Path $SourcesDir $id) -DocId $id
        if (-not $entry.Contains('title')) { $noMetadata++ }
        if ($entry.Contains('content_sha256')) { $hashed++ }
        $docs.Add($entry)
    }
    if ($noMetadata -gt 0) {
        Write-Warning "Export-SourcesIndex: $noMetadata source dir(s) have no readable metadata.json; they are indexed by id and content hash only."
    }

    $index = [ordered]@{
        schema_version = 1
        source_commit  = $sourceCommit
        doc_count      = $docs.Count
        docs           = $docs.ToArray()
    }
    $json = (ConvertTo-Json -InputObject $index -Depth 10).Replace("`r`n", "`n") + "`n"

    $existing = if (Test-Path -LiteralPath $OutputPath) { [System.IO.File]::ReadAllText($OutputPath) } else { $null }
    $changed = $existing -cne $json
    if ($changed -and $PSCmdlet.ShouldProcess($OutputPath, "Write sources index ($($docs.Count) docs)")) {
        Write-Utf8NoBom -Path $OutputPath -Value $json -NoNewline
    }

    $result = [PSCustomObject]@{
        Path         = $OutputPath
        DocCount     = $docs.Count
        Hashed       = $hashed
        NoMetadata   = $noMetadata
        SourceCommit = $sourceCommit
        Changed      = $changed
    }
    if ($PassThru) { $result | Add-Member -NotePropertyName Index -NotePropertyValue $index }
    $result
}
