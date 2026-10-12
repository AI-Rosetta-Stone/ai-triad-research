# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Generates a multi-POV AI summary for a single document.
.DESCRIPTION
    Core summarization worker called by Invoke-POVSummary and Invoke-BatchSummary.
    Reads the document's snapshot.md, builds a density-scaled prompt with the
    current taxonomy, and calls the AI API to produce a structured JSON summary
    containing per-POV key_points, factual_claims, and unmapped_concepts.

    Documents under ~20,000 estimated tokens use a single API call with density
    validation and one retry.  Larger documents are automatically split into
    semantically coherent chunks (via Split-DocumentChunks), each chunk is
    summarized independently, and results are merged (via Merge-ChunkSummaries)
    with deduplication.

    The output is written to summaries/<doc-id>.json and the source's
    metadata.json is updated with summary_status='current'.
.PARAMETER Doc
    Hashtable with document context: DocId, Meta, PovTags, SnapshotFile, MetaFile.
    Built by the calling cmdlet from the source directory.
.PARAMETER ApiKey
    AI API key for the configured backend.
.PARAMETER Model
    AI model identifier (e.g., 'gemini-3.5-flash-lite').  Must be registered in
    ai-models.json.
.PARAMETER Temperature
    Sampling temperature for the AI call.  Lower values produce more deterministic
    output.
.PARAMETER TaxonomyVersion
    Current taxonomy version string (from TAXONOMY_VERSION file).
.PARAMETER TaxonomyJson
    Serialized JSON of the full taxonomy, injected into the prompt for node
    mapping.
.PARAMETER SystemPromptTemplate
    The system prompt template with {{WORD_COUNT}}, {{KP_MIN}}, etc. placeholders
    for density scaling.
.PARAMETER ChunkSystemPromptTemplate
    Optional override prompt for chunk-level summarization.  If empty, the
    'pov-summary-chunk-system' prompt is loaded from Prompts/.
.PARAMETER OutputSchema
    JSON schema string that the AI response must conform to.
.PARAMETER SummariesDir
    Absolute path to the summaries output directory.
.PARAMETER Now
    ISO timestamp for the generated_at field.
.EXAMPLE
    # Typically called internally by Invoke-POVSummary:
    $Result = Invoke-DocumentSummary -Doc $DocContext -ApiKey $Key -Model 'gemini-3.5-flash-lite' `
        -Temperature 0.1 -TaxonomyVersion '4.2' -TaxonomyJson $TaxJson `
        -SystemPromptTemplate $Prompt -OutputSchema $Schema -SummariesDir $OutDir -Now (Get-Date -Format 'o')
    if ($Result.Success) { Write-Host "Generated $($Result.TotalPoints) key points" }
