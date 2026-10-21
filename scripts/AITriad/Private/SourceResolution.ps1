# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# The module's one duplicate_of resolver (docs/specs/source-identity.md section 6; t/4337 C1).
# Evidence producers attribute each citation to Resolve-SourceId and count each resolved id once;
# selection paths skip ids that fail Test-SourceSelectable; lookup by id is untouched. Stored ids
# are never rewritten (spec 6.4): resolution happens when an index or count is built.

$script:SourceResolutionCache = @{}

function New-IdentitySourceResolution {
    # No marks applied: every id resolves to itself and is selectable.
    [pscustomobject]@{
        Resolved   = @{}
        Marked     = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        MarkPairs  = [string[]]::new(0)
        Errors     = [object[]]::new(0)
        Source     = 'none'
    }
}

<#
.SYNOPSIS
    Builds (and caches) the duplicate_of resolution for a sources directory.
.DESCRIPTION
    Uses Get-SourceIdentityGroup, so section 6 (including the two-pass conflict check) has one PS
    implementation. Input is sources-index.json when it is fresh (no metadata.json newer than it,
    and the same doc count); otherwise metadata.json is read directly (the authoritative input, so
    the answer is the same; noted on Verbose). With no marks anywhere, grouping is skipped entirely.
    Invalid marks are WARNed and treated as absent; nothing throws.
.OUTPUTS
    Resolved (id -> resolved id, marked ids only), Marked (ids with a valid mark), MarkPairs
    (ordinally sorted 'id=>target' for every valid mark), Errors (section 6.1 report), Source.
#>
function Get-SourceResolution {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [AllowEmptyString()][string]$SourcesDir,
        [string]$IndexPath
    )
    Set-StrictMode -Version Latest

    if ([string]::IsNullOrEmpty($SourcesDir) -or -not (Test-Path -LiteralPath $SourcesDir -PathType Container)) {
        Write-Warning "Get-SourceResolution: sources directory '$SourcesDir' not found; duplicate_of marks are not applied (every doc counts as its own source)."
        return (New-IdentitySourceResolution)
    }
    $SourcesDir = (Resolve-Path -LiteralPath $SourcesDir).ProviderPath
    if (-not $IndexPath) {
        try { $IndexPath = Join-Path (Get-TaxonomyDir) 'sources-index.json' } catch { $IndexPath = $null }
    }

    $dirs = @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })
    $newestMeta = [datetime]::MinValue
    foreach ($d in $dirs) {
        $mp = Join-Path $d.FullName 'metadata.json'
        if (Test-Path -LiteralPath $mp) { $t = [System.IO.File]::GetLastWriteTimeUtc($mp); if ($t -gt $newestMeta) { $newestMeta = $t } }
    }
    $indexTime = if ($IndexPath -and (Test-Path -LiteralPath $IndexPath)) { [System.IO.File]::GetLastWriteTimeUtc($IndexPath) } else { $null }
    $cacheKey = '{0}|{1}|{2}|{3}' -f $SourcesDir, $dirs.Count, $newestMeta.Ticks, $(if ($indexTime) { $indexTime.Ticks } else { 0 })
    if ($script:SourceResolutionCache.ContainsKey($cacheKey)) { return $script:SourceResolutionCache[$cacheKey] }

    # Entries: from a fresh sources-index.json, else built in memory (same mapping, Get-SourcesIndexEntry).
    $entries = $null; $source = 'sources-index.json'
    if ($indexTime -and $indexTime -ge $newestMeta) {
        try {
            $ix = [System.IO.File]::ReadAllText($IndexPath) | ConvertFrom-Json
            if (@($ix.docs).Count -eq $dirs.Count) { $entries = @($ix.docs) }
        } catch { $entries = $null }
    }
    $why = $null
    if ($null -eq $entries) {
        $why = if (-not $indexTime) { 'it does not exist' } elseif ($indexTime -lt $newestMeta) { 'a metadata.json is newer than it' } else { 'its doc count differs from the sources directory, or it is unreadable' }
        $source = 'metadata'
        # Marks first (cheap); snapshots are hashed only if a mark exists and grouping is needed.
        $entries = @(foreach ($d in $dirs) {
            $e = [ordered]@{ id = $d.Name }
            $mp = Join-Path $d.FullName 'metadata.json'
            if (Test-Path -LiteralPath $mp) {
                try {
                    $m = [System.IO.File]::ReadAllText($mp) | ConvertFrom-Json
                    if ($m.PSObject.Properties['duplicate_of'] -and -not [string]::IsNullOrEmpty([string]$m.duplicate_of)) { $e['duplicate_of'] = [string]$m.duplicate_of }
                } catch { Write-Warning "Get-SourceResolution: unreadable metadata.json for '$($d.Name)'; treating it as unmarked: $($_.Exception.Message)" }
            }
            [pscustomobject]$e
        })
    }

    $hasMark = @($entries | Where-Object { $_.PSObject.Properties['duplicate_of'] -and -not [string]::IsNullOrEmpty([string]$_.duplicate_of) }).Count -gt 0
    if (-not $hasMark) {
        $res = New-IdentitySourceResolution; $res.Source = $source
        $script:SourceResolutionCache[$cacheKey] = $res
        return $res
    }
    if ($source -eq 'metadata') {
        # Verbose, not WARN: metadata.json is the authoritative input and sources-index.json only a
        # cache of it, so this path gives the same answer, just slower. Noted only when marks exist
        # (with none, every id resolves to itself whatever the input). Real degradations (no sources
        # dir, unreadable metadata, invalid marks) still WARN.
        Write-Verbose "Get-SourceResolution: not using sources-index.json ($why); reading metadata.json and snapshots directly to resolve duplicate_of marks."
        # Grouping needs every identity input (hash, URLs, title) for the conflict check.
        $entries = @(foreach ($d in $dirs) { [pscustomobject](Get-SourcesIndexEntry -DocDir $d.FullName -DocId $d.Name) })
    }

    $docs = @(foreach ($e in $entries) {
        $meta = [ordered]@{}
        foreach ($f in 'title', 'url', 'resolved_url', 'provenance', 'content_sha256', 'same_as', 'parent_doc_id', 'duplicate_of') {
            if ($e.PSObject.Properties[$f]) { $meta[$f] = $e.$f }
        }
        [pscustomobject]@{
            Id = [string]$e.id; Metadata = [pscustomobject]$meta
            SnapshotSha256 = $(if ($e.PSObject.Properties['snapshot_sha256']) { [string]$e.snapshot_sha256 } else { $null })
        }
    })
    $g = Get-SourceIdentityGroup -Documents $docs

    $resolved = @{}
    $marked = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $pairs = [System.Collections.Generic.List[string]]::new()
    foreach ($id in $g.Resolved.Keys) {
        if ($g.Resolved[$id] -cne $id) {
            $resolved[$id] = $g.Resolved[$id]; [void]$marked.Add($id); $pairs.Add("$id=>$($g.Resolved[$id])")
        }
    }
    $pairArr = $pairs.ToArray(); [Array]::Sort($pairArr, [System.StringComparer]::Ordinal)
    foreach ($err in @($g.DuplicateOfErrors)) {
        Write-Warning "Get-SourceResolution: invalid duplicate_of on '$($err.id)' -> '$($err.target)' ($($err.kind)); treated as absent (spec 6.1)."
    }
    $res = [pscustomobject]@{
        Resolved = $resolved; Marked = $marked; MarkPairs = [string[]]$pairArr
        Errors = [object[]]@($g.DuplicateOfErrors); Source = $source
    }
    $script:SourceResolutionCache[$cacheKey] = $res
    $res
}

