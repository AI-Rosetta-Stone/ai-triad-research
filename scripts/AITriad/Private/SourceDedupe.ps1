# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Ingestion duplicate detection (t/4337), built on the source-identity contract
# (docs/specs/source-identity.md, SourceIdentity.ps1). Strong evidence (an equal content hash or
# trusted URL key) refuses an ingest; weak evidence (an equal title key or raw filename) only
# warns, because distinct documents share generic titles and file names like paper.pdf.

<#
.SYNOPSIS
    Builds the identity index of every source document under a sources directory.
.DESCRIPTION
    Skips directories whose names start with '.' or '_' (.git, .claude, _inbox). For each
    document, records its content hash (the recorded content_sha256, else the hash computed from
    snapshot.md), its trusted URL keys, its title key and its raw file names.
#>
function Get-SourceIdentityIndex {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][string]$SourcesDir)

    $index = [pscustomobject]@{
        Ids       = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        ByHash    = @{}
        ByUrl     = @{}
        ByTitle   = @{}
        ByRawName = @{}
    }
    if (-not (Test-Path -LiteralPath $SourcesDir)) {
        Write-Warning "Get-SourceIdentityIndex: sources directory not found ($SourcesDir); duplicate detection has nothing to compare against"
        return $index
    }
    foreach ($dir in @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })) {
        Add-SourceIdentityIndexEntry -Index $index -DocDir $dir.FullName
    }
    $index
}

<#
.SYNOPSIS
    Adds one source document directory to an identity index (also used right after an ingest).
#>
function Add-SourceIdentityIndexEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$Index,
        [Parameter(Mandatory)][string]$DocDir
    )

    $id = Split-Path -Leaf $DocDir
    [void]$Index.Ids.Add($id)

    $meta = $null
    $metaPath = Join-Path $DocDir 'metadata.json'
    if (Test-Path -LiteralPath $metaPath) {
        try { $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json }
        catch { Write-Warning "Add-SourceIdentityIndexEntry: unreadable metadata.json for '$id', indexing by snapshot hash only: $($_.Exception.Message)" }
    }

    $hash = $null
    if ($null -ne $meta -and $meta.PSObject.Properties['content_sha256'] -and $meta.content_sha256) {
        $hash = [string]$meta.content_sha256
    } else {
        $snap = Join-Path $DocDir 'snapshot.md'
        if (Test-Path -LiteralPath $snap) { $hash = Get-SourceContentHash -Text ([System.IO.File]::ReadAllText($snap)) }
    }
    if ($hash -and -not $Index.ByHash.ContainsKey($hash)) { $Index.ByHash[$hash] = $id }

    if ($null -ne $meta) {
        foreach ($k in [string[]](Get-TrustedSourceUrlKey -Metadata $meta)) {
            if (-not $Index.ByUrl.ContainsKey($k)) { $Index.ByUrl[$k] = $id }
        }
        $title = if ($meta.PSObject.Properties['title']) { [string]$meta.title } else { '' }
        $tk = ConvertTo-SourceTitleKey -Title $title
        if ($tk) {
            if (-not $Index.ByTitle.ContainsKey($tk)) { $Index.ByTitle[$tk] = [System.Collections.Generic.List[string]]::new() }
            $Index.ByTitle[$tk].Add($id)
        }
    }

    $rawDir = Join-Path $DocDir 'raw'
    if (Test-Path -LiteralPath $rawDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $rawDir -File)) {
            $n = $f.Name.ToLowerInvariant()
            if (-not $Index.ByRawName.ContainsKey($n)) { $Index.ByRawName[$n] = [System.Collections.Generic.List[string]]::new() }
            $Index.ByRawName[$n].Add($id)
        }
    }
}

<#
.SYNOPSIS
    Looks an incoming document up in an identity index.
.OUTPUTS
    @{ Strong = $null or @{ Kind = 'hash'|'url'; DocId }; Weak = @(@{ Kind = 'title'|'filename'; DocIds }) }