#>
function Invoke-DocumentSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Doc,
        [Parameter(Mandatory)][string]$ApiKey,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][double]$Temperature,
        [Parameter(Mandatory)][string]$TaxonomyVersion,
        [Parameter(Mandatory)][string]$TaxonomyJson,
        [Parameter(Mandatory)][string]$SystemPromptTemplate,
        [string]$ChunkSystemPromptTemplate = '',
        [Parameter(Mandatory)][string]$OutputSchema,
        [Parameter(Mandatory)][string]$SummariesDir,
        [Parameter(Mandatory)][string]$Now,
        [switch]$IterativeExtraction,
        [switch]$AutoFire,

        # Directional polarity gate. DEFAULT ON as of t/2912 — promoted after the
        # durable two-stage LLM-judge fix (t/2900) cleared both-arms GV + a clean
        # observe cycle (121 deberta false-positives caught, 0 bad flips on a real
        # sample). It was default-OFF under t/2896 while deberta over-flagged solo.
        # Kill switch: pass -EnablePolarityGate:$false to disable.
        [bool]$EnablePolarityGate = $true
    )

    Set-StrictMode -Version Latest

    $ThisDocId = $Doc.DocId
    $Meta      = $Doc.Meta
    $ChunkThresholdTokens = 20000   # Documents above this get chunked

    # Tag every downstream [AI] log line in this runspace with the doc id so that
    # in a parallel batch (one worker runspace per doc) an interleaved backend
    # line can be attributed to the document that produced it (t/1647). This is
    # the single set-point that feeds all AI calls the worker makes — single-call,
    # chunked, and FIRE/IterativeExtraction paths all run in this same runspace.
    Set-AIApiCorrelationId $ThisDocId
    $script:ContextRotStages = @()  # accumulator for context-rot instrumentation

    Write-Host "`n  ┌─ $ThisDocId" -ForegroundColor White
    Write-Host "  │  pov: $($Doc.PovTags -join ', ')  |  model: $Model" -ForegroundColor Gray

    # -- Load snapshot --------------------------------------------------------
    $SnapshotText = Get-Content $Doc.SnapshotFile -Raw
    if ([string]::IsNullOrWhiteSpace($SnapshotText)) {
        Write-Host "  └─ SKIP $ThisDocId — snapshot.md is empty" -ForegroundColor Yellow
        return @{ Success = $false; DocId = $ThisDocId; Error = 'EmptySnapshot' }
    }
    $EstimatedTokens = [int]($SnapshotText.Length / 4)
    Write-Host "  │  snapshot: $($SnapshotText.Length) chars (~$EstimatedTokens tokens est.)" -ForegroundColor Gray

    # -- Decide: single-call or chunked pipeline ------------------------------
    if ($EstimatedTokens -gt $ChunkThresholdTokens) {
        Write-Host "  │  ✨ Large document — using chunked pipeline" -ForegroundColor Cyan
        $ChunkedParams = Get-ChunkedSummaryParameters -BoundParameters $PSBoundParameters
        return Invoke-ChunkedSummary @ChunkedParams
    }

    # ========================================================================
    # SINGLE-CALL PATH (small documents) — delegates to shared pipeline
    # ========================================================================

    Write-Host "  │  Running extraction pipeline..." -ForegroundColor Gray

    $PipelineResult = Invoke-SummaryPipeline `
        -SnapshotText          $SnapshotText `
        -DocId                 $ThisDocId `
        -Metadata              $Meta `
        -ApiKey                $ApiKey `
        -Model                 $Model `
        -Temperature           $Temperature `
        -TaxonomyVersion       $TaxonomyVersion `
        -SystemPromptTemplate  $SystemPromptTemplate `
        -OutputSchema          $OutputSchema `
        -IterativeExtraction:$IterativeExtraction `
        -AutoFire:$AutoFire

    if (-not $PipelineResult.Success) {
        Write-Host "  └─ ✗ FAILED: $ThisDocId — $($PipelineResult.Error)" -ForegroundColor Red
        return @{ Success = $false; DocId = $ThisDocId; Error = $PipelineResult.Error }
    }

    $Elapsed = [TimeSpan]::FromSeconds($PipelineResult.ElapsedSeconds)
    Write-Host "  │  ✓ Pipeline complete ($($PipelineResult.Backend)): $([int]$Elapsed.TotalSeconds)s" -ForegroundColor Green

    return Finalize-Summary -SummaryObject $PipelineResult.Summary -ThisDocId $ThisDocId `
        -TaxonomyVersion $TaxonomyVersion -Model $Model -Temperature $Temperature `
        -Now $Now -SummariesDir $SummariesDir -Doc $Doc -Elapsed $Elapsed `
        -TaxonomyJson $PipelineResult.TaxonomyJson -MaxTokens $PipelineResult['MaxTokens'] `
        -FireStats $PipelineResult.FireStats -EnablePolarityGate $EnablePolarityGate
}

# ============================================================================
# CHUNKED PIPELINE (large documents)
# ============================================================================

function Get-ChunkedSummaryParameters {
    <#
    .SYNOPSIS
        Invoke-DocumentSummary's bound parameters, minus the ones the chunked path cannot honour.
    .DESCRIPTION
        -IterativeExtraction and -AutoFire select FIRE, which runs only on the single-call path
        (Invoke-SummaryPipeline -> Invoke-IterativeExtraction over the whole snapshot). The chunked
        path makes one plain extraction call per chunk and has no FIRE stage, so it does not declare
        them, and splatting them threw "A parameter cannot be found" (t/4144). They are dropped here,
        with a WARN naming each switch that was set, because the caller asked for FIRE and is not
        getting it.
    #>
    param([Parameter(Mandatory)][System.Collections.IDictionary]$BoundParameters)
    $Params = @{}
    foreach ($Key in $BoundParameters.Keys) { $Params[$Key] = $BoundParameters[$Key] }
    foreach ($Name in 'IterativeExtraction', 'AutoFire') {
        if (-not $Params.ContainsKey($Name)) { continue }
        if ($Params[$Name]) {
            Write-Warning "Invoke-DocumentSummary: -$Name ignored for $($Params['Doc'].DocId) — the chunked pipeline (large document) has no FIRE stage; running single-shot extraction per chunk."
        }
        $Params.Remove($Name)
    }
    $Params
}

function Invoke-ChunkedSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Doc,
        [Parameter(Mandatory)][string]$ApiKey,
        [Parameter(Mandatory)][string]$Model,
        [Parameter(Mandatory)][double]$Temperature,
        [Parameter(Mandatory)][string]$TaxonomyVersion,
        [Parameter(Mandatory)][string]$TaxonomyJson,
        [Parameter(Mandatory)][string]$SystemPromptTemplate,
        [string]$ChunkSystemPromptTemplate = '',
        [Parameter(Mandatory)][string]$OutputSchema,
        [Parameter(Mandatory)][string]$SummariesDir,
        [Parameter(Mandatory)][string]$Now,
        # Forwarded from Invoke-DocumentSummary (@PSBoundParameters) and passed to Finalize-Summary.
        [bool]$EnablePolarityGate = $true
    )

    $ThisDocId = $Doc.DocId
    $Meta      = $Doc.Meta
    $SnapshotText = Get-Content $Doc.SnapshotFile -Raw

    # -- Split into chunks ----------------------------------------------------
    $Chunks = @(Split-DocumentChunks -Text $SnapshotText -MaxChunkTokens 6000 -MinChunkTokens 1500)
    $ChunkCount = $Chunks.Count
    Write-Host "  │  split into $ChunkCount chunks" -ForegroundColor Cyan

    # -- Context-rot: chunking metrics ----------------------------------------
    $InputTokensEst = [int]($SnapshotText.Length / 4)
    $ChunkTokensSum = 0
    foreach ($c in $Chunks) { $ChunkTokensSum += [int]($c.Length / 4) }
    $script:ContextRotStages += @(New-ContextRotStage `
        -Stage 'chunking' -InUnits 'tokens_est' -InCount $InputTokensEst `
        -OutUnits 'tokens_est' -OutCount $ChunkTokensSum `
        -Flags @{ chunk_count = $ChunkCount })

    # -- Load chunk-specific system prompt ------------------------------------
    if ($ChunkSystemPromptTemplate) {
        $ChunkSystemPrompt = $ChunkSystemPromptTemplate
    } else {
        $ChunkSystemPrompt = Get-Prompt -Name 'pov-summary-chunk-system'
    }
    $DocHeader = Build-DocHeader -Doc $Doc -Meta $Meta -ThisDocId $ThisDocId

    # -- Pre-compute all chunk RAG query embeddings in ONE batch subprocess ----
    # Get-RelevantTaxonomyNodes embeds the query via a cold ~6s model-load per
    # call; batching all chunk queries up front loads the model once. Queries are
    # truncated to 2000 chars to match Get-RelevantTaxonomyNodes' own truncation.
    $ChunkQueryTexts = [System.Collections.Generic.List[string]]::new()
    foreach ($Ck in $Chunks) {
        if ($Ck.Length -gt 2000) { $ChunkQueryTexts.Add($Ck.Substring(0, 2000)) } else { $ChunkQueryTexts.Add($Ck) }
    }
    $ChunkQueryEmb = Invoke-BatchEmbeddings -Texts $ChunkQueryTexts.ToArray()

    # -- Process each chunk sequentially (API rate limits) --------------------
    $StartTime = Get-Date
    $ChunkResults = [System.Collections.Generic.List[object]]::new()
    $FailedChunks = 0
    $ChunkRAGMetrics = [System.Collections.Generic.List[object]]::new()
    $ChunkExtractionStats = @{ TotalPoints = 0; NullNodes = 0; FactualClaims = 0; UnmappedConcepts = 0; PromptChars = 0 }
    $ChunkMaxTokens = 65536   # every chunk's extraction call; recorded as model_info.max_tokens (t/4079)

    for ($i = 0; $i -lt $ChunkCount; $i++) {
        $ChunkNum = $i + 1
        $ChunkText = $Chunks[$i]
        $ChunkTokens = [int]($ChunkText.Length / 4)

        Write-Host "  │  chunk $ChunkNum/$ChunkCount (~$ChunkTokens tokens)..." -ForegroundColor Gray -NoNewline

        # Per-chunk relevance filtering: use chunk text as query for better node selection
        $ChunkTaxonomy = $null
        $script:LastRAGMetrics = $null
        try {
            # Use the pre-computed (batched) query vector when available; falls
            # back to an in-call encode if the batch produced no vector for it.
            if ($ChunkText.Length -gt 2000) { $ChunkQueryText = $ChunkText.Substring(0, 2000) } else { $ChunkQueryText = $ChunkText }
            if ($ChunkQueryEmb.ContainsKey($ChunkQueryText)) { $ChunkQVec = $ChunkQueryEmb[$ChunkQueryText] } else { $ChunkQVec = @() }
            $ChunkRelevant = Get-RelevantTaxonomyNodes -Query $ChunkText -QueryVector $ChunkQVec `
                -MaxTotal 150 -TopK 60 -MinPerCategory 2 `
                -IncludeSituations -Format context -ApiKey $ApiKey
            if ($ChunkRelevant) {
                $ChunkTaxonomy = $ChunkRelevant
                Write-Verbose "  Chunk $ChunkNum`: RAG-filtered to ~40 nodes"
            }
        }
        catch {
            Write-Verbose "  Chunk $ChunkNum`: RAG fallback — using compact taxonomy"
        }
        if ($script:LastRAGMetrics) {
            $null = $ChunkRAGMetrics.Add($script:LastRAGMetrics)
            $script:LastRAGMetrics = $null
        }
        if (-not $ChunkTaxonomy) {
            $ChunkTaxonomy = Build-CompactTaxonomy
        }

        $ChunkSysInstruction = @"
$ChunkSystemPrompt

=== OUTPUT SCHEMA (your response must match this structure) ===
$OutputSchema
"@

        $ChunkPrompt = @"
=== TAXONOMY (version $TaxonomyVersion) ===
$ChunkTaxonomy

$DocHeader

--- DOCUMENT SECTION $ChunkNum OF $ChunkCount ---
$ChunkText
"@

        try {
            $__ApiSw = [System.Diagnostics.Stopwatch]::StartNew()
            $AIResult = Invoke-AIApi `
                -Prompt     $ChunkPrompt `
                -SystemInstruction $ChunkSysInstruction `
                -Model      $Model `
                -ApiKey     $ApiKey `
                -Temperature $Temperature `
                -MaxTokens  $ChunkMaxTokens `
                -JsonMode `
                -TimeoutSec 600 `
                -MaxRetries 3 `
                -RetryDelays @(5, 15, 45)
            $__ApiSw.Stop()
            Add-StageTiming -Name 'api.extraction (chunk)' -Milliseconds $__ApiSw.Elapsed.TotalMilliseconds

            if ($null -eq $AIResult) {
                Write-Host " ✗ null response" -ForegroundColor Red
                $FailedChunks++
                continue
            }

            if ($AIResult.PSObject.Properties['Truncated'] -and $AIResult.Truncated) {
                Write-Host " ⚠ TRUNCATED — output exceeded model limit, extraction may be incomplete" -ForegroundColor Yellow
            }

            $ChunkObj = Parse-AIResponse -RawText $AIResult.Text -ThisDocId "$ThisDocId-chunk$ChunkNum" -SummariesDir $SummariesDir
            if ($null -eq $ChunkObj) {
                Write-Host " ✗ bad JSON" -ForegroundColor Red
                $FailedChunks++
                continue
            }

            $ChunkResults.Add($ChunkObj)
            $ChunkPts = 0
            $ChunkNulls = 0
            foreach ($c in @('accelerationist','safetyist','skeptic')) {
                $campObj = $ChunkObj.pov_summaries.$c
                if ($campObj -and $campObj.PSObject.Properties['key_points'] -and $campObj.key_points) {
                    $pts = @($campObj.key_points)
                    $ChunkPts += $pts.Count
                    $ChunkNulls += @($pts | Where-Object { $null -eq $_.taxonomy_node_id }).Count
                }
            }
            $ChunkFacts = if ($ChunkObj.PSObject.Properties['factual_claims'] -and $ChunkObj.factual_claims) { @($ChunkObj.factual_claims).Count } else { 0 }
            $ChunkUnmapped = if ($ChunkObj.PSObject.Properties['unmapped_concepts'] -and $ChunkObj.unmapped_concepts) { @($ChunkObj.unmapped_concepts).Count } else { 0 }
            $ChunkExtractionStats.TotalPoints += $ChunkPts
            $ChunkExtractionStats.NullNodes += $ChunkNulls
            $ChunkExtractionStats.FactualClaims += $ChunkFacts
            $ChunkExtractionStats.UnmappedConcepts += $ChunkUnmapped
            $ChunkExtractionStats.PromptChars += $ChunkPrompt.Length
            if ($ChunkPts -eq 0) {
                Write-Host " ⚠ 0 points (chunk may be non-substantive or extraction failed silently)" -ForegroundColor Yellow
            } elseif ($ChunkPts -lt 3) {
                Write-Host " ⚠ $ChunkPts points (sparse)" -ForegroundColor Yellow
            } else {
                Write-Host " ✓ $ChunkPts points" -ForegroundColor Green
            }

        } catch {
            Write-Host " ✗ $_" -ForegroundColor Red
            $FailedChunks++
        }
    }

    $Elapsed = (Get-Date) - $StartTime

    if ($ChunkResults.Count -eq 0) {
        Write-Host "  └─ ✗ All $ChunkCount chunks failed" -ForegroundColor Red
        return @{ Success = $false; DocId = $ThisDocId; Error = "All $ChunkCount chunks failed" }
    }

    if ($FailedChunks -gt 0) {
        Write-Host "  │  ⚠ $FailedChunks/$ChunkCount chunks failed (proceeding with $($ChunkResults.Count) successful)" -ForegroundColor Yellow
    }

    # -- Context-rot: aggregated per-chunk RAG + extraction metrics -----------
    if ($ChunkRAGMetrics.Count -gt 0) {
        $TotalIn = 0; $TotalOut = 0; $TotalForced = 0
        $BeliefsSum = 0; $DesiresSum = 0; $IntentionsSum = 0
        $MinNodes = [int]::MaxValue; $MaxNodes = 0
        foreach ($rm in $ChunkRAGMetrics) {
            $TotalIn += $rm.in_count; $TotalOut += $rm.out_count
            $TotalForced += ($rm.flags.below_threshold_forced ?? 0)
            $BeliefsSum += ($rm.flags.beliefs_selected ?? 0)
            $DesiresSum += ($rm.flags.desires_selected ?? 0)
            $IntentionsSum += ($rm.flags.intentions_selected ?? 0)
            if ($rm.out_count -lt $MinNodes) { $MinNodes = [int]$rm.out_count }
            if ($rm.out_count -gt $MaxNodes) { $MaxNodes = [int]$rm.out_count }
        }
        $script:ContextRotStages += @(New-ContextRotStage `
            -Stage 'rag_filtering' -InUnits 'nodes' -InCount ([int]($TotalIn / $ChunkRAGMetrics.Count)) `
            -OutUnits 'nodes' -OutCount ([int]($TotalOut / $ChunkRAGMetrics.Count)) `
            -Flags @{
                chunk_count            = $ChunkRAGMetrics.Count
                avg_nodes_selected     = [Math]::Round($TotalOut / $ChunkRAGMetrics.Count, 0)
                min_nodes_selected     = $MinNodes
                max_nodes_selected     = $MaxNodes
                total_below_threshold  = $TotalForced
                avg_beliefs            = [Math]::Round($BeliefsSum / $ChunkRAGMetrics.Count, 0)
                avg_desires            = [Math]::Round($DesiresSum / $ChunkRAGMetrics.Count, 0)
                avg_intentions         = [Math]::Round($IntentionsSum / $ChunkRAGMetrics.Count, 0)
            })
    }
    if ($ChunkExtractionStats.TotalPoints -gt 0 -or $ChunkExtractionStats.PromptChars -gt 0) {
        $TotalItems = $ChunkExtractionStats.TotalPoints + $ChunkExtractionStats.FactualClaims + $ChunkExtractionStats.UnmappedConcepts
        $NullRate = if ($ChunkExtractionStats.TotalPoints -gt 0) {
            [Math]::Round($ChunkExtractionStats.NullNodes / $ChunkExtractionStats.TotalPoints, 4)
        } else { 0 }
        $script:ContextRotStages += @(New-ContextRotStage `
            -Stage 'extraction' -InUnits 'prompt_chars' -InCount $ChunkExtractionStats.PromptChars `
            -OutUnits 'items' -OutCount $TotalItems `
            -Flags @{
                null_node_rate    = $NullRate
                total_points      = $ChunkExtractionStats.TotalPoints
                factual_claims    = $ChunkExtractionStats.FactualClaims
                unmapped_concepts = $ChunkExtractionStats.UnmappedConcepts
                chunk_count       = $ChunkResults.Count
            })
    }

    # -- Merge chunk results --------------------------------------------------
    Write-Host "  │  merging $($ChunkResults.Count) chunk results..." -ForegroundColor Cyan
    $__MergeSw = [System.Diagnostics.Stopwatch]::StartNew()
    $MergedObject = Merge-ChunkSummaries -ChunkResults @($ChunkResults)
    $__MergeSw.Stop()
    Add-StageTiming -Name 'merge.total (incl. embed dedup)' -Milliseconds $__MergeSw.Elapsed.TotalMilliseconds

    # Capture context-rot merge metrics before stripping the internal field
    if ($MergedObject['_merge_metrics']) {
        $script:ContextRotStages += @($MergedObject['_merge_metrics'])
        $MergedObject.Remove('_merge_metrics')
    }

    # Convert ordered hashtable to PSCustomObject for consistent downstream handling
    $SummaryObject = [PSCustomObject]$MergedObject

    Write-Host "  │  ✓ Merged ($([int]$Elapsed.TotalSeconds)s total, $ChunkCount chunks)" -ForegroundColor Green

    # -- Density check on merged result (warn only, no retry for chunked) ----
    # Scale floors by merge discount — chunked extraction produces less per-unit
    # than single-pass because each chunk has limited cross-chunk context
    $WordCount = ($SnapshotText -split '\s+').Count
    $DensityFloors = Get-DensityFloors -WordCount $WordCount
    $MergeDiscount = 1 / [Math]::Sqrt($ChunkCount)
    $DensityFloors.KpMin = [Math]::Max(3, [int]($DensityFloors.KpMin * $MergeDiscount))
    $DensityFloors.UcMin = [Math]::Max(1, [int]($DensityFloors.UcMin * $MergeDiscount))
    $DensityFloors.TotalFloor = [Math]::Max(6, [int]($DensityFloors.TotalFloor * $MergeDiscount))
    $DensityCheck = Test-SummaryDensity -SummaryObject $SummaryObject -Floors $DensityFloors
    if (-not $DensityCheck.Pass) {
        Write-Host "  │  ⚠ Merged density below floor: $($DensityCheck.Shortfalls -join '; ')" -ForegroundColor Yellow
    }

    return Finalize-Summary -SummaryObject $SummaryObject -ThisDocId $ThisDocId `
        -TaxonomyVersion $TaxonomyVersion -Model $Model -Temperature $Temperature `
        -Now $Now -SummariesDir $SummariesDir -Doc $Doc -Elapsed $Elapsed -ChunkCount $ChunkCount `
        -TaxonomyJson $TaxonomyJson -MaxTokens $ChunkMaxTokens -EnablePolarityGate $EnablePolarityGate
}

# ============================================================================
# SHARED HELPERS
# ============================================================================

function Get-DensityFloors {
    param([int]$WordCount)

    $kpTarget = [Math]::Max(3,  [int]($WordCount / 500))
    return @{
        KpMin      = $kpTarget
        UcMin      = [Math]::Max(2,  [int]($WordCount / 2000))
        TotalFloor = [Math]::Max(6,  $kpTarget * 2)
    }
}

function Test-SummaryDensity {
    param(
        [object]$SummaryObject,
        [hashtable]$Floors
    )

    # Shared path constants (Get-SummaryProp.ps1) — the same camp list and
    # dictionary-safe reader used by the merge writer, so the checker sees the
    # exact structure Merge-ChunkSummaries stored. See t/1646.
    $Camps = $script:AITriadPovCamps
    $Shortfalls = [System.Collections.Generic.List[string]]::new()

    # Collect empty_cells declared by the model (licensed emptiness per REC-1)
    $EmptyCellSet = [System.Collections.Generic.HashSet[string]]::new()
    $EmptyCells = Get-SummaryProp $SummaryObject 'empty_cells'
    if ($EmptyCells) {
        foreach ($ec in @($EmptyCells)) {
            $ecCamp = Get-SummaryProp $ec 'camp'
            $ecCat  = Get-SummaryProp $ec 'category'
            if ($ecCamp -and $ecCat) {
                [void]$EmptyCellSet.Add("$ecCamp|$ecCat")
            }
        }
    }

    # Total key_points across all camps (replaces per-camp floors)
    $PovSummaries = Get-SummaryProp $SummaryObject 'pov_summaries'
    $TotalKp = 0
    foreach ($Camp in $Camps) {
        $CampData = Get-SummaryProp $PovSummaries $Camp
        $KeyPoints = Get-SummaryProp $CampData 'key_points'
        $Count = if ($KeyPoints) { @($KeyPoints).Count } else { 0 }
        $TotalKp += $Count

        # Flag camps with zero points and no empty_cell declaration
        if ($Count -eq 0) {
            $Categories = $script:AITriadPovCategories
            $AllDeclared = $true
            foreach ($cat in $Categories) {
                if (-not $EmptyCellSet.Contains("$Camp|$cat")) {
                    $AllDeclared = $false
                    break
                }
            }
            if (-not $AllDeclared) {
                $null = $Shortfalls.Add("$Camp has 0 key_points without empty_cells declarations")
            }
        }
    }

    $TotalFloor = if ($Floors.ContainsKey('TotalFloor')) { $Floors.TotalFloor } else { 6 }
    if ($TotalKp -lt $TotalFloor) {
        $null = $Shortfalls.Add("total key_points: $TotalKp < $TotalFloor across all camps")
    }

    # Read through Get-SummaryProp — the merged object is an [ordered] dictionary
    # whose keys are invisible to $x.PSObject.Properties[...], the same blindness
    # that produced the t/1646 key_points false-positive.
    $UnmappedConcepts = Get-SummaryProp $SummaryObject 'unmapped_concepts'
    $UcCount = if ($UnmappedConcepts) { @($UnmappedConcepts).Count } else { 0 }
    if ($UcCount -lt $Floors.UcMin) {
        $null = $Shortfalls.Add("unmapped_concepts: $UcCount < $($Floors.UcMin) min")
    }

    return @{
        Pass       = ($Shortfalls.Count -eq 0)
        Shortfalls = @($Shortfalls)
    }
}

function Build-DensityRetryNudge {
    param([string[]]$Shortfalls)

    $Lines = @(
        "IMPORTANT: Your previous response did not meet extraction effort requirements."
        "Specific shortfalls:"
    )
    foreach ($s in $Shortfalls) {
        $Lines += "  - $s"
    }
    $Lines += @(
        ""
        "Go back through the document and extract MORE points. Examine ALL nine BDI"
        "cells (3 POV camps x 3 categories). For each cell, extract every distinct"
        "point the document actually contains. If a cell is genuinely empty, declare"
        "it in the empty_cells array with a reason. Every distinct claim, argument,"
        "or piece of evidence should be its own key_point or factual_claim."
        "Include a canonical_proposition for every key_point."
    )
    return ($Lines -join "`n")
}

