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
        5. AI extraction (FIRE iterative or single-shot; tagged-camp-empty WARN)
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
    $TaxonomyJson = Get-PipelineTaxonomyJson -TaxonomyJsonOverride $TaxonomyJsonOverride `
        -FullTaxonomy:$FullTaxonomy -Metadata $Metadata -SnapshotText $SnapshotText `
        -ApiKey $ApiKey -RagMaxTotal $RagMaxTotal -CrossEncoderRerank:$CrossEncoderRerank

    # ── Stage 2: AutoFire Stage 1 — pre-extraction sniff (always runs) ───────
    if (-not $IterativeExtraction) {
        $Sniff1 = Test-PipelineFireStage1 -Metadata $Metadata -WordCount $WordCount -EstimatedTokens $EstimatedTokens
        if ($Sniff1.ShouldFire) {
            Write-Verbose "Pipeline AutoFire Stage 1: $($Sniff1.Reason) — switching to FIRE"
            $IterativeExtraction = $true
        }
    }

    # ── Stage 3: Prompt construction ──────────────────────────────────────────
    $SystemPrompt = Build-DensityScaledPrompt -WordCount $WordCount -Template $SystemPromptTemplate

    # Policy registry context
    $PolicyBlock = Get-PipelinePolicyBlock

    # Vocabulary constraints (standardized terms + bare-term ban)
    $VocabularyBlock = Build-VocabularyBlock
    if ($VocabularyBlock) { Write-Verbose "Pipeline: vocabulary block injected ($([int]($VocabularyBlock.Length / 4)) tokens est.)" }

    $Fields = Get-PipelineDocumentFields -Metadata $Metadata -DocId $DocId
    $PovTagsArray = @($Fields.PovTagsArray)
    $PovTagLine = $Fields.PovTagLine
    $TopicTagLine = $Fields.TopicTagLine
    $TitleLine = $Fields.TitleLine

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
    # t/4479: forensic/additive, nothing branches on them -- the exemption lapses the moment a
    # consumer branches on json_repaired/truncated/output_tokens. $null means "unknown to this
    # caller" (e.g. FIRE's internal retries aren't tracked here), never a guessed value.
    $JsonRepaired = $false
    $Truncated = $null
    $OutputTokens = $null

    if ($IterativeExtraction) {
        Write-Verbose "Pipeline: using FIRE iterative extraction"
        $FireResult = Invoke-IterativeExtraction `
            -Prompt $FullPrompt -SystemInstruction $SysInstruction `
            -Model $Model -ApiKey $ApiKey -Temperature $Temperature -MaxTokens $ExtractionMaxTokens

        $SummaryObject = $FireResult.Summary
        $AiBackend = $FireResult.Backend
        $FireStats = $FireResult.FireStats

        $DensityCheck = Write-SummaryDensityWarnings -SummaryObject $SummaryObject -PovTags $PovTagsArray -DocId $DocId
    }
    else {
        # Single-shot extraction. No density retry (t/4473/t/4519): the floor was
        # unreachable (281/288 single-shot documents still failed it after one
        # retry) and the retry bought nothing but a second billed call.
        $Single = Invoke-PipelineSingleShotExtraction -FullPrompt $FullPrompt -SysInstruction $SysInstruction `
            -Model $Model -ApiKey $ApiKey -Temperature $Temperature -ExtractionMaxTokens $ExtractionMaxTokens `
            -DocId $DocId -PovTagsArray $PovTagsArray
        if ($Single.Failed) { return $Single.FailureResult }

        $SummaryObject = $Single.SummaryObject
        $AiBackend = $Single.Backend
        $Truncated = $Single.Truncated
        $OutputTokens = $Single.OutputTokens
        $JsonRepaired = $Single.JsonRepaired
        $DensityCheck = $Single.DensityCheck
    }

    if ($null -eq $SummaryObject) {
        return @{ Success = $false; DocId = $DocId; Error = 'No summary produced' }
    }

    # ── Stage 5: AutoFire Stage 2 — post-extraction sniff (always runs) ──────
    $AutoFire2 = Invoke-PipelineAutoFireStage2 -IterativeExtraction:$IterativeExtraction -SummaryObject $SummaryObject `
        -FullPrompt $FullPrompt -SysInstruction $SysInstruction -Model $Model -ApiKey $ApiKey `
        -Temperature $Temperature -ExtractionMaxTokens $ExtractionMaxTokens `
        -CurrentBackend $AiBackend -CurrentFireStats $FireStats
    $SummaryObject = $AutoFire2.Summary
    $AiBackend = $AutoFire2.Backend
    $FireStats = $AutoFire2.FireStats

    # ── Stage 5b: Confidence backfill for single-shot claims ───────────────
    # FIRE produces fire_confidence on factual_claims; single-shot gets
    # extraction_confidence from the model but also needs a derived score
    # on any factual_claim missing it, using the same evidence_criteria formula.
    Add-PipelineDerivedConfidence -SummaryObject $SummaryObject -IterativeExtraction:$IterativeExtraction

    # ── Stage 5c: Semantic deduplication ────────────────────────────────────
    $Dedup = Invoke-PipelineDedup -SummaryObject $SummaryObject
    $SummaryObject = $Dedup.Summary
    $DedupMetrics = $Dedup.Metrics

    # ── Stage 6: Unmapped concept resolution ──────────────────────────────────
    Resolve-PipelineUnmappedConcepts -SummaryObject $SummaryObject -DocId $DocId

    # ── Stage 7: Collect stats and return ─────────────────────────────────────
    $Elapsed = (Get-Date) - $PipelineStart
    $KpCounts = Get-SummaryKeyPointNodeCount -SummaryObject $SummaryObject -Context "Invoke-SummaryPipeline ($DocId)"
    $TotalPoints = $KpCounts.TotalPoints; $NullNodes = $KpCounts.NullNodes
    $Counts = Get-PipelineClaimCounts -SummaryObject $SummaryObject
    $FactualCount = $Counts.FactualCount; $UnmappedCount = $Counts.UnmappedCount

    # ── Context-rot: extraction + RAG metrics ────────────────────────────────
    Add-PipelineContextRotStage -FullPrompt $FullPrompt -TotalPoints $TotalPoints -NullNodes $NullNodes `
        -FactualCount $FactualCount -UnmappedCount $UnmappedCount -DensityCheck $DensityCheck `
        -IterativeExtraction:$IterativeExtraction -DedupMetrics $DedupMetrics
    Add-PipelineLastRagMetrics

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
        JsonRepaired   = $JsonRepaired
        Truncated      = $Truncated
        OutputTokens   = $OutputTokens
    }
}

function Get-PipelineTaxonomyJson {
    <#
    .SYNOPSIS
        Stage 1 dispatcher: returns the taxonomy JSON context (caller override, full taxonomy, or RAG).
    #>
    param(
        [string]$TaxonomyJsonOverride,
        [switch]$FullTaxonomy,
        [object]$Metadata,
        [string]$SnapshotText,
        [AllowEmptyString()][string]$ApiKey,
        [int]$RagMaxTotal,
        [switch]$CrossEncoderRerank
    )
    Set-StrictMode -Version Latest
    if ($TaxonomyJsonOverride) {
        Write-Verbose "Pipeline: using caller-provided taxonomy context"
        return $TaxonomyJsonOverride
    }
    if ($FullTaxonomy) {
        return Get-PipelineFullTaxonomyJson
    }
    return Get-PipelineRagTaxonomyJson -Metadata $Metadata -SnapshotText $SnapshotText `
        -ApiKey $ApiKey -RagMaxTotal $RagMaxTotal -CrossEncoderRerank:$CrossEncoderRerank
}

