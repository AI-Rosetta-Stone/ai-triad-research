# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Extracted from Invoke-EdgeDiscovery's -EmbeddingFirst branch (t/3837,
# cyclomatic complexity 302 -> decomposed). Pure extraction, no behavior
# change: computes/loads a similarity matrix, classifies candidate pairs via
# an LLM, writes edges + discovery log. Mutates the caller's $EdgesList,
# $ExistingEdgeKeys, $EvaluatedPairs, $EdgesData, $DiscLogEntries (all
# reference types) and returns MissingRationaleCount for the caller to
# accumulate, since that counter is a plain int in the caller's scope.

function Invoke-EmbeddingFirstEdgeDiscovery {
    <#
    .SYNOPSIS
        Embedding-first edge discovery: similarity matrix, then LLM classifies type only.
    .DESCRIPTION
        See Invoke-EdgeDiscovery -EmbeddingFirst. Factored out verbatim (t/3837) --
        no logic change from the inline version it replaced.
    .OUTPUTS
        [PSCustomObject] with MissingRationaleCount (int). Returns as soon as the
        run completes OR exits early (no candidates, -DryRun) -- matching the
        original inline code's unconditional `return` in every one of those cases.
        The caller must `return` immediately after calling this, in all cases.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$TaxDir,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][double]$EmbeddingFirstThreshold,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ValidNodeIds,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$NodesToProcess,
        [Parameter(Mandatory)][bool]$Force,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$Embeddings,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ValidEdgeTypes,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$Labels,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$Descriptions,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][double]$Temperature,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ResolvedKey,
        [Parameter(Mandatory)][int]$ClassifyBatchSize,
        [Parameter(Mandatory)][bool]$DryRun,
        [Parameter(Mandatory)][int]$CheckpointEvery,
        [Parameter(Mandatory)][string]$EdgesPath,
        [Parameter(Mandatory)][string]$DiscLogPath,

        # Mutated reference-type state shared with the caller.
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$EdgesList,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ExistingEdgeKeys,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$EvaluatedPairs,
        [Parameter(Mandatory)][PSObject]$EdgesData,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$DiscLogEntries
    )

    $MissingRationaleCount = 0

    Write-Step "Embedding-first discovery (threshold=$EmbeddingFirstThreshold)"

    # Load or build similarity cache (prefer NumPy-accelerated rebuild)
    $CachePath = Join-Path $TaxDir 'similarity-cache.json'
    $CandidatePairs = [System.Collections.Generic.List[PSObject]]::new()

    # Auto-rebuild cache if missing or stale
    $NeedRebuild = -not (Test-Path $CachePath)
    if (-not $NeedRebuild) {
        $CacheMTime = (Get-Item $CachePath).LastWriteTimeUtc
        $EmbMTime = if (Test-Path (Join-Path $TaxDir 'embeddings.json')) { (Get-Item (Join-Path $TaxDir 'embeddings.json')).LastWriteTimeUtc } else { [datetime]::MinValue }
        if ($EmbMTime -gt $CacheMTime) { $NeedRebuild = $true }
    }
    if ($NeedRebuild) {
        $EmbedScript = Join-Path (Join-Path $RepoRoot 'scripts') 'embed_taxonomy.py'
        $PyCmd = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }
        if (Test-Path $EmbedScript) {
            Write-Info 'Rebuilding similarity cache (NumPy-accelerated)...'
            & $PyCmd $EmbedScript similarity-matrix --top-k 30 --threshold 0.20 -o $CachePath 2>&1 | ForEach-Object { Write-Verbose $_ }
        }
    }

    if (Test-Path $CachePath) {
        $SimCache = Get-Content $CachePath -Raw | ConvertFrom-Json -AsHashtable
        Write-OK "Loaded similarity cache ($($SimCache['node_count']) nodes, top-$($SimCache['top_k']))"

        # Fallback-Path Logging (t/3473, docs/error-handling.md): cache ids that
        # resolve to no live node are stale/retired (e.g. cc-* left over from the
        # t/1308 cc→sit migration, which did NOT rewrite this cache). Their pairs are
        # silently dropped below (source fails the ProcessIds gate, target fails the
        # ValidNodeIds gate). Surface the degradation instead of dropping in silence.
        $StaleCacheIds = @(Get-StaleSimilarityCacheIds -Entries $SimCache['entries'] -ValidNodeIds $ValidNodeIds)
        if ($StaleCacheIds.Count -gt 0) {
            $StaleSample = $StaleCacheIds | Select-Object -First 8
            Write-Warn ("similarity-cache: $($StaleCacheIds.Count) cached id(s) resolve to no live node (stale/retired, e.g. cc-* pre-t/1308) — their candidate pairs are silently dropped from discovery. Regenerate the cache (embed_taxonomy.py similarity-matrix) to clear. Sample: $($StaleSample -join ', ') [t/3473]")
        }

        # Extract candidate pairs above threshold
        $ProcessIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($N in $NodesToProcess) { $null = $ProcessIds.Add($N.id) }

        foreach ($NodeKey in $SimCache['entries'].Keys) {
            if (-not $ProcessIds.Contains($NodeKey) -and -not $Force) { continue }
            foreach ($Entry in $SimCache['entries'][$NodeKey]) {
                $Sim = [double]$Entry['sim']
                $TargetId = $Entry['id']
                if ($Sim -lt $EmbeddingFirstThreshold) { continue }
                if (-not $ValidNodeIds.Contains($TargetId)) { continue }

                # Dedup: sorted pair key
                $PairKey = if ($NodeKey -lt $TargetId) { "$NodeKey|$TargetId" } else { "$TargetId|$NodeKey" }
                if ($EvaluatedPairs.Contains($PairKey)) { continue }

                # Skip if edge already exists (any type)
                $AlreadyEdged = $false
                foreach ($ET in $ValidEdgeTypes) {
                    if ($ExistingEdgeKeys.Contains("$NodeKey|$ET|$TargetId") -or $ExistingEdgeKeys.Contains("$TargetId|$ET|$NodeKey")) {
                        $AlreadyEdged = $true; break
                    }
                }
                if ($AlreadyEdged) { continue }

                $CandidatePairs.Add([PSCustomObject]@{
                    Source     = $NodeKey
                    Target     = $TargetId
                    Similarity = $Sim
                    PairKey    = $PairKey
                })
            }
        }
    } elseif ($Embeddings.Count -gt 0) {
        # No cache — compute on the fly from embeddings
        Write-Info 'No similarity cache — computing from embeddings...'
        $ProcessIds = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($N in $NodesToProcess) { $null = $ProcessIds.Add($N.id) }

        foreach ($SrcId in $ProcessIds) {
            if (-not $Embeddings.ContainsKey($SrcId)) { continue }
            $VecA = $Embeddings[$SrcId]
            foreach ($TgtId in $Embeddings.Keys) {
                if ($SrcId -eq $TgtId) { continue }
                if ($TgtId -like 'pol-*') { continue }

                $PairKey = if ($SrcId -lt $TgtId) { "$SrcId|$TgtId" } else { "$TgtId|$SrcId" }
                if ($EvaluatedPairs.Contains($PairKey)) { continue }

                $Dot = 0.0
                $VecB = $Embeddings[$TgtId]
                for ($k = 0; $k -lt $VecA.Count; $k++) { $Dot += $VecA[$k] * $VecB[$k] }
                if ($Dot -lt $EmbeddingFirstThreshold) { continue }

                $CandidatePairs.Add([PSCustomObject]@{
                    Source     = $SrcId
                    Target     = $TgtId
                    Similarity = [Math]::Round($Dot, 4)
                    PairKey    = $PairKey
                })
            }
        }
    } else {
        Write-Fail 'Embedding-first mode requires embeddings.json or similarity-cache.json'
        throw 'No embedding data available for embedding-first mode'
    }

    # Dedup pairs
    $SeenPairs = [System.Collections.Generic.HashSet[string]]::new()
    $UniquePairs = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($P in $CandidatePairs) {
        if ($SeenPairs.Add($P.PairKey)) { $UniquePairs.Add($P) }
    }
    $CandidatePairs = $UniquePairs

    Write-OK "$($CandidatePairs.Count) candidate pairs above threshold $EmbeddingFirstThreshold"

    if ($CandidatePairs.Count -eq 0) {
        Write-OK 'No new candidate pairs to classify'
        return [PSCustomObject]@{ MissingRationaleCount = $MissingRationaleCount }
    }

    if ($DryRun) {
        Write-Host "`n  DRY RUN — top 20 candidate pairs:" -ForegroundColor Yellow
        $CandidatePairs | Sort-Object Similarity -Descending | Select-Object -First 20 | ForEach-Object {
            $SrcLabel = if ($Labels.ContainsKey($_.Source)) { $Labels[$_.Source] } else { $_.Source }
            $TgtLabel = if ($Labels.ContainsKey($_.Target)) { $Labels[$_.Target] } else { $_.Target }
            Write-Host "    sim=$($_.Similarity.ToString('F3')) $($_.Source) → $($_.Target)" -ForegroundColor Gray
            Write-Host "      $SrcLabel ↔ $TgtLabel" -ForegroundColor DarkGray
        }
        Write-Host "`n  Would send $([Math]::Ceiling($CandidatePairs.Count / $ClassifyBatchSize)) classification batches" -ForegroundColor Yellow
        return [PSCustomObject]@{ MissingRationaleCount = $MissingRationaleCount }
    }

    # Group into classification batches
    $SortedPairs = @($CandidatePairs | Sort-Object Similarity -Descending)
    $ClassifyBatches = [System.Collections.Generic.List[PSObject[]]]::new()
    for ($bi = 0; $bi -lt $SortedPairs.Count; $bi += $ClassifyBatchSize) {
        $End = [Math]::Min($bi + $ClassifyBatchSize - 1, $SortedPairs.Count - 1)
        $ClassifyBatches.Add(@($SortedPairs[$bi..$End]))
    }

    Write-Info "$($ClassifyBatches.Count) classification batches ($ClassifyBatchSize pairs/batch)"

    $NewEdgeCount = 0
    $BatchNum = 0

    foreach ($Batch in $ClassifyBatches) {
        $BatchNum++
        Write-Host "  Batch $BatchNum/$($ClassifyBatches.Count) ($($Batch.Count) pairs)..." -ForegroundColor Gray -NoNewline

        # Build pair descriptions for LLM
        $PairLinesList = [System.Collections.Generic.List[string]]::new()
        foreach ($P in $Batch) {
            $SrcLabel = if ($Labels.ContainsKey($P.Source)) { $Labels[$P.Source] } else { $P.Source }
            $TgtLabel = if ($Labels.ContainsKey($P.Target)) { $Labels[$P.Target] } else { $P.Target }
            $SrcDesc = if ($Descriptions.ContainsKey($P.Source)) { $Descriptions[$P.Source] } else { '' }
            $TgtDesc = if ($Descriptions.ContainsKey($P.Target)) { $Descriptions[$P.Target] } else { '' }
            $PairLinesList.Add("- [$($P.Source)] $SrcLabel`: $SrcDesc`n  [$($P.Target)] $TgtLabel`: $TgtDesc")
        }
        $PairLines = $PairLinesList -join "`n`n"

        $EdgeTypeLines = [System.Collections.Generic.List[string]]::new()
        foreach ($ET in $EdgesData.edge_types) {
            $IsBidir = if ($ET.PSObject.Properties['bidirectional']) { $ET.bidirectional } elseif ($ET.PSObject.Properties['direction'] -and $ET.direction -eq 'bidirectional') { $true } else { $false }
            $Def = if ($ET.PSObject.Properties['definition']) { $ET.definition } elseif ($ET.PSObject.Properties['description']) { $ET.description } else { '' }
            $EdgeTypeLines.Add("$($ET.type)$(if ($IsBidir) { ' (bidirectional)' }): $Def")
        }
        $EdgeTypeList = $EdgeTypeLines -join "`n"

        $ClassifyPrompt = @"
Classify the relationship between each pair of taxonomy nodes below. These pairs have high semantic similarity and likely have a meaningful relationship.

EDGE TYPES:
$EdgeTypeList

PAIRS TO CLASSIFY:
$PairLines

For each pair, determine:
1. The edge type (from the list above, or "NONE" if no meaningful relationship)
2. Direction: which node is source and which is target
3. Confidence (0.0-1.0)
4. Weight (0.0-1.0): strength of the relationship
5. Brief rationale

Return JSON: {"edges": [{"source": "id", "target": "id", "type": "TYPE", "confidence": 0.8, "weight": 0.7, "rationale": "..."}]}
Omit pairs with no relationship. No markdown fences.
"@

        if (-not $PSCmdlet.ShouldProcess("Batch $BatchNum ($($Batch.Count) pairs)", 'Classify edges')) {
            continue
        }

        try {
            # t/1261: route through UsageID registry. Template variables
            # render from -Values; -Override preserves the caller's runtime
            # model + temperature choices.
            $Response = Invoke-AIByUsage -UsageId 'enrichment.edge-discovery.classify' `
                -Values @{
                    edge_type_list = $EdgeTypeList
                    pair_lines     = $PairLines
                } `
                -Override @{
                    model       = $Model
                    temperature = $Temperature
                } `
                -ApiKey $ResolvedKey

            if ($null -eq $Response -or -not $Response.Text) {
                Write-Host " no response" -ForegroundColor Red
                continue
            }

            $Text = $Response.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            $Parsed = $null
            try { $Parsed = $Text | ConvertFrom-Json } catch {
                $Repaired = Repair-TruncatedJson -Text $Text
                if ($Repaired) { $Parsed = $Repaired | ConvertFrom-Json }
            }

            if ($Parsed -and $Parsed.PSObject.Properties['edges']) {
                $BatchNewEdges = 0
                foreach ($E in @($Parsed.edges)) {
                    # Guard all property access — truncated JSON may produce partial objects
                    $ESrc  = if ($E.PSObject.Properties['source']) { $E.source } else { $null }
                    $ETgt  = if ($E.PSObject.Properties['target']) { $E.target } else { $null }
                    $EType = if ($E.PSObject.Properties['type'])   { $E.type }   else { $null }
                    if (-not $ESrc -or -not $ETgt -or -not $EType) { continue }
                    if ($EType -eq 'NONE') { continue }
                    $ESrc = ConvertTo-SurvivorNodeId -Id $ESrc -Context 'Embedding-first edge discovery'   # t/4356
                    $ETgt = ConvertTo-SurvivorNodeId -Id $ETgt -Context 'Embedding-first edge discovery'
                    $E.source = $ESrc; $E.target = $ETgt
                    if (-not $ValidNodeIds.Contains($ESrc) -or -not $ValidNodeIds.Contains($ETgt)) { continue }

                    $EdgeKey = "$ESrc|$EType|$ETgt"
                    if ($ExistingEdgeKeys.Contains($EdgeKey)) { continue }

                    $NewEdge = [ordered]@{
                        source        = $ESrc
                        target        = $ETgt
                        type          = $EType.ToUpper()
                        bidirectional = if ($E.PSObject.Properties['bidirectional']) { $E.bidirectional } else { $false }
                        confidence    = if ($E.PSObject.Properties['confidence']) { [Math]::Round([double]$E.confidence, 2) } else { 0.5 }
                        weight        = if ($E.PSObject.Properties['weight']) { [Math]::Round([double]$E.weight, 2) } else { $null }
                        rationale     = if ($E.PSObject.Properties['rationale']) { $E.rationale } else { '' }
                        status        = 'proposed'
                        discovered_by = 'embedding-first'
                        discovered_at = (Get-Date).ToString('yyyy-MM-dd')
                    }

                    if ([string]::IsNullOrWhiteSpace($NewEdge.rationale)) { $MissingRationaleCount++ }
                    # t/2944 write-together invariant: stamp provenance iff a non-empty rationale is
                    # set (absent != null contract). NOTE: this is the embedding-FIRST candidate path
                    # (pairs found by similarity), BUT the rationale here is LLM-authored — it comes
                    # from the Classify prompt / Invoke-AIByUsage 'enrichment.edge-discovery.classify'
                    # response above, not a similarity template. So provenance is 'discovery', NOT
                    # 'embedding-template' (which the design reserves for a no-LLM template path; that
                    # path does not exist in this cmdlet today — flagged to CL, edge-rationale-source-marker.md).
                    if (-not [string]::IsNullOrWhiteSpace([string]$NewEdge.rationale)) { $NewEdge['rationale_source'] = 'discovery' }
                    $EdgesList.Add([PSCustomObject]$NewEdge)
                    $null = $ExistingEdgeKeys.Add($EdgeKey)
                    $BatchNewEdges++
                    $NewEdgeCount++
                }
                Write-Host " $BatchNewEdges edges" -ForegroundColor Green
            } else {
                Write-Host " parse error" -ForegroundColor Red
            }
        } catch {
            Write-Host " failed: $($_.Exception.Message)" -ForegroundColor Red
        }

        # Mark pairs as evaluated
        foreach ($P in $Batch) {
            $null = $EvaluatedPairs.Add($P.PairKey)
        }

        # Checkpoint
        if ($CheckpointEvery -gt 0 -and $BatchNum % $CheckpointEvery -eq 0) {
            $EdgesData.edges = @($EdgesList)
            $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
            Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
            Write-Info "  Checkpoint at batch $BatchNum"
        }

        if ($BatchNum -lt $ClassifyBatches.Count) { Start-Sleep -Milliseconds 500 }
    }

    # Final save
    $EdgesData.edges = @($EdgesList)
    $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')

    # Add discovery log entry for this run
    $DiscLogEntries.Add([PSCustomObject][ordered]@{
        node_id              = 'embedding-first-batch'
        timestamp            = (Get-Date).ToString('o')
        model                = $Model
        mode                 = 'embedding-first'
        threshold            = $EmbeddingFirstThreshold
        candidate_pairs      = $CandidatePairs.Count
        new_edges            = $NewEdgeCount
        batches              = $ClassifyBatches.Count
    })

    Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
    Save-DiscoveryLog -Path $DiscLogPath -Entries $DiscLogEntries

    Write-Host "`n=== EMBEDDING-FIRST COMPLETE ===" -ForegroundColor Cyan
    Write-Host "  Candidate pairs: $($CandidatePairs.Count)"
    Write-Host "  Classification batches: $($ClassifyBatches.Count)"
    Write-Host "  New edges discovered: $NewEdgeCount" -ForegroundColor Green
    Write-Host "  Total edges: $($EdgesList.Count)"
    if ($MissingRationaleCount -gt 0) {
        Write-Warning "Edge discovery: $MissingRationaleCount proposed edge(s) had an empty/missing rationale (LLM omitted the schema-required field); stored rationale='' for these. Inspect the model output or re-run — silent-blank rationales are a tracked gap (t/2674)."
    }

    return [PSCustomObject]@{ MissingRationaleCount = $MissingRationaleCount }
}