function Build-DensityScaledPrompt {
    param(
        [int]$WordCount,
        [string]$Template
    )

    $Floors = Get-DensityFloors -WordCount $WordCount
    $kpMin = $Floors.KpMin
    $kpMax = [Math]::Max(8,  [int]($WordCount / 200))
    $ucMin = $Floors.UcMin
    $ucMax = [Math]::Max(5,  [int]($WordCount / 800))
    $totalFloor = $Floors.TotalFloor

    Write-Host "  │  ~$WordCount words → key_points $kpMin-$kpMax/camp (target), total floor $totalFloor, unmapped $ucMin-$ucMax" -ForegroundColor Gray

    return $Template `
        -replace '{{WORD_COUNT}}',   $WordCount `
        -replace '{{KP_MIN}}',       $kpMin `
        -replace '{{KP_MAX}}',       $kpMax `
        -replace '{{UC_MIN}}',       $ucMin `
        -replace '{{UC_MAX}}',       $ucMax `
        -replace '{{TOTAL_FLOOR}}',  $totalFloor
}

function Build-CompactTaxonomy {
    <#
    .SYNOPSIS
        Builds a compact taxonomy context (~5-10K tokens) for prompt injection
        when full RAG embedding is unavailable.
    .DESCRIPTION
        Loads the four taxonomy files and emits only id, category, and label per node.
        This is ~95% smaller than the full taxonomy JSON while still providing
        enough context for the LLM to map claims to node IDs.
    #>
    $TaxDir = Get-TaxonomyDir
    $Lines = [System.Text.StringBuilder]::new()
    [void]$Lines.AppendLine("=== COMPACT TAXONOMY (id | category | label — full descriptions omitted for brevity) ===")
    [void]$Lines.AppendLine("")

    $TaxFiles = [ordered]@{
        'accelerationist.json' = 'Accelerationist'
        'safetyist.json'       = 'Safetyist'
        'skeptic.json'         = 'Skeptic'
        'situations.json'      = 'Situations'
    }

    foreach ($FileName in $TaxFiles.Keys) {
        $FilePath = Join-Path $TaxDir $FileName
        if (-not (Test-Path $FilePath)) { continue }
        $Data = Get-Content $FilePath -Raw | ConvertFrom-Json
        [void]$Lines.AppendLine("--- $($TaxFiles[$FileName]) ---")
        foreach ($Node in $Data.nodes) {
            $Cat = if ($null -ne $Node.PSObject.Properties['category'] -and $Node.category) { "[$($Node.category)]" } else { '' }
            [void]$Lines.AppendLine("  $($Node.id) $Cat $($Node.label)")
        }
        [void]$Lines.AppendLine("")
    }

    Write-Verbose "Pipeline: compact taxonomy built (~$([int]($Lines.Length / 4)) tokens est.)"
    return $Lines.ToString()
}