function Get-DefaultSourceResolution {
    # For callers with no -SourcesDir of their own: resolves Get-SourcesDir, and WARNs and applies no
    # marks when it can't (a machine with no ai-triad-sources checkout).
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([string]$Caller = 'AITriad')
    try { $dir = Get-SourcesDir }
    catch {
        Write-Warning "${Caller}: no sources directory resolved ($($_.Exception.Message)); duplicate_of marks are not applied."
        return (New-IdentitySourceResolution)
    }
    Get-SourceResolution -SourcesDir $dir
}

function Resolve-SourceId {
    # Spec 6.2: the valid mark's target, else the id itself (an unknown id resolves to itself).
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][pscustomobject]$Resolution, [Parameter(Mandatory)][AllowEmptyString()][string]$Id)
    if ($Resolution.Resolved.ContainsKey($Id)) { [string]$Resolution.Resolved[$Id] } else { $Id }
}

function Test-SourceSelectable {
    # Spec 6.3: a doc with a valid mark is not selectable; lookup by id is unaffected.
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)][pscustomobject]$Resolution, [Parameter(Mandatory)][AllowEmptyString()][string]$Id)
    -not $Resolution.Marked.Contains($Id)
}

function Select-SelectableSummaryFile {
    <#
    .SYNOPSIS
        Drops summaries/<docId>.json files whose doc carries a valid duplicate_of mark.
    .DESCRIPTION
        The evidence rule for summary-scanning producers: a marked copy's summary is skipped, so the
        canonical's summary is the resolved doc's one evidence unit (spec 6.3). Attributing the
        copy's key points to the canonical instead would count them twice and could credit the
        canonical with a claim only the copy's summary holds (SO e/342#2). Files are named by doc id.
    #>
    [CmdletBinding()]
    [OutputType([System.IO.FileInfo[]])]
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.IO.FileInfo[]]$Files, [Parameter(Mandatory)][pscustomobject]$Resolution)
    # Emits to the pipeline; callers wrap the call in @().
    if ($Resolution.Marked.Count -eq 0) { return $Files }
    $kept = [System.IO.FileInfo[]]@($Files | Where-Object { -not $Resolution.Marked.Contains($_.BaseName) })
    $skipped = $Files.Count - $kept.Count
    if ($skipped -gt 0) { Write-Verbose "Select-SelectableSummaryFile: skipped $skipped summary file(s) of docs marked duplicate_of." }
    $kept
}

function Get-SourceMarksHash {
    <#
    .SYNOPSIS
        Content hash of the valid mark set (t/4337 C1): sha256 over the ordinally sorted
        'id=>target' pairs joined with LF. Adding, removing, swapping or re-pointing a mark all
        change it. The empty set hashes the empty string.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][pscustomobject]$Resolution)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(([string[]]$Resolution.MarkPairs) -join "`n")
        -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}
