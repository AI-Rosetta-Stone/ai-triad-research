# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Entity store loader + id allocator + merge-walk (t/1804, Phase 1 entity ontology).
# Design of record: research/comp-linguist/designs/entity-ontology-proposal.md §3/§4/§7.
# The contract is lib/entities/types.ts (Entity, EntityRef) — the SINGLE authority. The
# records produced/consumed here are shape-matched to it (a parity test guards drift),
# never a restated PS class (TL t/1804#2 Q1). Dot-sourced by AITriad.psm1 — do NOT export.

$script:EntitiesCache = $null
$script:EntitiesCacheTimestamp = $null
$script:EntitiesCachePath = $null

# Merge-walk depth cap. MUST equal the server's MAX_MERGE_DEPTH in
# taxonomy-editor/src/server/routes/entity.ts (t/1786): if the two differ, one side
# calls a chain a data defect the other tolerates. Treat as a shared contract constant
# (verified = 16 on origin/main, TL t/1804#2 reinforcement).
$script:EntityMergeMaxDepth = 16

function Get-EntitiesFilePath {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return Join-Path (Get-TaxonomyDir) 'entities.json'
}

function Get-EntityEmbeddingsFilePath {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return Join-Path (Get-TaxonomyDir) 'entity_embeddings.json'
}

function Get-EntityMentionsFilePath {
    # entity_mentions.json — the derived mention index (t/1894, contract lib/entities/mentionTypes.ts).
    # Same data-repo location convention as entities.json / entity_extraction_log.json.
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return Join-Path (Get-TaxonomyDir) 'entity_mentions.json'
}

function New-EmptyEntitiesStore {
    <#
    .SYNOPSIS
        A fresh, empty entities.json envelope (design §3 shape).
    #>
    [CmdletBinding()]
    param()
    return [PSCustomObject]@{
        _schema_version = '1.0.0'
        _doc            = 'Entity records (ent-*). Ref kinds and the Entity type: lib/entities/types.ts.'
        entity_count    = 0
        last_modified   = (Get-Date).ToString('yyyy-MM-dd')
        entities        = @()
    }
}

function New-EmptyEntityEmbeddingsStore {
    <#
    .SYNOPSIS
        A fresh, empty entity_embeddings.json envelope (design §3 shape). model + dim are
        recorded IN the file so a silent model swap is detectable (design §3).
    #>
    [CmdletBinding()]
    param()
    # _schema_version '2.0.0' (t/3121): vectors[<id>] is an EntityVectorRecord
    # { name_vector, description_vector? } — see lib/entities/entityVectors.ts. `_src_hashes`
    # is a PS-owned envelope map { <id>: sha256(name+aliases\ndescription) } used by the
    # writer + Update-EntityEmbeddings to skip unchanged records (staleness guard, t/3085
    # class). It is deliberately NOT part of the EntityVectorRecord type — readers ignore it.
    return [PSCustomObject]@{
        _schema_version = '2.0.0'
        _doc            = 'Entity vectors for linking and dedup ONLY. Never an input to debate relevance.'
        model           = 'all-MiniLM-L6-v2'  # model-lint:allow-pin embedding model (sentence-transformers), not an ai-models.json LLM backend
        dim             = 384
        last_modified   = (Get-Date).ToString('yyyy-MM-dd')
        vectors         = [PSCustomObject]@{}
        _src_hashes     = [PSCustomObject]@{}
    }
}