function Build-DocHeader {
    param(
        [hashtable]$Doc,
        [object]$Meta,
        [string]$ThisDocId
    )

    if ($Meta.title) { $Title = $Meta.title } else { $Title = $ThisDocId }
    $PovTags  = $Doc.PovTags -join ', '
    if ($null -ne $Meta.PSObject.Properties['topic_tags'] -and $Meta.topic_tags) { $TopicTags = $Meta.topic_tags -join ', ' } else { $TopicTags = '(none)' }

    return @"
=== DOCUMENT: $ThisDocId ===
Title: $Title
POV tags (pre-classified): $PovTags
Topic tags: $TopicTags
"@
}

function Parse-AIResponse {
    param(
        [string]$RawText,
        [string]$ThisDocId,
        [string]$SummariesDir
    )

    $CleanText = $RawText -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
    $CleanText = $CleanText.Trim()

    try {
        return ($CleanText | ConvertFrom-Json)
    } catch {
        Write-Host "  │  ⚠ JSON parse failed — attempting repair" -ForegroundColor Yellow
        $Repaired = Repair-TruncatedJson -Text $RawText
        if ($Repaired) {
            try {
                return ($Repaired | ConvertFrom-Json)
            } catch {
                # fall through
            }
        }
        $DebugPath = Join-Path $SummariesDir "${ThisDocId}.debug-raw.txt"
        Write-Utf8NoBom -Path $DebugPath -Value $RawText 
        Write-Host "  │  ✗ Invalid JSON. Raw saved: $DebugPath" -ForegroundColor Red
        return $null
    }
}

