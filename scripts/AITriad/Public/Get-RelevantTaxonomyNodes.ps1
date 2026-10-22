# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-RelevantTaxonomyNodes {
    <#
    .SYNOPSIS
        Returns taxonomy nodes most relevant to a query using embedding similarity.
    .DESCRIPTION
        Loads cached embedding vectors, computes cosine similarity between the query
        and every taxonomy node, and returns the top matches. Uses threshold + min-per-BDI
        + max cap selection logic (mirrors Shared Lib's selectRelevantNodes).

        Replaces full-taxonomy injection in the pipeline — at 518 nodes, unfiltered
        injection wastes 15,000+ tokens. This cmdlet typically returns 30-50 relevant
        nodes (~3,000-5,000 tokens).
    .PARAMETER Query
        Text to find relevant nodes for (e.g., document excerpt, first 500 words).
    .PARAMETER Threshold
        Cosine similarity floor. Nodes below this are excluded unless needed for
        MinPerCategory guarantee. When -AdaptiveThreshold is set (default), the
        effective threshold is the higher of this floor and the score at the
        TopK-th percentile, adapting to query specificity. Default: 0.20.
    .PARAMETER MaxTotal
        Maximum nodes to return. Default: 50.
    .PARAMETER TopK
        Select the top-K nodes by similarity rank instead of using a fixed threshold.
        Combined with Threshold as a floor — nodes below the floor are excluded even
        if they're in the top K. Default: 40. Set to 0 to disable rank-based selection.
    .PARAMETER MinPerCategory
        Minimum nodes per BDI category (Beliefs, Desires, Intentions). Guarantees
        coverage even if one category has low similarity. Default: 3.
    .PARAMETER POV
        Filter to specific POVs. Default: all.
    .PARAMETER IncludeSituations
        Include situation nodes. Default: true.
    .PARAMETER Format
        Output format: 'objects' (TaxonomyNode[]), 'json' (serialized), 'context'
        (formatted text block for prompt injection). Default: 'objects'.
    .PARAMETER Model
        Deprecated — ignored. Query embedding now uses the same local model
        (all-MiniLM-L6-v2) as the cached taxonomy embeddings.
    .PARAMETER ApiKey
        Deprecated — ignored. No API key required; embeddings are computed locally.
    .PARAMETER CrossEncoderRerank
        After bi-encoder top-K retrieval, re-score the top-$RerankTopN (query, node)
        pairs with a cross-encoder and re-sort by that score. Cross-encoders catch
        vocabulary-collision mismatches the bi-encoder cosine misses (epic t/2285).
        Default OFF. On any failure (Python/model unavailable, subprocess error) the
        pass warns and keeps the bi-encoder ranking — it never throws. When on, each
        reranked node's Score is the cross-encoder sigmoid score (a display 0–1 scale,
        NOT the bi-encoder cosine and NOT cross-comparable with a rerank-off score).
    .PARAMETER RerankTopN
        Number of top bi-encoder candidates to re-rank when -CrossEncoderRerank is
        set. Default: 10. Nodes beyond this keep their bi-encoder order.
    .PARAMETER RerankerModel
        Cross-encoder model for re-ranking. Default: cross-encoder/ms-marco-MiniLM-L-6-v2.
    .EXAMPLE
        Get-RelevantTaxonomyNodes -Query "AI regulation and liability frameworks"
    .EXAMPLE
        # Cross-encoder re-ranking of the top-10 bi-encoder candidates
        Get-RelevantTaxonomyNodes -Query $DocText -CrossEncoderRerank
    .EXAMPLE
        Get-RelevantTaxonomyNodes -Query $DocText -MaxTotal 40 -Format context
    .EXAMPLE
        Get-RelevantTaxonomyNodes -Query $DocText -POV accelerationist,safetyist
    .EXAMPLE
        # Chunk-level: use chunk text for per-chunk relevance
        Get-RelevantTaxonomyNodes -Query $ChunkText -MaxTotal 40 -MinPerCategory 2 -Format context
    .EXAMPLE
        # Topic-level: use debate topic + recent transcript for debate context
        Get-RelevantTaxonomyNodes -Query "$DebateTopic. $RecentTranscript" -MaxTotal 30 -Format context
    .EXAMPLE
        # Use more synthetic vectors for broader matching
        Get-RelevantTaxonomyNodes -Query $DocText -SyntheticTopN 5
    .LINK
        Show-AITriadHelp
    .LINK
        Get-Tax
    .LINK
        Get-GraphNode
    .LINK
        Get-TaxonomyHealth
    .LINK
        Compare-Taxonomy
    .LINK
        Test-TaxonomyIntegrity
    .LINK
        Test-OntologyCompliance
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Query,

        [ValidateRange(0.0, 1.0)]
        [double]$Threshold = 0.20,

        [ValidateRange(1, 600)]
        [int]$MaxTotal = 50,

        [ValidateRange(0, 500)]
        [int]$TopK = 40,

        [ValidateRange(0, 20)]
        [int]$MinPerCategory = 3,

        [ValidateRange(1, 10)]
        [int]$SyntheticTopN = 3,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'situations', '')]
        [string[]]$POV = @(),

        [switch]$IncludeSituations = $true,

        [ValidateSet('objects', 'json', 'context')]
        [string]$Format = 'objects',

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = '',
        [string]$ApiKey = '',

        # Pre-computed query embedding. When supplied (e.g. callers that batch
        # many chunk queries in one embed subprocess), the per-call encode
        # subprocess is skipped entirely — avoids a ~6s cold model load per call.
        [double[]]$QueryVector = @(),

        # Cross-encoder re-ranking (t/2287). Default OFF; see comment-based help.
        [switch]$CrossEncoderRerank,

        [ValidateRange(1, 100)]
        [int]$RerankTopN = 10,

        [string]$RerankerModel = 'cross-encoder/ms-marco-MiniLM-L-6-v2'  # model-lint:allow-pin reranker cross-encoder model, not an ai-models.json LLM backend
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Load embeddings (cached in module scope, auto-refreshes if stale) ─────
    Assert-TaxonomyCacheFresh  # invalidates $script:CachedEmbeddings if embeddings.json changed
    if (-not $script:CachedEmbeddings) {
        $EmbPath = Join-Path (Get-TaxonomyDir) 'embeddings.json'
        if (-not (Test-Path $EmbPath)) {
            New-ActionableError -Goal 'load taxonomy embeddings' `
                -Problem "embeddings.json not found at $EmbPath" `
                -Location 'Get-RelevantTaxonomyNodes' `
                -NextSteps @('Run Update-TaxEmbeddings to generate embeddings') -Throw
        }
        Write-Verbose 'Loading embeddings.json (first call or after refresh)...'
        $EmbData = Get-Content -Raw -Path $EmbPath | ConvertFrom-Json
        $script:CachedEmbeddings = @{}
        foreach ($Prop in $EmbData.nodes.PSObject.Properties) {
            $script:CachedEmbeddings[$Prop.Name] = [double[]]@($Prop.Value.vector)
        }
        $script:EmbeddingsTimestamp = (Get-Item $EmbPath).LastWriteTime
        Write-Verbose "Cached $($script:CachedEmbeddings.Count) embedding vectors"
    }

    # ── Build pillar-node exclusion set (t/2369, lazy, invalidated with TaxonomyData) ──
    if ($null -eq $script:PillarNodeIds) {
        $PillarIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($PovVal in $script:TaxonomyData.Values) {
            if (-not $PovVal.PSObject.Properties['nodes']) { continue }
            foreach ($N in @($PovVal.nodes)) {
                if ($N.PSObject.Properties['description'] -and
                    $N.description -match '(?i)^\s*a thematic pillar\b') {
                    [void]$PillarIds.Add([string]$N.id)
                }
            }
        }
        $script:PillarNodeIds = $PillarIds
        Write-Verbose "Pillar-node exclusion set: $($PillarIds.Count) nodes excluded from candidate scoring"
    }

    # ── Load synthetic multi-vector embeddings (optional, cached) ────────────
    if (-not $script:CachedSyntheticVectors) {
        $SynPath = Join-Path (Get-TaxonomyDir) 'synthetic/synthetic_embeddings.json'
        if (Test-Path $SynPath) {
            Write-Verbose 'Loading synthetic_embeddings.json (first call or after refresh)...'
            $SynData = Get-Content -Raw -Path $SynPath | ConvertFrom-Json
            $script:CachedSyntheticVectors = @{}
            foreach ($Prop in $SynData.nodes.PSObject.Properties) {
                $Vecs = [System.Collections.Generic.List[double[]]]::new()
                foreach ($V in @($Prop.Value.vectors)) {
                    $Vecs.Add([double[]]@($V))
                }
                $script:CachedSyntheticVectors[$Prop.Name] = $Vecs
            }
            $script:SyntheticTimestamp = (Get-Item $SynPath).LastWriteTime
            Write-Verbose "Cached synthetic vectors for $($script:CachedSyntheticVectors.Count) nodes"
        }
    }

    # ── Get query embedding ───────────────────────────────────────────────────
    # Use the same local model (all-MiniLM-L6-v2) as the cached taxonomy embeddings.
    # Calls embed_taxonomy.py encode — no API key required, dimensions always match.
    $EmbedScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'embed_taxonomy.py'
    if (-not (Test-Path $EmbedScript)) { $EmbedScript = Join-Path $script:ModuleRoot 'embed_taxonomy.py' }
    if (-not (Test-Path $EmbedScript)) {
        New-ActionableError -Goal 'compute query embedding' `
            -Problem "embed_taxonomy.py not found at $EmbedScript" `
            -Location 'Get-RelevantTaxonomyNodes' `
            -NextSteps @('Verify scripts/embed_taxonomy.py exists in the repo') -Throw
    }

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    # Truncate query to ~2000 chars (model context limit)
    if ($Query.Length -gt 2000) { $QueryText = $Query.Substring(0, 2000) } else { $QueryText = $Query }

    if ($QueryVector.Count -gt 0) {
        # Caller supplied a pre-computed embedding (batched upstream) — skip the
        # per-call encode subprocess entirely.
        $QueryVector = [double[]]$QueryVector
    }
    else {
    try {
        # Pipe query text via stdin to avoid CLI arg escaping issues with long text.
        # embed_taxonomy.py encode reads from stdin when arg is '-' (default).
        $PrevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $__EmbSw = [System.Diagnostics.Stopwatch]::StartNew()
            $EmbOutput = $QueryText | & $PythonCmd $EmbedScript encode - 2>$null
            $__EmbSw.Stop()
            Add-StageTiming -Name 'embed.subprocess (RAG query)' -Milliseconds $__EmbSw.Elapsed.TotalMilliseconds
        } finally {
            $ErrorActionPreference = $PrevEAP
        }
        if ($LASTEXITCODE -ne 0) {
            New-ActionableError -Goal 'compute query embedding' `
                -Problem "embed_taxonomy.py encode failed (exit code $LASTEXITCODE)" `
                -Location 'Get-RelevantTaxonomyNodes' `
                -NextSteps @('Check Python is installed', 'Run: pip install sentence-transformers') -Throw
        }
        if (-not $EmbOutput -or "$EmbOutput".Trim().Length -eq 0) {
            New-ActionableError -Goal 'compute query embedding' `
                -Problem "embed_taxonomy.py produced no output" `
                -Location 'Get-RelevantTaxonomyNodes' `
                -NextSteps @('Check Python is installed', 'Run: pip install sentence-transformers') -Throw
        }
        $Parsed = $EmbOutput | ConvertFrom-Json
        $QueryVector = [double[]]($Parsed | ForEach-Object { [double]$_ })
    }
    catch {
        New-ActionableError -Goal 'compute query embedding' `
            -Problem "Local embedding failed: $($_.Exception.Message)" `
            -Location 'Get-RelevantTaxonomyNodes' `
            -NextSteps @('Check Python is installed', 'Run: pip install sentence-transformers') -Throw
    }
    }

    # ── Compute cosine similarity for all nodes ───────────────────────────────
    $Scores = [System.Collections.Generic.List[PSObject]]::new()
    $SynScoredCount = 0
    $Dim = $QueryVector.Count

    # Precompute query norm (same for all nodes)
    $QueryNormSq = 0.0
    for ($i = 0; $i -lt $Dim; $i++) { $QueryNormSq += $QueryVector[$i] * $QueryVector[$i] }
    $QueryNormSqrt = [Math]::Sqrt($QueryNormSq)

    if ($POV.Count -gt 0) {
        $PovFilter = [System.Collections.Generic.HashSet[string]]::new([string[]]$POV, [System.StringComparer]::OrdinalIgnoreCase)
    }
    else { $PovFilter = $null }

    foreach ($NodeId in $script:CachedEmbeddings.Keys) {
        # POV filtering
        if ($NodeId -match '^acc-') { $NodePov = 'accelerationist' }
        elseif ($NodeId -match '^saf-') { $NodePov = 'safetyist' }
        elseif ($NodeId -match '^skp-') { $NodePov = 'skeptic' }
        elseif ($NodeId -match '^sit-') { $NodePov = 'situations' }
        else { $NodePov = 'unknown' }

        if ($NodePov -eq 'situations' -and -not $IncludeSituations) { continue }
        if ($PovFilter -and -not $PovFilter.Contains($NodePov)) { continue }
        if ($script:PillarNodeIds -and $script:PillarNodeIds.Contains($NodeId)) { continue }  # t/2369
        # Superseded nodes never compete for a slot (t/4356): skipping them only at the later cache
        # lookup would silently leave fewer than MaxTotal nodes.
        if ($script:TaxonomySupersession -and $script:TaxonomySupersession.SupersededIds.Contains($NodeId)) { continue }

        # Mean-of-top-N scoring (synthetic multi-vector) or single-vector fallback
        if ($script:CachedSyntheticVectors -and $script:CachedSyntheticVectors.ContainsKey($NodeId)) {
            $SynVecs = $script:CachedSyntheticVectors[$NodeId]
            $Sims = [System.Collections.Generic.List[double]]::new($SynVecs.Count)
            foreach ($SynVec in $SynVecs) {
                $Dot = 0.0; $NormB = 0.0
                for ($i = 0; $i -lt $Dim; $i++) {
                    $Dot += $QueryVector[$i] * $SynVec[$i]
                    $NormB += $SynVec[$i] * $SynVec[$i]
                }
                $D = $QueryNormSqrt * [Math]::Sqrt($NormB)
                if ($D -gt 0) { $Sims.Add($Dot / $D) }
            }
            $SortedSims = @($Sims | Sort-Object -Descending)
            $N = [Math]::Min($SyntheticTopN, $SortedSims.Count)
            if ($N -gt 0) {
                $Sum = 0.0
                for ($j = 0; $j -lt $N; $j++) { $Sum += $SortedSims[$j] }
                $Similarity = $Sum / $N
            }
            else { $Similarity = 0.0 }
            $SynScoredCount++
        }
        else {
            $NodeVec = $script:CachedEmbeddings[$NodeId]
            if (@($NodeVec).Count -ne $Dim) { continue }
            $Dot = 0.0; $NormB = 0.0
            for ($i = 0; $i -lt $Dim; $i++) {
                $Dot += $QueryVector[$i] * $NodeVec[$i]
                $NormB += $NodeVec[$i] * $NodeVec[$i]
            }
            $D = $QueryNormSqrt * [Math]::Sqrt($NormB)
            if ($D -gt 0) { $Similarity = $Dot / $D } else { $Similarity = 0.0 }
        }

        # Determine BDI category from node ID
        if ($NodeId -match '-beliefs-') { $Category = 'Beliefs' }
        elseif ($NodeId -match '-desires-') { $Category = 'Desires' }
        elseif ($NodeId -match '-intentions-') { $Category = 'Intentions' }
        else { $Category = 'Situations' }

        $Scores.Add([PSCustomObject]@{
            NodeId     = $NodeId
            POV        = $NodePov
            Category   = $Category
            Similarity = [Math]::Round($Similarity, 4)
        })
    }

    # ── Selection: adaptive top-K + threshold floor + min-per-BDI + max cap ──
    $Ranked = @($Scores | Sort-Object Similarity -Descending)

    # Adaptive threshold: use top-K rank to determine effective cutoff
    $EffectiveThreshold = $Threshold
    if ($TopK -gt 0 -and $Ranked.Count -gt $TopK) {
        $KthScore = $Ranked[$TopK - 1].Similarity
        $EffectiveThreshold = [Math]::Max($Threshold, $KthScore)
    }

    $AboveThreshold = @($Ranked | Where-Object { $_.Similarity -ge $EffectiveThreshold })

    # Guarantee MinPerCategory (uses raw threshold floor, not adaptive)
    $Selected = [System.Collections.Generic.List[PSObject]]::new()
    $SelectedIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($Cat in @('Beliefs', 'Desires', 'Intentions')) {
        $CatNodes = @($Ranked | Where-Object { $_.Category -eq $Cat })
        $Added = 0
        foreach ($N in $CatNodes) {
            if ($Added -ge $MinPerCategory) { break }
            if (-not $SelectedIds.Contains($N.NodeId)) {
                $Selected.Add($N)
                [void]$SelectedIds.Add($N.NodeId)
                $Added++
            }
        }
    }

    # Fill remaining slots from above-threshold pool
    foreach ($N in $AboveThreshold) {
        if ($Selected.Count -ge $MaxTotal) { break }
        if (-not $SelectedIds.Contains($N.NodeId)) {
            $Selected.Add($N)
            [void]$SelectedIds.Add($N.NodeId)
        }
    }

    # Sort final selection by similarity descending
    $Selected = @($Selected | Sort-Object Similarity -Descending)

    Write-Verbose "Selected $($Selected.Count) / $($Scores.Count) nodes (floor=$Threshold, effective=$([Math]::Round($EffectiveThreshold, 3)), topK=$TopK, max=$MaxTotal)"

    # Context-rot: RAG filtering metrics (module-scoped for pipeline to capture)
    $BelowThresholdForced = @($Selected | Where-Object { $_.Similarity -lt $EffectiveThreshold }).Count
    $CatCounts = @{}
    foreach ($S in $Selected) { $CatCounts[$S.Category] = ($CatCounts[$S.Category] ?? 0) + 1 }
    $script:LastRAGMetrics = New-ContextRotStage `
        -Stage 'rag_filtering' -InUnits 'nodes' -InCount $Scores.Count `
        -OutUnits 'nodes' -OutCount $Selected.Count `
        -Flags @{
            threshold_floor        = $Threshold
            effective_threshold    = $EffectiveThreshold
            top_k                  = $TopK
            above_threshold        = $AboveThreshold.Count
            below_threshold_forced = $BelowThresholdForced
            beliefs_selected       = ($CatCounts['Beliefs'] ?? 0)
            desires_selected       = ($CatCounts['Desires'] ?? 0)
            intentions_selected    = ($CatCounts['Intentions'] ?? 0)
            synthetic_nodes_scored = $SynScoredCount
            rerank_applied         = $false  # set true below if cross-encoder rerank ran
            rerank_top1_delta      = 0        # bi-encoder rank the new #1 climbed from (rank-overturn signal, t/2287#5)
        }

    # ── Look up full node data ────────────────────────────────────────────────
    $Results = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($S in $Selected) {
        $NodeData = $null
        foreach ($PovKey in $script:TaxonomyData.Keys) {
            $Found = $script:TaxonomyData[$PovKey].nodes | Where-Object { $_.id -eq $S.NodeId } | Select-Object -First 1
            if ($Found) {
                $NodeData = $Found
                break
            }
        }

        if ($NodeData) {
            $Obj = ConvertTo-TaxonomyNode -PovKey $S.POV -Node $NodeData -Score $S.Similarity
            $Results.Add($Obj)
        }
    }

    # ── Optional cross-encoder re-ranking (t/2287) ────────────────────────────
    # After bi-encoder top-K retrieval, re-score the top-$RerankTopN (query, node)
    # pairs with a cross-encoder and re-sort. Catches vocabulary-collision
    # mismatches the bi-encoder misses (epic t/2285). Default OFF. The scoring
    # subprocess is isolated in Invoke-RerankScoring, which NEVER throws and
    # returns $null on any failure — so we degrade to the bi-encoder ranking.
    if ($CrossEncoderRerank -and $Results.Count -gt 0) {
      # Defensive: rerank must NEVER break core retrieval — any error here degrades
      # to the bi-encoder ranking. $Results is only reassigned after the reorder
      # succeeds, so a throw leaves the bi-encoder order intact.
      try {
        $RerankN = [Math]::Min($RerankTopN, $Results.Count)
        $TopSlice = @($Results[0..($RerankN - 1)])
        # Preserve bi-encoder order for the rerank_top1_delta diagnostic (CL t/2287#5)
        $BiEncoderOrder = @($TopSlice | ForEach-Object { $_.Id })

        $Candidates = @($TopSlice | ForEach-Object {
            if ($_.Description) { $Text = "$($_.Label). $($_.Description)" } else { $Text = $_.Label }
            [PSCustomObject]@{ id = $_.Id; text = $Text }
        })
        $Scored = Invoke-RerankScoring -Query $QueryText -Candidates $Candidates -RerankerModel $RerankerModel

        if ($null -eq $Scored -or @($Scored).Count -eq 0) {
            Write-Warning "Cross-encoder rerank unavailable — keeping bi-encoder ranking."
        }
        else {
            $Scored = @($Scored)
            $ScoreMap = @{}
            foreach ($S in $Scored) { $ScoreMap[$S.id] = $S }
            $NodeById = @{}
            foreach ($N in $TopSlice) { $NodeById[$N.Id] = $N }

            # Reorder the reranked slice by cross-encoder score desc; overwrite each
            # node's Score with the CE sigmoid score (the surfaced confidence).
            $RerankedNodes = [System.Collections.Generic.List[PSObject]]::new()
            foreach ($S in @($Scored | Sort-Object { $_.score } -Descending)) {
                if ($NodeById.ContainsKey($S.id)) {
                    $Node = $NodeById[$S.id]
                    $Node.Score = [Math]::Round([double]$S.score, 6)
                    $RerankedNodes.Add($Node)
                }
            }
            # Any slice node the scorer didn't return keeps its place at the slice tail
            foreach ($N in $TopSlice) {
                if (-not $ScoreMap.ContainsKey($N.Id)) { $RerankedNodes.Add($N) }
            }
            # Tail beyond the reranked slice keeps bi-encoder order
            if ($Results.Count -gt $RerankN) { $Tail = @($Results[$RerankN..($Results.Count - 1)]) } else { $Tail = @() }
            $Results = [System.Collections.Generic.List[PSObject]]::new()
            foreach ($N in $RerankedNodes) { $Results.Add($N) }
            foreach ($N in $Tail) { $Results.Add($N) }

            # rerank_top1_delta = how far the new #1 climbed from its bi-encoder
            # position (0 = unchanged). This rank-overturn is the divergence
            # diagnostic the epic monitors (CL t/2287#5).
            $RerankTop1Delta = [Math]::Max(0, $BiEncoderOrder.IndexOf($RerankedNodes[0].Id))
            if (Test-Path variable:script:LastRAGMetrics) {
                $script:LastRAGMetrics.flags['rerank_applied'] = $true
                $script:LastRAGMetrics.flags['rerank_top1_delta'] = $RerankTop1Delta
            }
        }
      }
      catch {
          Write-Warning "Cross-encoder rerank error: $($_.Exception.Message). Keeping bi-encoder ranking."
      }
    }

    # ── Format output ─────────────────────────────────────────────────────────
    switch ($Format) {
        'objects' {
            return $Results.ToArray()
        }
        'json' {
            $JsonData = @($Results | ForEach-Object {
                [ordered]@{
                    id          = $_.Id
                    pov         = $_.POV
                    category    = $_.Category
                    label       = $_.Label
                    description = $_.Description
                    score       = $_.Score
                }
            })
            return ($JsonData | ConvertTo-Json -Depth 5)
        }
        'context' {
            # Build compact context block for prompt injection
            $Lines = [System.Text.StringBuilder]::new()
            [void]$Lines.AppendLine("=== RELEVANT TAXONOMY NODES ($($Results.Count) of $($script:CachedEmbeddings.Count) total, filtered by relevance) ===")
            [void]$Lines.AppendLine("")

            $GroupedByPov = $Results | Group-Object POV
            foreach ($Group in $GroupedByPov) {
                [void]$Lines.AppendLine("--- $($Group.Name) ---")
                foreach ($Node in $Group.Group) {
                    if ($Node.Category) { $CatLabel = "[$($Node.Category)]" } else { $CatLabel = '' }
                    [void]$Lines.AppendLine("  $($Node.Id) $CatLabel $($Node.Label)")
                    if ($Node.Description) {
                        if ($Node.Description.Length -gt 200) { $DescShort = $Node.Description.Substring(0, 200) + '...' } else { $DescShort = $Node.Description }
                        [void]$Lines.AppendLine("    $DescShort")
                    }
                }
                [void]$Lines.AppendLine("")
            }

            return $Lines.ToString()
        }
    }
}