function Get-PipelineFullTaxonomyJson {
    <#
    .SYNOPSIS
        -FullTaxonomy path: injects all four taxonomy documents (prompt-selectable, t/4356).
    #>
    Set-StrictMode -Version Latest
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
    return $TaxonomyJson
}

function Get-PipelineDocWindows {
    <#
    .SYNOPSIS
        Window + embed the WHOLE document once (t/4468) so CHESS (t/4477) and RAG reuse one model load.
        Returns @{ Texts = [string[]]; Vectors = List[double[]] }.
    #>
    param([string]$Text)
    Set-StrictMode -Version Latest
    $DocSplit = Split-RagQueryWindows -Text $Text
    if ($DocSplit.SkippedSections -gt 0) { Write-Verbose "Pipeline: skipped $($DocSplit.SkippedSections) back-matter section(s)" }
    $DocWindowTexts = @($DocSplit.Windows)
    $DocWindowEmb = if ($DocWindowTexts.Count -gt 0) { Invoke-BatchEmbeddings -Texts $DocWindowTexts } else { @{} }
    $DocWindowVectors = [System.Collections.Generic.List[double[]]]::new()
    foreach ($T in $DocWindowTexts) { if ($DocWindowEmb.ContainsKey($T)) { $DocWindowVectors.Add([double[]]$DocWindowEmb[$T]) } }
    return @{ Texts = $DocWindowTexts; Vectors = $DocWindowVectors }
}