$script:ValidStances = @('strongly_aligned','aligned','neutral','opposed','strongly_opposed','not_applicable')

$script:StanceKeywordMap = @{
    strongly_aligned = @('strongly_align','strongly_support','fully_align','fully_support',
                         'enthusiastic','wholehearted','completely_agree','fully_endorse',
                         'strongly agree','fully agree','totally agree','completely support')
    aligned          = @('align','support','agree','endorse','advocate','favor','embrace',
                         'concur','approve','accept','positive','promote','back','champion',
                         'sympathetic','pro','affirmative','encourage')
    opposed          = @('oppose','disagree','reject','dispute','challenge','contest','resist',
                         'deny','refute','counter','critical','against','negative','skeptical',
                         'pushback','push back','object','sucks','bad','wrong','flawed','harmful')
    strongly_opposed = @('strongly_oppose','strongly_disagree','vehemently','adamant',
                         'completely_reject','fundamentally_oppose','categorically',
                         'strongly reject','totally reject','completely disagree','dangerous',
                         'catastrophic','existential threat','reckless','unconscionable')
    not_applicable   = @('not_applicable','n/a','irrelevant','no_stance','no stance','unrelated',
                         'does not address','not relevant','outside scope')
}

function Resolve-Stance {
    param([string]$Raw)

    if ([string]::IsNullOrWhiteSpace($Raw)) { return 'neutral' }

    $Lower = $Raw.Trim().ToLowerInvariant() -replace '[_\-]',' '

    if ($Lower -in $script:ValidStances) { return $Lower }
    $Normalized = $Lower -replace '\s+','_'
    if ($Normalized -in $script:ValidStances) { return $Normalized }

    foreach ($Stance in 'strongly_opposed','strongly_aligned','opposed','aligned','not_applicable') {
        foreach ($Kw in $script:StanceKeywordMap[$Stance]) {
            $KwNorm = $Kw -replace '[_\-]',' '
            if ($Lower -match [regex]::Escape($KwNorm)) { return $Stance }
        }
    }

    return 'neutral'
}