function Get-EntitiesStore {
    <#
    .SYNOPSIS
        Loads (or returns cached) entities.json content, mirroring Get-OrganizationsStore.
    .DESCRIPTION
        Reads ../ai-triad-data/taxonomy/Origin/entities.json, caches the parsed structure,
        and invalidates on file mtime change. A missing store THROWS by default (a stray
        deletion must be loud — the file is the mint authority for the never-reused id
        allocator, design §3). The write path passes -InitIfMissing to bootstrap a fresh
        empty store; that is the ONLY path that treats "missing" as "empty".
    .PARAMETER Force
        Bypass the cache and re-read from disk.
    .PARAMETER Path
        Override the source file path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER InitIfMissing
        When the file is absent, return a fresh empty envelope instead of throwing. Used
        by Import-Entity to bootstrap the first write; never by the read path.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [string]$Path,
        [switch]$InitIfMissing
    )
    Set-StrictMode -Version Latest

    $path = if ($Path) { $Path } else { Get-EntitiesFilePath }

    if (-not (Test-Path $path)) {
        if ($InitIfMissing) { return (New-EmptyEntitiesStore) }
        throw (New-ActionableError -PassThru `
            -Goal 'Load entity registry' `
            -Problem "entities.json not found at $path" `
            -Location 'Get-EntitiesStore' `
            -NextSteps @(
                'The entity store has not been created yet — run Import-Entity to initialize it',
                'Verify the data repo is present at ../ai-triad-data/ and taxonomy/Origin/ exists',
                'Check .aitriad.json or $env:AI_TRIAD_DATA_ROOT for a data-root override'
            ))
    }

    $mtime = (Get-Item $path).LastWriteTimeUtc
    if (-not $Force -and $script:EntitiesCache -and $script:EntitiesCacheTimestamp -eq $mtime -and $script:EntitiesCachePath -eq $path) {
        return $script:EntitiesCache
    }

    try {
        $parsed = (Get-Content -Raw -Path $path -Encoding utf8) | ConvertFrom-Json
    } catch {
        throw (New-ActionableError -PassThru `
            -Goal 'Parse entity registry' `
            -Problem "Failed to parse entities.json: $($_.Exception.Message)" `
            -Location 'Get-EntitiesStore' `
            -NextSteps @(
                'Validate JSON with: Get-Content entities.json | ConvertFrom-Json',
                'Check for trailing commas or unbalanced brackets',
                'Restore from git history if the file was recently modified'
            ))
    }

    $script:EntitiesCache = $parsed
    $script:EntitiesCacheTimestamp = $mtime
    $script:EntitiesCachePath = $path
    return $parsed
}

function Clear-EntitiesCache {
    <#
    .SYNOPSIS
        Invalidates the entities cache. Called by Import-Entity after writes.
    #>
    [CmdletBinding()]
    param()
    $script:EntitiesCache = $null
    $script:EntitiesCacheTimestamp = $null
    $script:EntitiesCachePath = $null
}

function ConvertTo-NormalizedEntityListFields {
    <#
    .SYNOPSIS
        Coerce an entity record's list fields (aliases, source_refs) to proper JSON
        arrays IN PLACE — the writer half of t/1964/t/1969.
    .DESCRIPTION
        The Entity type (lib/entities/types.ts) declares aliases + source_refs as
        string[], but entities.json had drifted to store them as array | null | bare
        string — a shape-vs-type lie that null-deref'd / .map-on-string crashed the
        entity browser and the t/1898 mention flow. Normalizing here (the single write
        chokepoint) stops the drift recurring: $null -> @(), a bare scalar/string ->
        a one-element array, an existing array preserved. $null is guarded FIRST
        (@($null) would emit [null]); direct property assignment avoids single-element
        unrolling. `aliases` (contract-required) is always ensured present; `source_refs`
        (optional) is normalized only when the field exists. `external_refs`
        ({label,url}[]) is a different shape and is left untouched.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Entity
    )

    # aliases — contract-required string[]; ensure the field EXISTS and is an array.
    # (Add-Member for the absent case: direct assignment to a non-existent property
    # throws under Set-StrictMode -Version Latest.)
    if (-not $Entity.PSObject.Properties['aliases']) {
        $Entity | Add-Member -NotePropertyName aliases -NotePropertyValue @() -Force
    } elseif ($null -eq $Entity.aliases) {
        $Entity.aliases = @()
    } elseif ($Entity.aliases -isnot [array]) {
        $Entity.aliases = @($Entity.aliases)
    }

    # source_refs — optional string[]; normalize only when the field is present.
    if ($Entity.PSObject.Properties['source_refs']) {
        $refs = $Entity.source_refs
        if ($null -eq $refs)          { $Entity.source_refs = @() }
        elseif ($refs -isnot [array]) { $Entity.source_refs = @($refs) }
    }
}

