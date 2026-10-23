# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Import-Entity {
    <#
    .SYNOPSIS
        Curation write path for entity records (ent-*) — machine-proposes / human-disposes
        (t/1804, mirrors Import-Organization). Batch-capped at ~20 proposals (design §4).
    .DESCRIPTION
        Upserts a batch of proposed/approved/deprecated entity records into entities.json,
        minting never-reused ent-NNN ids for new records via New-EntityId. Records are only
        ever added, updated, tombstoned (`merged_into`), or `deprecated` — NEVER hard-deleted.
        That is the invariant the monotonic id allocator depends on (design §3, TL t/1804#2 Q3).

        Person policy (owner decision 2026-08-31, design §4/§9.3, t/3131): a `person` description
        may be AI-DRAFTED, but approval requires a human editor. A `person` is `approved` only when
        `description` is non-empty AND `description_provenance` is `human-edited` / `human-authored`
        (or unset — grandfathered legacy, safe while no AI path drafts a person description without
        stamping `ai-drafted`). Approving a `person` whose provenance is still `ai-drafted`, or whose
        description is empty, throws an ActionableError directing the human to edit + set provenance.

        Approved records get one all-MiniLM-L6-v2 embedding (name + genus-differentia line)
        written to a SEPARATE entity_embeddings.json via the existing Get-TextEmbedding path
        (Shared Utility Rule). Only `approved` entities carry vectors (design §3).

        The Entity shape is the contract in lib/entities/types.ts — not restated here; a
        parity test guards drift (TL t/1804#2 Q1).
    .PARAMETER Proposal
        1-20 proposal records (hashtable or PSCustomObject). New records require `name`,
        `entity_type`, `dolce_category`; optional `description`, `aliases`, `source_refs`,
        `external_refs`, `discovered_by`, `confidence`, `status` (default 'proposed'), `id`
        (to update an existing record), `merged_into` (to tombstone/merge into a canonical id; a
        tombstone is always `deprecated` and loses its vector, t/4450),
        `description_provenance` (`ai-drafted` | `human-edited` | `human-authored`; gates person approval).
    .PARAMETER Path
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER EmbeddingsPath
        Override entity_embeddings.json path (fixtures/tests). Defaults to Get-EntityEmbeddingsFilePath.
    .PARAMETER SkipEmbedding
        Do not compute/write embeddings for approved records (tests / offline curation).
    .EXAMPLE
        Import-Entity -Proposal @(@{ name = 'GPT-4'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = 'A model that ...' })
    .LINK
        Get-Entity
    .LINK
        Import-Organization
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateCount(1, 20)]
        [object[]]$Proposal,

        [string]$Path,

        [string]$EmbeddingsPath,

        [switch]$SkipEmbedding
    )

    Set-StrictMode -Version Latest

    $entPath = if ($Path) { $Path } else { Get-EntitiesFilePath }
    $embPath = if ($EmbeddingsPath) { $EmbeddingsPath } else { Get-EntityEmbeddingsFilePath }

    $store = Get-EntitiesStore -Path $entPath -Force -InitIfMissing
    $existing = [System.Collections.Generic.List[object]]::new()
    if ($store.PSObject.Properties['entities']) {
        foreach ($e in @($store.entities)) { $existing.Add($e) }
    }

    # Embeddings store loaded lazily only if an approval needs a vector.
    $embStore = $null
    $embDirty = $false
    $now = (Get-Date).ToString('yyyy-MM-dd')

    # Small helpers over the working list (match/replace/append; never remove).
    $findIndex = {
        param($id)
        for ($i = 0; $i -lt $existing.Count; $i++) {
            if ($existing[$i].PSObject.Properties['id'] -and [string]$existing[$i].id -eq $id) { return $i }
        }
        return -1
    }
    $prop = {
        param($obj, $name, $default)
        if ($obj -is [hashtable]) { if ($obj.ContainsKey($name)) { return $obj[$name] } else { return $default } }
        if ($obj.PSObject.Properties[$name]) { return $obj.$name } else { return $default }
    }

    $results = [System.Collections.Generic.List[object]]::new()

    foreach ($p in $Proposal) {
        $propId      = [string](& $prop $p 'id' '')
        $name        = [string](& $prop $p 'name' '')
        $entityType  = [string](& $prop $p 'entity_type' '')
        $dolce       = [string](& $prop $p 'dolce_category' '')
        $description = [string](& $prop $p 'description' '')
        $status      = [string](& $prop $p 'status' 'proposed')
        $mergedInto  = [string](& $prop $p 'merged_into' '')
        $descProv    = [string](& $prop $p 'description_provenance' '')   # t/3131: '' = unset/legacy

        # t/3133: reject UNKNOWN proposal fields loudly instead of silently dropping them. The t/3118
        # near-miss: a stale (pre-t/3131) module didn't read description_provenance, dropped it, and
        # the grandfather rule would have auto-approved unedited AI drafts. Erroring turns any
        # stale-code / typo'd-field case into an immediate failure, not silent data-correctness drift.
        # Top-level keys only (nested shapes like discovered_by.{usage_id,model} are not recursed);
        # allowlist = the Entity contract (Get-EntityProposalFieldName, kept in sync by the parity test).
        $knownFields   = Get-EntityProposalFieldName
        $provKeys      = if ($p -is [hashtable]) { @($p.Keys) } else { @($p.PSObject.Properties.Name) }
        $unknownFields = @($provKeys | Where-Object { $_ -notin $knownFields })
        if ($unknownFields.Count -gt 0) {
            $idLabel = if ($propId) { $propId } elseif ($name) { $name } else { '(unnamed)' }
            throw (New-ActionableError -PassThru `
                -Goal 'Import an entity proposal' `
                -Problem "Proposal '$idLabel' carries unrecognized field(s): $($unknownFields -join ', ')" `
                -Location 'Import-Entity' `
                -NextSteps @(
                    'Remove the unrecognized field(s) from the proposal, OR'
                    'If a field is a new Entity contract field, add it to lib/entities/types.ts AND Get-EntityProposalFieldName (the drift-parity test guards the pairing)'
                    'Older module versions silently DROP unknown fields — this refusal prevents a stale-module field-drop (t/3133)'
                ))
        }

        # t/3170: write-side relation-DAG gate. `relations[]` is allowlisted (t/3119) but VALIDATE-ONLY
        # (Q1, TL-approved t/3170#2) — invalid edges are rejected here and valid relations are still
        # DROPPED (not persisted); persistence is the downstream ticket this gate blocks. Enforced now:
        # target well-formedness, ent-* existence (from the store), acyclicity, depth<=3 (combined DAG,
        # depth = edges). Term-target EXISTENCE is DEFERRED to Q4 (Shared Lib parseEntityRef parity) —
        # until it lands we accept any WELL-FORMED term:* by treating the candidate's term targets as
        # known, so well-formedness + acyclic + depth still bind on term edges.
        $propRelations = @(& $prop $p 'relations' @())
        if ($propRelations.Count -gt 0) {
            $candId = if ($propId) { $propId } else { 'ent-NEW' }
            $candTermRefs = @($propRelations |
                    ForEach-Object { [string](& $prop $_ 'target') } |
                    Where-Object { $_ -match '^term:' })
            Assert-EntityRelationsValid -EntityId $candId -Relation $propRelations -ExistingEntity $existing -KnownTermRef $candTermRefs
        }

        $idx = if ($propId) { & $findIndex $propId } else { -1 }
        $isUpdate = ($idx -ge 0)

        # t/4450 invariant (CL t/4450#2): merged_into set => status 'deprecated'. A merge, or any update
        # of an existing tombstone, is written as deprecated; an explicit other status is refused, since
        # an approved tombstone stays embedded and indexed as a live entity (ent-054, t/3118 curation).
        $statusGiven = if ($p -is [hashtable]) { $p.ContainsKey('status') } else { [bool]$p.PSObject.Properties['status'] }
        $effMerged = if ($mergedInto) { $mergedInto } elseif ($isUpdate) { Get-EntityMergedIntoId $existing[$idx] } else { '' }
        if ($effMerged) {
            if ($statusGiven -and $status -cne 'deprecated') {
                $idLabel = if ($propId) { $propId } else { $name }
                throw (New-ActionableError -PassThru `
                    -Goal 'Import an entity proposal' `
                    -Problem "Proposal '$idLabel' sets status '$status' on a merge tombstone (merged_into '$effMerged'); a tombstone is always 'deprecated' (t/4450)" `
                    -Location 'Import-Entity' `
                    -NextSteps @(
                        "Drop 'status' from the proposal (a merge writes 'deprecated'), or set it to 'deprecated'",
                        "To keep the record live, don't merge it: approve the canonical '$effMerged' and leave this one unmerged"
                    ))
            }
            $status = 'deprecated'
        }

        # For updates, resolve the effective type against the existing record so the
        # person gate can't be dodged by omitting entity_type on an approval update.
        if ($isUpdate -and -not $entityType -and $existing[$idx].PSObject.Properties['entity_type']) {
            $entityType = [string]$existing[$idx].entity_type
        }
        if ($isUpdate -and -not $description -and $existing[$idx].PSObject.Properties['description']) {
            $description = [string]$existing[$idx].description
        }
        # t/3131: resolve effective provenance from the existing record on updates, so an approval
        # can't dodge the person gate by omitting description_provenance on the update. An explicit
        # value on the proposal (e.g. flipping ai-drafted -> human-edited) still wins.
        if ($isUpdate -and -not $descProv -and $existing[$idx].PSObject.Properties['description_provenance']) {
            $descProv = [string]$existing[$idx].description_provenance
        }

        # Person-approval gate (design §4/§9.3, revised t/3131): AI may DRAFT a person description,
        # but approval still requires a human. A person is approvable iff `description` is non-empty
        # AND provenance is human (human-edited / human-authored) OR unset. It is NOT approvable when
        # provenance is 'ai-drafted' (an unedited AI draft) or the description is empty.
        #
        # GRANDFATHER SAFETY INVARIANT (t/3131, TL-required): unset provenance is treated as
        # human-authored ONLY because no code path AI-drafts a person description without stamping
        # 'ai-drafted' — verified: Invoke-EntityExtraction mints person proposals with NO description
        # (:40-43/:766). Any FUTURE person AI-drafter MUST stamp description_provenance='ai-drafted',
        # or an unedited draft would land as unset+non-empty and be silently auto-approved here.
        # ORDERING (t/3131): this cmdlet must READ+PERSIST description_provenance before any
        # ai-drafted person is imported (else the marker drops -> grandfather misfires).
        if ($entityType -eq 'person' -and $status -eq 'approved') {
            $idLabel = if ($propId) { $propId } else { $name }
            if ([string]::IsNullOrWhiteSpace($description)) {
                throw (New-ActionableError -PassThru `
                    -Goal 'Approve a person entity' `
                    -Problem "Person entity '$idLabel' cannot be approved without a description" `
                    -Location 'Import-Entity' `
                    -NextSteps @(
                        'Provide a genus-differentia description ("A person who ...")',
                        "Set description_provenance to 'human-edited' (an AI draft a human edited) or 'human-authored'",
                        'Re-run Import-Entity'
                    ))
            }
            if ($descProv -eq 'ai-drafted') {
                throw (New-ActionableError -PassThru `
                    -Goal 'Approve a person entity' `
                    -Problem "Person entity '$idLabel' has an AI draft that no human has edited" `
                    -Location 'Import-Entity' `
                    -NextSteps @(
                        "Edit the drafted description and set description_provenance to 'human-edited', then re-run"
                    ))
            }
            # else: description non-empty AND provenance in {human-edited, human-authored, unset} -> approvable.
        }

        if ($isUpdate) {
            $rec = $existing[$idx]
            $newId = [string]$rec.id
        } else {
            if (-not $name -or -not $entityType -or -not $dolce) {
                throw (New-ActionableError -PassThru `
                    -Goal 'Create an entity record' `
                    -Problem 'A new proposal requires name, entity_type, and dolce_category' `
                    -Location 'Import-Entity' `
                    -NextSteps @('Add the missing field(s) to the proposal record'))
            }
            # Mint against the WORKING list so ids stay monotonic + collision-free within
            # this batch (each append feeds the next mint's max).
            $newId = @(New-EntityId -Store ([PSCustomObject]@{ entities = @($existing) }))[0]
            $rec = [PSCustomObject]@{
                id            = $newId
                name          = $name
                aliases       = @()
                entity_type   = $entityType
                dolce_category = $dolce
                description   = $description
                external_refs = @()
                source_refs   = @()
                status        = $status
                created_at    = $now
                last_modified = $now
            }
        }

        # Apply mutable fields (shape-matched to the Entity contract; optionals only when present).
        $rec.name          = if ($name) { $name } else { $rec.name }
        $rec.entity_type   = if ($entityType) { $entityType } else { $rec.entity_type }
        if ($dolce) { $rec.dolce_category = $dolce }
        $rec.description   = $description
        $rec.status        = $status
        $rec.last_modified = $now

        # t/3131 (TL-required): READ + PERSIST description_provenance so an imported 'ai-drafted'
        # marker survives on the stored record (that's what keeps the grandfather rule safe — an
        # unedited AI draft stays blockable instead of degrading to unset+non-empty). Optional enum:
        # only written when set; never write '' (not a valid contract value).
        if ($descProv) {
            if ($rec.PSObject.Properties['description_provenance']) { $rec.description_provenance = $descProv }
            else { Add-Member -InputObject $rec -MemberType NoteProperty -Name 'description_provenance' -Value $descProv }
        }

        foreach ($fld in @(
            @{ k = 'aliases';       d = @() },
            @{ k = 'source_refs';   d = @() },
            @{ k = 'source_refs_basis';  d = $null },   # t/4404: { doc_id -> basis }
            @{ k = 'source_refs_status'; d = $null },   # t/4404: attributed | none-matched
            @{ k = 'external_refs'; d = @() },
            @{ k = 'discovered_by'; d = $null },
            @{ k = 'confidence';    d = $null }
        )) {
            $v = & $prop $p $fld.k '__ABSENT__'
            if ($v -ne '__ABSENT__') {
                if ($rec.PSObject.Properties[$fld.k]) { $rec.$($fld.k) = $v }
                else { Add-Member -InputObject $rec -MemberType NoteProperty -Name $fld.k -Value $v }
            }
        }

        # Merge: set the tombstone pointer, then PATH-COMPRESS (design §7) — rewrite any
        # X.merged_into = thisId to the canonical target in the same pass so stored chains
        # never form. The defensive walk in Get-Entity remains as the safety net.
        if ($mergedInto) {
            if ($rec.PSObject.Properties['merged_into']) { $rec.merged_into = $mergedInto }
            else { Add-Member -InputObject $rec -MemberType NoteProperty -Name 'merged_into' -Value $mergedInto }
            foreach ($other in $existing) {
                if ($other.PSObject.Properties['merged_into'] -and $null -ne $other.merged_into -and [string]$other.merged_into -eq $newId) {
                    $other.merged_into = $mergedInto
                }
            }
        }

        if ($isUpdate) { $existing[$idx] = $rec } else { [void]$existing.Add($rec) }

        # Approved records carry exactly one vector (design §3). Proposed/deprecated do not.
        $embedded = $false
        if ($status -eq 'approved' -and -not $SkipEmbedding) {
            if ($null -eq $embStore) {
                $embStore = if (Test-Path $embPath) { Get-Content -Raw -Path $embPath -Encoding utf8 | ConvertFrom-Json } else { New-EmptyEntityEmbeddingsStore }
            }
            # t/3121 v2 multi-vector: name_vector embeds label + aliases (drives the resolution
            # ladder's cosine tie-break); description_vector embeds the description (future R6
            # rung), OMITTED when description is empty (Shared Lib readers tolerate absence,
            # entityVectors.ts nameVectorOf). One sub-id batch → one embed subprocess.
            # `_src_hash` (envelope-side `_src_hashes` map, PS-owned — deliberately NOT in the
            # EntityVectorRecord type) fingerprints the EXACT embedded source so a re-import and
            # Update-EntityEmbeddings (t/3121 D) can skip unchanged records idempotently
            # (staleness guard, t/3085 class). Hash over the same text the writer embeds.
            # Get-EntityVectorSource is the SHARED source-text + fingerprint builder (also used by
            # Update-EntityEmbeddings) so both writers compute a byte-identical `_src_hash`.
            $src      = Get-EntityVectorSource -Name ([string]$rec.name) -Aliases @($rec.aliases) -Description ([string]$rec.description)
            $srcHash  = $src.SrcHash

            $priorHash = if ($embStore.PSObject.Properties['_src_hashes'] -and $embStore._src_hashes.PSObject.Properties[$newId]) { [string]$embStore._src_hashes.$newId } else { '' }
            $hasV2Rec  = $embStore.PSObject.Properties['vectors'] -and $embStore.vectors.PSObject.Properties[$newId] -and ($embStore.vectors.$newId -isnot [array])
            if ($hasV2Rec -and $priorHash -eq $srcHash) {
                # Already current (v2 record + matching fingerprint): carries a vector, no re-embed.
                $embedded = $true
            }
            else {
                $subIds   = @("$newId#name")
                $subTexts = @($src.NameText)
                if ($src.DescText) { $subIds += "$newId#desc"; $subTexts += $src.DescText }
                $vecMap = Get-TextEmbedding -Texts $subTexts -Ids $subIds
                if ($vecMap -and $vecMap.ContainsKey("$newId#name")) {
                    $descVec = if ($src.DescText -and $vecMap.ContainsKey("$newId#desc")) { $vecMap["$newId#desc"] } else { $null }
                    $vrec = New-EntityVectorRecord -NameVector $vecMap["$newId#name"] -DescriptionVector $descVec
                    if (-not $embStore.PSObject.Properties['vectors']) {
                        Add-Member -InputObject $embStore -MemberType NoteProperty -Name 'vectors' -Value ([PSCustomObject]@{})
                    }
                    if ($embStore.vectors.PSObject.Properties[$newId]) { $embStore.vectors.$newId = $vrec }
                    else { Add-Member -InputObject $embStore.vectors -MemberType NoteProperty -Name $newId -Value $vrec }

                    if (-not $embStore.PSObject.Properties['_src_hashes']) {
                        Add-Member -InputObject $embStore -MemberType NoteProperty -Name '_src_hashes' -Value ([PSCustomObject]@{})
                    }
                    if ($embStore._src_hashes.PSObject.Properties[$newId]) { $embStore._src_hashes.$newId = $srcHash }
                    else { Add-Member -InputObject $embStore._src_hashes -MemberType NoteProperty -Name $newId -Value $srcHash }

                    # This store now holds a v2 record — declare the schema (bumps a loaded v1 envelope).
                    if ($embStore.PSObject.Properties['_schema_version']) { $embStore._schema_version = '2.0.0' }
                    else { Add-Member -InputObject $embStore -MemberType NoteProperty -Name '_schema_version' -Value '2.0.0' }

                    $embDirty = $true
                    $embedded = $true
                }
            }
        }

        # A tombstone carries no vector (t/4450): drop one left from before the merge, with its fingerprint.
        if ($effMerged -and (Test-Path $embPath)) {
            if ($null -eq $embStore) { $embStore = Get-Content -Raw -Path $embPath -Encoding utf8 | ConvertFrom-Json }
            if ($embStore.PSObject.Properties['vectors'] -and $embStore.vectors.PSObject.Properties[$newId]) {
                $embStore.vectors.PSObject.Properties.Remove($newId)
                if ($embStore.PSObject.Properties['_src_hashes'] -and $embStore._src_hashes.PSObject.Properties[$newId]) {
                    $embStore._src_hashes.PSObject.Properties.Remove($newId)
                }
                $embDirty = $true
            }
        }

        $results.Add([PSCustomObject]@{
            Id       = $newId
            Name     = $rec.name
            Status   = $status
            Action   = if ($isUpdate) { 'updated' } else { 'created' }
            Embedded = $embedded
        })
    }

    # Refresh envelope counters.
    if ($store.PSObject.Properties['entities']) { $store.entities = @($existing) }
    else { Add-Member -InputObject $store -MemberType NoteProperty -Name 'entities' -Value (@($existing)) }
    if ($store.PSObject.Properties['entity_count']) { $store.entity_count = $existing.Count }
    else { Add-Member -InputObject $store -MemberType NoteProperty -Name 'entity_count' -Value ($existing.Count) }
    if ($store.PSObject.Properties['last_modified']) { $store.last_modified = $now }
    else { Add-Member -InputObject $store -MemberType NoteProperty -Name 'last_modified' -Value $now }

    if (-not $PSCmdlet.ShouldProcess($entPath, "Upsert $($Proposal.Count) entity record(s)")) {
        return @($results)
    }

    Write-EntityStoreAtomic -Store $store -Path $entPath
    if ($embDirty) {
        if ($embStore.PSObject.Properties['last_modified']) { $embStore.last_modified = $now }
        Write-EntityStoreAtomic -Store $embStore -Path $embPath
    }
    Clear-EntitiesCache

    return @($results)
}