#>
function Find-SourceDuplicate {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][pscustomobject]$Index,
        [string]$Url,
        [string]$ContentHash,
        [string]$Title,
        [string]$RawFileName
    )

    $strong = $null
    if ($ContentHash -and $Index.ByHash.ContainsKey($ContentHash)) {
        $strong = [pscustomobject]@{ Kind = 'hash'; DocId = $Index.ByHash[$ContentHash] }
    }
    if (-not $strong -and $Url) {
        $k = ConvertTo-SourceUrlKey -Url $Url
        if ($k -and $Index.ByUrl.ContainsKey($k)) { $strong = [pscustomobject]@{ Kind = 'url'; DocId = $Index.ByUrl[$k] } }
    }

    $weak = [System.Collections.Generic.List[object]]::new()
    $tk = ConvertTo-SourceTitleKey -Title $Title
    if ($tk -and $Index.ByTitle.ContainsKey($tk)) {
        $weak.Add([pscustomobject]@{ Kind = 'title'; DocIds = [string[]]$Index.ByTitle[$tk].ToArray() })
    }
    if ($RawFileName) {
        $n = $RawFileName.ToLowerInvariant()
        if ($Index.ByRawName.ContainsKey($n)) { $weak.Add([pscustomobject]@{ Kind = 'filename'; DocIds = [string[]]$Index.ByRawName[$n].ToArray() }) }
    }

    [pscustomobject]@{ Strong = $strong; Weak = [object[]]$weak.ToArray() }
}

<#
.SYNOPSIS
    Refuses an ingest that duplicates an existing source document; warns on weak matches.
.DESCRIPTION
    Called by Import-AITriadDocument twice: before conversion with -Url / -RawFileName (cheap,
    avoids downloading or converting a known document), and after the snapshot is built with
    -ContentHash / -Title. A strong match (equal content hash or trusted URL key) throws an
    actionable error; -Force does not bypass it (t/4337). Weak matches only WARN.
#>
function Assert-NoSourceDuplicate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$Index,
        [string]$Url,
        [string]$ContentHash,
        [string]$Title,
        [string]$RawFileName,
        [switch]$ForceRequested
    )

    $found = Find-SourceDuplicate -Index $Index -Url $Url -ContentHash $ContentHash -Title $Title -RawFileName $RawFileName
    if ($found.Strong) {
        $what = if ($found.Strong.Kind -eq 'hash') { 'identical content (content_sha256)' } else { "the same source URL ($(ConvertTo-SourceUrlKey -Url $Url))" }
        $steps = [System.Collections.Generic.List[string]]::new()
        $steps.Add("View the existing source: Get-AITSource -DocId '$($found.Strong.DocId)'")
        $steps.Add("If that copy is wrong or incomplete, fix or replace it rather than ingesting a second copy")
        if ($ForceRequested) { $steps.Add('-Force no longer bypasses duplicate detection (t/4337): it used to mint a -N copy of the same document') }
        throw (New-ActionableError -AsErrorRecord `
            -Goal      'Ingest document' `
            -Problem   "Duplicate source: $what already ingested as '$($found.Strong.DocId)'" `
            -Location  'Import-AITriadDocument' `
            -NextSteps $steps.ToArray())
    }
    foreach ($w in $found.Weak) {
        $ids = ($w.DocIds -join ', ')
        if ($w.Kind -eq 'title') {
            Write-Warning "Possible duplicate: same title as existing source(s) $ids, but different content and URL, so ingesting as a new document. If it is a reprint of one of them, re-ingest with -SameAs <docId>; if it is part of one, use -ParentDocId <docId>."
        } else {
            Write-Warning "Possible duplicate: raw file name '$RawFileName' already exists in source(s) $ids. Ingesting anyway; content is compared once the snapshot is built."
        }
    }
}