function Write-EntityStoreAtomic {
    <#
    .SYNOPSIS
        Atomically write an entity envelope (entities.json / entity_embeddings.json),
        mirroring Import-Organization's temp + File.Move idiom.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Store,

        [Parameter(Mandatory)]
        [string]$Path
    )
    Set-StrictMode -Version Latest

    # t/1969 — normalize entity list-fields to arrays before serialization so aliases/
    # source_refs never write as null or a bare string (the drift that crashed the entity
    # browser / t/1898). Gated on the ENTITIES envelope so the embeddings store's
    # `vectors` write is untouched. Because the whole envelope is rewritten each save,
    # this auto-backfills every existing record on the next write (no data-repo pass).
    if ($Store.PSObject.Properties['entities']) {
        foreach ($e in @($Store.entities)) {
            if ($null -ne $e) { ConvertTo-NormalizedEntityListFields -Entity $e }
        }
    }

    Assert-DataWriteAllowed -Path $Path  # t/2902
    $temp = "$Path.tmp"
    $json = $Store | ConvertTo-Json -Depth 12
    try {
        Set-Content -Path $temp -Value $json -Encoding utf8NoBOM
        [System.IO.File]::Move($temp, $Path, $true)
    } catch {
        if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
        throw (New-ActionableError -PassThru `
            -Goal 'Write entity registry' `
            -Problem "Failed to write $Path : $($_.Exception.Message)" `
            -Location 'Write-EntityStoreAtomic' `
            -NextSteps @(
                'Check the data directory is writable and not locked',
                'Verify free disk space and that the parent directory exists'
            ))
    }
}

function New-EntityId {
    <#
    .SYNOPSIS
        Monotonic, NEVER-reused ent-NNN id allocator (design §3, non-negotiable).
    .DESCRIPTION
        Scans EVERY id in the store — including `deprecated` records and `merged_into`
        tombstones, which are retained (never deleted). That retention is the invariant
        that keeps `max + 1` monotonic; if a record could ever be removed the next mint
        would recycle its id and silently repoint historical links (design §3, TL Q3).

        Compares the PARSED INTEGER, not the string, so the 999 -> 1000 boundary does not
        regress under lexical ordering. -Count mints a contiguous batch off a single
        high-water mark so several mints inside one Import-Entity call never collide.
        Padding is >= 3 digits (cosmetic); it widens naturally past ent-999 -> ent-1000.
    .PARAMETER Store
        The parsed entities.json envelope to allocate against.
    .PARAMETER Count
        How many contiguous ids to mint. Capped at the ~20/batch curation cap (design §4).
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)]
        [object]$Store,

        [ValidateRange(1, 20)]
        [int]$Count = 1
    )
    Set-StrictMode -Version Latest

    $maxNum = 0
    if ($Store.PSObject.Properties['entities']) {
        foreach ($e in @($Store.entities)) {
            if (-not $e.PSObject.Properties['id']) { continue }
            $m = [regex]::Match([string]$e.id, '^ent-(\d+)$')
            if ($m.Success) {
                $n = [int]$m.Groups[1].Value      # parsed int compare — NOT lexical
                if ($n -gt $maxNum) { $maxNum = $n }
            }
        }
    }

    $ids = for ($i = 1; $i -le $Count; $i++) {
        'ent-' + ([string]($maxNum + $i)).PadLeft(3, '0')
    }
    return @($ids)
}

function Get-EntityMergedIntoId {
    # The record's merged_into target, or '' when it is not a tombstone.
    param($Entity)
    if ($null -ne $Entity -and $Entity.PSObject.Properties['merged_into'] -and -not [string]::IsNullOrWhiteSpace([string]$Entity.merged_into)) {
        return [string]$Entity.merged_into
    }
    ''
}

