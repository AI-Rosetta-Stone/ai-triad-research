# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-EdgeDiscovery {
    <#
    .SYNOPSIS
        Uses AI to discover typed edges between taxonomy nodes (Phase 2 of LAG proposal).
    .DESCRIPTION
        For each taxonomy node, sends the node plus a filtered candidate list to an LLM,
        which proposes typed, directed edges with confidence scores and rationale.

        Edges are stored in taxonomy/Origin/edges.json. Proposed edges require human
        approval before becoming active.

        Nodes that have been edited since their last edge discovery are marked STALE
        and can be selectively re-processed with -StaleOnly.

        SCALING FEATURES
        ----------------
        - Embedding pre-filter (-TopKCandidates): uses embeddings.json to send only the
          top-K most semantically similar candidates per node instead of the full list,
          reducing prompt size from O(N) to O(K) per call. Disabled with -SkipEmbeddingFilter.
        - Cross-POV floor (-MinPerOtherPov): guarantees a minimum number of candidates
          from each non-source POV to preserve cross-cutting relationship discovery.
        - Parallel workers (-MaxConcurrent): runs multiple API calls concurrently using
          ForEach-Object -Parallel. Default 1 (sequential).
        - Checkpointing (-CheckpointEvery): writes edges.json every N nodes in sequential
          mode so progress is not lost on crash or interruption.
    .PARAMETER POV
        Process only nodes from this POV. If omitted, processes all POVs and cross-cutting.
        Valid values: accelerationist, safetyist, skeptic, cross-cutting.
    .PARAMETER NodeId
        Process only this specific node ID. Useful for targeted re-discovery.
    .PARAMETER StaleOnly
        Only process nodes marked as STALE (edited since last edge discovery).
    .PARAMETER Model
        AI model to use. Defaults to 'gemini-3.5-flash-lite'.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.3.
    .PARAMETER DryRun
        Build and display the prompt for the first node, but do NOT call the API.
    .PARAMETER Force
        Re-discover edges for all nodes, even those that already have edges and are not STALE.
    .PARAMETER MaxConcurrent
        Number of parallel API workers. Default: 4. Values > 1 enable
        ForEach-Object -Parallel. Checkpointing is only active in sequential mode.
        Recommended settings by backend:
          Gemini free tier: 3 (avoids 429 rate limits)
          Gemini paid:      8
          Claude:           4
          Groq:             6 (generous free tier)
        Rate-limited (429) calls are automatically retried with exponential backoff.
    .PARAMETER TopKCandidates
        Maximum number of embedding-filtered candidates per source node. Default: 30.
        Has no effect when -SkipEmbeddingFilter is set or embeddings.json is absent.
    .PARAMETER TwoPhase
        Enables two-phase discovery: Phase 1 uses a fast/cheap model to screen which
        candidates have ANY relationship with the source. Phase 2 runs full classification
        only on screened-in candidates. Reduces total tokens by ~50-60% when most candidates
        have no relationship.
    .PARAMETER ScreenModel
        Model for Phase 1 screening when -TwoPhase is set. Should be a fast/cheap model.
        Default: 'gemini-2.0-flash-lite' (falls back to main -Model if not set).
    .PARAMETER BatchSize
        When > 0, enables batch mode: groups nodes into clusters of this size and asks
        the LLM to propose edges between ANY pair in the group. Reduces total API calls
        from N to N/BatchSize. Default: 0 (disabled, uses per-node mode).
        Recommended: 8-12. Nodes are clustered by embedding similarity to maximize edge
        discovery within each batch.
    .PARAMETER MinSimilarity
        Minimum embedding cosine similarity for candidate inclusion. Candidates below
        this threshold are excluded from top-K selection (cross-POV floor still applies).
        Default: 0.20. Analysis shows only 0.5% of real edges fall below 0.20 similarity.
        Set to 0.0 to disable.
    .PARAMETER MinPerOtherPov
        Minimum candidates from each non-source POV, added after top-K ranking to
        ensure cross-cutting edge discovery. Default: 4.
    .PARAMETER SkipEmbeddingFilter
        Disable embedding-based pre-filtering and send all candidates per node.
        Use when embeddings.json is stale or to replicate original behavior.
    .PARAMETER CheckpointEvery
        Write edges.json after every N nodes in sequential mode. Default: 10. Set to 0
        to disable checkpointing (write only at the end).
    .PARAMETER RepoRoot
        Path to the repository root. Defaults to the module-resolved repo root.
    .EXAMPLE
        Invoke-EdgeDiscovery -DryRun
    .EXAMPLE
        Invoke-EdgeDiscovery -POV accelerationist
    .EXAMPLE
        Invoke-EdgeDiscovery -StaleOnly
    .EXAMPLE
        Invoke-EdgeDiscovery -NodeId "acc-desires-001" -Force
    .EXAMPLE
        Invoke-EdgeDiscovery -MaxConcurrent 6
    .EXAMPLE
        Invoke-EdgeDiscovery -TopKCandidates 25 -MinSimilarity 0.25 -MinPerOtherPov 6
    .EXAMPLE
        Invoke-EdgeDiscovery -EmbeddingFirst -DryRun
        # Preview embedding-first candidate pairs without LLM calls.
    .EXAMPLE
        Invoke-EdgeDiscovery -EmbeddingFirst -EmbeddingFirstThreshold 0.35
        # Embedding-first with tighter threshold (fewer candidates, less LLM cost).
    .LINK
        Show-AITriadHelp
    .LINK
        Approve-Edge
    .LINK
        Get-Edge
    .LINK
        Set-Edge
    .LINK
        Test-EdgeDirection
    .LINK
        Invoke-EdgeWeightEvaluation
    .LINK
        Invoke-AttributeExtraction
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations')]
        [string]$POV = '',

        [string]$NodeId = '',

        [switch]$StaleOnly,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey = '',

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.3,

        [switch]$DryRun,

        [switch]$Force,

        [ValidateRange(1, 32)]
        [int]$MaxConcurrent = 4,

        [ValidateRange(5, 500)]
        [int]$TopKCandidates = 30,

        [ValidateRange(0.0, 1.0)]
        [double]$MinSimilarity = 0.20,

        [ValidateRange(0, 20)]
        [int]$MinPerOtherPov = 4,

        [ValidateRange(0, 20)]
        [int]$BatchSize = 0,

        [switch]$TwoPhase,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$ScreenModel = '',

        [Parameter(HelpMessage = 'Embedding-first mode: compute similarity matrix, LLM classifies type only')]
        [switch]$EmbeddingFirst,

        [Parameter(HelpMessage = 'Similarity threshold for embedding-first candidate pairs')]
        [ValidateRange(0.10, 0.90)]
        [double]$EmbeddingFirstThreshold = 0.30,

        [Parameter(HelpMessage = 'Max pairs per LLM classification batch in embedding-first mode')]
        [ValidateRange(5, 50)]
        [int]$ClassifyBatchSize = 20,

        [switch]$SkipEmbeddingFilter,

        [ValidateRange(0, 100)]
        [int]$CheckpointEvery = 10,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # t/2674 — surface silent-blank rationales. When the LLM omits the
    # schema-required `rationale`, the edge is still written with rationale=''
    # (schema contract preserved). Count those so a run that quietly drops
    # rationales is visible in the summary, not invisible (silent-failure class
    # shared with t/2664/t/2669). Only one mode runs per call, so a single
    # function-scoped counter never double-counts across modes.
    $MissingRationaleCount = 0

    # Save-DiscoveryLog promoted to Private/Save-DiscoveryLog.ps1 (t/3837) so
    # the extracted mode helpers can call it without a scriptblock parameter.

    # ForEach-Object -Parallel is PS 7+ only. The AITriad module supports
    # Windows PowerShell 5.1 as a hard requirement (see AITriad.psd1), so on
    # 5.1 we clamp -MaxConcurrent to 1 and use the sequential code path.
    if ($MaxConcurrent -gt 1 -and $PSVersionTable.PSVersion.Major -lt 7) {
        Write-Warn "MaxConcurrent > 1 requires PowerShell 7+; falling back to sequential (MaxConcurrent = 1) on Windows PowerShell $($PSVersionTable.PSVersion)."
        $MaxConcurrent = 1
    }

    # ── Step 1: Validate environment ──
    Write-Step 'Validating environment'

    if (-not (Test-Path $RepoRoot)) {
        Write-Fail "Repo root not found: $RepoRoot"
        throw 'Repo root not found'
    }

    $TaxDir = Get-TaxonomyDir
    if (-not (Test-Path $TaxDir)) {
        Write-Fail "Taxonomy directory not found: $TaxDir"
        throw 'Taxonomy directory not found'
    }

    # Backend from ai-models.json, never guessed (t/4087). $ResolvedKey is the key FORWARDED to
    # Invoke-AIApi: only the user's own -ApiKey (or ''), never an env key resolved here, so
    # Invoke-AIApi resolves the key for the registry backend itself.
    $ResolvedKey = $ApiKey
    if (-not $DryRun) {
        $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
        if (-not $KeyStatus.HasKey) {
            Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
            throw 'No API key configured'
        }
    }

    # ── Step 2: Load all taxonomy nodes ──
    Write-Step 'Loading taxonomy'

    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    $AllNodes = [System.Collections.Generic.List[PSObject]]::new()
    $NodePovMap = @{}   # node ID → pov key
    $Labels = @{}       # node ID → label
    $Descriptions = @{} # node ID → truncated description

    foreach ($PovKey in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }

        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        # Candidates and the valid-id set are selectable nodes only; the POV file is never written here (t/4356).
        Set-TaxonomyDocumentSelectable -Document $FileData -Name $PovKey
        foreach ($Node in $FileData.nodes) {
            $AllNodes.Add($Node)
            $NodePovMap[$Node.id] = $PovKey
            $Labels[$Node.id] = $Node.label
            if ($Node.PSObject.Properties['description'] -and $Node.description) {
                $Desc = $Node.description
                if ($Desc.Length -gt 120) { $Desc = $Desc.Substring(0, 120) + '...' }
                $Descriptions[$Node.id] = $Desc
            }
        }
    }

    Write-OK "Loaded $($AllNodes.Count) nodes across $($PovFiles.Count) POVs"

    # ── Step 3: Load existing edges ──
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    if (Test-Path $EdgesPath) {
        # t/2974: coercion-free read so existing edges' discovered_at is not coerced to [datetime]
        # and truncated (.440Z -> .44Z) when this run re-writes the whole file.
        $EdgesData = Read-EdgesFile -Path $EdgesPath
    } else {
        $EdgesData = [PSCustomObject]@{
            _schema_version = '1.0.0'
            _doc            = 'Edge discovery results. Each entry represents a proposed or approved edge between taxonomy nodes.'
            last_modified   = (Get-Date).ToString('yyyy-MM-dd')
            # t/1093: canonical 8-type vocabulary. Removed CITES, SUPPORTED_BY,
            # PROPOSES (deprecated). Added CONVERGES_WITH. Resolve-EdgeType
            # enforces this set at the validation sites below.
            edge_types      = @(
                [PSCustomObject]@{ type = 'SUPPORTS';       bidirectional = $false; definition = 'Source claim directly strengthens or provides evidence for target.' }
                [PSCustomObject]@{ type = 'CONTRADICTS';    bidirectional = $true;  definition = 'Source and target make incompatible claims.' }
                [PSCustomObject]@{ type = 'WEAKENS';        bidirectional = $false; definition = 'Source undermines target without fully contradicting it.' }
                [PSCustomObject]@{ type = 'TENSION_WITH';   bidirectional = $true;  definition = 'Source and target pull in different directions without direct contradiction.' }
                [PSCustomObject]@{ type = 'RESPONDS_TO';    bidirectional = $false; definition = 'Source was formulated as a direct response to target.' }
                [PSCustomObject]@{ type = 'ASSUMES';        bidirectional = $false; definition = 'Source claim depends on target being true.' }
                [PSCustomObject]@{ type = 'INTERPRETS';     bidirectional = $false; definition = 'POV node offers an interpretation of a situation node (target must be situation).' }
                [PSCustomObject]@{ type = 'CONVERGES_WITH'; bidirectional = $false; definition = 'POV node has reached consensus with a situation node (target must be situation).' }
            )
            edges           = @()
        }
    }

    # Build canonical edge type set for validation (gap 7.2)
    $ValidEdgeTypes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($ET in @($EdgesData.edge_types)) {
        [void]$ValidEdgeTypes.Add($ET.type)
    }

    # Build full node ID set for validation (gap 7.1)
    $ValidNodeIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($Node in $AllNodes) { [void]$ValidNodeIds.Add($Node.id) }

    # Use a List for O(1) appends instead of O(N²) array concatenation
    $EdgesList = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($Edge in @($EdgesData.edges)) {
        $EdgesList.Add($Edge)
    }

    # Build a set of existing edge keys for dedup: "source|type|target"
    $ExistingEdgeKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($Edge in $EdgesList) {
        [void]$ExistingEdgeKeys.Add("$($Edge.source)|$($Edge.type)|$($Edge.target)")
    }

    # ── Step 4: Determine which nodes to process ──
    $NodesToProcess = [System.Collections.Generic.List[PSObject]]::new()

    # ── Load discovery log from standalone file ──
    $DiscLogPath = Join-Path $TaxDir 'edge_discovery_log.json'
    $DiscLogEntries = [System.Collections.Generic.List[PSObject]]::new()
    if (Test-Path $DiscLogPath) {
        $DiscLogData = Get-Content -Raw -Path $DiscLogPath | ConvertFrom-Json
        if ($DiscLogData.PSObject.Properties['entries'] -and $DiscLogData.entries) {
            foreach ($E in @($DiscLogData.entries)) {
                if ($null -ne $E) { $DiscLogEntries.Add($E) }
            }
        }
    } elseif ($EdgesData.PSObject.Properties['discovery_log'] -and $EdgesData.discovery_log) {
        foreach ($E in @($EdgesData.discovery_log)) {
            if ($null -ne $E) { $DiscLogEntries.Add($E) }
        }
    }

    $DiscoveredNodeIds = [System.Collections.Generic.HashSet[string]]::new()
    $EvaluatedPairs = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($Entry in $DiscLogEntries) {
        [void]$DiscoveredNodeIds.Add($Entry.node_id)
        if ($Entry.PSObject.Properties['candidates_evaluated']) {
            foreach ($CandId in $Entry.candidates_evaluated) {
                $PairKey = if ($Entry.node_id -lt $CandId) { "$($Entry.node_id)|$CandId" } else { "$CandId|$($Entry.node_id)" }
                [void]$EvaluatedPairs.Add($PairKey)
            }
        }
    }
    if ($EvaluatedPairs.Count -gt 0) {
        Write-OK "Loaded $($EvaluatedPairs.Count) previously evaluated pairs (will skip in incremental mode)"
    }

    foreach ($Node in $AllNodes) {
        if ($POV    -and $NodePovMap[$Node.id] -ne $POV)    { continue }
        if ($NodeId -and $Node.id -ne $NodeId)              { continue }

        $NeedsProcessing = $false
        if     ($Force)                                                                               { $NeedsProcessing = $true }
        elseif ($StaleOnly -and $Node.PSObject.Properties['edge_status'] -and $Node.edge_status -eq 'STALE') { $NeedsProcessing = $true }
        elseif (-not $Force -and -not $StaleOnly -and -not $DiscoveredNodeIds.Contains($Node.id))    { $NeedsProcessing = $true }

        if ($NeedsProcessing) { $NodesToProcess.Add($Node) }
    }

    if ($NodesToProcess.Count -eq 0) {
        Write-OK 'No nodes need edge discovery (use -Force to re-discover all)'
        return
    }

    Write-Info "$($NodesToProcess.Count) nodes to process"

    # ── Step 5: Load embeddings (best-effort) ──
    $Embeddings = @{}   # node ID → [double[]]

    if (-not $SkipEmbeddingFilter) {
        $EmbeddingsPath = Join-Path $TaxDir 'embeddings.json'
        if (Test-Path $EmbeddingsPath) {
            try {
                $EmbJson = Get-Content -Raw -Path $EmbeddingsPath | ConvertFrom-Json
                foreach ($Prop in $EmbJson.nodes.PSObject.Properties) {
                    $Embeddings[$Prop.Name] = [double[]]@($Prop.Value.vector)
                }
                Write-OK "Loaded embeddings for $($Embeddings.Count) nodes (TopK=$TopKCandidates, MinSim=$MinSimilarity, MinPerPov=$MinPerOtherPov)"
            } catch {
                Write-Warn "Failed to parse embeddings from '$EmbeddingsPath': $($_.Exception.Message)"
                Write-Info 'Falling back to full candidate list. To fix, regenerate embeddings with Update-TaxonomyEmbeddings.'
            }
        } else {
            Write-Info 'embeddings.json not found — using full candidate list'
        }
    } else {
        Write-Info 'Embedding filter disabled (-SkipEmbeddingFilter)'
    }

    # ── Step 6: Load prompts ──
    $SystemPrompt = Get-Prompt -Name 'edge-discovery'
    $SchemaPrompt = Get-Prompt -Name 'edge-discovery-schema'

    # Two-phase: resolve screen model and load screen prompt
    if ($TwoPhase) {
        $ScreenPrompt = Get-Prompt -Name 'edge-screen'
        if ([string]::IsNullOrWhiteSpace($ScreenModel)) { $ScreenModel = (Get-AITierModel -Tier basic) }
        # The user's -ApiKey is for -Model. Forward it to the screen model only when both share a
        # backend; otherwise forward '' so the screen backend resolves its own key (t/4087).
        $ScreenKey = ''
        if ((Get-AIModelBackend -Model $ScreenModel) -eq (Get-AIModelBackend -Model $Model)) { $ScreenKey = $ApiKey }
        Write-Info "Two-phase mode: screen=$ScreenModel, classify=$Model"

        $ScreenSchema = @{
            type       = 'object'
            properties = @{
                source_id   = @{ type = 'string' }
                related_ids = @{ type = 'array'; items = @{ type = 'string' } }
            }
            required   = @('source_id', 'related_ids')
        }
    } else {
        # Invoke-PerNodeEdgeDiscovery (t/3837) always takes these as mandatory
        # params; give them harmless defaults when -TwoPhase is off so the call
        # below never passes an unset variable under Set-StrictMode.
        $ScreenPrompt = ''
        $ScreenKey    = ''
        $ScreenSchema = @{}
    }

    $EdgeSchema = @{
        type       = 'object'
        properties = @{
            source_node_id = @{ type = 'string' }
            edges          = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        type          = @{ type = 'string' }
                        target        = @{ type = 'string' }
                        bidirectional = @{ type = 'boolean' }
                        confidence    = @{ type = 'number' }
                        weight        = @{ type = 'number' }
                        rationale     = @{ type = 'string' }
                        strength      = @{ type = 'string'; enum = @('strong', 'moderate', 'weak') }
                        notes         = @{ type = 'string' }
                    }
                    required   = @('type', 'target', 'confidence', 'rationale')
                }
            }
            new_edge_types = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        type          = @{ type = 'string' }
                        definition    = @{ type = 'string' }
                        bidirectional = @{ type = 'boolean' }
                    }
                    required   = @('type', 'definition')
                }
            }
        }
        required   = @('edges')
    }

    # ── Step 7: Build prompts (embedding-first, batch, or per-node mode) ──

    if ($EmbeddingFirst) {
        # ═══════════════════════════════════════════════════════════════════
        # EMBEDDING-FIRST MODE: similarity matrix → LLM classifies type only
        # Extracted to Invoke-EmbeddingFirstEdgeDiscovery (t/3837) -- this mode
        # always owns the entire run; it never falls through to Step 9/10.
        # ═══════════════════════════════════════════════════════════════════
        $EfResult = Invoke-EmbeddingFirstEdgeDiscovery `
            -TaxDir $TaxDir -RepoRoot $script:RepoRoot `
            -EmbeddingFirstThreshold $EmbeddingFirstThreshold `
            -ValidNodeIds $ValidNodeIds -NodesToProcess $NodesToProcess -Force:$Force `
            -Embeddings $Embeddings -ValidEdgeTypes $ValidEdgeTypes `
            -Labels $Labels -Descriptions $Descriptions `
            -Model $Model -Temperature $Temperature -ResolvedKey $ResolvedKey `
            -ClassifyBatchSize $ClassifyBatchSize -DryRun:$DryRun -CheckpointEvery $CheckpointEvery `
            -EdgesPath $EdgesPath -DiscLogPath $DiscLogPath `
            -EdgesList $EdgesList -ExistingEdgeKeys $ExistingEdgeKeys -EvaluatedPairs $EvaluatedPairs `
            -EdgesData $EdgesData -DiscLogEntries $DiscLogEntries
        $MissingRationaleCount += $EfResult.MissingRationaleCount
        return
    }


    if ($BatchSize -gt 0 -and $Embeddings.Count -gt 0) {
        # ═══════════════════════════════════════════════════════════════════
        # BATCH MODE: cluster nodes and discover edges between all pairs in each batch
        # Extracted to Invoke-BatchEdgeDiscovery (t/3837) -- falls through to
        # shared Step 9/10 unless the -DryRun preview path signals ShouldReturn.
        # ═══════════════════════════════════════════════════════════════════
        $BatchResult = Invoke-BatchEdgeDiscovery `
            -NodesToProcess $NodesToProcess -BatchSize $BatchSize `
            -Embeddings $Embeddings -NodePovMap $NodePovMap -DryRun:$DryRun `
            -Model $Model -Temperature $Temperature -ResolvedKey $ResolvedKey `
            -ValidNodeIds $ValidNodeIds -CheckpointEvery $CheckpointEvery -EdgesPath $EdgesPath `
            -EdgesList $EdgesList -ExistingEdgeKeys $ExistingEdgeKeys -EvaluatedPairs $EvaluatedPairs `
            -EdgesData $EdgesData -DiscLogEntries $DiscLogEntries
        $MissingRationaleCount += $BatchResult.MissingRationaleCount
        if ($BatchResult.ShouldReturn) { return }
        $TotalProcessed = $BatchResult.TotalProcessed
        $TotalEdges     = $BatchResult.TotalEdges
        $TotalFailed    = $BatchResult.TotalFailed
        $NewEdgeTypes   = $BatchResult.NewEdgeTypes

    } else {
        # ═══════════════════════════════════════════════════════════════════
        # PER-NODE MODE (original behavior)
        # Extracted to Invoke-PerNodeEdgeDiscovery (t/3837) -- falls through to
        # shared Step 9/10 unless the -DryRun preview path signals ShouldReturn.
        # ═══════════════════════════════════════════════════════════════════
        $PerNodeResult = Invoke-PerNodeEdgeDiscovery `
            -NodesToProcess $NodesToProcess -NodePovMap $NodePovMap `
            -Embeddings $Embeddings -AllNodes $AllNodes `
            -TopKCandidates $TopKCandidates -MinPerOtherPov $MinPerOtherPov -MinSimilarity $MinSimilarity `
            -Force:$Force -TwoPhase:$TwoPhase -DryRun:$DryRun `
            -ScreenPrompt $ScreenPrompt -ScreenModel $ScreenModel -ScreenSchema $ScreenSchema -ScreenKey $ScreenKey `
            -SystemPrompt $SystemPrompt -SchemaPrompt $SchemaPrompt -EdgeSchema $EdgeSchema `
            -MaxConcurrent $MaxConcurrent -Model $Model -ResolvedKey $ResolvedKey -Temperature $Temperature `
            -CheckpointEvery $CheckpointEvery -EdgesPath $EdgesPath -ModuleRoot $script:ModuleRoot `
            -EvaluatedPairs $EvaluatedPairs -EdgesData $EdgesData -EdgesList $EdgesList `
            -ExistingEdgeKeys $ExistingEdgeKeys -DiscLogEntries $DiscLogEntries
        $MissingRationaleCount += $PerNodeResult.MissingRationaleCount
        if ($PerNodeResult.ShouldReturn) { return }
        $TotalProcessed = $PerNodeResult.TotalProcessed
        $TotalEdges     = $PerNodeResult.TotalEdges
        $TotalFailed    = $PerNodeResult.TotalFailed
        $NewEdgeTypes   = $PerNodeResult.NewEdgeTypes
    } # end per-node mode else block


    # ── Step 9: Add any new edge types to the schema ──
    if ($NewEdgeTypes.Count -gt 0) {
        foreach ($NewType in $NewEdgeTypes) {
            $Existing = $EdgesData.edge_types | Where-Object { $_.type -eq $NewType.type }
            if (-not $Existing) {
                $EdgesData.edge_types += [PSCustomObject][ordered]@{
                    type          = $NewType.type
                    bidirectional = if ($NewType.PSObject.Properties['bidirectional']) { [bool]$NewType.bidirectional } else { $false }
                    definition    = if ($NewType.PSObject.Properties['definition']) { $NewType.definition } elseif ($NewType.PSObject.Properties['description']) { $NewType.description } else { '' }
                    llm_proposed  = $true
                }
                Write-OK "Added new edge type: $($NewType.type)"
            }
        }
    }

    # ── Step 10: Write edges file + discovery log ──
    if ($TotalProcessed -gt 0) {
        if ($PSCmdlet.ShouldProcess($EdgesPath, 'Write edges file')) {
            $EdgesData.edges        = $EdgesList.ToArray()
            $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
            if ($EdgesData.PSObject.Properties['discovery_log']) {
                $EdgesData.PSObject.Properties.Remove('discovery_log')
            }
            try {
                Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
                Write-OK "Saved edges to $EdgesPath"
            } catch {
                Write-Fail "Failed to write edges.json — $($_.Exception.Message)"
                Write-Info "$TotalEdges edges were discovered but NOT saved. Check file permissions and try again."
                throw
            }
        }
        Save-DiscoveryLog -Path $DiscLogPath -Entries $DiscLogEntries
    }

    # ── Summary ──
    Write-Host ''
    Write-Host '=== Edge Discovery Complete ===' -ForegroundColor Cyan
    Write-Host "  Nodes processed:  $TotalProcessed" -ForegroundColor Green
    Write-Host "  Edges proposed:   $TotalEdges" -ForegroundColor Green
    Write-Host "  Failed:           $TotalFailed" -ForegroundColor $(if ($TotalFailed -gt 0) { 'Red' } else { 'Green' })
    if ($NewEdgeTypes.Count -gt 0) {
        Write-Host "  New edge types:   $($NewEdgeTypes.Count)" -ForegroundColor Yellow
    }
    Write-Host "  Total edges in store: $($EdgesList.Count)" -ForegroundColor Cyan
    if ($MissingRationaleCount -gt 0) {
        Write-Warning "Edge discovery: $MissingRationaleCount proposed edge(s) had an empty/missing rationale (LLM omitted the schema-required field); stored rationale='' for these. Inspect the model output or re-run — silent-blank rationales are a tracked gap (t/2674)."
    }
    Write-Host ''
    Write-Host 'Proposed edges need human approval. Use Approve-Edge or Review-Edges to manage.' -ForegroundColor DarkGray
    Write-Host ''
}
