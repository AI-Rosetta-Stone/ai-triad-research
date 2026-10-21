# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    One sources-index.json record for a source directory (t/4334#18). The single place the index
    schema's per-document fields are mapped.
.DESCRIPTION
    Keys are emitted in a fixed order and only when present (an absent field is omitted, never null),
    so the index is byte-stable and small. Strings are copied verbatim: metadata.json is read
    shape-preserving, so ISO timestamps are not re-formatted (t/4366). content_sha256 is the RECORDED
    hash only; snapshot_sha256 is the hash computed from snapshot.md under
    docs/specs/source-identity.md section 1 when nothing is recorded, and can be absent (empty body,
    placeholder, or under the 100-word floor). They stay separate because spec 4.4 lets only a
    recorded hash veto a suffix edge.
#>
function Get-SourcesIndexEntry {
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)][string]$DocDir,
        [Parameter(Mandatory)][string]$DocId
    )
    Set-StrictMode -Version Latest

    $meta = $null
    $metaPath = Join-Path $DocDir 'metadata.json'
    if (Test-Path -LiteralPath $metaPath) {
        try { $meta = ConvertFrom-JsonPreserveShape -Json ([System.IO.File]::ReadAllText($metaPath)) }
        catch { Write-Warning "Export-SourcesIndex: unreadable metadata.json for '$DocId', indexing it by id and content hash only: $($_.Exception.Message)" }
    }
    $field = {
        param($name)
        if ($null -ne $meta -and $meta.PSObject.Properties[$name]) { $meta.$name } else { $null }
    }

    $entry = [ordered]@{ id = $DocId }
    # Source-card fields (t/4333 PI scope), then identity fields (docs/specs/source-identity.md).
    foreach ($name in 'title', 'url', 'resolved_url') {
        $v = & $field $name
        if (-not [string]::IsNullOrEmpty([string]$v)) { $entry[$name] = [string]$v }
    }
    $authors = & $field 'authors'
    if ($null -ne $authors) {
        $list = [string[]]@(@($authors) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
        if ($list.Count -gt 0) { $entry['authors'] = $list }
    }
    foreach ($name in 'date_published', 'one_liner') {
        $v = & $field $name
        if (-not [string]::IsNullOrEmpty([string]$v)) { $entry[$name] = [string]$v }
    }
    $topics = & $field 'topic_tags'
    if ($null -ne $topics) {
        $list = [string[]]@(@($topics) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
        if ($list.Count -gt 0) { $entry['topic_tags'] = $list }
    }

    # Recorded and computed hashes stay distinct (spec 4.0 / 4.4: only a RECORDED hash may veto a
    # suffix edge; review of #3560). content_sha256 = recorded only; snapshot_sha256 = computed from
    # snapshot.md under spec section 1, present only when nothing is recorded (absent under the floor).
    $recorded = [string](& $field 'content_sha256')
    if (-not [string]::IsNullOrEmpty($recorded)) {
        $entry['content_sha256'] = $recorded
    } else {
        $snap = Join-Path $DocDir 'snapshot.md'
        $computed = if (Test-Path -LiteralPath $snap) { Get-SourceContentHash -Text ([System.IO.File]::ReadAllText($snap)) } else { $null }
        if ($computed) { $entry['snapshot_sha256'] = $computed }
    }

    $prov = & $field 'provenance'
    if ($null -ne $prov) {
        $items = [System.Collections.Generic.List[object]]::new()
        foreach ($p in @($prov)) {
            if ($null -eq $p) { continue }
            $item = [ordered]@{}
            foreach ($k in 'scheme', 'id', 'confidence') {
                if ($p.PSObject.Properties[$k] -and -not [string]::IsNullOrEmpty([string]$p.$k)) { $item[$k] = [string]$p.$k }
            }
            if ($item.Count -gt 0) { $items.Add($item) }
        }
        if ($items.Count -gt 0) { $entry['provenance'] = $items.ToArray() }
    }
    foreach ($name in 'same_as', 'parent_doc_id', 'duplicate_of') {
        $v = & $field $name
        if (-not [string]::IsNullOrEmpty([string]$v)) { $entry[$name] = [string]$v }
    }
    $entry
}
