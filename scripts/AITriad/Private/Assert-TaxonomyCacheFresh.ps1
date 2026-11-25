# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-IsExcludedTaxonomyAuxFile {
    # True for aux/sidecar files that the freshness check and reload loop skip
    # loading as POV taxonomy. Kept as a single list so both callers agree.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FileName)

    return $FileName -in 'embeddings.json', 'edges.json', 'policy_actions.json',
        '_archived_edges.json', 'lineage_categories.json', 'interpretation_embeddings.json',
        'source_evidence_index.json', 'similarity-cache.json'
}

function Test-TaxonomyPovFilesStale {
    # Stat-only scan: returns $true if any POV .json file is newer than its
    # recorded load-time timestamp (or has never been stamped).
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaxDir)

    foreach ($File in Get-ChildItem -Path $TaxDir -Filter '*.json' -File) {
        if (Test-IsExcludedTaxonomyAuxFile -FileName $File.Name) { continue }

        $Cached = $script:TaxonomyFileTimestamps[$File.FullName]
        if (-not $Cached -or $File.LastWriteTime -gt $Cached) {
            return $true
        }
    }
    return $false
}

function Invoke-TaxonomyCacheReload {
    # Flush and reload the POV taxonomy cache (and the policy registry) from disk.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaxDir)

    Write-Verbose 'Taxonomy cache stale — reloading from disk'
    $script:TaxonomyData = @{}
    $script:TaxonomyFileTimestamps = @{}
    $script:PillarNodeIds = $null  # invalidated with TaxonomyData; rebuilt lazily on next scoring call (t/2369)

    foreach ($File in Get-ChildItem -Path $TaxDir -Filter '*.json' -File) {
        if (Test-IsExcludedTaxonomyAuxFile -FileName $File.Name) { continue }
        # Stamp every scanned file — even ones we don't load into the cache
        # below — so non-POV aux files (logs, staging, cruxes without a
        # 'nodes' property, or files >10MB) don't perpetually re-trigger the
        # `-not $Cached` staleness check and force needless full reloads.
        $script:TaxonomyFileTimestamps[$File.FullName] = $File.LastWriteTime
        if ($File.Length -gt 10MB) { continue }
        try {
            # Cheap pre-check: non-POV files skip the full ConvertFrom-Json.
            if (-not (Test-IsPovTaxonomyBytes -Bytes ([System.IO.File]::ReadAllBytes($File.FullName)) -FileName $File.Name)) { continue }
            $Json = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
            # Shape-gate: only real POV node files (nodes[].id) register. Sidecar
            # logs like entity_extraction_log.json (nodes keyed by 'node_id') are
            # skipped so Get-Tax doesn't later crash on them (t/1834).
            if (-not (Test-IsPovTaxonomyData $Json)) { continue }
            $PovName = $File.BaseName.ToLower()
            $script:TaxonomyData[$PovName] = $Json
            Write-Verbose "  Reloaded '$PovName' ($($Json.nodes.Count) nodes)"
        }
        catch {
            Write-Warning "Taxonomy reload: failed to load $($File.Name): $_"
        }
    }
    Update-TaxonomySupersessionCache  # POV .nodes become selectable; full set indexed (t/4356)

    # Also reload policy registry
    $RegistryFile = Join-Path $TaxDir 'policy_actions.json'
    if (Test-Path $RegistryFile) {
        try {
            $script:PolicyRegistry = Get-Content -Raw $RegistryFile | ConvertFrom-Json
        } catch { }
    }
}

function Update-StaleEmbeddingsCache {
    # Invalidate the in-memory embeddings cache if embeddings.json is newer.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaxDir)

    if ($null -eq $script:CachedEmbeddings) { return }
    $EmbFile = Join-Path $TaxDir 'embeddings.json'
    if (-not (Test-Path $EmbFile)) { return }
    $EmbWriteTime = (Get-Item $EmbFile).LastWriteTime
    if (-not $script:EmbeddingsTimestamp -or $EmbWriteTime -gt $script:EmbeddingsTimestamp) {
        Write-Verbose 'Embeddings cache stale — will reload on next use'
        $script:CachedEmbeddings = $null
        $script:EmbeddingsTimestamp = $null
    }
}

function Update-StaleSyntheticCache {
    # Invalidate the in-memory synthetic-vector cache if its file is newer.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$TaxDir)

    if ($null -eq $script:CachedSyntheticVectors) { return }
    $SynFile = Join-Path $TaxDir 'synthetic/synthetic_embeddings.json'
    if (-not (Test-Path $SynFile)) { return }
    $SynWriteTime = (Get-Item $SynFile).LastWriteTime
    if (-not $script:SyntheticTimestamp -or $SynWriteTime -gt $script:SyntheticTimestamp) {
        Write-Verbose 'Synthetic embeddings cache stale — will reload on next use'
        $script:CachedSyntheticVectors = $null
        $script:SyntheticTimestamp = $null
    }
}

function Assert-TaxonomyCacheFresh {
    <#
    .SYNOPSIS
        Checks if on-disk taxonomy files are newer than the in-memory cache
        and reloads if stale. Also invalidates the embeddings cache if
        embeddings.json has been regenerated.
    .DESCRIPTION
        Called at the start of cmdlets that read $script:TaxonomyData or
        $script:CachedEmbeddings. Compares file LastWriteTime against the
        timestamps recorded at load time. If any file is newer, flushes
        and reloads the affected cache.

        This is cheap — just stat calls on 4-6 files, no JSON parsing
        unless a file has actually changed.
    #>
    [CmdletBinding()]
    param()

    # Cooldown: skip check if last reload was < 30s ago AND cache is populated.
    # Always check when cache is empty (data may have become available since last check).
    if ($script:TaxonomyData.Count -gt 0 -and
        $script:TaxonomyCacheLastCheck -and
        ([DateTime]::UtcNow - $script:TaxonomyCacheLastCheck).TotalSeconds -lt 30) {
        return
    }
    $script:TaxonomyCacheLastCheck = [DateTime]::UtcNow

    $TaxDir = Get-TaxonomyDir
    if (-not (Test-Path $TaxDir)) { return }

    # ── Check taxonomy POV files ──────────────────────────────────────────────
    if (Test-TaxonomyPovFilesStale -TaxDir $TaxDir) {
        Invoke-TaxonomyCacheReload -TaxDir $TaxDir
    }

    # ── Check embeddings.json ─────────────────────────────────────────────────
    Update-StaleEmbeddingsCache -TaxDir $TaxDir

    # ── Check synthetic_embeddings.json ───────────────────────────────────────
    Update-StaleSyntheticCache -TaxDir $TaxDir
}