function Resolve-PipelineChessSample {
    <#
    .SYNOPSIS
        Builds the CHESS classification query from an evenly spaced, section-stratified sample (t/4477),
        falling back to the opening-words query with a WARN when windowing produced nothing.
    #>
    param([string[]]$WindowTexts, [string]$SnapshotText, [string]$Title)
    Set-StrictMode -Version Latest
    $ChessSample = if ($WindowTexts.Count -gt 0) { Get-PovClassificationSample -Windows $WindowTexts } else { '' }
    if (-not $ChessSample) {
        # Windowing produced nothing (e.g. all-back-matter or unparseable text) — fall back to the
        # former opening-words query rather than sending CHESS an empty string.
        Write-Warning "Pipeline: CHESS sample was empty after windowing; falling back to the opening-words query (t/4477)."
        $QueryWords = ($SnapshotText -split '\s+') | Select-Object -First 500
        $ChessSample = ($QueryWords -join ' ')
    }
    return "$Title. $ChessSample"
}

function Write-PipelinePovCrossCheck {
    <#
    .SYNOPSIS
        Forensic-only window/camp cosine cross-check (T0 exemption: nothing branches on it, t/4477).
    #>
    param([object]$WindowVectors)
    Set-StrictMode -Version Latest
    if ($WindowVectors.Count -le 0) { return }
    $PovCheck = Get-PovWindowSimilarityCheck -WindowVectors $WindowVectors.ToArray()
    if (-not $PovCheck) { return }
    foreach ($Camp in $PovCheck.Keys) {
        $Mean = [Math]::Round((($PovCheck[$Camp] | Measure-Object -Average).Average), 3)
        Write-Verbose "Pipeline: window/camp cross-check — $Camp mean cosine $Mean (forensic only, t/4477)"
    }
}

function Invoke-PipelineRagSelection {
    <#
    .SYNOPSIS
        CHESS classify + RAG node selection, with the compact-taxonomy fallback on failure.
    #>
    param(
        [string]$RagQueryText,
        [string]$QueryText,
        [AllowEmptyString()][string]$ApiKey,
        [object]$WindowVectors,
        [int]$RagMaxTotal,
        [switch]$CrossEncoderRerank
    )
    Set-StrictMode -Version Latest
    try {
        $__ChessSw = [System.Diagnostics.Stopwatch]::StartNew()
        $RelevantPovs = Get-DocumentPovClassification -QueryText $QueryText -ApiKey $ApiKey
        $__ChessSw.Stop()
        Add-StageTiming -Name 'api.chess (POV classify)' -Milliseconds $__ChessSw.Elapsed.TotalMilliseconds
        Write-Verbose "Pipeline: CHESS classified POVs: $($RelevantPovs -join ', ')"

        $AllPovs = @('accelerationist', 'safetyist', 'skeptic')
        if ($WindowVectors.Count -gt 0) {
            $TaxonomyJson = Get-RelevantTaxonomyNodes -Query $RagQueryText -QueryVectors $WindowVectors.ToArray() `
                -MaxTotal $RagMaxTotal -MinPerCategory 3 `
                -POV $AllPovs -IncludeSituations -Format context `
                -CrossEncoderRerank:$CrossEncoderRerank
        }
        else {
            # Windowing produced nothing; Get-RelevantTaxonomyNodes falls back to its own single-encode path.
            $TaxonomyJson = Get-RelevantTaxonomyNodes -Query $RagQueryText `
                -MaxTotal $RagMaxTotal -MinPerCategory 3 `
                -POV $AllPovs -IncludeSituations -Format context `
                -CrossEncoderRerank:$CrossEncoderRerank
        }
        Write-Verbose "Pipeline: RAG selected ~$([int]($TaxonomyJson.Length / 4)) tokens of taxonomy"
        return $TaxonomyJson
    }
    catch {
        Write-Verbose "Pipeline: RAG failed ($($_.Exception.Message)) — falling back to compact taxonomy"
        return Build-CompactTaxonomy
    }
}

