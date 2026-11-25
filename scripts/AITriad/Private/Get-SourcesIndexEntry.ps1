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
# Internal helpers (NOT exported; private to this file). They take the shape-preserving metadata
# object (or $null) and the ordered $entry they append to, so Get-SourcesIndexEntry reads as the
# fixed field order it documents. Each stays well under the CC ceiling.

function Get-SourcesIndexMetaField {
    param($Meta, [string]$Name)
    if ($null -ne $Meta -and $Meta.PSObject.Properties[$Name]) { $Meta.$Name } else { $null }
}

function Add-SourcesIndexStringField {
    # Copies each named field verbatim as a string when it is a non-empty string (absent fields and
    # empties are omitted, never emitted as null). Call order fixes the key order in $Entry.
    param([System.Collections.Specialized.OrderedDictionary]$Entry, $Meta, [string[]]$Names)
    foreach ($name in $Names) {
        $v = Get-SourcesIndexMetaField -Meta $Meta -Name $name
        if (-not [string]::IsNullOrEmpty([string]$v)) { $Entry[$name] = [string]$v }
    }
}

function Add-SourcesIndexListField {
    # Emits a string[] of the named field's non-blank elements, omitting the key when none remain.
    param([System.Collections.Specialized.OrderedDictionary]$Entry, $Meta, [string]$Name)
    $raw = Get-SourcesIndexMetaField -Meta $Meta -Name $Name
    if ($null -eq $raw) { return }
    $list = [string[]]@(@($raw) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
    if ($list.Count -gt 0) { $Entry[$Name] = $list }
}

function Add-SourcesIndexHash {
    # content_sha256 = RECORDED hash only; snapshot_sha256 = hash computed from snapshot.md under
    # spec section 1, present only when nothing is recorded (absent under the floor). They stay
    # distinct because spec 4.4 lets only a recorded hash veto a suffix edge.
    param([System.Collections.Specialized.OrderedDictionary]$Entry, $Meta, [string]$DocDir)
    $recorded = [string](Get-SourcesIndexMetaField -Meta $Meta -Name 'content_sha256')
    if (-not [string]::IsNullOrEmpty($recorded)) {
        $Entry['content_sha256'] = $recorded
        return
    }
    $snap = Join-Path $DocDir 'snapshot.md'
    $computed = if (Test-Path -LiteralPath $snap) { Get-SourceContentHash -Text ([System.IO.File]::ReadAllText($snap)) } else { $null }
    if ($computed) { $Entry['snapshot_sha256'] = $computed }
}

function Get-SourcesIndexProvenanceItem {
    # One provenance record: scheme/id/confidence copied verbatim when non-empty, else $null when the
    # record contributes nothing.
    param($Prov)
    if ($null -eq $Prov) { return $null }
    $item = [ordered]@{}
    foreach ($k in 'scheme', 'id', 'confidence') {
        if ($Prov.PSObject.Properties[$k] -and -not [string]::IsNullOrEmpty([string]$Prov.$k)) { $item[$k] = [string]$Prov.$k }
    }
    if ($item.Count -gt 0) { $item } else { $null }
}

function Add-SourcesIndexProvenance {
    # Raw marks only (t/4337): no validity filtering or resolution here; each stack's loader applies
    # spec section 6 itself. Emits provenance only when at least one record contributes a field.
    param([System.Collections.Specialized.OrderedDictionary]$Entry, $Meta)
    $prov = Get-SourcesIndexMetaField -Meta $Meta -Name 'provenance'
    if ($null -eq $prov) { return }
    $items = [System.Collections.Generic.List[object]]::new()
    foreach ($p in @($prov)) {
        $item = Get-SourcesIndexProvenanceItem -Prov $p
        if ($null -ne $item) { $items.Add($item) }
    }
    if ($items.Count -gt 0) { $Entry['provenance'] = $items.ToArray() }
}

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

    $entry = [ordered]@{ id = $DocId }
    # Source-card fields (t/4333 PI scope), then identity fields (docs/specs/source-identity.md).
    Add-SourcesIndexStringField -Entry $entry -Meta $meta -Names 'title', 'url', 'resolved_url'
    Add-SourcesIndexListField -Entry $entry -Meta $meta -Name 'authors'
    Add-SourcesIndexStringField -Entry $entry -Meta $meta -Names 'date_published', 'one_liner'
    Add-SourcesIndexListField -Entry $entry -Meta $meta -Name 'topic_tags'

    # Recorded and computed hashes stay distinct (spec 4.0 / 4.4: only a RECORDED hash may veto a
    # suffix edge; review of #3560).
    Add-SourcesIndexHash -Entry $entry -Meta $meta -DocDir $DocDir

    Add-SourcesIndexProvenance -Entry $entry -Meta $meta
    # Raw marks only (t/4337, agreed with Server Storage p/783#18): no validity filtering or
    # resolution here. Each stack's loader applies spec section 6 itself, so a hosted reader, which
    # sees marks only through this index, validates them with the same rules as everything else.
    # duplicate_of_ref is the mark's provenance (its frozen-list entry), copied verbatim.
    Add-SourcesIndexStringField -Entry $entry -Meta $meta -Names 'same_as', 'parent_doc_id', 'duplicate_of', 'duplicate_of_ref'
    $entry
}
