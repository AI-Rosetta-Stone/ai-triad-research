# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-POVSummary {
    <#
    .SYNOPSIS
        Processes a single source document through AI to extract a structured
        POV summary mapped to the AI Triad taxonomy.
    .DESCRIPTION
        Implements the core AI summarization loop for ONE document:
            1. Validates inputs and resolves paths
            2. Loads taxonomy version
            3. Delegates extraction to Invoke-SummaryPipeline (CHESS, RAG,
               AutoFire, FIRE/single-shot, density retry, unmapped resolution)
            4. Writes summaries/<doc-id>.json
            5. Updates sources/<doc-id>/metadata.json (summary_status, summary_version)
            6. Runs basic conflict detection
    .PARAMETER DocId
        The document slug ID, e.g. "altman-2024-agi-path".
    .PARAMETER RepoRoot
        Path to the root of the ai-triad-research repository.
        Defaults to the module-resolved repo root.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Model
        AI model to use. Defaults to "gemini-3.5-flash-lite".
        Supports Gemini, Claude, and Groq backends.
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.1
    .PARAMETER DryRun
        Build and display the prompt, but do NOT call the API or write any files.
    .PARAMETER Force
        Re-process the document even if summary_status is already "current".
    .PARAMETER FullTaxonomy
        Bypass RAG — inject all taxonomy nodes into the prompt.
    .PARAMETER IterativeExtraction
        Force FIRE iterative extraction.
    .PARAMETER AutoFire
        Enable two-stage FIRE sniff (auto-detect whether FIRE is worthwhile).
    .PARAMETER ReExtract
        Batch re-extraction mode. Finds all documents with summary_status
        "needs_reextraction" and re-processes them using -ModelEscalation model.
        When used, -DocId is ignored.
    .PARAMETER ModelEscalation
        Model to use for re-extraction of under-extracted documents.
        Default: "gemini-2.5-flash".
    .EXAMPLE
        Invoke-POVSummary -DocId "altman-2024-agi-path"
    .EXAMPLE
        Invoke-POVSummary -DocId "altman-2024-agi-path" -DryRun
    .EXAMPLE
        Invoke-POVSummary -DocId "lecun-2024-critique" -Model "gemini-3.5-flash-lite"
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-BatchSummary
    .LINK
        Get-Summary
    .LINK
        Repair-AITSummaryMappings
    .LINK
        Test-ExtractionQuality
    .LINK
        Repair-UnmappedConcepts
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory, Position = 0, HelpMessage = "Document slug ID, e.g. altman-2024-agi-path")]
        [string]$DocId,

        [string]$RepoRoot    = $script:RepoRoot,

        [string]$ApiKey      = '',

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model       = (Get-AITierModel -Tier basic),

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.1,

        [switch]$DryRun,
        [switch]$Force,

        [switch]$FullTaxonomy,

        [switch]$IterativeExtraction,

        [switch]$AutoFire,

        [switch]$ReExtract,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$ModelEscalation = "gemini-2.5-flash",

        [int]$RagMaxTotal = 300,

        # Cross-encoder re-ranking of RAG candidates (t/2287). Default OFF.
        [switch]$CrossEncoderRerank
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # The steps live in Private/InvokePOVSummarySteps.ps1 (t/3910).

    # -- ReExtract dispatch: find all needs_reextraction docs and recurse -----
    if ($ReExtract) {
        Invoke-POVSummaryReExtract -ModelEscalation $ModelEscalation -ApiKey $ApiKey -RepoRoot $RepoRoot -AutoFire:$AutoFire
        return
    }

    # -- STEP 0 — Validate inputs and resolve paths ---------------------------
    Write-Step "Validating inputs"

    $paths = Get-POVSummaryPathSet -RepoRoot $RepoRoot -DocId $DocId
    Assert-POVSummaryInput -Paths $paths -DocId $DocId

    $script:ContextRotStages = @()

    $metadata = Get-Content $paths.MetadataFile -Raw | ConvertFrom-Json
    # duplicate_of (t/4337 C1): an explicit -DocId is a lookup, so a marked copy is still summarized
    # when asked for, but batch runs skip it and its summary isn't counted as evidence.
    if ($metadata.PSObject.Properties['duplicate_of'] -and -not [string]::IsNullOrEmpty([string]$metadata.duplicate_of)) {
        Write-Warning "Invoke-POVSummary: '$DocId' is marked duplicate_of '$($metadata.duplicate_of)'. Summarizing it as asked, but evidence producers skip a marked copy's summary; summarize '$($metadata.duplicate_of)' instead."
    }
    if (Test-POVSummaryAlreadyCurrent -Metadata $metadata -Force:$Force -DryRun:$DryRun) { return }

    if (-not $DryRun) {
        $ApiKey = Resolve-POVSummaryApiKey -Model $Model -ApiKey $ApiKey
    }

    Write-OK "Doc ID      : $DocId"
    Write-OK "Repo root   : $RepoRoot"
    Write-OK "Model       : $Model"
    Write-OK "Temperature : $Temperature"
    if ($DryRun) { Write-Warn "DRY RUN — no API call, no file writes" }

    # -- STEP 1 — Load taxonomy version ---------------------------------------
    Write-Step "Loading taxonomy"
    $taxonomyVersion = Get-POVSummaryTaxonomyVersion -VersionFile $paths.VersionFile

    # -- STEP 2 — Load snapshot ------------------------------------------------
    Write-Step "Loading document snapshot"
    $snapshotText = Read-POVSummarySnapshot -SnapshotFile $paths.SnapshotFile -Metadata $metadata

    # -- DRY RUN — build prompt locally and display ----------------------------
    if ($DryRun) {
        Show-POVSummaryDryRun -TaxonomyDir $paths.TaxonomyDir -SnapshotText $snapshotText
        return
    }

    # Created after the dry-run return, so -DryRun creates nothing (t/4070). Before the pipeline,
    # because it saves a debug-raw file into summaries/ when the model returns invalid JSON.
    foreach ($dir in @($paths.SummariesDir, $paths.ConflictsDir)) {
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }

    # -- STEP 3 — Run extraction pipeline --------------------------------------
    Write-Step "Running extraction pipeline"

    $systemPromptTemplate = Get-Prompt -Name 'pov-summary-system'
    $outputSchema = Get-Prompt -Name 'pov-summary-schema'

    $pipelineResult = Invoke-SummaryPipeline `
        -SnapshotText          $snapshotText `
        -DocId                 $DocId `
        -Metadata              $metadata `
        -ApiKey                $ApiKey `
        -Model                 $Model `
        -Temperature           $Temperature `
        -TaxonomyVersion       $taxonomyVersion `
        -SystemPromptTemplate  $systemPromptTemplate `
        -OutputSchema          $outputSchema `
        -FullTaxonomy:$FullTaxonomy `
        -IterativeExtraction:$IterativeExtraction `
        -AutoFire:$AutoFire `
        -RagMaxTotal           $RagMaxTotal `
        -CrossEncoderRerank:$CrossEncoderRerank

    if (-not $pipelineResult.Success) {
        Write-Fail "Pipeline failed: $($pipelineResult.Error)"
        throw "Pipeline failed for ${DocId}: $($pipelineResult.Error)"
    }

    # Extract results from pipeline
    $summaryObject        = $pipelineResult.Summary
    $factualClaimCount    = $pipelineResult.FactualCount
    $unmappedConceptCount = $pipelineResult.UnmappedCount
    $fireStats            = $pipelineResult.FireStats
    $usedFire             = $pipelineResult.UsedFire

    # Collect context-rot stages from pipeline
    $contextRot = Get-POVSummaryContextRot -DocId $DocId

    Write-POVSummaryExtractionReport -PipelineResult $pipelineResult -SummaryObject $summaryObject `
        -FactualClaimCount $factualClaimCount -UnmappedConceptCount $unmappedConceptCount -UsedFire $usedFire -FireStats $fireStats

    # -WhatIf / -Confirm: one decision covers every write in steps 4-6 (summary, metadata, source
    # index, conflicts), so a declined run reports none of them as done and can never leave
    # metadata.json marked current for a summary that was not written (t/4070).
    $writeTarget = "summaries/$DocId.json, sources/$DocId/metadata.json and conflicts/"
    $filesWritten = $PSCmdlet.ShouldProcess($writeTarget, 'Write POV summary, update metadata and log conflicts')
    if ($filesWritten) {
        # -- STEP 4 — Write summary file --------------------------------------
        Write-Step "Writing summary file"

        $nodeCount = Get-POVSummaryTaxonomyNodeCount -TaxonomyJson $pipelineResult.TaxonomyJson
        $modelInfo = Get-POVSummaryModelInfo -Model $Model -Temperature $Temperature -UsedFire $usedFire -FireStats $fireStats `
            -FullTaxonomy:$FullTaxonomy -TaxonomyNodeCount $nodeCount -MaxTokens (Get-SummaryField $pipelineResult 'MaxTokens')
        Write-POVSummaryFile -Path $paths.SummaryFile -DocId $DocId -TaxonomyVersion $taxonomyVersion -ModelInfo $modelInfo `
            -SummaryObject $summaryObject -ContextRotObj $contextRot.Obj

        # -- STEP 5 — Update metadata.json ------------------------------------
        Write-Step "Updating metadata"
        Write-POVSummaryMetadataFile -Paths $paths -DocId $DocId -TaxonomyVersion $taxonomyVersion -SummaryObject $summaryObject `
            -FactualClaimCount $factualClaimCount -UnmappedConceptCount $unmappedConceptCount `
            -ContextRotStages $contextRot.Stages -ContextRotObj $contextRot.Obj

        # -- STEP 6 — Conflict detection --------------------------------------
        Write-Step "Running conflict detection"
        Invoke-POVSummaryConflictDetection -SummaryObject $summaryObject -FactualClaimCount $factualClaimCount `
            -DocId $DocId -ConflictsDir $paths.ConflictsDir
    }

    # -- STEP 7 — Print human-readable summary to console --------------------
    Write-POVSummaryConsole -DocId $DocId -TaxonomyVersion $taxonomyVersion -Model $Model -SummaryObject $summaryObject `
        -UnmappedConceptCount $unmappedConceptCount -FactualClaimCount $factualClaimCount -SnapshotFile $paths.SnapshotFile `
        -FilesWritten:$filesWritten
}
