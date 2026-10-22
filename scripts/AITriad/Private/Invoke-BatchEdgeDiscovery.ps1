# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Extracted from Invoke-EdgeDiscovery's -BatchSize branch (t/3837, cyclomatic
# complexity 302 -> decomposed). Pure extraction, no behavior change: clusters
# nodes by embedding similarity, discovers edges between all pairs in each
# cluster via Invoke-NodeEdgeDiscovery (reusing its pseudo-node infrastructure),
# writes edges + discovery log, checkpoints every 5 batches.
#
# Unlike EmbeddingFirst mode, Batch mode does NOT own the whole run -- the
# original code falls through to the caller's shared Step 9/10 (schema update
# + final write + summary) except on the -DryRun preview path, which returns
# immediately. This function signals that via the ShouldReturn field rather
# than returning early from the cmdlet itself (which it cannot do).

function Invoke-BatchEdgeDiscovery {
    <#
    .SYNOPSIS
        Batch-mode edge discovery: cluster nodes, discover edges within each cluster.
    .DESCRIPTION
        See Invoke-EdgeDiscovery -BatchSize. Factored out verbatim (t/3837) --
        no logic change from the inline version it replaced.
    .OUTPUTS
        [PSCustomObject] with ShouldReturn (bool -- true only for the -DryRun
        preview path, meaning the caller must `return` immediately), plus
        TotalProcessed, TotalEdges, TotalFailed, NewEdgeTypes, and
        MissingRationaleCount for the caller to carry into Step 9/10.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$NodesToProcess,
        [Parameter(Mandatory)][int]$BatchSize,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$Embeddings,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$NodePovMap,
        [Parameter(Mandatory)][bool]$DryRun,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][double]$Temperature,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ResolvedKey,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ValidNodeIds,
        [Parameter(Mandatory)][int]$CheckpointEvery,
        [Parameter(Mandatory)][string]$EdgesPath,

        # Mutated reference-type state shared with the caller.
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$EdgesList,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$ExistingEdgeKeys,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$EvaluatedPairs,
        [Parameter(Mandatory)][PSObject]$EdgesData,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[PSObject]]$DiscLogEntries
    )

    $MissingRationaleCount = 0

    $BatchSystemPrompt = Get-Prompt -Name 'edge-discovery-batch'
    $BatchSchemaPrompt = Get-Prompt -Name 'edge-discovery-batch-schema'

    $BatchEdgeSchema = @{
        type       = 'object'
        properties = @{
            edges = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        source        = @{ type = 'string' }
                        target        = @{ type = 'string' }
                        type          = @{ type = 'string' }
                        bidirectional = @{ type = 'boolean' }
                        confidence    = @{ type = 'number' }
                        weight        = @{ type = 'number' }
                        rationale     = @{ type = 'string' }
                        strength      = @{ type = 'string'; enum = @('strong', 'moderate', 'weak') }
                        notes         = @{ type = 'string' }
                    }
                    required   = @('source', 'target', 'type', 'confidence', 'rationale')
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

    Write-Step "Clustering $($NodesToProcess.Count) nodes into batches of $BatchSize"
    $NodesToProcessArray = @($NodesToProcess.ToArray())
    $Batches = Get-NodeBatches `
        -Nodes      $NodesToProcessArray `
        -Embeddings $Embeddings `
        -NodePovMap $NodePovMap `
        -BatchSize  $BatchSize

    Write-OK "$($Batches.Count) batches created (avg $([Math]::Round($NodesToProcessArray.Count / $Batches.Count, 1)) nodes/batch)"

    if ($DryRun -and $Batches.Count -gt 0) {
        $FirstBatch = $Batches[0]
        $NodeListJson = @($FirstBatch | ForEach-Object {
            $Entry = [ordered]@{ id = $_.id; pov = $NodePovMap[$_.id]; label = $_.label }
            if ($_.PSObject.Properties['category'])    { $Entry['category']    = $_.category }
            if ($_.PSObject.Properties['description']) {
                $Desc = $_.description
                if ($Desc.Length -gt 200) { $Desc = $Desc.Substring(0, 197) + '...' }
                $Entry['description'] = $Desc
            }
            $Entry
        }) | ConvertTo-Json -Depth 5
        $PreviewPrompt = "$BatchSystemPrompt`n`n--- NODE GROUP ($($FirstBatch.Count) nodes) ---`n$NodeListJson`n`n$BatchSchemaPrompt"
        Write-Host ''
        Write-Host '=== BATCH PROMPT PREVIEW (first batch) ===' -ForegroundColor Cyan
        Write-Host "Batch contains: $($FirstBatch | ForEach-Object { $_.id } | Join-String -Separator ', ')" -ForegroundColor Yellow
        Write-Host "Total prompt length: ~$($PreviewPrompt.Length) chars (~$([Math]::Round($PreviewPrompt.Length / 4)) tokens est.)" -ForegroundColor Cyan
        Write-Host "Batches: $($Batches.Count), API calls saved: $($NodesToProcessArray.Count - $Batches.Count)" -ForegroundColor Green
        return [PSCustomObject]@{
            ShouldReturn           = $true
            TotalProcessed         = 0
            TotalEdges             = 0
            TotalFailed            = 0
            NewEdgeTypes           = [System.Collections.Generic.List[PSObject]]::new()
            MissingRationaleCount  = $MissingRationaleCount
        }
    }

    # Execute batch discovery
    $TotalProcessed = 0
    $TotalEdges     = 0
    $TotalFailed    = 0
    $NewEdgeTypes   = [System.Collections.Generic.List[PSObject]]::new()

    $BatchNum = 0
    foreach ($Batch in $Batches) {
        $BatchNum++
        $BatchNodeIds = @($Batch | ForEach-Object { $_.id })
        Write-Step "[$BatchNum/$($Batches.Count)] Batch: $($BatchNodeIds.Count) nodes"

        # Build node group JSON (full detail for batch)
        $NodeListJson = @($Batch | ForEach-Object {
            $N = $_
            $Entry = [ordered]@{ id = $N.id; pov = $NodePovMap[$N.id]; label = $N.label }
            if ($N.PSObject.Properties['category'])    { $Entry['category']    = $N.category }
            if ($N.PSObject.Properties['description']) {
                $Desc = $N.description
                if ($Desc.Length -gt 300) { $Desc = $Desc.Substring(0, 297) + '...' }
                $Entry['description'] = $Desc
            }
            if ($NodePovMap[$N.id] -eq 'situations' -and $N.PSObject.Properties['interpretations']) {
                $Entry['interpretations'] = $N.interpretations
            }
            $Entry
        }) | ConvertTo-Json -Depth 10

        $BatchPrompt = @"
$BatchSystemPrompt

--- NODE GROUP ($($BatchNodeIds.Count) nodes) ---
$NodeListJson

$BatchSchemaPrompt
"@

        # Create a pseudo-node for Invoke-NodeEdgeDiscovery (reuse existing infrastructure)
        $PseudoNode = [PSCustomObject]@{ id = "batch-$BatchNum" }
        $Disc = Invoke-NodeEdgeDiscovery `
            -Node            $PseudoNode `
            -FullPrompt      $BatchPrompt `
            -Model           $Model `
            -ApiKey          $ResolvedKey `
            -Temperature     $Temperature `
            -ResponseSchema  $BatchEdgeSchema

        if ($Disc.Error) {
            Write-Fail "Batch ${BatchNum}: $($Disc.Error)"
            $TotalFailed++
            continue
        }

        Write-Info "Batch ${BatchNum}: API response in $($Disc.ElapsedSec)s"

        $BatchEdgeCount = 0
        foreach ($Edge in @($Disc.RawEdges)) {
            # Batch mode: edges have 'source' field instead of inheriting from source node
            $SourceId = if ($Edge.PSObject.Properties['source']) { $Edge.source } else { $null }
            $TargetId = if ($Edge.PSObject.Properties['target']) { $Edge.target } else { $null }
            if (-not $SourceId -or -not $TargetId -or
                -not $Edge.PSObject.Properties['type'] -or
                -not $Edge.PSObject.Properties['confidence']) {
                Write-Warn "Batch ${BatchNum}: malformed edge (missing source/target/type/confidence), skipping"
                continue
            }
            $SourceId = ConvertTo-SurvivorNodeId -Id $SourceId -Context "Edge discovery batch $BatchNum"   # t/4356
            $TargetId = ConvertTo-SurvivorNodeId -Id $TargetId -Context "Edge discovery batch $BatchNum"
            $Edge.source = $SourceId; $Edge.target = $TargetId
            if (-not $ValidNodeIds.Contains($SourceId)) {
                Write-Warn "Batch ${BatchNum}: source '$SourceId' not in taxonomy, skipping"
                continue
            }
            if (-not $ValidNodeIds.Contains($TargetId)) {
                Write-Warn "Batch ${BatchNum}: target '$TargetId' not in taxonomy, skipping"
                continue
            }
            if ($SourceId -eq $TargetId) { continue }
            # t/1093: gate every edge through Resolve-EdgeType — accept, reclassify, or drop
            $Resolved = Resolve-EdgeType -Type $Edge.type
            if ($Resolved.Action -eq 'drop') {
                Write-Warn "Batch ${BatchNum}: dropped edge $SourceId→$TargetId type='$($Edge.type)' — $($Resolved.Reason)"
                continue
            }
            $CanonicalType = $Resolved.Type
            if ($Resolved.Action -eq 'reclassify') {
                Write-Verbose "Batch ${BatchNum}: reclassified $SourceId→$TargetId — $($Resolved.Reason)"
            }
            $Confidence = [double]$Edge.confidence
            if ($Confidence -lt 0.5) { continue }
            $EdgeKey = "$SourceId|$CanonicalType|$TargetId"
            if ($ExistingEdgeKeys.Contains($EdgeKey)) {
                if ($Resolved.Action -eq 'reclassify') {
                    Write-Verbose "Batch ${BatchNum}: dedup drop $SourceId→$TargetId ($CanonicalType already exists)"
                }
                continue
            }

            if ($Edge.PSObject.Properties['bidirectional']) { $Bidir = [bool]$Edge.bidirectional } else { $Bidir = $false }
            if ($Edge.PSObject.Properties['rationale'])    { $Rationale = $Edge.rationale }           else { $Rationale = '' }
            if ([string]::IsNullOrWhiteSpace($Rationale)) { $MissingRationaleCount++ }
            $EdgeObj = [ordered]@{
                source        = $SourceId
                target        = $TargetId
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
            if ($Bidir) { [void]$ExistingEdgeKeys.Add("$TargetId|$CanonicalType|$SourceId") }
            $BatchEdgeCount++
            $TotalEdges++
        }

        foreach ($NewType in @($Disc.NewEdgeTypes)) {
            Write-Info "New edge type proposed: $($NewType.type) — $(if ($NewType.PSObject.Properties['definition']) { $NewType.definition } elseif ($NewType.PSObject.Properties['description']) { $NewType.description } else { '(no definition)' })"
            $NewEdgeTypes.Add($NewType)
        }

        Write-OK "Batch ${BatchNum}: $BatchEdgeCount edge(s) proposed"

        # Log all pairs in this batch as evaluated
        $DiscLogEntries.Add([PSCustomObject][ordered]@{
            node_id              = "batch-$BatchNum"
            discovered_at        = (Get-Date).ToString('yyyy-MM-dd')
            model                = $Model
            edge_count           = $BatchEdgeCount
            candidates_evaluated = $BatchNodeIds
            batch_mode           = $true
        })

        # Update evaluated_pairs for all pairs in this batch
        for ($i = 0; $i -lt $BatchNodeIds.Count; $i++) {
            for ($j = $i + 1; $j -lt $BatchNodeIds.Count; $j++) {
                $A = $BatchNodeIds[$i]; $B = $BatchNodeIds[$j]
                $PairKey = if ($A -lt $B) { "$A|$B" } else { "$B|$A" }
                [void]$EvaluatedPairs.Add($PairKey)
            }
        }

        $TotalProcessed += $BatchNodeIds.Count

        # Checkpoint every 5 batches
        if ($CheckpointEvery -gt 0 -and $BatchNum % 5 -eq 0) {
            if ($PSCmdlet.ShouldProcess($EdgesPath, "Write checkpoint after batch $BatchNum")) {
                try {
                    $EdgesData.edges         = $EdgesList.ToArray()
                    $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
                    Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
                    Write-Info "Checkpoint saved ($($EdgesList.Count) edges)"
                } catch {
                    Write-Warn "Checkpoint write failed: $($_.Exception.Message)"
                }
            }
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
