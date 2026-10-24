# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Shared pipeline worker for POV summary extraction.
# Single source of truth for: CHESS → RAG → Prompt → FIRE/Single-shot → Density → Unmapped resolution
# Called by Invoke-POVSummary (interactive) and Invoke-DocumentSummary (batch).
# Dot-sourced by AITriad.psm1 — do NOT export.

function Invoke-SummaryPipeline {
    <#
    .SYNOPSIS
        Core summary extraction pipeline — shared by all callers.
    .DESCRIPTION
        Executes the 7-stage extraction pipeline:
        1. CHESS pre-classification (identify relevant POVs)
        2. RAG node selection (filter taxonomy to relevant nodes)
        3. AutoFire Stage 1 sniff (pre-extraction)
        4. Prompt construction (system + taxonomy + schema + document)
        5. AI extraction (FIRE iterative or single-shot with density retry)
        6. AutoFire Stage 2 sniff + re-run (post-extraction)
        7. Unmapped concept resolution

        Does NOT handle: path resolution, file writing, metadata updates,
        console reporting, or batch coordination. Those are caller concerns.
    .PARAMETER SnapshotText
        The document text to summarize.
    .PARAMETER DocId
        Document slug ID (for logging).
    .PARAMETER Metadata
        Parsed metadata.json hashtable.
    .PARAMETER ApiKey
        Resolved AI API key.
    .PARAMETER Model
        AI model identifier.
    .PARAMETER Temperature
        Sampling temperature.
    .PARAMETER TaxonomyVersion
        Current taxonomy version string.
    .PARAMETER SystemPromptTemplate
        System prompt template with density placeholders.
    .PARAMETER OutputSchema
        JSON schema string for the AI response.
    .PARAMETER FullTaxonomy
        Bypass RAG — inject all taxonomy nodes.
    .PARAMETER IterativeExtraction
        Force FIRE iterative extraction.
    .PARAMETER AutoFire
        Enable two-stage FIRE sniff.
    .PARAMETER TaxonomyJsonOverride
        Pre-computed taxonomy JSON (for chunked pipeline passing parent-level taxonomy).
    .PARAMETER CrossEncoderRerank
        Cross-encoder re-rank the RAG candidates (t/2287). Forwarded to
        Get-RelevantTaxonomyNodes. Default OFF; no effect when -FullTaxonomy or
        -TaxonomyJsonOverride bypass RAG.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SnapshotText,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][object]$Metadata,
        [Parameter(Mandatory)][AllowEmptyString()][string]$ApiKey,
        [Parameter(Mandatory)][string]$Model,
        [double]$Temperature = 0.1,
        [Parameter(Mandatory)][string]$TaxonomyVersion,
        [Parameter(Mandatory)][string]$SystemPromptTemplate,
        [Parameter(Mandatory)][string]$OutputSchema,
        [switch]$FullTaxonomy,
        [switch]$IterativeExtraction,
        [switch]$AutoFire,
        [string]$TaxonomyJsonOverride = '',
        [int]$RagMaxTotal = 300,
        [switch]$CrossEncoderRerank
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $PipelineStart = Get-Date
    if (-not (Test-Path variable:script:ContextRotStages)) { $script:ContextRotStages = @() }

    $WordCount = ($SnapshotText -split '\s+').Count
    $EstimatedTokens = [int]($SnapshotText.Length / 4)

    # ── Stage 1: CHESS + RAG taxonomy selection ───────────────────────────────
    $TaxonomyJson = $null

    if ($TaxonomyJsonOverride) {
        $TaxonomyJson = $TaxonomyJsonOverride
        Write-Verbose "Pipeline: using caller-provided taxonomy context"
    }
    elseif ($FullTaxonomy) {
        $TaxFiles = @("accelerationist.json", "safetyist.json", "skeptic.json", "situations.json")
        $TaxContext = [ordered]@{}
        $TaxDir = Get-TaxonomyDir
        foreach ($F in $TaxFiles) {
            $P = Join-Path $TaxDir $F
            if (Test-Path $P) {
                $TaxContext[$F] = Get-Content $P -Raw | ConvertFrom-Json
                Set-TaxonomyDocumentSelectable -Document $TaxContext[$F] -Name $F   # prompt only (t/4356)
            }
        }
        $TaxonomyJson = $TaxContext | ConvertTo-Json -Depth 20 -Compress:$false
        Write-Verbose "Pipeline: full taxonomy injected"
    }
    else {
        $QueryWords = ($SnapshotText -split '\s+') | Select-Object -First 500
        $QueryText = "$($Metadata.title). $($QueryWords -join ' ')"

        try {
            $__ChessSw = [System.Diagnostics.Stopwatch]::StartNew()
            $RelevantPovs = Get-DocumentPovClassification -QueryText $QueryText -ApiKey $ApiKey
            $__ChessSw.Stop()
            Add-StageTiming -Name 'api.chess (POV classify)' -Milliseconds $__ChessSw.Elapsed.TotalMilliseconds
            Write-Verbose "Pipeline: CHESS classified POVs: $($RelevantPovs -join ', ')"

            $AllPovs = @('accelerationist', 'safetyist', 'skeptic')
            # The RAG query covers the WHOLE document (t/4468): Get-RelevantTaxonomyNodes windows and embeds it.
            # It used to be $QueryText (title + first 500 words). CHESS above still classifies on the 500 words
            # (separate stage, follow-up t/4477).
            $RagQueryText = "$($Metadata.title). $SnapshotText"
            $TaxonomyJson = Get-RelevantTaxonomyNodes -Query $RagQueryText `
                -MaxTotal $RagMaxTotal -MinPerCategory 3 `
                -POV $AllPovs -IncludeSituations -Format context `
                -CrossEncoderRerank:$CrossEncoderRerank
            Write-Verbose "Pipeline: RAG selected ~$([int]($TaxonomyJson.Length / 4)) tokens of taxonomy"
        }
        catch {
            Write-Verbose "Pipeline: RAG failed ($($_.Exception.Message)) — falling back to compact taxonomy"
            $TaxonomyJson = Build-CompactTaxonomy
        }
    }

    # ── Stage 2: AutoFire Stage 1 — pre-extraction sniff (always runs) ───────
    if (-not $IterativeExtraction) {
        if ($Metadata.PSObject.Properties['source_type']) { $SourceType = $Metadata.source_type } else { $SourceType = 'unknown' }
        $Sniff1 = Test-FireRequired -WordCount $WordCount -IsChunked:($EstimatedTokens -gt 20000) -SourceType $SourceType
        if ($Sniff1.ShouldFire) {
            Write-Verbose "Pipeline AutoFire Stage 1: $($Sniff1.Reason) — switching to FIRE"
            $IterativeExtraction = $true
        }
    }

    # ── Stage 3: Prompt construction ──────────────────────────────────────────
    $SystemPrompt = Build-DensityScaledPrompt -WordCount $WordCount -Template $SystemPromptTemplate

    # Policy registry context
    $PolicyBlock = ''
    $PolicyPath = Join-Path (Get-TaxonomyDir) 'policy_actions.json'
    if (Test-Path $PolicyPath) {
        try {
            $PolicyReg = Get-Content -Raw -Path $PolicyPath | ConvertFrom-Json
            if ($PolicyReg.policies -and $PolicyReg.policies.Count -gt 0) {
                $PolicyLines = $PolicyReg.policies | ForEach-Object { "$($_.id): $($_.action)" }
                $PB = $PolicyLines -join "`n"
                if ($PB.Length -gt 5000) { $PB = $PB.Substring(0, 5000) + "`n... (truncated)" }
                $PolicyBlock = "`n=== POLICY REGISTRY (use pol-NNN IDs when referencing policy actions) ===`n$PB"
            }
        }
        catch { }
    }

    # Vocabulary constraints (standardized terms + bare-term ban)
    $VocabularyBlock = Build-VocabularyBlock
    if ($VocabularyBlock) { Write-Verbose "Pipeline: vocabulary block injected ($([int]($VocabularyBlock.Length / 4)) tokens est.)" }

    if ($Metadata.PSObject.Properties['pov_tags']) { $PovTagLine = $Metadata.pov_tags -join ', ' } else { $PovTagLine = '' }
    if ($Metadata.PSObject.Properties['topic_tags']) { $TopicTagLine = $Metadata.topic_tags -join ', ' } else { $TopicTagLine = '' }
    if ($Metadata.PSObject.Properties['title']) { $TitleLine = $Metadata.title } else { $TitleLine = $DocId }

    $SysInstruction = @"