function Get-PipelineRagTaxonomyJson {
    <#
    .SYNOPSIS
        Default path: window/embed once, CHESS-classify, RAG-select (t/4468, t/4477).
    #>
    param([object]$Metadata, [string]$SnapshotText, [AllowEmptyString()][string]$ApiKey, [int]$RagMaxTotal, [switch]$CrossEncoderRerank)
    Set-StrictMode -Version Latest
    $RagQueryText = "$($Metadata.title). $SnapshotText"
    $Windows = Get-PipelineDocWindows -Text $RagQueryText
    $QueryText = Resolve-PipelineChessSample -WindowTexts $Windows.Texts -SnapshotText $SnapshotText -Title $Metadata.title
    Write-PipelinePovCrossCheck -WindowVectors $Windows.Vectors
    return Invoke-PipelineRagSelection -RagQueryText $RagQueryText -QueryText $QueryText -ApiKey $ApiKey `
        -WindowVectors $Windows.Vectors -RagMaxTotal $RagMaxTotal -CrossEncoderRerank:$CrossEncoderRerank
}

function Test-PipelineFireStage1 {
    <#
    .SYNOPSIS
        AutoFire Stage 1 pre-extraction sniff; defaults source_type to 'unknown' when absent.
    #>
    param([object]$Metadata, [int]$WordCount, [int]$EstimatedTokens)
    Set-StrictMode -Version Latest
    if ($Metadata.PSObject.Properties['source_type']) { $SourceType = $Metadata.source_type } else { $SourceType = 'unknown' }
    return Test-FireRequired -WordCount $WordCount -IsChunked:($EstimatedTokens -gt 20000) -SourceType $SourceType
}

function Get-PipelinePolicyBlock {
    <#
    .SYNOPSIS
        Builds the POLICY REGISTRY prompt block from policy_actions.json ('' when absent/empty/unreadable).
    #>
    Set-StrictMode -Version Latest
    $PolicyPath = Join-Path (Get-TaxonomyDir) 'policy_actions.json'
    if (-not (Test-Path $PolicyPath)) { return '' }
    try {
        $PolicyReg = Get-Content -Raw -Path $PolicyPath | ConvertFrom-Json
        if ($PolicyReg.policies -and $PolicyReg.policies.Count -gt 0) {
            $PolicyLines = $PolicyReg.policies | ForEach-Object { "$($_.id): $($_.action)" }
            $PB = $PolicyLines -join "`n"
            if ($PB.Length -gt 5000) { $PB = $PB.Substring(0, 5000) + "`n... (truncated)" }
            return "`n=== POLICY REGISTRY (use pol-NNN IDs when referencing policy actions) ===`n$PB"
        }
    }
    catch { }
    return ''
}

