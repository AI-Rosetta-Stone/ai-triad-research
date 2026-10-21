# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-EntityMentionIndex {
    <#
    .SYNOPSIS
        Rebuilds entity_mentions.json — the derived, alias-first mention index over the
        curated batch tier (t/1894, Phase 2-B; epic t/1890 design of record §5/§7).
    .DESCRIPTION
        The retroactive re-index (§7): the durable rebuild path for entity_mentions.json,
        a DERIVED artifact (never a source of truth). Scans each curated container's exact
        analyzed text for entity aliases and writes one Mention per hit. By default only
        APPROVED entities are indexed (design of record §5; the D1 caller-filters-to-approved
        contract) — widen with -Status to build a preview over proposed/deprecated records.

        Matching is ALIAS-FIRST and deterministic — an alias table (name + aliases) over the
        in-scope entities in entities.json (default: status 'approved'), matched
        case-insensitively with word boundaries and flexible interior whitespace. No AI call,
        no embeddings; embedding tie-break is D1 (Shared Lib), out of scope here. The
        populated statuses are recorded in the envelope's `indexed_status`, so a curated
        index is distinguishable from a preview by inspecting the file.

        Container sources — alias-first mention indexing over NON-NODE content text
        (source-evidence facts + summary content):
          - Source-Evidence-Index facts: container id `sei:<sei_key>`, text = the entry's
            `facts[].claim` values joined by newline in file order.
          - Summary key points (t/3122, claims-entity-fol-recommendations.md §4/R2.2 T2):
            container id `summary:<doc_id>#<pov>-kp-<n>` where <pov> ∈ acc/saf/skp, text = the
            key point's `point` field. `<n>` is a 0-based index reset PER POV array
            (`pov_summaries.<pov>.key_points`). POV-scoping (CL ruling p/23#220-221) confines
            renumber-churn to a single POV array instead of cascading a running counter across
            all three; key_points carry no stable per-claim id (taxonomy_node_id is a non-unique
            node reference), so positional is the pragmatic key and inserts within a POV still
            churn that array's tail (the reconciler must tolerate it).
          - Summary factual claims (t/3122, same doc §4/R2.2 T2): container id
            `summary:<doc_id>#fc-<n>`, text = the `factual_claims[n].claim` field, `<n>` the
            0-based index into that array.
        Live statement-side (debate/chat, `<debate_id>#<entry_id>`) is Phase 2b — NOT here.

        DISJOINT-SCOPE BOUNDARY (t/3160 G7, TL-approved contract t/3160#2-#3): this cmdlet
        owns ONLY {sei:*, summary:*} — alias-first mention indexing over source-evidence and
        summary content text. `node:*` mentions are NODE-GROUNDING (resolved from node text
        alongside concept_refs / entity_refs / used_by_nodes) and are owned by CL's hash-gated
        Python reconciler (research/comp-linguist/scripts/reconcile_grounding.py), not here.
        This cmdlet NEVER emits a `node:*` key; the two tools write disjoint container sets
        (asserted in the test suite). node:* was moved out here after the reconciler shipped
        (#1712) and covered pov+sit nodes — the sequenced no-orphan handoff.

        Per-container `text_sha256` (lowercase hex over the exact text's UTF-8 bytes) is the
        idempotency + supersession guard: re-running on unchanged input is a byte-stable
        no-op (extracted_at and the file are only rewritten when a container actually
        changes). Overlapping alias hits are settled by the longest-most-specific rule
        (§2), ties broken deterministically (length desc, offset asc, entity_ref asc).

        Human-authored mentions win (§5): on rebuild, existing `discovered_by:'human'`
        mentions on a container whose text is UNCHANGED (matching text_sha256) are preserved
        and take precedence over overlapping alias hits. If the container text changed, prior
        mentions were computed against text that no longer exists and are dropped
        (supersession). Containers with no resulting mentions are omitted (absence == "no
        links yet").
    .PARAMETER EntitiesPath
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER SourceEvidenceIndexPath
        Override source_evidence_index.json path. Defaults to
        Join-Path (Get-TaxonomyDir) 'source_evidence_index.json'. Absent file = skipped.
    .PARAMETER SummariesPath
        Override the summary JSON files to scan for `summary:<doc_id>#kp-<n>` /
        `#fc-<n>` containers (t/3122). Defaults to every `*.json` file directly under
        Get-SummariesDir. Pass @() to skip summary containers entirely. Absent files/dir
        are skipped (non-fatal).
    .PARAMETER OutputPath
        Override entity_mentions.json output path. Defaults to Get-EntityMentionsFilePath.
    .PARAMETER Status
        Which entity statuses to index. Default @('approved') — the design-of-record §5
        population and the D1 caller-filters-to-approved contract. Pass e.g.
        -Status approved,proposed to build an explicit PREVIEW over un-curated candidates
        (useful before any entity has been approved, so the Phase-2 render is not empty).
        The populated set is recorded in the output envelope's `indexed_status`.
    .PARAMETER Force
        Rewrite the file even when the containers are unchanged (bumps last_modified).
        Without -Force an unchanged rebuild is a no-op that does not touch the file.
    .EXAMPLE
        Update-EntityMentionIndex
    .EXAMPLE
        Update-EntityMentionIndex -SummariesPath @()   # sei:*-only re-index (skip summary containers)
    .LINK
        Invoke-EntityExtraction
    .LINK
        Get-EntityReport
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$EntitiesPath,

        [Parameter()]
        [string]$SourceEvidenceIndexPath,

        [Parameter()]
        [string[]]$SummariesPath,

        [Parameter()]
        [Alias('Path')]
        [string]$OutputPath,

        [Parameter()]
        [ValidateSet('proposed', 'approved', 'deprecated')]
        [string[]]$Status = @('approved'),

        [Parameter()]
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $EntPath = if ($EntitiesPath) { $EntitiesPath } else { Get-EntitiesFilePath }
    $SeiPath = if ($SourceEvidenceIndexPath) { $SourceEvidenceIndexPath } else { Join-Path (Get-TaxonomyDir) 'source_evidence_index.json' }
    $OutPath = if ($OutputPath) { $OutputPath } else { Get-EntityMentionsFilePath }
    $SummarySet   = Get-EmiSummaryFiles -Bound $PSBoundParameters.ContainsKey('SummariesPath') -SummariesPath $SummariesPath
    $SummaryFiles = $SummarySet.Files

    # --- Alias table over in-scope entities (default: status 'approved'): normalized surface -> raw ent-* ref ------------
    $Store = Get-EntitiesStore -Path $EntPath -InitIfMissing
    $Entities = if ($Store.PSObject.Properties['entities']) { @($Store.entities) } else { @() }
    $AliasEntries = [System.Collections.Generic.List[object]]::new()
    Add-EmiAliasEntries -Entities $Entities -Status $Status -AliasEntries $AliasEntries

    # --- Collect source containers + per-container alias scan (READ-ONLY) — OUTSIDE the lock (t/3163) ------------------
    # Both read only source-of-record files (SEI facts + summary key-points/claims) and the alias table, so they are
    # independent of the shared entity_mentions.json. The scan measured ~288-296s over the real corpus; holding the
    # lock across it was unsafe (>2x the 120s mtime stale-break, so a peer could break the "stale" lock mid-scan and
    # both would write -> lost update). node:* is NOT built here: it belongs to CL's reconciler (t/3160 G7).
    $Containers = [ordered]@{}   # insertion order irrelevant; sorted before scan and write
    Add-EmiSeiContainers -SeiPath $SeiPath -Containers $Containers
    Add-EmiSummaryContainers -SummaryFiles $SummaryFiles -Containers $Containers
    Add-EmiUnionContainers -Copies @($SummarySet.Copies) -Containers $Containers   # t/4337 spec 7.4: summary:<canonical>#via-<copy>-…
    $ScanByCid = Get-EmiContainerScan -Containers $Containers -AliasEntries $AliasEntries

    # --- Grounding write-lock (t/3203 / t/3163) -------------------------------------------
    # entity_mentions.json is a SHARED read-merge-write with CL's reconcile_grounding.py (which owns node:*). ONLY the
    # existing-index read + merge + write below is serialized under the advisory lockfile + mtime-staleness rule (TL
    # contract t/3163#1 / t/3194): that read is the lost-update surface and MUST stay under the lock.
    $LockPath = Join-Path (Split-Path -Parent $OutPath) 'entity_mentions.lock'
    # Protocol v2 (t/4193): the returned lock object heartbeats while held; Assert-GroundingLockHeld runs right
    # before the final write so a holder whose lock was broken or replaced refuses to write.
    $LockHandle = Enter-GroundingLock -LockPath $LockPath -Holder 'Update-EntityMentionIndex'
    # Lock-hold telemetry (t/3163): the released hold time must stay well under the 120s stale-break.
    $LockHeld = [System.Diagnostics.Stopwatch]::StartNew()
    try {

    # THE LOST-UPDATE SURFACE: this read of the shared file stays INSIDE the lock (t/3163 GV condition 1).
    $Existing = Read-EmiExistingIndex -OutPath $OutPath
    $ExistingById = $Existing.ById

    # Merge the outside-lock scan against the FRESH in-lock read (GV guardrail 1), then guard scope and preserve
    # every container this cmdlet does not own VERBATIM (t/3160 G7 no-orphan: never clobber reconciler node:*).
    $Built = Build-EmiOwnContainers -ScanByCid $ScanByCid -ExistingById $ExistingById
    $NewContainers = $Built.Containers
    $TotalMentions = $Built.TotalMentions
    Assert-EmiOwnedScope -NewContainers $NewContainers
    $Merged = Merge-EmiContainers -ExistingById $ExistingById -NewContainers $NewContainers
    $FinalContainers = $Merged.Containers
    $PreservedForeign = $Merged.PreservedForeign

    $unchanged = Test-EmiIndexUnchanged -FinalContainers $FinalContainers -ExistingById $ExistingById -AnyContentChanged $Built.AnyContentChanged
    $lastModified = if ($unchanged -and $Existing.LastModified) { $Existing.LastModified } else { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

    $result = [PSCustomObject]@{
        OutputPath            = $OutPath
        ContainerCount        = @($NewContainers.Keys).Count   # containers THIS cmdlet built (sei:*/summary:*)
        PreservedForeignCount = $PreservedForeign              # node:* etc. carried forward untouched (t/3160 G7)
        MentionCount          = $TotalMentions
        AliasCount            = @($AliasEntries).Count
        IndexedStatus         = @($Status | Sort-Object -Unique)
        Unchanged             = $unchanged
        Written               = $false
    }

    if ($unchanged -and -not $Force) {
        Write-Verbose "entity_mentions.json unchanged ($($result.ContainerCount) own + $PreservedForeign preserved containers); no write."
        return $result
    }

    $file = [ordered]@{
        _schema_version = '1.0.0'
        _doc            = 'Derived artifact — rebuildable via Update-EntityMentionIndex (re-index, epic t/1890 design §7). This tool owns {sei:*, summary:*}; node:* is owned by the CL grounding reconciler (t/3160 G7) and is preserved verbatim on rebuild. Absence of a container means "no links yet", never an error.'
        indexed_status  = @($Status | Sort-Object -Unique)
        last_modified   = $lastModified
        containers      = $FinalContainers
    }

    if ($PSCmdlet.ShouldProcess($OutPath, "Write entity_mentions.json ($($result.ContainerCount) own + $PreservedForeign preserved containers, $TotalMentions mentions)")) {
        $json = ConvertTo-Json $file -Depth 8
        Assert-DataWriteAllowed -Path $OutPath  # t/2902
        Assert-GroundingLockHeld -Lock $LockHandle  # t/4193 TL condition 2: no write once the lock is lost
        $tmp = "$OutPath.tmp"
        try {
            Set-Content -LiteralPath $tmp -Value $json -Encoding utf8NoBOM
            [System.IO.File]::Move($tmp, $OutPath, $true)
        }
        catch {
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            throw (New-ActionableError -PassThru `
                    -Goal 'Write the entity mention index' `
                    -Problem "Failed to write ${OutPath}: $($_.Exception.Message)" `
                    -Location 'Update-EntityMentionIndex' `
                    -NextSteps @('Verify the data-repo path is writable', 'Check disk space and that the taxonomy directory exists') `
                    -InnerError $_)
        }
        $result.Written = $true
    }

    return $result

    }
    finally {
        # t/3203: always release the grounding lock (even on an early return or a write error).
        # t/3163: stop the hold timer BEFORE releasing so the emitted number is the true hold time.
        $LockHeld.Stop()
        Exit-GroundingLock -Lock $LockHandle
        Write-Verbose ("Grounding lock held {0:N1}s (t/3163: read-only source scan runs outside the lock; must stay < the 120s stale-break)." -f $LockHeld.Elapsed.TotalSeconds)
    }
}