function Finalize-Summary {
    param(
        [object]$SummaryObject,
        [string]$ThisDocId,
        [string]$TaxonomyVersion,
        [string]$Model,
        [double]$Temperature,
        [string]$Now,
        [string]$SummariesDir,
        [hashtable]$Doc,
        [TimeSpan]$Elapsed,
        [int]$ChunkCount = 0,
        [string]$TaxonomyJson = '',
        [object]$FireStats = $null,
        # The extraction call's MaxTokens, recorded as model_info.max_tokens (t/4079). Both callers pass
        # it; when it is not passed it is unknown here, so it is recorded as null, not guessed.
        [object]$MaxTokens = $null,
        # Explicit since t/4136: it used to resolve from the caller's scope. Default matches
        # Invoke-DocumentSummary's (gate ON, t/2912); both callers pass it.
        [bool]$EnablePolarityGate = $true
    )

    # -- Schema validation and normalization (Gap 3.4) -------------------------
    # Steps live in FinalizeSummarySteps.ps1 (t/4136). Both callers pass a PSCustomObject; the steps
    # also accept an IDictionary.
    $SchemaErrors = Repair-SummarySchema -SummaryObject $SummaryObject -Model $Model
    if ($SchemaErrors.Count -gt 0 -and -not (Test-SummaryField $SummaryObject 'pov_summaries')) {
        return @{ Success = $false; DocId = $ThisDocId; Error = "Schema validation failed: $($SchemaErrors -join '; ')" }
    }

    # -- Validate stance values and gather counts --------------------------------
    $StanceCounts = Update-SummaryStances -SummaryObject $SummaryObject
    $TotalPoints  = $StanceCounts.TotalPoints
    $NullNodes    = $StanceCounts.NullNodes

    # -- Validate taxonomy_node_id existence (Gap 3.1) ---------------------------
    # Each rerouted key_point is one more unmapped point.
    $InvalidNodeIds = Move-HallucinatedNodeIdsToUnmapped -SummaryObject $SummaryObject
    $NullNodes += $InvalidNodeIds.Count

    # -- Cross-camp consistency check (Gap 3.3) --------------------------------
    $CrossCampWarnings = Get-CrossCampAgreementWarnings -SummaryObject $SummaryObject
    foreach ($Warn in $CrossCampWarnings) {
        Write-Host "  │  ⚠ $Warn" -ForegroundColor Yellow
    }

    # -- Enrichment passes, in the pinned order (t/2288, t/2739, t/2357, t/2286) --
    # Each lives in FinalizeSummarySteps.ps1 (t/4136 B2) with its own skip guard.
    Invoke-SummaryRetrievalConfidencePass -SummaryObject $SummaryObject
    Invoke-SummaryPolarityGate -SummaryObject $SummaryObject -EnablePolarityGate $EnablePolarityGate
    Invoke-SummaryMechanism5Pass -SummaryObject $SummaryObject
    Invoke-SummaryExcludesVetoPass -SummaryObject $SummaryObject

    $SoProps = $SummaryObject.PSObject.Properties
    if ($SoProps['factual_claims'] -and $null -ne $SummaryObject.factual_claims) { $FactualClaims = $SummaryObject.factual_claims } else { $FactualClaims = @() }
    if ($SoProps['unmapped_concepts'] -and $null -ne $SummaryObject.unmapped_concepts) { $UnmappedConcs = $SummaryObject.unmapped_concepts } else { $UnmappedConcs = @() }
    $FactualCount   = @($FactualClaims).Count
    $UnmappedCount  = @($UnmappedConcs).Count

    if ($ChunkCount -gt 0) { $ChunkLabel = " ($ChunkCount chunks)" } else { $ChunkLabel = '' }
    Write-Host "  │  points: $TotalPoints ($NullNodes unmapped)  factual: $FactualCount  new_concepts: $UnmappedCount$ChunkLabel" -ForegroundColor Gray

    # -- Cross-POV fuzzy match on unmapped concepts ----------------------------
    $Unmapped      = Resolve-SummaryUnmappedConcepts -SummaryObject $SummaryObject -UnmappedConcs $UnmappedConcs -UnmappedCount $UnmappedCount
    $UnmappedConcs = $Unmapped.Concepts
    $UnmappedCount = $Unmapped.Count

    # -- Write summaries/<doc-id>.json ----------------------------------------
    $ModelInfo = New-SummaryModelInfo -Model $Model -Temperature $Temperature -TaxonomyJson $TaxonomyJson `
        -ChunkCount $ChunkCount -FireStats $FireStats -MaxTokens $MaxTokens

    # -- Build context-rot metrics from stages collected during processing ----
    $ContextRotStages = @($script:ContextRotStages)
    $ContextRotObj = if ($ContextRotStages.Count -gt 0) {
        New-ContextRotMetrics -Pipeline 'summary' -DocId $ThisDocId -Stages $ContextRotStages
    } else { $null }

    $FinalSummary = New-SummaryDocument -DocId $ThisDocId -TaxonomyVersion $TaxonomyVersion -Now $Now `
        -ModelInfo $ModelInfo -ContextRot $ContextRotObj -SummaryObject $SummaryObject `
        -FactualClaims $FactualClaims -UnmappedConcepts $UnmappedConcs `
        -SchemaErrors $SchemaErrors -InvalidNodeIds $InvalidNodeIds -CrossCampWarnings $CrossCampWarnings
    $WriteFailure = Write-SummaryDocument -SummariesDir $SummariesDir -DocId $ThisDocId -Document $FinalSummary
    if ($WriteFailure) { return $WriteFailure }

    # -- Update metadata.json -------------------------------------------------
    Update-SummaryMetadata -Doc $Doc -TaxonomyVersion $TaxonomyVersion -Now $Now -FactualClaims $FactualClaims `
        -FactualCount $FactualCount -TotalPoints $TotalPoints -UnmappedCount $UnmappedCount `
        -ContextRot $ContextRotObj -ContextRotStages $ContextRotStages

    Write-Host "  └─ ✓ Done: summaries/$ThisDocId.json" -ForegroundColor Green

    return @{
        Success       = $true
        DocId         = $ThisDocId
        TotalPoints   = $TotalPoints
        NullNodes     = $NullNodes
        FactualCount  = $FactualCount
        UnmappedCount = $UnmappedCount
        ElapsedSecs   = [int]$Elapsed.TotalSeconds
        ChunkCount    = $ChunkCount
    }
}