function Get-PipelineDocumentFields {
    <#
    .SYNOPSIS
        Extracts prompt metadata lines (pov/topic tags, title) from Metadata, with DocId as title fallback.
    #>
    param([object]$Metadata, [string]$DocId)
    Set-StrictMode -Version Latest
    if ($Metadata.PSObject.Properties['pov_tags']) { $PovTagsArray = @($Metadata.pov_tags) } else { $PovTagsArray = @() }
    $PovTagLine = $PovTagsArray -join ', '
    if ($Metadata.PSObject.Properties['topic_tags']) { $TopicTagLine = $Metadata.topic_tags -join ', ' } else { $TopicTagLine = '' }
    if ($Metadata.PSObject.Properties['title']) { $TitleLine = $Metadata.title } else { $TitleLine = $DocId }
    return @{ PovTagsArray = $PovTagsArray; PovTagLine = $PovTagLine; TopicTagLine = $TopicTagLine; TitleLine = $TitleLine }
}

function Write-SummaryDensityWarnings {
    <#
    .SYNOPSIS
        Runs the density check and emits one WARN per shortfall; returns the density-check result.
    #>
    param([object]$SummaryObject, [object]$PovTags, [string]$DocId)
    Set-StrictMode -Version Latest
    $DensityCheck = Test-SummaryDensity -SummaryObject $SummaryObject -PovTags $PovTags
    if (-not $DensityCheck.Pass) {
        foreach ($Shortfall in $DensityCheck.Shortfalls) {
            Write-Warning "WARN: ${DocId}: $Shortfall"
        }
    }
    return $DensityCheck
}

function Invoke-PipelineSingleShotExtraction {
    <#
    .SYNOPSIS
        Single-shot extraction path (t/4473/t/4519: no density retry). Returns a result hashtable with
        Failed/FailureResult on the null-API and invalid-JSON early returns, else the parsed summary and
        forensic flags (t/4479).
    #>
    param(
        [string]$FullPrompt, [string]$SysInstruction, [string]$Model,
        [AllowEmptyString()][string]$ApiKey, [double]$Temperature,
        [int]$ExtractionMaxTokens, [string]$DocId, [object]$PovTagsArray
    )
    Set-StrictMode -Version Latest
    Write-Verbose "Pipeline: using single-shot extraction"

    $__SsSw = [System.Diagnostics.Stopwatch]::StartNew()
    $AiResult = Invoke-AIApi `
        -Prompt      $FullPrompt `
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
        return @{ Failed = $true; FailureResult = @{ Success = $false; DocId = $DocId; Error = 'API call returned null' } }
    }

    $AiBackend = $AiResult.Backend
    Write-Verbose "Pipeline: response from $AiBackend"
    # t/4479: recorded as-is, whatever the backend reports; $AiResult.Usage is $null when the
    # backend's response carried no usage block (never guessed as 0). PSObject.Properties guard
    # (not just truthiness) because a mocked AiResult in tests may lack these properties entirely,
    # which StrictMode treats as an error, not a missing/falsy value.
    $Truncated = $null
    $OutputTokens = $null
    if ($AiResult.PSObject.Properties['Truncated']) { $Truncated = [bool]$AiResult.Truncated }
    if ($AiResult.PSObject.Properties['Usage'] -and $AiResult.Usage) { $OutputTokens = $AiResult.Usage.OutputTokens }

    $JsonRepaired = $false
    $CleanedText = $AiResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
    try {
        $SummaryObject = $CleanedText.Trim() | ConvertFrom-Json
    }
    catch {
        # Try repair
        $Repaired = Repair-TruncatedJson -Text $CleanedText
        try { $SummaryObject = $Repaired | ConvertFrom-Json; $JsonRepaired = $true } catch { $SummaryObject = $null }
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
        return @{ Failed = $true; FailureResult = @{ Success = $false; DocId = $DocId; Error = 'InvalidJson' } }
    }

    $DensityCheck = Write-SummaryDensityWarnings -SummaryObject $SummaryObject -PovTags $PovTagsArray -DocId $DocId

    return @{
        Failed        = $false
        SummaryObject = $SummaryObject
        Backend       = $AiBackend
        Truncated     = $Truncated
        OutputTokens  = $OutputTokens
        JsonRepaired  = $JsonRepaired
        DensityCheck  = $DensityCheck
    }
}

