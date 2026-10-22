# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Extracted from Invoke-EdgeDiscovery's per-node (non-batch, non-embedding-first)
# branch (t/3837, cyclomatic complexity 302 -> decomposed). Pure extraction, no
# behavior change: builds one classification prompt per node (optionally
# two-phase screened), then executes sequentially (with checkpointing) or in
# parallel via ForEach-Object -Parallel, reusing Invoke-NodeEdgeDiscovery.
#
# Like Batch mode, Per-Node mode does NOT own the whole run -- it falls through
# to the caller's shared Step 9/10 except on the -DryRun preview path, which
# must exit the cmdlet entirely (signaled via ShouldReturn, same convention as
# Invoke-BatchEdgeDiscovery).
#
# Note (t/3837#7): the parallel path does not update $EvaluatedPairs -- this is
# dead code in the original, not a bug introduced here. $EvaluatedPairs is only
# read earlier in this same function (candidate pre-filtering) and persisted
# across RUNS via the discovery log file, not via in-memory state carried out
# of a parallel run. Preserved verbatim; not "fixed" as part of this refactor.

function Invoke-PerNodeEdgeDiscovery {
    <#
    .SYNOPSIS
        Per-node edge discovery: one classification call per node, sequential or parallel.
    .DESCRIPTION
        See Invoke-EdgeDiscovery (default mode, i.e. neither -EmbeddingFirst nor
        -BatchSize). Factored out verbatim (t/3837) -- no logic change from the
        inline version it replaced.
    .OUTPUTS
        [PSCustomObject] with ShouldReturn (bool -- true only for the -DryRun
        preview path, meaning the caller must `return` immediately), plus
        TotalProcessed, TotalEdges, TotalFailed, NewEdgeTypes, and
        MissingRationaleCount for the caller to carry into Step 9/10.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$NodesToProcess,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$NodePovMap,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$Embeddings,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$AllNodes,
        [Parameter(Mandatory)][int]$TopKCandidates,
        [Parameter(Mandatory)][int]$MinPerOtherPov,
        [Parameter(Mandatory)][double]$MinSimilarity,
        [Parameter(Mandatory)][bool]$Force,
        [Parameter(Mandatory)][bool]$TwoPhase,
        [Parameter(Mandatory)][bool]$DryRun,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ScreenPrompt,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ScreenModel,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$ScreenSchema,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ScreenKey,
        [Parameter(Mandatory)][string]$SystemPrompt,
        [Parameter(Mandatory)][string]$SchemaPrompt,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$EdgeSchema,
        [Parameter(Mandatory)][int]$MaxConcurrent,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ResolvedKey,
        [Parameter(Mandatory)][double]$Temperature,
        [Parameter(Mandatory)][int]$CheckpointEvery,
        [Parameter(Mandatory)][string]$EdgesPath,
        [Parameter(Mandatory)][string]$ModuleRoot,

        # Mutated reference-type state shared with the caller.
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$EvaluatedPairs,
        [Parameter(Mandatory)][PSObject]$EdgesData,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$EdgesList,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ExistingEdgeKeys,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$DiscLogEntries
    )

    $MissingRationaleCount = 0

    Write-Step 'Building per-node prompts'

    $NodePrompts = @{}   # node ID → full prompt string
    $NodeCandidateIds = @{}   # node ID → [string[]] candidate IDs (for evaluated_pairs tracking)
    $AllNodeArray = $AllNodes.ToArray()

    foreach ($Node in $NodesToProcess) {
        $PovKey = $NodePovMap[$Node.id]

        # Filter candidates for this source node
        if ($Embeddings.Count -gt 0) {
            $Candidates = Get-FilteredCandidates `
                -SourceId       $Node.id `
                -Embeddings     $Embeddings `
                -AllNodes       $AllNodeArray `
                -NodePovMap     $NodePovMap `
                -TopK           $TopKCandidates `
                -MinPerOtherPov $MinPerOtherPov `
                -MinSimilarity  $MinSimilarity
        } else {
            $Candidates = @($AllNodes | Where-Object { $_.id -ne $Node.id })
        }

        # Skip already-evaluated pairs (incremental optimization)
        # Only active when not using -Force (full re-evaluation ignores evaluated pairs)
        if (-not $Force -and $EvaluatedPairs.Count -gt 0) {
            $PreFilterCount = $Candidates.Count
            $Candidates = @($Candidates | Where-Object {
                $CandId = $_.id
                $PairKey = if ($Node.id -lt $CandId) { "$($Node.id)|$CandId" } else { "$CandId|$($Node.id)" }
                -not $EvaluatedPairs.Contains($PairKey)
            })
            $SkippedCount = $PreFilterCount - $Candidates.Count
            if ($SkippedCount -gt 0) {
                Write-Verbose "$($Node.id): skipped $SkippedCount already-evaluated candidates ($($Candidates.Count) remaining)"
            }
            # If all candidates were already evaluated, skip this node entirely
            if ($Candidates.Count -eq 0) {
                Write-Verbose "$($Node.id): all candidates already evaluated — skipping"
                continue
            }
        }

        # Two-phase screen: use cheap model to filter candidates before full classification
        if ($TwoPhase -and -not $DryRun) {
            $ScreenCandJson = @($Candidates | ForEach-Object {
                $E = [ordered]@{ id = $_.id; pov = $NodePovMap[$_.id]; label = $_.label }
                if ($_.PSObject.Properties['description']) {
                    $D = $_.description; if ($D.Length -gt 120) { $D = $D.Substring(0, 117) + '...' }
                    $E['description'] = $D
                }
                $E
            }) | ConvertTo-Json -Depth 3

            $ScreenSourceJson = (@{ id = $Node.id; label = $Node.label; description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' } }) | ConvertTo-Json -Depth 2

            $ScreenFullPrompt = @"
$ScreenPrompt

--- SOURCE NODE ---
$ScreenSourceJson

--- CANDIDATES ---
$ScreenCandJson
"@

            try {
                # t/1261: route through UsageID registry. -Override preserves
                # the caller's runtime screen model + the inline ScreenSchema.
                $ScreenResult = Invoke-AIByUsage -UsageId 'enrichment.edge-discovery.screen' `
                    -Values @{
                        screen_prompt   = $ScreenPrompt
                        source_json     = $ScreenSourceJson
                        candidates_json = $ScreenCandJson
                    } `
                    -Override @{
                        model          = $ScreenModel
                        responseSchema = $ScreenSchema
                    } `
                    -ApiKey $ScreenKey
                $ScreenText = $ScreenResult.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
                $ScreenParsed = $ScreenText | ConvertFrom-Json
                if ($ScreenParsed.PSObject.Properties['related_ids'] -and $ScreenParsed.related_ids.Count -gt 0) {
                    $ScreenedIds = [System.Collections.Generic.HashSet[string]]::new([string[]]@($ScreenParsed.related_ids))
                    $PreScreenCount = $Candidates.Count
                    $Candidates = @($Candidates | Where-Object { $ScreenedIds.Contains($_.id) })
                    Write-Verbose "$($Node.id): screen passed $($Candidates.Count)/$PreScreenCount candidates"
                    if ($Candidates.Count -eq 0) {
                        Write-Verbose "$($Node.id): screen returned 0 candidates — skipping full classification"
                        continue
                    }
                }
            } catch {
                Write-Warn "$($Node.id): screen failed ($($_.Exception.Message)) — proceeding with full candidate list"
            }
        }

        # Build compact candidate JSON
        $CandidateList = foreach ($Cand in $Candidates) {
            $Entry = [ordered]@{
                id    = $Cand.id
                pov   = $NodePovMap[$Cand.id]
                label = $Cand.label
            }
            if ($Cand.PSObject.Properties['category'])    { $Entry['category']    = $Cand.category }
            if ($Cand.PSObject.Properties['description']) {
                $Desc = $Cand.description
                if ($Desc.Length -gt 200) { $Desc = $Desc.Substring(0, 197) + '...' }
                $Entry['description'] = $Desc
            }
            $Entry
        }
        $CandidateJson = $CandidateList | ConvertTo-Json -Depth 5

        # Build source node context (full detail)
        $SourceContext = [ordered]@{
            id          = $Node.id
            pov         = $PovKey
            label       = $Node.label
        }
        if ($Node.PSObject.Properties['description']) { $SourceContext['description'] = $Node.description }
        if ($Node.PSObject.Properties['category'])         { $SourceContext['category']        = $Node.category }
        if ($PovKey -eq 'situations' -and $Node.PSObject.Properties['interpretations']) {
            $SourceContext['interpretations'] = $Node.interpretations
        }
        if ($Node.PSObject.Properties['graph_attributes']) { $SourceContext['graph_attributes'] = $Node.graph_attributes }

        $SourceJson = $SourceContext | ConvertTo-Json -Depth 10

        $FullPrompt = @"