$SystemPrompt
$PolicyBlock
$VocabularyBlock
=== OUTPUT SCHEMA (your response must match this structure) ===
$OutputSchema
"@

    $FullPrompt = @"
=== TAXONOMY (version $TaxonomyVersion) ===
$TaxonomyJson

=== DOCUMENT: $DocId ===
Title: $TitleLine
POV tags (pre-classified): $PovTagLine
Topic tags: $TopicTagLine

--- DOCUMENT CONTENT ---
$SnapshotText
"@

    Write-Verbose "Pipeline: system instruction ($([int]($SysInstruction.Length / 4)) tokens est.) + prompt ($([int]($FullPrompt.Length / 4)) tokens est.)"

    # ── Stage 4: AI extraction ────────────────────────────────────────────────
    $SummaryObject = $null
    $FireStats = $null
    # The extraction call's output budget (single-shot and FIRE's initial call), returned as MaxTokens
    # so Finalize-Summary records the value actually used (t/4079).
    $ExtractionMaxTokens = 32768
    $AiBackend = ''
    $DensityCheck = $null

    if ($IterativeExtraction) {
        Write-Verbose "Pipeline: using FIRE iterative extraction"
        $FireResult = Invoke-IterativeExtraction `
            -Prompt $FullPrompt -SystemInstruction $SysInstruction `
            -Model $Model -ApiKey $ApiKey -Temperature $Temperature -MaxTokens $ExtractionMaxTokens

        $SummaryObject = $FireResult.Summary
        $AiBackend = $FireResult.Backend
        $FireStats = $FireResult.FireStats
    }
    else {
        # Single-shot with density validation + retry
        Write-Verbose "Pipeline: using single-shot extraction"
        $DensityFloors = Get-DensityFloors -WordCount $WordCount
        $MaxRetries = 1
        $DensityRetryNudge = ''

        for ($Attempt = 0; $Attempt -le $MaxRetries; $Attempt++) {
            $AttemptPrompt = $FullPrompt
            if ($Attempt -gt 0 -and $DensityRetryNudge) {
                Write-Verbose "Pipeline: density retry $Attempt/$MaxRetries"
                $AttemptPrompt = $FullPrompt + "`n`n" + $DensityRetryNudge
            }

            $__SsSw = [System.Diagnostics.Stopwatch]::StartNew()
            $AiResult = Invoke-AIApi `
                -Prompt      $AttemptPrompt `
                -SystemInstruction $SysInstruction `
                -Model       $Model `
                -ApiKey      $ApiKey `
                -Temperature $Temperature `
                -MaxTokens   $ExtractionMaxTokens `
                -JsonMode `
                -TimeoutSec  600
            $__SsSw.Stop()
            Add-StageTiming -Name 'api.extraction (single-shot)' -Milliseconds $__SsSw.Elapsed.TotalMilliseconds

            if ($null -eq $AiResult) {
                Write-Warning "Single-shot summary: AI call returned null for '$DocId' (model=$Model, backend=unknown — call failed before returning a response)"
                return @{ Success = $false; DocId = $DocId; Error = 'API call returned null' }
            }

            $AiBackend = $AiResult.Backend
            Write-Verbose "Pipeline: response from $AiBackend"

            $CleanedText = $AiResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
            try {
                $SummaryObject = $CleanedText.Trim() | ConvertFrom-Json
            }
            catch {
                # Try repair
                $Repaired = Repair-TruncatedJson -Text $CleanedText
                try { $SummaryObject = $Repaired | ConvertFrom-Json } catch { $SummaryObject = $null }
            }

            if ($null -eq $SummaryObject) {
                # Mirror the chunked path (Parse-AIResponse): persist the raw model
                # output so a parse failure on a small doc is diagnosable. Use a
                # -single-shot suffix so it never clobbers the chunked debug file.
                try {
                    $DebugPath = Join-Path (Get-SummariesDir) "${DocId}-single-shot.debug-raw.txt"
                    Write-Utf8NoBom -Path $DebugPath -Value $AiResult.Text
                    Write-Verbose "Pipeline: invalid JSON from $AiBackend — raw response saved: $DebugPath"
                }
                catch {
                    Write-Warning "Single-shot summary: invalid JSON for '$DocId' (backend=$AiBackend); additionally failed to save debug-raw: $($_.Exception.Message)"
                }
                return @{ Success = $false; DocId = $DocId; Error = 'InvalidJson' }
            }

            # Density check
            $DensityCheck = Test-SummaryDensity -SummaryObject $SummaryObject -Floors $DensityFloors
            if ($DensityCheck.Pass) { break }

            $DensityRetryNudge = Build-DensityRetryNudge -Shortfalls $DensityCheck.Shortfalls
            Write-Verbose "Pipeline: density check failed — $($DensityCheck.Shortfalls -join '; ')"

            if ($Attempt -eq $MaxRetries) {
                Write-Verbose 'Pipeline: accepting under-dense result after retries'
            }
        }
    }

    if ($null -eq $SummaryObject) {
        return @{ Success = $false; DocId = $DocId; Error = 'No summary produced' }
    }

    # ── Stage 5: AutoFire Stage 2 — post-extraction sniff (always runs) ──────
    if (-not $IterativeExtraction -and $null -ne $SummaryObject) {
        $Sniff2 = Test-FireRequired -SummaryObject $SummaryObject
        if ($Sniff2.ShouldFire) {
            Write-Verbose "Pipeline AutoFire Stage 2: $($Sniff2.Reason) — re-running with FIRE"
            $FireResult = Invoke-IterativeExtraction `
                -Prompt $FullPrompt -Model $Model -ApiKey $ApiKey -Temperature $Temperature -MaxTokens $ExtractionMaxTokens
            if ($FireResult.Summary) {
                $SummaryObject = $FireResult.Summary
                $AiBackend = $FireResult.Backend
                $FireStats = $FireResult.FireStats
            }
        }
    }

    # ── Stage 5b: Confidence backfill for single-shot claims ───────────────
    # FIRE produces fire_confidence on factual_claims; single-shot gets
    # extraction_confidence from the model but also needs a derived score
    # on any factual_claim missing it, using the same evidence_criteria formula.
    if (-not $IterativeExtraction -and $SummaryObject.PSObject.Properties['factual_claims'] -and $SummaryObject.factual_claims) {
        foreach ($Claim in @($SummaryObject.factual_claims)) {
            if (-not $Claim.PSObject.Properties['extraction_confidence'] -or $null -eq $Claim.extraction_confidence) {
                $DerivedConf = 0.5
                if ($Claim.PSObject.Properties['evidence_criteria']) {
                    $EC = $Claim.evidence_criteria
                    $DerivedConf = 0.3
                    if ($EC.PSObject.Properties['specificity'] -and $EC.specificity -eq 'precise') { $DerivedConf += 0.2 }
                    if ($EC.PSObject.Properties['has_warrant'] -and $EC.has_warrant) { $DerivedConf += 0.2 }
                    if ($EC.PSObject.Properties['internally_consistent'] -and $EC.internally_consistent) { $DerivedConf += 0.1 }
                }
                $Claim | Add-Member -NotePropertyName 'extraction_confidence' -NotePropertyValue $DerivedConf -Force
            }
        }
    }

    # ── Stage 5c: Semantic deduplication ────────────────────────────────────
    try {
        $DedupResult = Remove-DuplicateClaims -SummaryObject $SummaryObject -SimilarityThreshold 0.85
        $SummaryObject = $DedupResult.Summary
        $DedupMetrics = $DedupResult.Metrics
        if ($DedupMetrics.points_removed -gt 0 -or $DedupMetrics.claims_removed -gt 0) {
            Write-Verbose "Pipeline dedup: removed $($DedupMetrics.points_removed) key_points, $($DedupMetrics.claims_removed) factual_claims"
        }
    }
    catch {
        Write-Verbose "Pipeline dedup: skipped — $($_.Exception.Message)"
        $DedupMetrics = $null
    }

    # ── Stage 6: Unmapped concept resolution ──────────────────────────────────
    Resolve-PipelineUnmappedConcepts -SummaryObject $SummaryObject -DocId $DocId

    # ── Stage 7: Collect stats and return ─────────────────────────────────────
    $Elapsed = (Get-Date) - $PipelineStart
    $KpCounts = Get-SummaryKeyPointNodeCount -SummaryObject $SummaryObject -Context "Invoke-SummaryPipeline ($DocId)"
    $TotalPoints = $KpCounts.TotalPoints; $NullNodes = $KpCounts.NullNodes
    $FactualRaw = if ($SummaryObject.PSObject.Properties['factual_claims']) { $SummaryObject.factual_claims } else { $null }
    if ($FactualRaw) { $FactualCount = @($FactualRaw).Count } else { $FactualCount = 0 }
    $UnmappedRaw2 = if ($SummaryObject.PSObject.Properties['unmapped_concepts']) { $SummaryObject.unmapped_concepts } else { $null }
    if ($UnmappedRaw2) { $UnmappedCount = @($UnmappedRaw2).Count } else { $UnmappedCount = 0 }

    # ── Context-rot: extraction + RAG metrics ────────────────────────────────
    $NullNodeRate = if ($TotalPoints -gt 0) { [Math]::Round($NullNodes / $TotalPoints, 4) } else { 0 }
    $DensityFloorHit = if ($null -ne $DensityCheck -and -not $DensityCheck.Pass) { 1 } else { 0 }
    $script:ContextRotStages += @(New-ContextRotStage `
        -Stage 'extraction' -InUnits 'prompt_chars' -InCount $FullPrompt.Length `
        -OutUnits 'items' -OutCount ($TotalPoints + $FactualCount + $UnmappedCount) `
        -Flags @{
            null_node_rate    = $NullNodeRate
            density_floor_hit = $DensityFloorHit
            total_points      = $TotalPoints
            factual_claims    = $FactualCount
            unmapped_concepts = $UnmappedCount
            used_fire         = if ($IterativeExtraction) { 1 } else { 0 }
            dedup_points_removed = if ($DedupMetrics) { $DedupMetrics.points_removed } else { 0 }
            dedup_claims_removed = if ($DedupMetrics) { $DedupMetrics.claims_removed } else { 0 }
        })
    if ((Test-Path variable:script:LastRAGMetrics) -and $script:LastRAGMetrics) {
        $script:ContextRotStages += @($script:LastRAGMetrics)
        $script:LastRAGMetrics = $null
    }

    return @{
        Success        = $true
        DocId          = $DocId
        Summary        = $SummaryObject
        Backend        = $AiBackend
        TotalPoints    = $TotalPoints
        NullNodes      = $NullNodes
        FactualCount   = $FactualCount
        UnmappedCount  = $UnmappedCount
        ElapsedSeconds = [Math]::Round($Elapsed.TotalSeconds, 1)
        FireStats      = $FireStats
        MaxTokens      = $ExtractionMaxTokens
        TaxonomyJson   = $TaxonomyJson
        UsedFire       = [bool]$IterativeExtraction
    }
}