function Invoke-PipelineAutoFireStage2 {
    <#
    .SYNOPSIS
        AutoFire Stage 2 post-extraction sniff + FIRE re-run (single-shot path only). Returns the
        possibly-updated @{ Summary; Backend; FireStats }; unchanged when it does not fire.
    #>
    param(
        [switch]$IterativeExtraction, [object]$SummaryObject,
        [string]$FullPrompt, [string]$SysInstruction, [string]$Model,
        [AllowEmptyString()][string]$ApiKey, [double]$Temperature, [int]$ExtractionMaxTokens,
        [string]$CurrentBackend, [object]$CurrentFireStats
    )
    Set-StrictMode -Version Latest
    $Result = @{ Summary = $SummaryObject; Backend = $CurrentBackend; FireStats = $CurrentFireStats }
    if ($IterativeExtraction -or $null -eq $SummaryObject) { return $Result }

    $Sniff2 = Test-FireRequired -SummaryObject $SummaryObject
    if (-not $Sniff2.ShouldFire) { return $Result }

    Write-Verbose "Pipeline AutoFire Stage 2: $($Sniff2.Reason) — re-running with FIRE"
    # -SystemInstruction was missing here (t/4473/t/4519 spec review): Invoke-IterativeExtraction
    # defaults it to '', so the re-run's extraction call carried no system prompt at all —
    # dropping CAMP EXPECTATIONS, the BDI rules, and every other system-prompt instruction.
    $FireResult = Invoke-IterativeExtraction `
        -Prompt $FullPrompt -SystemInstruction $SysInstruction `
        -Model $Model -ApiKey $ApiKey -Temperature $Temperature -MaxTokens $ExtractionMaxTokens
    if ($FireResult.Summary) {
        $Result.Summary = $FireResult.Summary
        $Result.Backend = $FireResult.Backend
        $Result.FireStats = $FireResult.FireStats
    }
    return $Result
}

function Get-PipelineDerivedConfidence {
    <#
    .SYNOPSIS
        Derives an extraction_confidence score for a factual_claim from its evidence_criteria
        (0.5 when no evidence_criteria; else 0.3 + specificity/warrant/consistency bonuses).
    #>
    param([object]$Claim)
    Set-StrictMode -Version Latest
    if (-not $Claim.PSObject.Properties['evidence_criteria']) { return 0.5 }
    $EC = $Claim.evidence_criteria
    $DerivedConf = 0.3
    if ($EC.PSObject.Properties['specificity'] -and $EC.specificity -eq 'precise') { $DerivedConf += 0.2 }
    if ($EC.PSObject.Properties['has_warrant'] -and $EC.has_warrant) { $DerivedConf += 0.2 }
    if ($EC.PSObject.Properties['internally_consistent'] -and $EC.internally_consistent) { $DerivedConf += 0.1 }
    return $DerivedConf
}

function Add-PipelineDerivedConfidence {
    <#
    .SYNOPSIS
        Stage 5b: backfills extraction_confidence on single-shot factual_claims missing it.
        No-op under FIRE or when there are no factual_claims.
    #>
    param([object]$SummaryObject, [switch]$IterativeExtraction)
    Set-StrictMode -Version Latest
    if ($IterativeExtraction) { return }
    if (-not $SummaryObject.PSObject.Properties['factual_claims'] -or -not $SummaryObject.factual_claims) { return }
    foreach ($Claim in @($SummaryObject.factual_claims)) {
        if ($Claim.PSObject.Properties['extraction_confidence'] -and $null -ne $Claim.extraction_confidence) { continue }
        $DerivedConf = Get-PipelineDerivedConfidence -Claim $Claim
        $Claim | Add-Member -NotePropertyName 'extraction_confidence' -NotePropertyValue $DerivedConf -Force
    }
}

