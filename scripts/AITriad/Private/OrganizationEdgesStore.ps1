# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Organization actor-edges loader + module-scope cache (t/1526).
# Dot-sourced by AITriad.psm1 — do NOT export.
# Parallel to OrganizationsStore.ps1 (same shape / mtime invalidation pattern).

$script:OrganizationEdgesCache = $null
$script:OrganizationEdgesCacheTimestamp = $null
$script:OrganizationEdgesCachePath = $null

function Get-OrganizationEdgesFilePath {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $tax = Get-TaxonomyDir
    return Join-Path $tax 'organization_edges.json'
}

function Get-OrganizationEdgesStore {
    <#
    .SYNOPSIS
        Loads (or returns cached) organization_edges.json content.
    .DESCRIPTION
        Reads ../ai-triad-data/taxonomy/Origin/organization_edges.json, caches
        the parsed structure in $script:OrganizationEdgesCache, and invalidates
        on file mtime change. Returns the raw parsed object with fields:
        _schema_version, _doc, last_modified, edges[].
    .PARAMETER Force
        Bypass the cache and re-read from disk.
    .PARAMETER Path
        Override the source file path. Defaults to Get-OrganizationEdgesFilePath.
        Used by Test-OrganizationEdgeIntegrity so callers can validate a snapshot
        or fixture file without touching the live registry.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [string]$Path
    )

    Set-StrictMode -Version Latest

    if ($Path) {
        $path = $Path
    } else {
        $path = Get-OrganizationEdgesFilePath
    }
    if (-not (Test-Path $path)) {
        throw (New-ActionableError `
            -Goal 'Load organization edges registry' `
            -Problem "organization_edges.json not found at $path" `
            -Location 'Get-OrganizationEdgesStore' `
            -NextSteps @(
                'Verify the data repo is present at ../ai-triad-data/',
                'Check .aitriad.json or $env:AI_TRIAD_DATA_ROOT for override',
                'Confirm taxonomy/Origin/organization_edges.json exists in the data repo'
            ) `
            -AsErrorRecord)
    }

    $mtime = (Get-Item $path).LastWriteTimeUtc
    if (-not $Force -and $script:OrganizationEdgesCache -and $script:OrganizationEdgesCacheTimestamp -eq $mtime -and $script:OrganizationEdgesCachePath -eq $path) {
        return $script:OrganizationEdgesCache
    }

    try {
        $raw = Get-Content -Raw -Path $path -Encoding utf8
        $parsed = $raw | ConvertFrom-Json
    } catch {
        throw (New-ActionableError `
            -Goal 'Parse organization edges registry' `
            -Problem "Failed to parse organization_edges.json: $($_.Exception.Message)" `
            -Location 'Get-OrganizationEdgesStore' `
            -NextSteps @(
                'Validate JSON with: Get-Content organization_edges.json | ConvertFrom-Json',
                'Check for trailing commas or unbalanced brackets',
                'Restore from git history if the file was recently modified'
            ) `
            -AsErrorRecord)
    }

    $script:OrganizationEdgesCache = $parsed
    $script:OrganizationEdgesCacheTimestamp = $mtime
    $script:OrganizationEdgesCachePath = $path
    return $parsed
}

function ConvertTo-OrganizationEdgeObject {
    <#
    .SYNOPSIS
        Converts a raw PSObject from organization_edges.json into a typed [OrganizationEdge].
    #>
    [CmdletBinding()]
    [OutputType([OrganizationEdge])]
    param(
        [Parameter(Mandatory)]
        [object]$Raw
    )
    Set-StrictMode -Version Latest

    $e = [OrganizationEdge]::new()
    $e.Source       = if ($Raw.PSObject.Properties['source']) { [string]$Raw.source } else { '' }
    $e.Target       = if ($Raw.PSObject.Properties['target']) { [string]$Raw.target } else { '' }
    $e.Type         = if ($Raw.PSObject.Properties['type']) { [string]$Raw.type } else { '' }
    $e.Rationale    = if ($Raw.PSObject.Properties['rationale']) { [string]$Raw.rationale } else { '' }
    $e.SourceRefs   = if ($Raw.PSObject.Properties['source_refs']) { @($Raw.source_refs | ForEach-Object { [string]$_ }) } else { @() }
    $e.Status       = if ($Raw.PSObject.Properties['status']) { [string]$Raw.status } else { 'approved' }
    $e.DiscoveredAt = if ($Raw.PSObject.Properties['discovered_at']) { [string]$Raw.discovered_at } else { '' }
    return $e
}

function Clear-OrganizationEdgesCache {
    <#
    .SYNOPSIS
        Invalidates the organization edges cache. Called by Import-OrganizationEdge after writes.
    #>
    [CmdletBinding()]
    param()
    $script:OrganizationEdgesCache = $null
    $script:OrganizationEdgesCacheTimestamp = $null
    $script:OrganizationEdgesCachePath = $null
}