$SystemPrompt

--- SOURCE NODE ---
$SourceJson

--- CANDIDATE NODES ---
$CandidateJson

$SchemaPrompt
"@

        # ── DryRun: show first node prompt and exit ──
        if ($DryRun) {
            Write-Host ''
            Write-Host '=== PROMPT PREVIEW (first node) ===' -ForegroundColor Cyan
            Write-Host ''
            $Lines = $SystemPrompt -split "`n"
            if ($Lines.Count -gt 15) {
                Write-Host ($Lines[0..14] -join "`n") -ForegroundColor DarkGray
                Write-Host "  ... ($($Lines.Count) total lines)" -ForegroundColor DarkGray
            } else {
                Write-Host $SystemPrompt -ForegroundColor DarkGray
            }
            Write-Host ''
            Write-Host '--- SOURCE NODE ---' -ForegroundColor Yellow
            Write-Host $SourceJson -ForegroundColor White
            Write-Host ''
            Write-Host '--- CANDIDATE NODES ---' -ForegroundColor Yellow
            $CandCount = @($Candidates).Count
            Write-Host "($CandCount candidates, ~$($CandidateJson.Length) chars)" -ForegroundColor DarkGray
            if ($Embeddings.Count -gt 0) {
                Write-Host "  (filtered from $($AllNodes.Count) using embeddings)" -ForegroundColor DarkGray
            }
            Write-Host ''
            Write-Host "Total prompt length: ~$($FullPrompt.Length) chars (~$([Math]::Round($FullPrompt.Length / 4)) tokens est.)" -ForegroundColor Cyan
            Write-Host "Nodes to process: $($NodesToProcess.Count)" -ForegroundColor Cyan
            return [PSCustomObject]@{
                ShouldReturn           = $true
                TotalProcessed         = 0
                TotalEdges             = 0
                TotalFailed            = 0
                NewEdgeTypes           = [System.Collections.Generic.List[PSObject]]::new()
                MissingRationaleCount  = $MissingRationaleCount
            }
        }

        $NodePrompts[$Node.id] = $FullPrompt
        $NodeCandidateIds[$Node.id] = @($Candidates | ForEach-Object { $_.id })
    }

    # ── Step 8: Execute per-node edge discovery ──
    $TotalProcessed = 0
    $TotalEdges     = 0
    $TotalFailed    = 0
    $NewEdgeTypes   = [System.Collections.Generic.List[PSObject]]::new()

    # Shared save-checkpoint logic (called in sequential mode)
    $SaveCheckpoint = {
        param([string]$Path, [PSObject]$Data, [System.Collections.Generic.List[PSObject]]$List)
        $Data.edges         = $List.ToArray()
        $Data.last_modified = (Get-Date).ToString('yyyy-MM-dd')
        Write-EdgesFile -EdgesData $Data -Path $Path
        Write-Info "Checkpoint saved ($($List.Count) edges)"
    }

    if ($MaxConcurrent -le 1) {
        # ── Sequential path (with checkpointing) ──
        $NodeNum = 0
        foreach ($Node in $NodesToProcess) {
            $NodeNum++
            $PovKey = $NodePovMap[$Node.id]
            Write-Step "[$NodeNum/$($NodesToProcess.Count)] $($Node.id) ($PovKey)"

            $Disc = Invoke-NodeEdgeDiscovery `
                -Node            $Node `
                -FullPrompt      $NodePrompts[$Node.id] `
                -Model           $Model `
                -ApiKey          $ResolvedKey `
                -Temperature     $Temperature `
                -ResponseSchema  $EdgeSchema

            # ── Process result ──
            if ($Disc.Error) {
                Write-Fail "$($Disc.NodeId): $($Disc.Error)"
                $TotalFailed++
                continue
            }

            Write-Info "$($Disc.NodeId): API response in $($Disc.ElapsedSec)s"

            $NodeEdgeCount = 0
            foreach ($Edge in @($Disc.RawEdges)) {
                if (-not ($Edge.PSObject.Properties['target'] -and
                          $Edge.PSObject.Properties['type']   -and
                          $Edge.PSObject.Properties['confidence'])) {
                    Write-Warn "$($Disc.NodeId): malformed edge (missing target/type/confidence), skipping"
                    continue
                }
                $Edge.target = ConvertTo-SurvivorNodeId -Id $Edge.target -Context "Edge discovery $($Disc.NodeId)"   # t/4356
                if (-not $NodePovMap.ContainsKey($Edge.target)) {
                    Write-Warn "$($Disc.NodeId) → $($Edge.target): target not in taxonomy, skipping"
                    continue
                }
                if ($Edge.target -eq $Disc.NodeId) {
                    Write-Warn "$($Disc.NodeId): self-edge skipped"
                    continue
                }
                # t/1093: gate via Resolve-EdgeType — accept, reclassify, or drop
                $Resolved = Resolve-EdgeType -Type $Edge.type
                if ($Resolved.Action -eq 'drop') {
                    Write-Warn "$($Disc.NodeId) → $($Edge.target): dropped type='$($Edge.type)' — $($Resolved.Reason)"
                    continue
                }
                $CanonicalType = $Resolved.Type
                if ($Resolved.Action -eq 'reclassify') {
                    Write-Verbose "$($Disc.NodeId) → $($Edge.target): reclassified — $($Resolved.Reason)"
                }
                $Confidence = [double]$Edge.confidence
                if ($Confidence -lt 0.5) {
                    Write-Warn "$($Disc.NodeId) → $($Edge.target): confidence $Confidence < 0.5, skipping"
                    continue
                }
                $EdgeKey = "$($Disc.NodeId)|$CanonicalType|$($Edge.target)"
                if ($ExistingEdgeKeys.Contains($EdgeKey)) {
                    if ($Resolved.Action -eq 'reclassify') {
                        Write-Verbose "$($Disc.NodeId) → $($Edge.target): dedup drop ($CanonicalType already exists)"
                    } else {
                        Write-Info "$($Disc.NodeId) → $($Edge.target) ($CanonicalType): already exists, skipping"
                    }
                    continue
                }

                if ($Edge.PSObject.Properties['bidirectional']) { $Bidir = [bool]$Edge.bidirectional } else { $Bidir = $false }
                if ($Edge.PSObject.Properties['rationale'])    { $Rationale = $Edge.rationale }           else { $Rationale = '' }
                if ([string]::IsNullOrWhiteSpace($Rationale)) { $MissingRationaleCount++ }
                $EdgeObj  = [ordered]@{
                    source        = $Disc.NodeId
                    target        = $Edge.target
                    type          = $CanonicalType
                    bidirectional = $Bidir
                    confidence    = $Confidence
                    rationale     = $Rationale
                    status        = 'proposed'
                    discovered_at = (Get-Date).ToString('yyyy-MM-dd')
                    model         = $Model
                }
                if ($Edge.PSObject.Properties['weight'] -and $null -ne $Edge.weight) {
                    $W = [double]$Edge.weight
                    if ($W -ge 0.0 -and $W -le 1.0) { $EdgeObj['weight'] = $W }
                }
                if ($Edge.PSObject.Properties['strength'] -and $Edge.strength) { $EdgeObj['strength'] = $Edge.strength }
                if ($Edge.PSObject.Properties['notes']    -and $Edge.notes)    { $EdgeObj['notes']    = $Edge.notes    }
                # t/2944 write-together invariant: stamp provenance iff a non-empty rationale is set —
                # never emit rationale_source:null where the rationale is absent (absent != null contract,
                # e/120#88/#91). LLM discovery path -> 'discovery' (edge-rationale-source-marker.md).
                if (-not [string]::IsNullOrWhiteSpace([string]$Rationale)) { $EdgeObj['rationale_source'] = 'discovery' }

                $EdgesList.Add([PSCustomObject]$EdgeObj)
                [void]$ExistingEdgeKeys.Add($EdgeKey)
                if ($Bidir) { [void]$ExistingEdgeKeys.Add("$($Edge.target)|$($Edge.type)|$($Disc.NodeId)") }
                $NodeEdgeCount++
                $TotalEdges++
            }

            foreach ($NewType in @($Disc.NewEdgeTypes)) {
                Write-Info "New edge type proposed: $($NewType.type) — $(if ($NewType.PSObject.Properties['definition']) { $NewType.definition } elseif ($NewType.PSObject.Properties['description']) { $NewType.description } else { '(no definition)' })"
                $NewEdgeTypes.Add($NewType)
            }

            Write-OK "$($Disc.NodeId): $NodeEdgeCount edge(s) proposed"

            $CandIds = $NodeCandidateIds[$Disc.NodeId]
            $DiscLogEntries.Add([PSCustomObject][ordered]@{
                node_id                = $Disc.NodeId
                discovered_at          = (Get-Date).ToString('yyyy-MM-dd')
                model                  = $Model
                edge_count             = $NodeEdgeCount
                candidates_evaluated   = if ($CandIds) { $CandIds } else { @() }
            })

            # Update evaluated_pairs set for subsequent nodes in this run
            if ($CandIds) {
                foreach ($CandId in $CandIds) {
                    $PairKey = if ($Disc.NodeId -lt $CandId) { "$($Disc.NodeId)|$CandId" } else { "$CandId|$($Disc.NodeId)" }
                    [void]$EvaluatedPairs.Add($PairKey)
                }
            }

            $TotalProcessed++

            # Checkpoint
            if ($CheckpointEvery -gt 0 -and $TotalProcessed % $CheckpointEvery -eq 0) {
                if ($PSCmdlet.ShouldProcess($EdgesPath, "Write checkpoint after $TotalProcessed nodes")) {
                    try {
                        & $SaveCheckpoint $EdgesPath $EdgesData $EdgesList
                    } catch {
                        Write-Warn "Checkpoint write failed: $($_.Exception.Message)"
                    }
                }
            }
        }

    } else {
        # ── Parallel path ──
        Write-Info "Running $MaxConcurrent parallel workers"

        $DiscFnBody   = (Get-Command Invoke-NodeEdgeDiscovery).ScriptBlock.ToString()
        $AIEnrichPath = Join-Path (Join-Path $ModuleRoot '..') 'AIEnrich.psm1'
        $ParallelBag  = [System.Collections.Concurrent.ConcurrentBag[object]]::new()

        $NodesToProcess | ForEach-Object -Parallel {
            Import-Module $using:AIEnrichPath -Force
            . ([scriptblock]::Create("function Invoke-NodeEdgeDiscovery {$using:DiscFnBody}"))

            $Prompts = $using:NodePrompts
            $Disc = Invoke-NodeEdgeDiscovery `
                -Node            $_ `
                -FullPrompt      $Prompts[$_.id] `
                -Model           $using:Model `
                -ApiKey          $using:ResolvedKey `
                -Temperature     $using:Temperature `
                -ResponseSchema  $using:EdgeSchema

            [void]($using:ParallelBag).Add($Disc)

        } -ThrottleLimit $MaxConcurrent

        # ── Merge parallel results ──
        Write-Step 'Merging parallel results'

        foreach ($Disc in $ParallelBag) {
            if ($Disc.Error) {
                Write-Fail "$($Disc.NodeId): $($Disc.Error)"
                $TotalFailed++
                continue
            }

            Write-Info "$($Disc.NodeId): $($Disc.ElapsedSec)s"

            $NodeEdgeCount = 0
            foreach ($Edge in @($Disc.RawEdges)) {
                if (-not ($Edge.PSObject.Properties['target'] -and
                          $Edge.PSObject.Properties['type']   -and
                          $Edge.PSObject.Properties['confidence'])) {
                    Write-Warn "$($Disc.NodeId): malformed edge, skipping"
                    continue
                }
                $Edge.target = ConvertTo-SurvivorNodeId -Id $Edge.target -Context "Edge discovery $($Disc.NodeId)"   # t/4356
                if (-not $NodePovMap.ContainsKey($Edge.target)) {
                    Write-Warn "$($Disc.NodeId) → $($Edge.target): target not in taxonomy, skipping"
                    continue
                }
                if ($Edge.target -eq $Disc.NodeId) { continue }
                # t/1093: gate via Resolve-EdgeType — accept, reclassify, or drop
                $Resolved = Resolve-EdgeType -Type $Edge.type
                if ($Resolved.Action -eq 'drop') {
                    Write-Warn "$($Disc.NodeId) → $($Edge.target): dropped type='$($Edge.type)' — $($Resolved.Reason)"
                    continue
                }
                $CanonicalType = $Resolved.Type
                if ($Resolved.Action -eq 'reclassify') {
                    Write-Verbose "$($Disc.NodeId) → $($Edge.target): reclassified — $($Resolved.Reason)"
                }
                $Confidence = [double]$Edge.confidence
                if ($Confidence -lt 0.5) { continue }
                $EdgeKey = "$($Disc.NodeId)|$CanonicalType|$($Edge.target)"
                if ($ExistingEdgeKeys.Contains($EdgeKey)) { continue }

                if ($Edge.PSObject.Properties['bidirectional']) { $Bidir = [bool]$Edge.bidirectional } else { $Bidir = $false }
                if ($Edge.PSObject.Properties['rationale'])    { $Rationale = $Edge.rationale }           else { $Rationale = '' }
                if ([string]::IsNullOrWhiteSpace($Rationale)) { $MissingRationaleCount++ }
                $EdgeObj  = [ordered]@{
                    source        = $Disc.NodeId
                    target        = $Edge.target
                    type          = $CanonicalType
                    bidirectional = $Bidir
                    confidence    = $Confidence
                    rationale     = $Rationale
                    status        = 'proposed'
                    discovered_at = (Get-Date).ToString('yyyy-MM-dd')
                    model         = $Model
                }
                if ($Edge.PSObject.Properties['weight'] -and $null -ne $Edge.weight) {
                    $W = [double]$Edge.weight
                    if ($W -ge 0.0 -and $W -le 1.0) { $EdgeObj['weight'] = $W }
                }
                if ($Edge.PSObject.Properties['strength'] -and $Edge.strength) { $EdgeObj['strength'] = $Edge.strength }
                if ($Edge.PSObject.Properties['notes']    -and $Edge.notes)    { $EdgeObj['notes']    = $Edge.notes    }
                # t/2944 write-together invariant: stamp provenance iff a non-empty rationale is set —
                # never emit rationale_source:null where the rationale is absent (absent != null contract,
                # e/120#88/#91). LLM discovery path -> 'discovery' (edge-rationale-source-marker.md).
                if (-not [string]::IsNullOrWhiteSpace([string]$Rationale)) { $EdgeObj['rationale_source'] = 'discovery' }

                $EdgesList.Add([PSCustomObject]$EdgeObj)
                [void]$ExistingEdgeKeys.Add($EdgeKey)
                if ($Bidir) { [void]$ExistingEdgeKeys.Add("$($Edge.target)|$($Edge.type)|$($Disc.NodeId)") }
                $NodeEdgeCount++
                $TotalEdges++
            }

            foreach ($NewType in @($Disc.NewEdgeTypes)) {
                Write-Info "New edge type proposed: $($NewType.type) — $(if ($NewType.PSObject.Properties['definition']) { $NewType.definition } elseif ($NewType.PSObject.Properties['description']) { $NewType.description } else { '(no definition)' })"
                $NewEdgeTypes.Add($NewType)
            }

            Write-OK "$($Disc.NodeId): $NodeEdgeCount edge(s)"

            $CandIds2 = $NodeCandidateIds[$Disc.NodeId]
            $DiscLogEntries.Add([PSCustomObject][ordered]@{
                node_id                = $Disc.NodeId
                discovered_at          = (Get-Date).ToString('yyyy-MM-dd')
                model                  = $Model
                edge_count             = $NodeEdgeCount
                candidates_evaluated   = if ($CandIds2) { $CandIds2 } else { @() }
            })

            $TotalProcessed++
        }
    }

    return [PSCustomObject]@{
        ShouldReturn           = $false
        TotalProcessed         = $TotalProcessed
        TotalEdges             = $TotalEdges
        TotalFailed            = $TotalFailed
        NewEdgeTypes           = $NewEdgeTypes
        MissingRationaleCount  = $MissingRationaleCount
    }
}
