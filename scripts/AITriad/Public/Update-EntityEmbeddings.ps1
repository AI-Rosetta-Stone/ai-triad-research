# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-EntityEmbeddings {
    <#
    .SYNOPSIS
        Backfill / refresh entity_embeddings.json to the v2 multi-vector shape (t/3121 D).

    .DESCRIPTION
        Reads approved entities from entities.json and (re)embeds each to the schema-2.0.0
        EntityVectorRecord { name_vector, description_vector? } shape defined by the Shared Lib
        contract (lib/entities/entityVectors.ts, TL ruling t/3121#4). name_vector embeds
        label + aliases; description_vector embeds the description and is omitted when empty.

        IDEMPOTENT: a per-entity `_src_hash` (envelope map `_src_hashes`) fingerprints the exact
        embedded source. An entity is re-embedded only when it has no v2 record OR its source
        changed OR -Force is passed — so a second run with no data change embeds nothing and is a
        cheap no-op (closes the stale-vector class t/3085 for the backfill path). ALL entities
        needing embedding are batched into ONE Get-TextEmbedding call (sub-ids <id>#name /
        <id>#desc) rather than one subprocess per entity.

        ADDITIVE ONLY: vectors for entities that are no longer approved are left in place (not
        pruned) — pruning is a separate, deletion-risk concern out of scope for this backfill.

        Running this against production data writes ../ai-triad-data/.../entity_embeddings.json,
        which is a HUMAN data-push (agents cannot write the data repo). Use -WhatIf to preview.

        Shares Get-EntityVectorSource + New-EntityVectorRecord with Import-Entity so both writers
        produce byte-identical fingerprints and record shapes (no staleness drift).

    .PARAMETER Path
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.

    .PARAMETER EmbeddingsPath
        Override entity_embeddings.json path (fixtures/tests). Defaults to Get-EntityEmbeddingsFilePath.

    .PARAMETER Force
        Re-embed every approved entity even when its `_src_hash` is unchanged (e.g. after a model swap).

    .EXAMPLE
        Update-EntityEmbeddings -WhatIf
        Preview how many approved entities would be embedded, without writing.

    .EXAMPLE
        Update-EntityEmbeddings
        Backfill/refresh, skipping entities whose source is unchanged.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$Path,

        [Parameter()]
        [string]$EmbeddingsPath,

        [Parameter()]
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $entPath = if ($Path) { $Path } else { Get-EntitiesFilePath }
    $embPath = if ($EmbeddingsPath) { $EmbeddingsPath } else { Get-EntityEmbeddingsFilePath }

    if (-not (Test-Path $entPath)) {
        throw (New-ActionableError -PassThru `
            -Goal 'Backfill entity vectors' `
            -Problem "entities.json not found: $entPath" `
            -Location 'Update-EntityEmbeddings' `
            -NextSteps 'Run entity curation (Import-Entity) first, or pass -Path to the correct entities.json.')
    }

    $store = Get-Content -Raw -Path $entPath -Encoding utf8 | ConvertFrom-Json
    $entities = if ($store.PSObject.Properties['entities']) { @($store.entities) } else { @() }
    # The shared vector-scope predicate (t/4450): approved and not a merge tombstone.
    $approved = @($entities | Where-Object { $_.PSObject.Properties['id'] -and (Test-EntityVectorEligible $_) })

    $embStore = if (Test-Path $embPath) {
        Get-Content -Raw -Path $embPath -Encoding utf8 | ConvertFrom-Json
    } else {
        New-EmptyEntityEmbeddingsStore
    }
    if (-not $embStore.PSObject.Properties['vectors']) {
        Add-Member -InputObject $embStore -MemberType NoteProperty -Name 'vectors' -Value ([PSCustomObject]@{})
    }
    if (-not $embStore.PSObject.Properties['_src_hashes']) {
        Add-Member -InputObject $embStore -MemberType NoteProperty -Name '_src_hashes' -Value ([PSCustomObject]@{})
    }

    # Plan: decide which approved entities need (re)embedding, computing the shared fingerprint once.
    $plan = foreach ($e in $approved) {
        $id      = [string]$e.id
        $aliases = if ($e.PSObject.Properties['aliases']) { @($e.aliases) } else { @() }
        $desc    = if ($e.PSObject.Properties['description']) { [string]$e.description } else { '' }
        $src     = Get-EntityVectorSource -Name ([string]$e.name) -Aliases $aliases -Description $desc

        $prior = if ($embStore._src_hashes.PSObject.Properties[$id]) { [string]$embStore._src_hashes.$id } else { '' }
        $hasV2 = $embStore.vectors.PSObject.Properties[$id] -and ($embStore.vectors.$id -isnot [array])
        $needs = [bool]($Force -or (-not $hasV2) -or ($prior -ne $src.SrcHash))

        [PSCustomObject]@{ Id = $id; Src = $src; Needs = $needs }
    }
    $need = @($plan | Where-Object { $_.Needs })

    if ($need.Count -eq 0) {
        return [PSCustomObject]@{
            TotalApproved  = $approved.Count
            Embedded       = 0
            Skipped        = $approved.Count
            EmbeddingsPath = $embPath
        }
    }

    if (-not $PSCmdlet.ShouldProcess($embPath, "Embed $($need.Count) of $($approved.Count) approved entity(ies)")) {
        return [PSCustomObject]@{
            TotalApproved  = $approved.Count
            Embedded       = 0
            Skipped        = $approved.Count
            EmbeddingsPath = $embPath
        }
    }

    # One batch across ALL entities needing embedding (sub-ids <id>#name / <id>#desc).
    $batchIds   = [System.Collections.Generic.List[string]]::new()
    $batchTexts = [System.Collections.Generic.List[string]]::new()
    foreach ($p in $need) {
        $batchIds.Add("$($p.Id)#name"); $batchTexts.Add($p.Src.NameText)
        if ($p.Src.DescText) { $batchIds.Add("$($p.Id)#desc"); $batchTexts.Add($p.Src.DescText) }
    }

    $vecMap = if ($batchTexts.Count -gt 0) { Get-TextEmbedding -Texts @($batchTexts) -Ids @($batchIds) } else { @{} }

    $embeddedCount = 0
    foreach ($p in $need) {
        $id = $p.Id
        # Partial-results: if this entity's name vector didn't come back, skip it (don't fail the batch).
        if (-not ($vecMap -and $vecMap.ContainsKey("$id#name"))) { continue }

        $descVec = if ($p.Src.DescText -and $vecMap.ContainsKey("$id#desc")) { $vecMap["$id#desc"] } else { $null }
        $vrec = New-EntityVectorRecord -NameVector $vecMap["$id#name"] -DescriptionVector $descVec

        if ($embStore.vectors.PSObject.Properties[$id]) { $embStore.vectors.$id = $vrec }
        else { Add-Member -InputObject $embStore.vectors -MemberType NoteProperty -Name $id -Value $vrec }

        if ($embStore._src_hashes.PSObject.Properties[$id]) { $embStore._src_hashes.$id = $p.Src.SrcHash }
        else { Add-Member -InputObject $embStore._src_hashes -MemberType NoteProperty -Name $id -Value $p.Src.SrcHash }

        $embeddedCount++
    }

    if ($embeddedCount -gt 0) {
        if ($embStore.PSObject.Properties['_schema_version']) { $embStore._schema_version = '2.0.0' }
        else { Add-Member -InputObject $embStore -MemberType NoteProperty -Name '_schema_version' -Value '2.0.0' }
        if ($embStore.PSObject.Properties['last_modified']) { $embStore.last_modified = (Get-Date).ToString('yyyy-MM-dd') }
        Write-EntityStoreAtomic -Store $embStore -Path $embPath
    }

    [PSCustomObject]@{
        TotalApproved  = $approved.Count
        Embedded       = $embeddedCount
        Skipped        = $approved.Count - $embeddedCount
        EmbeddingsPath = $embPath
    }
}