function Test-EntityVectorEligible {
    <#
    .SYNOPSIS
        True when a record should carry a vector: approved and not a merge tombstone (t/4450).
    .DESCRIPTION
        The ONE predicate for the vector scope (CL t/4450#2 condition 3): the extraction vector index
        (Get-EntityVectorIndex), the embedding writer (Update-EntityEmbeddings) and Get-EntityReport's
        orphan-vector check all call it, so what is indexed and what is reported can't drift.
        Invariant (t/4450): merged_into set => status 'deprecated'. The tombstone test stays here as
        well, for records written before the invariant (ent-054).
    #>
    param($Entity)
    if ($null -eq $Entity) { return $false }
    $status = if ($Entity.PSObject.Properties['status']) { [string]$Entity.status } else { '' }
    ($status -ceq 'approved') -and -not (Get-EntityMergedIntoId $Entity)
}

function Resolve-EntityTombstoneTarget {
    <#
    .SYNOPSIS
        The id a tombstone's name and aliases should link to: its canonical, followed through the chain.
    .DESCRIPTION
        For indexes that must not throw on a bad chain (CL t/4450#2 condition 1, the t/4278 C6 rule):
        a cycle, an exceeded depth cap or a dangling target resolves to the record ITSELF, with a WARN.
        Get-EntityReport's merge-chain section reports those defects. Non-tombstones return their own id.
    #>
    param([Parameter(Mandatory)]$Entity, [Parameter(Mandatory)][hashtable]$ById, [string]$Caller = 'Resolve-EntityTombstoneTarget')
    $id = [string]$Entity.id
    if (-not (Get-EntityMergedIntoId $Entity)) { return $id }
    try {
        $canonical = Resolve-EntityMergedInto -StartId $id -ById $ById
    } catch {
        Write-Warning "${Caller}: merge chain from '$id' is broken ($($_.Exception.Message)); keeping '$id' itself. Get-EntityReport -Report merge-chain lists it."
        return $id
    }
    if ($null -eq $canonical) {
        Write-Warning "${Caller}: '$id' merges into '$(Get-EntityMergedIntoId $Entity)', which is not in the store; keeping '$id' itself. Get-EntityReport -Report merge-chain lists it."
        return $id
    }
    [string]$canonical.id
}

function Resolve-EntityMergedInto {
    <#
    .SYNOPSIS
        Follow a merged_into tombstone chain to its canonical record (design §7).
    .DESCRIPTION
        Mirrors the server resolveMergedInto (taxonomy-editor/src/server/routes/entity.ts,
        t/1786) exactly: a `visited` set for cycle detection and a depth cap
        ($script:EntityMergeMaxDepth). Path-compression on write is the invariant; this
        defensive walk is the safety net for a transiently-uncompressed chain. A cycle or
        an exceeded cap is a DATA DEFECT (throws → surfaced by Get-EntityReport), never a
        silent 404. A terminal id that is absent from the store returns $null (not_found).
    .PARAMETER StartId
        The requested entity id.
    .PARAMETER ById
        Map of id -> raw entity record for the whole store.
    .PARAMETER MaxDepth
        Depth cap; defaults to the shared contract constant.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$StartId,

        [Parameter(Mandatory)]
        [hashtable]$ById,

        [int]$MaxDepth = $script:EntityMergeMaxDepth
    )
    Set-StrictMode -Version Latest

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $currentId = $StartId

    for ($depth = 0; $depth -le $MaxDepth; $depth++) {
        if (-not $ById.ContainsKey($currentId)) { return $null }   # terminal missing -> not_found
        $rec = $ById[$currentId]
        $mergedInto = if ($rec.PSObject.Properties['merged_into'] -and $null -ne $rec.merged_into) { [string]$rec.merged_into } else { '' }
        if ([string]::IsNullOrWhiteSpace($mergedInto)) { return $rec }   # canonical reached

        if (-not $seen.Add($currentId)) {
            throw (New-ActionableError -PassThru `
                -Goal 'Resolve entity merge chain' `
                -Problem "merged_into cycle detected at '$currentId'" `
                -Location 'Resolve-EntityMergedInto' `
                -NextSteps @(
                    'A merged_into cycle is a data defect — inspect the pointers in entities.json',
                    'Run Get-EntityReport to surface merge-chain defects'
                ))
        }
        $currentId = $mergedInto
    }

    throw (New-ActionableError -PassThru `
        -Goal 'Resolve entity merge chain' `
        -Problem "merged_into chain from '$StartId' exceeded the depth cap ($MaxDepth)" `
        -Location 'Resolve-EntityMergedInto' `
        -NextSteps @(
            "If a legitimately long chain exists, raise the cap (currently $MaxDepth) IN SYNC with the server (t/1786)",
            'Otherwise treat as a data defect and inspect the merged_into pointers'
        ))
}