function Resolve-PipelineUnmappedConcepts {
    <#
    .SYNOPSIS
        Stage 6 of Invoke-SummaryPipeline: cross-POV fuzzy match on the model's unmapped_concepts.
        When any concept resolves, $SummaryObject.unmapped_concepts becomes the remaining ones.
    .DESCRIPTION
        Null entries are skipped with a WARN that names how many (t/4168). Resolve-UnmappedConcepts
        takes [object[]] without [AllowNull()], so a single null used to fail the whole step with
        "Cannot bind argument ... because it is null". When nothing resolves, the summary is left as
        is, nulls included; Finalize-Summary drops them (t/3907).
        A failure is a fallback (every concept stays unmapped), so it is a WARN, not Verbose (t/4168).
    #>
    param([object]$SummaryObject, [string]$DocId)
    $UnmappedRaw = Get-SummaryProp $SummaryObject 'unmapped_concepts'
    if (-not $UnmappedRaw -or @($UnmappedRaw).Count -eq 0) { return }
    $All = @($UnmappedRaw)
    $Concepts = @($All.Where({ $null -ne $_ }))
    $NullCount = $All.Count - $Concepts.Count
    if ($NullCount -gt 0) {
        Write-Warning "Invoke-SummaryPipeline: skipped $NullCount null unmapped_concepts entry/entries for '$DocId' before unmapped resolution (t/4168)"
    }
    if ($Concepts.Count -eq 0) { return }
    try {
        $Resolution = Resolve-UnmappedConcepts -UnmappedConcepts $Concepts
        $ResolvedCount = @($Resolution.Resolved).Count
        if ($ResolvedCount -gt 0) {
            $SummaryObject.unmapped_concepts = @($Resolution.Remaining)
            Write-Verbose "Pipeline: resolved $ResolvedCount unmapped concept(s)"
        }
    }
    catch {
        Write-Warning "Invoke-SummaryPipeline: unmapped concept resolution failed for '$DocId' — keeping all $($Concepts.Count) unmapped concept(s) unresolved: $($_.Exception.Message)"
    }
}