function Invoke-PipelineDedup {
    <#
    .SYNOPSIS
        Stage 5c: semantic deduplication; returns @{ Summary; Metrics }. On failure keeps the input
        summary and returns $null metrics with a Verbose note.
    #>
    param([object]$SummaryObject)
    Set-StrictMode -Version Latest
    try {
        $DedupResult = Remove-DuplicateClaims -SummaryObject $SummaryObject -SimilarityThreshold 0.85
        $DedupMetrics = $DedupResult.Metrics
        if ($DedupMetrics.points_removed -gt 0 -or $DedupMetrics.claims_removed -gt 0) {
            Write-Verbose "Pipeline dedup: removed $($DedupMetrics.points_removed) key_points, $($DedupMetrics.claims_removed) factual_claims"
        }
        return @{ Summary = $DedupResult.Summary; Metrics = $DedupMetrics }
    }
    catch {
        Write-Verbose "Pipeline dedup: skipped — $($_.Exception.Message)"
        return @{ Summary = $SummaryObject; Metrics = $null }
    }
}

function Get-PipelineClaimCounts {
    <#
    .SYNOPSIS
        Counts factual_claims and unmapped_concepts on the summary (0 when the field is absent/empty).
    #>
    param([object]$SummaryObject)
    Set-StrictMode -Version Latest
    $FactualRaw = if ($SummaryObject.PSObject.Properties['factual_claims']) { $SummaryObject.factual_claims } else { $null }
    if ($FactualRaw) { $FactualCount = @($FactualRaw).Count } else { $FactualCount = 0 }
    $UnmappedRaw2 = if ($SummaryObject.PSObject.Properties['unmapped_concepts']) { $SummaryObject.unmapped_concepts } else { $null }
    if ($UnmappedRaw2) { $UnmappedCount = @($UnmappedRaw2).Count } else { $UnmappedCount = 0 }
    return @{ FactualCount = $FactualCount; UnmappedCount = $UnmappedCount }
}

function Add-PipelineContextRotStage {
    <#
    .SYNOPSIS
        Stage 7: appends the 'extraction' context-rot stage (flags are forensic/additive) to
        $script:ContextRotStages.
    #>
    param(
        [string]$FullPrompt, [int]$TotalPoints, [int]$NullNodes,
        [int]$FactualCount, [int]$UnmappedCount, [object]$DensityCheck,
        [switch]$IterativeExtraction, [object]$DedupMetrics
    )
    Set-StrictMode -Version Latest
    $NullNodeRate = if ($TotalPoints -gt 0) { [Math]::Round($NullNodes / $TotalPoints, 4) } else { 0 }
    $DensityFloorHit = if ($null -ne $DensityCheck -and -not $DensityCheck.Pass) { 1 } else { 0 }
    $UsedFire = if ($IterativeExtraction) { 1 } else { 0 }
    $DedupPointsRemoved = if ($DedupMetrics) { $DedupMetrics.points_removed } else { 0 }
    $DedupClaimsRemoved = if ($DedupMetrics) { $DedupMetrics.claims_removed } else { 0 }
    $script:ContextRotStages += @(New-ContextRotStage `
        -Stage 'extraction' -InUnits 'prompt_chars' -InCount $FullPrompt.Length `
        -OutUnits 'items' -OutCount ($TotalPoints + $FactualCount + $UnmappedCount) `
        -Flags @{
            null_node_rate       = $NullNodeRate
            density_floor_hit    = $DensityFloorHit
            total_points         = $TotalPoints
            factual_claims       = $FactualCount
            unmapped_concepts    = $UnmappedCount
            used_fire            = $UsedFire
            dedup_points_removed = $DedupPointsRemoved
            dedup_claims_removed = $DedupClaimsRemoved
        })
}

function Add-PipelineLastRagMetrics {
    <#
    .SYNOPSIS
        Stage 7: folds the RAG stage's recorded metrics into $script:ContextRotStages, then clears them.
    #>
    Set-StrictMode -Version Latest
    if ((Test-Path variable:script:LastRAGMetrics) -and $script:LastRAGMetrics) {
        $script:ContextRotStages += @($script:LastRAGMetrics)
        $script:LastRAGMetrics = $null
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
