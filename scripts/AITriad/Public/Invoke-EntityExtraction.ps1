# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-EntityExtraction {
    <#
    .SYNOPSIS
        Phase 1 entity ontology (t/1806) — extracts person/artifact/event/legislation/
        institution entity proposals from source_evidence_index.json facts, resolves
        each against existing records BEFORE minting, and mints only the unmatched
        remainder via Import-Entity.
    .DESCRIPTION
        Mirrors Invoke-OrgStanceExtraction's structure (t/1553 Stage 1): per-node AI
        calls (parallel, sequential merge), an idempotence sidecar, fence-stripped
        JSON parsing, and a post-parse validator that drops malformed items into a
        counted bucket rather than failing the run.

        Corpus: source_evidence_index.json (a dict keyed by node id; each entry has
        `facts[]` with `claim` text). Per node, calls the `enrichment.entity-extraction`
        UsageID with template vars {{node_id}} and {{facts}} (the node's claim texts).
        The UsageID does not exist in ai-usages.json yet (t/1819 is its go-live
        dependency) — a preflight guard fails actionably rather than letting
        Get-UsageConfig's generic "not found" error surface.

        Response shape: `proposals[]{name, entity_type, aliases[], quote, confidence}`
        plus `org_mentions[]{name}` (captured for traceability only — Phase 1 mints
        no organization records and creates no links from org_mentions).

        entity_type -> dolce_category (frozen mapping, lib/entities/types.ts):
          person -> agentive-physical-object
          artifact -> non-agentive-functional-artifact
          event -> perdurant
          legislation -> normative-description
          institution -> non-agentive-social-object

        CONFIDENCE GATE (stipulated, design t/1806): proposals below -ConfidenceThreshold
        (default 0.6) are dropped and counted, never minted. Proposals in
        [-ConfidenceThreshold, -ConfidenceThreshold + -NearGateBand) are minted but
        flagged `near_gate` in the run report — a human reviewer prompt, not a rejection.

        PERSON EXCEPTION: person proposals are minted with NO `description` — Import-Entity
        already blocks *approving* a person without a human-authored description, but this
        cmdlet never even offers one, for any entity_type (Phase 1's schema carries no
        genus-differentia description field; `quote` is evidence, not a description, and is
        never repurposed as one).

        RESOLUTION BEFORE MINTING (per proposal, name/aliases normalized to
        lowercase+trim+collapse-whitespace):
          1. Exact/alias match against existing entities (name+aliases), organizations
             (name+short_name), taxonomy node labels (acc/saf/skp/situations), the
             dictionary (colloquial_term + standardized canonical_form), and policy
             actions (action text).
          2. EXISTING-ENTITY CANDIDATES (ADVISORY, t/4075): cosine of the proposal's
             name vector against existing entity name vectors (entity_embeddings.json, v1
             flat or v2 name_vector). This stage NEVER links (TL ruling p/360#571): distinct
             siblings score above any threshold (Claude 3.5 vs 3.7 Sonnet 0.987, GPT-4 vs
             GPT-5 0.879). The proposal mints normally, and up to 3 non-sibling candidates
             at or above -LinkSimilarityThreshold, plus every version sibling (flagged), are
             written to the sidecar's existing_entity_candidates[] with the run's
             embedding_model. version_sibling=false means only that no version difference
             was detected (tier/variant siblings such as Sonnet vs Opus are not detected),
             NOT that the pair is safe to merge. Review with Get-EntityExtractionCandidates;
             record a confirmed match with Import-Entity merged_into. A WARN is written
             when the stage is skipped or finds nothing.
          3. Within-run EXACT dedup: the proposal's normalized name OR any alias matches
             an already-minted within-run candidate's name OR alias (t/1880 bullet 1 —
             the pre-existing MatchIndex never sees freshly-minted siblings).
          4. Within-run NEAR-VARIANT surfacing (ADVISORY, t/1881): cosine >=
             -WithinRunSimilarityThreshold of the proposal's probe vector against
             already-minted within-run candidates. This stage does NOT link — name-only
             cosine false-merges sibling entities (GPT-4/GPT-4o 0.90, Gemini 3.5/3.6 Flash
             0.97) that score ABOVE true dups, so auto-linking would destroy a distinct
             entity. On a hit the proposal MINTS normally and the pair is written to the
             sidecar's possible_duplicates[] for a curator to review — a false positive
             costs a human glance, not an entity. WITHIN-RUN ONLY (fires with zero approved
             entities); cross-run near-variant surfacing is Phase 2.
          Steps 1 and 3 record a `linked` disposition and mint nothing (links are Phase 2);
          an unmatched proposal is queued for minting and every later within-run EXACT
          occurrence is `linked` to the id just minted. Steps 2 and 4 never link — they only
          surface. Probe vectors are batch-encoded once per node (not per proposal).
          Minting happens in sub-batches of <= 20 (Import-Entity's ValidateCount ceiling).

        IDEMPOTENCE: an entity_extraction_log.json sidecar (mirrors organization_stance_
        claims.json's role for Invoke-OrgStanceExtraction) records every successfully
        processed node id; re-runs skip them unless -Force. A node whose AI call/parse
        FAILS is never marked processed, so it is retried on the next run.
    .PARAMETER NodeId
        Restrict extraction to specific node id(s). Default: every node present in
        source_evidence_index.json with at least one fact.
    .PARAMETER MaxNodes
        Safety cap on nodes processed per run. Default: no cap.
    .PARAMETER Concurrency
        Parallel AI calls. Default 3 (same conservative default as Invoke-OrgStanceExtraction).
    .PARAMETER Model
        AI model id used for every extraction call, OVERRIDING the model the
        enrichment.entity-extraction UsageID resolves from ai-usages.json. Default:
        unset — the usage's configured model wins (currently claude-sonnet-4-6, whose
        Claude-shaped structured-output schema a gemini-flash model rejects with HTTP
        400, t/3123). Pass -Model only to deliberately override. Tab-completes against
        registered ids; validated by Test-AIModelId.
    .PARAMETER Force
        Re-extract for node ids that already have a log entry.
    .PARAMETER ConfidenceThreshold
        Minimum extraction_confidence to mint. Default 0.6 (stipulated, t/1806).
    .PARAMETER NearGateBand
        Width of the near-gate review window above -ConfidenceThreshold. Default 0.1
        (so [0.6, 0.7) is flagged `near_gate` when using the defaults).
    .PARAMETER LinkSimilarityThreshold
        Minimum cosine similarity against an existing entity name vector for that entity
        to be listed as an ADVISORY candidate in existing_entity_candidates[]. Default 0.60.
        It never links (t/4075); the name is kept for interface stability.
    .PARAMETER WithinRunSimilarityThreshold
        Minimum cosine similarity between a proposal and an already-minted WITHIN-RUN
        candidate (both freshly proposed this run) at which the pair is SURFACED as a
        possible duplicate in the sidecar — advisory only, never an auto-link (t/1881).
        A DISTINCT knob from -LinkSimilarityThreshold. Because a hit only surfaces a pair
        for curation (a false positive costs a human glance, not an entity), this is a
        surfacing threshold and the default (0.60) needs no calibration sign-off.
    .PARAMETER EntitiesPath
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER EmbeddingsPath
        Override entity_embeddings.json path (fixtures/tests). Defaults to
        Get-EntityEmbeddingsFilePath.
    .PARAMETER SourceEvidenceIndexPath
        Override source_evidence_index.json path (fixtures/tests).
    .PARAMETER OutputPath
        Override the entity_extraction_log.json sidecar path (data-repo taxonomy/Origin
        by default).
    .EXAMPLE
        Invoke-EntityExtraction -MaxNodes 5
    .EXAMPLE
        Invoke-EntityExtraction -NodeId acc-desires-001 -Force
    .LINK
        Show-AITriadHelp
    .LINK
        Import-Entity
    .LINK
        Get-Entity
    .LINK
        Get-EntityReport
    .LINK
        Invoke-OrgStanceExtraction
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()]
        [string[]]$NodeId,

        [Parameter()]
        [ValidateRange(1, 5000)]
        [int]$MaxNodes,

        [Parameter()]
        [ValidateRange(1, 20)]
        [int]$Concurrency = 3,

        [Parameter()]
        [ValidateScript({ [string]::IsNullOrEmpty($_) -or (Test-AIModelId $_) })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = '',

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$ConfidenceThreshold = 0.6,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$NearGateBand = 0.1,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$LinkSimilarityThreshold = 0.60,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$WithinRunSimilarityThreshold = 0.60,

        [Parameter()]
        [string]$EntitiesPath,

        [Parameter()]
        [string]$EmbeddingsPath,

        [Parameter()]
        [string]$SourceEvidenceIndexPath,

        [Parameter()]
        [Alias('Path')]
        [string]$OutputPath
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $UsageId = 'enrichment.entity-extraction'
    Assert-EntityExtractionUsage -UsageId $UsageId

    # ── Resolve paths ─────────────────────────────────────────────────────────────
    $TaxDir = Get-TaxonomyDir
    $SeiPath = Resolve-EntityExtractionSeiPath -TaxDir $TaxDir -Override $SourceEvidenceIndexPath
    $EntPath = if ($EntitiesPath) { $EntitiesPath } else { Get-EntitiesFilePath }
    $EmbPath = if ($EmbeddingsPath) { $EmbeddingsPath } else { Get-EntityEmbeddingsFilePath }
    if (-not $OutputPath) { $OutputPath = Join-Path $TaxDir 'entity_extraction_log.json' }

    $DolceMap = @{
        person       = 'agentive-physical-object'
        artifact     = 'non-agentive-functional-artifact'
        event        = 'perdurant'
        legislation  = 'normative-description'
        institution  = 'non-agentive-social-object'
    }

    # Exact/alias match index, existing entity vectors, and the within-run accumulators.
    $State = Get-EntityResolutionState -TaxDir $TaxDir -EntPath $EntPath -EmbPath $EmbPath

    $Sei = Get-Content -Raw -Path $SeiPath | ConvertFrom-Json -AsHashtable
    $Log = Read-EntityExtractionLog -Path $OutputPath
    $Work = Get-EntityExtractionWorkList -Sei $Sei -NodeId $NodeId -Force $Force.IsPresent -ProcessedNodeIds $Log.ProcessedNodeIds -MaxNodes $MaxNodes `
        -Resolution (Get-DefaultSourceResolution -Caller 'Invoke-EntityExtraction')
    $WorkItems = $Work.Items

    $Total = @($WorkItems).Count
    Write-Verbose "Work items: $Total (skipped no-facts: $($Work.SkippedNoFacts), already-done: $($Work.SkippedAlreadyDone))"

    if ($Total -eq 0) {
        Write-Host 'Nothing to extract — no nodes with facts match the filter, or all are already done.'
        return [PSCustomObject]@{
            NodesProcessed     = 0
            ProposalsTotal     = 0
            Minted             = 0
            Linked             = 0
            DroppedBelowGate   = 0
            NearGateMinted     = 0
            InvalidDropped     = 0
            Failed             = 0
            SkippedNoFacts     = $Work.SkippedNoFacts
            SkippedAlreadyDone = $Work.SkippedAlreadyDone
            MintedEntities     = @()
            LinkedDispositions = @()
            OutputPath         = $OutputPath
        }
    }

    if (-not $PSCmdlet.ShouldProcess("$Total node(s)", "Extract entity proposals via $UsageId")) {
        return [PSCustomObject]@{
            WouldProcess = $Total
            OutputPath   = $OutputPath
        }
    }

    # ── Extract (parallel or sequential) — AI call + shape validation ONLY. ─────────
    $Extracted = Invoke-EntityProposalExtraction -WorkItems $WorkItems -UsageId $UsageId -Model $Model -Concurrency $Concurrency
    $Failed = $Extracted.Failed
    $Invalid = $Extracted.Invalid

    # ── Sequential resolution + minting ──────────────────────────────────────────────
    $SortedResults = @($Extracted.RawResults | Sort-Object -Property NodeId)
    foreach ($Node in $SortedResults) {
        $ProbeVecByNorm = Get-NodeProbeVectorMap -Node $Node -ConfidenceThreshold $ConfidenceThreshold
        foreach ($p in @($Node.Proposals)) {
            Resolve-EntityProposal -State $State -Node $Node -Proposal $p -ProbeVecByNorm $ProbeVecByNorm -DolceMap $DolceMap `
                -ConfidenceThreshold $ConfidenceThreshold -NearGateBand $NearGateBand `
                -LinkSimilarityThreshold $LinkSimilarityThreshold -WithinRunSimilarityThreshold $WithinRunSimilarityThreshold
        }
    }

    Invoke-EntityCandidateMint -MintCandidates $State.MintCandidates -UsageId $UsageId -EntPath $EntPath -EmbPath $EmbPath
    Add-WithinRunOccurrenceLink -State $State

    $MintedEntities = @($State.MintCandidates | ForEach-Object {
        [PSCustomObject]@{
            node_id        = $_.NodeId
            id             = $_.MintedId
            name           = $_.Name
            entity_type    = $_.EntityType
            dolce_category = $_.Dolce
            confidence     = $_.Confidence
            near_gate      = $_.NearGate
        }
    })
    $PossibleDuplicateRows = Get-EntityPossibleDuplicateRowSet -State $State
    $ExistingCandidateRows = Get-EntityExistingCandidateRowSet -State $State
    Write-ExistingCandidateStageStatus -State $State -CandidateRowCount @($ExistingCandidateRows).Count -Floor $LinkSimilarityThreshold

    # ── Persist the idempotence sidecar (only nodes whose AI call/parse succeeded are
    # marked processed — a failure is retried next run). ─────────────────────────────
    $NewlyProcessed = Get-EntityExtractionLogNodeSet -SortedResults $SortedResults -State $State `
        -PossibleDuplicateRows $PossibleDuplicateRows -ExistingCandidateRows $ExistingCandidateRows
    Write-EntityExtractionLog -Path $OutputPath -ExistingLogNodes $Log.ExistingLogNodes -NewlyProcessed $NewlyProcessed -Force $Force.IsPresent

    $FailCount = @($Failed).Count
    $InvalidCount = @($Invalid).Count
    $MintedCount = @($State.MintCandidates).Count
    $LinkedCount = @($State.LinkedDispositions).Count
    $PossibleDupCount = @($PossibleDuplicateRows).Count
    $CandidateCount = @($ExistingCandidateRows).Count

    Write-Host ""
    Write-Host "Done. Nodes processed: $Total | Proposals: $($State.ProposalsTotal) | Minted: $MintedCount | Linked: $LinkedCount | Possible dups (advisory): $PossibleDupCount | Existing-entity candidates (advisory): $CandidateCount | Dropped (below gate): $($State.DroppedBelowGate) | Near-gate minted: $($State.NearGateMinted) | Invalid: $InvalidCount | Failed: $FailCount"

    [PSCustomObject]@{
        NodesProcessed     = $Total
        ProposalsTotal     = $State.ProposalsTotal
        Minted             = $MintedCount
        Linked             = $LinkedCount
        DroppedBelowGate   = $State.DroppedBelowGate
        DroppedItems       = @($State.DroppedProposals)
        NearGateMinted     = $State.NearGateMinted
        InvalidDropped     = $InvalidCount
        InvalidItems       = @($Invalid)
        Failed             = $FailCount
        FailedItems        = @($Failed)
        SkippedNoFacts     = $Work.SkippedNoFacts
        SkippedAlreadyDone = $Work.SkippedAlreadyDone
        MintedEntities     = $MintedEntities
        LinkedDispositions = @($State.LinkedDispositions)
        PossibleDuplicates = @($PossibleDuplicateRows)
        ExistingEntityCandidates = @($ExistingCandidateRows)
        OutputPath         = $OutputPath
    }
}