function Get-SummaryKeyPointNodeCount {
    <#
    .SYNOPSIS
        @{ TotalPoints; NullNodes } over the three camps' key_points (summary as PSCustomObject or dictionary).
    .DESCRIPTION
        Used by Invoke-SummaryPipeline's Stage 7 and by each chunk in Invoke-ChunkedSummary. Their
        inline reads of $_.taxonomy_node_id threw under StrictMode on a key point without that field,
        before Finalize-Summary's guard (Repair-SummaryKeyPointFields) could run (t/4172). A key point
        with no taxonomy_node_id field, or a null key point, now counts as unmapped like a null node
        ID, and the missing fields get one WARN per camp naming the count. A missing camp or
        key_points list counts as no points, as it did.
    #>
    param([object]$SummaryObject, [string]$Context)
    $TotalPoints = 0; $NullNodes = 0
    $PovSummaries = Get-SummaryProp $SummaryObject 'pov_summaries'
    foreach ($Camp in $script:AITriadPovCamps) {
        $KeyPoints = Get-SummaryProp (Get-SummaryProp $PovSummaries $Camp) 'key_points'
        if (-not $KeyPoints) { continue }
        $Points = @($KeyPoints)
        $NoField = @($Points.Where({ $null -eq $_ -or -not (Test-SummaryField $_ 'taxonomy_node_id') })).Count
        if ($NoField -gt 0) {
            Write-Warning "${Context}: $NoField key point(s) in pov_summaries.$Camp have no taxonomy_node_id field — counting them as unmapped (t/4172)"
        }
        $TotalPoints += $Points.Count
        $NullNodes += @($Points.Where({ $null -eq (Get-SummaryProp $_ 'taxonomy_node_id') })).Count
    }
    @{ TotalPoints = $TotalPoints; NullNodes = $NullNodes }
}
