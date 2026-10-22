# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# The steps of Invoke-POVSummary, extracted for t/3910 (cyclomatic complexity under 20), then fixed for
# t/4070: fields the model omits degrade with a fallback WARN instead of a StrictMode throw, and the
# persisted factual_claims/unmapped_concepts are always arrays. Pinned by
# tests/Invoke-POVSummary.Characterization.Tests.ps1. Strict mode and ErrorActionPreference are
# inherited from Invoke-POVSummary's scope.


# Node-id prefix -> POV bucket for the metadata reference counts.
$script:POVSummaryNodePrefixes = [ordered]@{ 'acc-*' = 'accelerationist'; 'saf-*' = 'safetyist'; 'skp-*' = 'skeptic'; 'sit-*' = 'situations' }

$script:POVSummaryCampColors = @{ accelerationist = 'Green'; safetyist = 'Red'; skeptic = 'Yellow' }

# ── ReExtract ────────────────────────────────────────────────────────────────

function Invoke-POVSummaryReExtract {
    # Finds every source whose metadata says needs_reextraction and re-runs Invoke-POVSummary on it.
    param([string]$ModelEscalation, [string]$ApiKey, [string]$RepoRoot, [switch]$AutoFire)
    $SourcesDir = Get-SourcesDir
    $Flagged = @()
    # duplicate_of (t/4337 C1): a marked copy is never re-extracted.
    $Resolution = Get-SourceResolution -SourcesDir $SourcesDir
    foreach ($DocDir in (Get-ChildItem -Path $SourcesDir -Directory)) {
        if (-not (Test-SourceSelectable -Resolution $Resolution -Id $DocDir.Name)) { continue }
        $MetaPath = Join-Path $DocDir.FullName 'metadata.json'
        if (-not (Test-Path $MetaPath)) { continue }
        $Meta = Get-Content $MetaPath -Raw | ConvertFrom-Json
        if ($Meta.PSObject.Properties['summary_status'] -and $Meta.summary_status -eq 'needs_reextraction') {
            $Flagged += $DocDir.Name
        }
    }
    if ($Flagged.Count -eq 0) {
        Write-OK "No documents flagged for re-extraction."
        return
    }
    Write-Host "`n  RE-EXTRACTION: $($Flagged.Count) document(s) flagged" -ForegroundColor Yellow
    foreach ($FlaggedId in $Flagged) {
        Write-Host "    - $FlaggedId" -ForegroundColor Gray
    }
    Write-Host ''
    foreach ($FlaggedId in $Flagged) {
        Invoke-POVSummary -DocId $FlaggedId -Model $ModelEscalation -Force -ApiKey $ApiKey -RepoRoot $RepoRoot -AutoFire:$AutoFire
    }
}

# ── Step 0: inputs ───────────────────────────────────────────────────────────

function Get-POVSummaryPathSet {
    param([string]$RepoRoot, [string]$DocId)
    @{
        Root         = $RepoRoot
        TaxonomyDir  = Get-TaxonomyDir
        SourcesDir   = Get-SourcesDir
        SummariesDir = Get-SummariesDir
        ConflictsDir = Get-ConflictsDir
        VersionFile  = Get-VersionFile
        DocDir       = Join-Path (Get-SourcesDir) $DocId
        SnapshotFile = Join-Path (Join-Path (Get-SourcesDir) $DocId) "snapshot.md"
        MetadataFile = Join-Path (Join-Path (Get-SourcesDir) $DocId) "metadata.json"
        SummaryFile  = Join-Path (Get-SummariesDir) "$DocId.json"
    }
}

function Assert-POVSummaryInput {
    # The four required paths, checked in order; the first one missing is reported and thrown.
    param([hashtable]$Paths, [string]$DocId)
    $Checks = @(
        @{ Path = $Paths.Root;         Fail = "Repo root not found: $($Paths.Root)";             Info = $null;                      Throw = "Repo root not found: $($Paths.Root)" }
        @{ Path = $Paths.DocDir;       Fail = "Document folder not found: $($Paths.DocDir)";     Info = "Expected: sources/$DocId/"; Throw = "Document folder not found: sources/$DocId/" }
        @{ Path = $Paths.SnapshotFile; Fail = "snapshot.md not found: $($Paths.SnapshotFile)";   Info = $null;                      Throw = "snapshot.md not found for $DocId" }
        @{ Path = $Paths.MetadataFile; Fail = "metadata.json not found: $($Paths.MetadataFile)"; Info = $null;                      Throw = "metadata.json not found for $DocId" }
    )
    foreach ($Check in $Checks) {
        if (Test-Path $Check.Path) { continue }
        Write-Fail $Check.Fail
        if ($Check.Info) { Write-Info $Check.Info }
        throw $Check.Throw
    }
}

function Test-POVSummaryAlreadyCurrent {
    # True (after telling the user) when the summary is current and neither -Force nor -DryRun was given.
    param($Metadata, [switch]$Force, [switch]$DryRun)
    if ((-not $Force) -and (-not $DryRun) -and ($Metadata.summary_status -eq "current")) {
        if ($Metadata.PSObject.Properties['summary_version']) {
            Write-Warn "Summary is already current (taxonomy v$($Metadata.summary_version))."
        }
        else {
            # Fallback (t/4070): skip as current with the version unknown, rather than throw.
            Write-Warning "Invoke-POVSummary: metadata.json says summary_status=current but has no summary_version; skipping it as current with the taxonomy version unknown."
            Write-Warn "Summary is already current (taxonomy version not recorded)."
        }
        Write-Info "Use -Force to re-process anyway."
        return $true
    }
    $false
}

function Resolve-POVSummaryApiKey {
    # Checks that a key exists for the model's REGISTRY backend (never a prefix guess), or throws naming
    # the env var to set. Returns the key to FORWARD: only the user's own -ApiKey (or ''), never an env
    # key resolved here; Invoke-AIApi resolves the key for the registry backend itself (t/4087).
    param([string]$Model, [string]$ApiKey)
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Fail "No API key found for $($KeyStatus.Backend) backend."
        Write-Info "Set $($KeyStatus.EnvHint), or pass -ApiKey."
        throw "No API key found for $($KeyStatus.Backend) backend."
    }
    $ApiKey
}

# ── Steps 1-2: taxonomy version and snapshot ─────────────────────────────────

function Get-POVSummaryTaxonomyVersion {
    param([string]$VersionFile)
    if (-not (Test-Path $VersionFile)) {
        Write-Fail "TAXONOMY_VERSION file not found at: $VersionFile"
        throw "TAXONOMY_VERSION not found"
    }
    $Version = (Get-Content $VersionFile -Raw).Trim()
    Write-OK "Taxonomy version: $Version"
    $Version
}

function Read-POVSummarySnapshot {
    param([string]$SnapshotFile, $Metadata)
    # Inline base64 images stripped before the RAG query and token estimate (t/4386).
    $SnapshotText    = Read-SnapshotForModel -Path $SnapshotFile -CallerName 'Invoke-POVSummary'
    $SnapshotLength  = $SnapshotText.Length
    $EstimatedTokens = [int]($SnapshotLength / 4)

    Write-OK "Snapshot loaded: $SnapshotLength chars (~$EstimatedTokens tokens estimated)"
    Write-Info "Title from metadata: $($Metadata.title)"
    Write-Info "POV tags in metadata: $($Metadata.pov_tags -join ', ')"

    if ($EstimatedTokens -gt 100000) {
        Write-Warn "Document is very long (~$EstimatedTokens tokens). Consider chunking if the API call fails."
    }
    $SnapshotText
}

# ── Dry run ──────────────────────────────────────────────────────────────────

function Show-POVSummaryDryRun {
    # Builds the prompt locally (no API key, so no CHESS/RAG) and prints it. Writes nothing.
    param([string]$TaxonomyDir, [string]$SnapshotText)
    $TaxonomyFiles   = @("accelerationist.json", "safetyist.json", "skeptic.json", "situations.json")
    $TaxonomyContext = [ordered]@{}
    foreach ($File in $TaxonomyFiles) {
        $FilePath = Join-Path $TaxonomyDir $File
        if (Test-Path $FilePath) {
            $TaxonomyContext[$File] = Get-Content $FilePath -Raw | ConvertFrom-Json
            Set-TaxonomyDocumentSelectable -Document $TaxonomyContext[$File] -Name $File   # dry-run prompt preview (t/4356)
        }
    }
    $TaxonomyJson = $TaxonomyContext | ConvertTo-Json -Depth 20 -Compress:$false

    $WordCount = ($SnapshotText -split '\s+').Count
    $OutputSchema = Get-Prompt -Name 'pov-summary-schema'
    $KpMin = [Math]::Max(3,  [int]($WordCount / 500))
    $SystemPrompt = Get-Prompt -Name 'pov-summary-system' -Replacements @{
        WORD_COUNT   = $WordCount
        KP_MIN       = $KpMin
        KP_MAX       = [Math]::Max(8,  [int]($WordCount / 200))
        UC_MIN       = [Math]::Max(2,  [int]($WordCount / 2000))
        UC_MAX       = [Math]::Max(5,  [int]($WordCount / 800))
        TOTAL_FLOOR  = [Math]::Max(6,  $KpMin * 2)
    }

    Write-Host "`n$('─' * 72)" -ForegroundColor DarkGray
    Write-Host "  DRY RUN: FULL PROMPT PREVIEW" -ForegroundColor Yellow
    Write-Host "$('─' * 72)" -ForegroundColor DarkGray

    Write-Host "`n[SYSTEM PROMPT]" -ForegroundColor Cyan
    Write-Host $SystemPrompt -ForegroundColor Gray

    Write-Host "`n[TAXONOMY CONTEXT — first 500 chars]" -ForegroundColor Cyan
    Write-Host $TaxonomyJson.Substring(0, [Math]::Min(500, $TaxonomyJson.Length)) -ForegroundColor Gray
    Write-Host "... (truncated for display)" -ForegroundColor DarkGray

    Write-Host "`n[DOCUMENT CONTENT — first 500 chars]" -ForegroundColor Cyan
    Write-Host $SnapshotText.Substring(0, [Math]::Min(500, $SnapshotText.Length)) -ForegroundColor Gray
    Write-Host "... (truncated for display)" -ForegroundColor DarkGray

    Write-Host "`n[OUTPUT SCHEMA]" -ForegroundColor Cyan
    Write-Host $OutputSchema -ForegroundColor Gray

    Write-Host "`n$('─' * 72)" -ForegroundColor DarkGray
    Write-Host "  DRY RUN complete. No API call made. No files written." -ForegroundColor Yellow
    Write-Host "$('─' * 72)`n" -ForegroundColor DarkGray
}

# ── Step 3: extraction ───────────────────────────────────────────────────────

function Get-POVSummaryContextRot {
    # The context-rot stages the pipeline recorded, and the metrics object built from them ($null if none).
    param([string]$DocId)
    $Stages = @($script:ContextRotStages)
    $Obj = if ($Stages.Count -gt 0) {
        New-ContextRotMetrics -Pipeline 'summary' -DocId $DocId -Stages $Stages
    } else { $null }
    @{ Stages = $Stages; Obj = $Obj }
}

function Invoke-POVSummaryNodeIdCheck {
    <#
    .SYNOPSIS
        The node-id check Finalize-Summary runs on the document path, for the POV-summary path (t/4430).
    .DESCRIPTION
        Invoke-POVSummary never calls Finalize-Summary, so a key_point citing a node id that isn't in the
        taxonomy used to reach the written summary. Same rule as the document path
        (Move-HallucinatedNodeIdsToUnmapped): the id is nulled and the point moves to unmapped_concepts.
        Returns the unmapped count after the move, so the console, report and metadata agree.
    #>
    param([object]$SummaryObject, [int]$UnmappedConceptCount)
    $Moved = Move-HallucinatedNodeIdsToUnmapped -SummaryObject $SummaryObject
    $UnmappedConceptCount + @($Moved).Count
}

function Test-POVSummaryCampPresent {
    # True when pov_summaries carries the camp at all (its value may still be null or empty).
    param($SummaryObject, [string]$Camp)
    if (-not $SummaryObject.PSObject.Properties['pov_summaries']) { return $false }
    $Povs = $SummaryObject.pov_summaries
    ($null -ne $Povs) -and [bool]$Povs.PSObject.Properties[$Camp]
}

function Get-POVSummaryCampData {
    # One camp's block from pov_summaries, or $null when the model omitted the camp (t/4070).
    param($SummaryObject, [string]$Camp)
    if (-not (Test-POVSummaryCampPresent -SummaryObject $SummaryObject -Camp $Camp)) { return $null }
    $SummaryObject.pov_summaries.$Camp
}

function Write-POVSummaryExtractionReport {
    param($PipelineResult, $SummaryObject, $FactualClaimCount, $UnmappedConceptCount, $UsedFire, $FireStats)
    Write-OK "Pipeline complete in $($PipelineResult.ElapsedSeconds)s ($($PipelineResult.Backend))"
    foreach ($Camp in @('accelerationist', 'safetyist', 'skeptic')) {
        if (-not (Test-POVSummaryCampPresent -SummaryObject $SummaryObject -Camp $Camp)) {
            # Fallback (t/4070): the camp counts as empty everywhere below instead of throwing.
            Write-Warning "Invoke-POVSummary: the model's pov_summaries has no '$Camp' camp; treating it as empty (no key points)."
        }
        $CampData = Get-POVSummaryCampData -SummaryObject $SummaryObject -Camp $Camp
        if ($CampData -and $CampData.PSObject.Properties['key_points'] -and $CampData.key_points) {
            $PointCount = @($CampData.key_points).Count
            $NullNodes  = @($CampData.key_points | Where-Object { -not $_.PSObject.Properties['taxonomy_node_id'] -or $null -eq $_.taxonomy_node_id }).Count
            Write-OK "  $Camp : $PointCount key points ($NullNodes unmapped)"
        }
        else {
            Write-Warn "  $Camp : no data returned"
        }
    }
    Write-OK "  factual_claims    : $FactualClaimCount"
    Write-OK "  unmapped_concepts : $UnmappedConceptCount"

    if ($UsedFire -and $FireStats) {
        Write-Info "  FIRE: $($FireStats.total_api_calls) API calls, $($FireStats.total_iterations) iterations, $($FireStats.termination_reason)"
    }
}

# ── Step 4: summary file ─────────────────────────────────────────────────────

function Get-POVSummaryTaxonomyNodeCount {
    # Node count in the prompt's taxonomy context: indented lines in RAG output, "id" keys in full JSON.
    param([string]$TaxonomyJson)
    if ($TaxonomyJson -match '^\s*=== RELEVANT TAXONOMY NODES') {
        return ([regex]::Matches($TaxonomyJson, '^\s{2}\w', [System.Text.RegularExpressions.RegexOptions]::Multiline)).Count
    }
    ([regex]::Matches($TaxonomyJson, '"id"\s*:')).Count
}

function Get-POVSummaryModelInfo {
    # max_tokens is the extraction call's MaxTokens as Invoke-SummaryPipeline returns it, and
    # fire_confidence_threshold is the threshold FIRE reports in its FireStats (confidence_threshold),
    # as in New-SummaryModelInfo (t/4079). Both used to be hard-coded here (32768 and 0.7, t/4172).
    # Either is recorded as null when the caller does not know it, rather than as a made-up number.
    param([string]$Model, [double]$Temperature, $UsedFire, $FireStats, [switch]$FullTaxonomy, $TaxonomyNodeCount,
          [object]$MaxTokens = $null)
    $ModelInfo = [ordered]@{
        model             = $Model
        temperature       = $Temperature
        max_tokens        = $MaxTokens
        extraction_mode   = if ($UsedFire) { 'fire' } else { 'single_shot' }
        taxonomy_filter   = if ($FullTaxonomy) { 'full' } else { 'rag' }
        taxonomy_nodes    = $TaxonomyNodeCount
    }
    if ($UsedFire -and $FireStats) {
        $ModelInfo['fire_confidence_threshold'] = Get-SummaryField $FireStats 'confidence_threshold'
        $ModelInfo['fire_stats'] = [ordered]@{
            api_calls          = $FireStats.total_api_calls
            iterations         = $FireStats.total_iterations
            claims_total       = $FireStats.claims_total
            claims_confident   = $FireStats.claims_confident
            claims_iterated    = $FireStats.claims_iterated
            elapsed_seconds    = $FireStats.elapsed_seconds
            termination_reason = $FireStats.termination_reason
        }
    }
    $ModelInfo
}

function Get-POVSummaryOptionalArray {
    # A summary's LLM-optional array field, or @() when the model omitted it (t/1726) or sent null
    # (@($null) would be a one-element array holding null; t/4070). Callers wrap in @().
    param($SummaryObject, [string]$Name)
    if ($SummaryObject.PSObject.Properties[$Name] -and $null -ne $SummaryObject.$Name) { return @($SummaryObject.$Name) }
    @()
}

function Write-POVSummaryFile {
    param([string]$Path, [string]$DocId, [string]$TaxonomyVersion, $ModelInfo, $SummaryObject, $ContextRotObj)
    $FinalSummary = [ordered]@{
        doc_id            = $DocId
        taxonomy_version  = $TaxonomyVersion
        generated_at      = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        model_info        = $ModelInfo
        pov_summaries     = $SummaryObject.pov_summaries
        # t/1726: coerce LLM-optional fields to arrays so the persisted summary always carries them,
        # which protects every downstream consumer from a strict-mode missing-property throw when the
        # model omits the field. The outer @() is load-bearing: a bare if-expression unrolls, so 0 items
        # persisted as null and 1 item as a bare object (t/4070).
        factual_claims    = @(Get-POVSummaryOptionalArray -SummaryObject $SummaryObject -Name 'factual_claims')
        unmapped_concepts = @(Get-POVSummaryOptionalArray -SummaryObject $SummaryObject -Name 'unmapped_concepts')
        context_rot       = $ContextRotObj
    }
    $SummaryJson = $FinalSummary | ConvertTo-Json -Depth 20
    try {
        Write-Utf8NoBom -Path $Path -Value $SummaryJson
        Write-OK "Summary written to: summaries/$DocId.json"
    }
    catch {
        Write-Fail "Failed to write summary file — $($_.Exception.Message)"
        Write-Info "AI response was valid but could not be saved. Check disk space and permissions."
        throw
    }
}

# ── Step 5: metadata ─────────────────────────────────────────────────────────

function Get-POVSummaryNodeRefStat {
    # Per-POV node reference counts (every linked id) and primary-POV distribution (first recognised id
    # per claim). The two hashtables are plain @{} as before, so their key order stays unordered.
    param($SummaryObject)
    $NodeRefsByPov = @{ accelerationist = 0; safetyist = 0; skeptic = 0; situations = 0 }
    $PrimaryPovDist = @{ accelerationist = 0; safetyist = 0; skeptic = 0; situations = 0 }
    foreach ($Claim in @(Get-POVSummaryOptionalArray -SummaryObject $SummaryObject -Name 'factual_claims')) {
        if ($null -eq $Claim) { continue }
        $PrimaryAssigned = $false
        # An omitted linked_taxonomy_nodes counts as no links (t/4070); the conflict step WARNs for it.
        $Linked = if ($Claim.PSObject.Properties['linked_taxonomy_nodes']) { $Claim.linked_taxonomy_nodes } else { $null }
        foreach ($NodeId in @($Linked)) {
            if ($null -eq $NodeId) { continue }
            $Pov = Get-POVSummaryNodePov -NodeId $NodeId
            if (-not $Pov) { continue }
            $NodeRefsByPov[$Pov]++
            if (-not $PrimaryAssigned) { $PrimaryPovDist[$Pov]++; $PrimaryAssigned = $true }
        }
    }
    @{ NodeRefsByPov = $NodeRefsByPov; PrimaryPovDist = $PrimaryPovDist }
}

function Get-POVSummaryNodePov {
    # The POV bucket for a node id by prefix, or $null for an unrecognised prefix.
    param($NodeId)
    foreach ($Pattern in $script:POVSummaryNodePrefixes.Keys) {
        if ($NodeId -like $Pattern) { return $script:POVSummaryNodePrefixes[$Pattern] }
    }
    $null
}

function Get-POVSummaryKeyPointTotal {
    param($SummaryObject)
    $Total = 0
    foreach ($Camp in @('accelerationist', 'safetyist', 'skeptic')) {
        $CampData = Get-POVSummaryCampData -SummaryObject $SummaryObject -Camp $Camp
        if ($CampData -and $CampData.PSObject.Properties['key_points'] -and $CampData.key_points) {
            $Total += @($CampData.key_points).Count
        }
    }
    $Total
}

function Get-POVSummaryContextRotDigest {
    # The metadata's context_rot block: cumulative retention, the worst same-unit stage, and
    # extraction density (items per 1000 input units).
    param([object[]]$Stages, $ContextRotObj)
    $SameUnitStages = @($Stages | Where-Object { $_.in_units -eq $_.out_units })
    $WorstStage = $SameUnitStages | Sort-Object { $_.ratio } | Select-Object -First 1

    $ExtractionStage = @($Stages | Where-Object { $_.stage -eq 'extraction' }) | Select-Object -First 1
    $ExtractionDensity = if ($ExtractionStage -and $ExtractionStage.in_count -gt 0) {
        [Math]::Round(($ExtractionStage.out_count / $ExtractionStage.in_count) * 1000, 4)
    } else { $null }

    [ordered]@{
        cumulative_retention = $ContextRotObj.cumulative_retention
        worst_stage          = if ($WorstStage) { $WorstStage.stage } else { $null }
        worst_ratio          = if ($WorstStage) { $WorstStage.ratio } else { $null }
        extraction_density   = $ExtractionDensity
    }
}

function Test-POVSummaryUnderExtracted {
    # Large snapshot (> 30 KB) with fewer than 3 factual claims.
    param([string]$SnapshotFile, $FactualClaimCount)
    $SnapshotSizeKB = [Math]::Round((Get-Item $SnapshotFile).Length / 1024, 1)
    [pscustomobject]@{ Flagged = ($FactualClaimCount -lt 3 -and $SnapshotSizeKB -gt 30); SizeKB = $SnapshotSizeKB }
}

function Write-POVSummaryMetadataFile {
    # Rewrites metadata.json with status, version and summary statistics, then rebuilds the source
    # index. A failure here is reported and swallowed: the summary file is already written.
    param([hashtable]$Paths, [string]$DocId, [string]$TaxonomyVersion, $SummaryObject,
          $FactualClaimCount, $UnmappedConceptCount, [object[]]$ContextRotStages, $ContextRotObj)
    try {
        $MetaRaw     = Get-Content $Paths.MetadataFile -Raw
        # Shape-preserving read (t/4366): a bare ConvertFrom-Json coerces ISO strings such as
        # import_time to [datetime], and the whole-object rewrite below re-emits them in this
        # machine's offset. Same fix as Set-BatchDocCurrent / Update-SummaryMetadata (#3553).
        $MetaUpdated = ConvertFrom-JsonPreserveShape -Json $MetaRaw -AsOrderedHashtable

        $MetaUpdated["summary_version"] = $TaxonomyVersion
        $MetaUpdated["summary_status"]  = "current"
        $MetaUpdated["summary_updated"] = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")

        $RefStats = Get-POVSummaryNodeRefStat -SummaryObject $SummaryObject
        $TotalFacts = Get-POVSummaryKeyPointTotal -SummaryObject $SummaryObject

        # Quality gate: flag under-extracted large documents
        $Under = Test-POVSummaryUnderExtracted -SnapshotFile $Paths.SnapshotFile -FactualClaimCount $FactualClaimCount
        if ($Under.Flagged) {
            $MetaUpdated["summary_status"] = "needs_reextraction"
            Write-Warn "Under-extraction detected: $FactualClaimCount claims from $($Under.SizeKB)KB snapshot. Queued for re-extraction with stronger model."
            Write-Info "Run Invoke-POVSummary -ReExtract to re-process flagged documents."
        }

        $MetaUpdated["total_claims"]              = $FactualClaimCount
        $MetaUpdated["node_references_by_pov"]   = $RefStats.NodeRefsByPov
        $MetaUpdated["primary_pov_distribution"] = $RefStats.PrimaryPovDist
        $MetaUpdated.Remove("claims_by_pov")
        $MetaUpdated["total_facts"]        = $TotalFacts
        $MetaUpdated["unmapped_concepts"]  = $UnmappedConceptCount

        if ($ContextRotObj) {
            $MetaUpdated['context_rot'] = Get-POVSummaryContextRotDigest -Stages $ContextRotStages -ContextRotObj $ContextRotObj
        }

        Write-Utf8NoBom -Path $Paths.MetadataFile -Value ($MetaUpdated | ConvertTo-Json -Depth 10)
        $WrittenStatus = $MetaUpdated["summary_status"]
        Write-OK "metadata.json updated: summary_status=$WrittenStatus, summary_version=$TaxonomyVersion"

        # Rebuild source index so Get-AITSource picks up updated stats
        try { Update-AITSourceIndex -Quiet } catch { Write-Verbose "Index rebuild skipped: $_" }
    }
    catch {
        Write-Warn "Summary written but metadata update failed — $($_.Exception.Message)"
        Write-Info "Run Invoke-POVSummary -Force -DocId '$DocId' to retry."
    }
}

# ── Step 6: conflict detection ───────────────────────────────────────────────

function Invoke-POVSummaryConflictDetection {
    param($SummaryObject, $FactualClaimCount, [string]$DocId, [string]$ConflictsDir)
    $Today = Get-Date -Format "yyyy-MM-dd"
    if ($FactualClaimCount -eq 0) {
        Write-Info "No factual claims to process."
        return
    }
    foreach ($Claim in @(Get-POVSummaryOptionalArray -SummaryObject $SummaryObject -Name 'factual_claims')) {
        Add-POVSummaryClaimConflict -Claim $Claim -DocId $DocId -ConflictsDir $ConflictsDir -Today $Today
    }
}

function Add-POVSummaryClaimConflict {
    # Logs one claim as a conflict instance: into its hinted conflict file if it names one, else into a
    # fuzzy-matched file, else into a new file.
    param($Claim, [string]$DocId, [string]$ConflictsDir, [string]$Today)
    $Read = Get-POVSummaryClaimField -Claim $Claim
    if ($null -eq $Read) { return }
    $ClaimText   = $Read.claim
    $ClaimLabel  = $Read.claim_label
    $DocPosition = $Read.doc_position
    $HintId      = $Read.potential_conflict_id
    $LinkedNodes = ConvertTo-LinkedNodesArray -Value $Read.linked_taxonomy_nodes

    # Normalize stance value
    if ($DocPosition -in @('supports','disputes','neutral','qualifies')) { $Stance = $DocPosition } else { $Stance = 'neutral' }

    $NewInstance = [ordered]@{
        doc_id       = $DocId
        stance       = $Stance
        assertion    = $ClaimText
        date_flagged = $Today
    }

    $Context = @{ DocId = $DocId; ConflictsDir = $ConflictsDir; ClaimText = $ClaimText; ClaimLabel = $ClaimLabel; Instance = $NewInstance; LinkedNodes = $LinkedNodes }
    if ($HintId) { Add-POVSummaryHintedConflict -HintId $HintId -Context $Context }
    else         { Add-POVSummaryUnhintedConflict -Context $Context }
}

function Get-POVSummaryClaimField {
    # The claim's conflict-logging fields as a hashtable, or $null (claim skipped, with a WARN) when
    # there is no claim text to log. Optional fields the model omitted read as $null, the same as an
    # explicit null, with one fallback WARN per claim naming them; they used to throw (t/4070).
    param($Claim)
    $Names = @('claim', 'claim_label', 'doc_position', 'potential_conflict_id', 'linked_taxonomy_nodes')
    $Fields = @{}
    $Missing = [System.Collections.Generic.List[string]]::new()
    foreach ($Name in $Names) {
        if ($null -ne $Claim -and $Claim.PSObject.Properties[$Name]) { $Fields[$Name] = $Claim.$Name; continue }
        $Fields[$Name] = $null
        $Missing.Add($Name)
    }
    if ($null -eq $Fields.claim) {
        Write-Warning "Invoke-POVSummary: a factual claim has no claim text; it is not logged as a conflict."
        return $null
    }
    if ($Missing.Count -gt 0) {
        $Text = [string]$Fields.claim
        $Short = $Text.Substring(0, [Math]::Min(60, $Text.Length))
        Write-Warning "Invoke-POVSummary: factual claim '$Short' is missing $($Missing -join ', '); logging it as a conflict with each treated as null."
    }
    $Fields
}

function Add-POVSummaryHintedConflict {
    param([string]$HintId, [hashtable]$Context)
    $ExistingPath = Join-Path $Context.ConflictsDir "$HintId.json"

    if (Test-Path $ExistingPath) {
        $ConflictData = Get-Content $ExistingPath -Raw | ConvertFrom-Json -AsHashtable
        if (Test-POVSummaryConflictLogged -ConflictData $ConflictData -DocId $Context.DocId) {
            Write-Info "  SKIP duplicate conflict instance: $HintId (doc already logged)"
            return
        }
        Add-POVSummaryConflictInstance -ConflictData $ConflictData -Instance $Context.Instance -LinkedNodes $Context.LinkedNodes
        Write-Utf8NoBom -Path $ExistingPath -Value ($ConflictData | ConvertTo-Json -Depth 10)
        Write-OK "  Appended to existing conflict: $HintId"
        return
    }
    Write-Warn "  Suggested conflict '$HintId' not found — creating new file"
    $NewConflict = ConvertTo-POVSummaryConflictRecord -Id $HintId -Context $Context
    Write-Utf8NoBom -Path $ExistingPath -Value ($NewConflict | ConvertTo-Json -Depth 10)
    Write-OK "  Created new conflict file: $HintId.json"
}

function Add-POVSummaryUnhintedConflict {
    param([hashtable]$Context)
    $ClaimText = $Context.ClaimText
    $DocId = $Context.DocId
    $Slug = $ClaimText.ToLower() -replace '[^\w\s]', '' -replace '\s+', '-'
    $Slug = $Slug.Substring(0, [Math]::Min(40, $Slug.Length)).TrimEnd('-')
    $NewId = "conflict-$Slug-$($DocId.Substring(0,[Math]::Min(8,$DocId.Length)))"

    $ExistingMatch = Get-ChildItem $Context.ConflictsDir -Filter "*.json" |
        Where-Object { $_.BaseName -like "*$($Slug.Substring(0,[Math]::Min(20,$Slug.Length)))*" } |
        Select-Object -First 1

    if ($ExistingMatch) {
        $ConflictData = Get-Content $ExistingMatch.FullName -Raw | ConvertFrom-Json -AsHashtable
        if (-not (Test-POVSummaryConflictLogged -ConflictData $ConflictData -DocId $DocId)) {
            Add-POVSummaryConflictInstance -ConflictData $ConflictData -Instance $Context.Instance -LinkedNodes $Context.LinkedNodes
            Write-Utf8NoBom -Path $ExistingMatch.FullName -Value ($ConflictData | ConvertTo-Json -Depth 10)
            Write-OK "  Appended to fuzzy-matched conflict: $($ExistingMatch.BaseName)"
        }
        return
    }
    $NewConflictPath = Join-Path $Context.ConflictsDir "$NewId.json"
    $NewConflict = ConvertTo-POVSummaryConflictRecord -Id $NewId -Context $Context
    Write-Utf8NoBom -Path $NewConflictPath -Value ($NewConflict | ConvertTo-Json -Depth 10)
    Write-OK "  Created new conflict file: $NewId.json"
}

function Test-POVSummaryConflictLogged {
    # True when the conflict already has an instance from this document.
    param([hashtable]$ConflictData, [string]$DocId)
    $AlreadyLogged = $ConflictData["instances"] | Where-Object { $_["doc_id"] -eq $DocId }
    [bool]$AlreadyLogged
}

function Add-POVSummaryConflictInstance {
    # Appends the instance and merges the claim's linked nodes in (flat, de-duplicated; t/3948).
    param([hashtable]$ConflictData, $Instance, [object[]]$LinkedNodes)
    $ConflictData["instances"] += $Instance
    if ($LinkedNodes.Count -gt 0) {
        $Existing = @($ConflictData["linked_taxonomy_nodes"])
        $Merged   = @(($Existing + $LinkedNodes) | Select-Object -Unique)
        $ConflictData["linked_taxonomy_nodes"] = $Merged
    }
}

function ConvertTo-POVSummaryConflictRecord {
    param([string]$Id, [hashtable]$Context)
    $ClaimText = $Context.ClaimText
    [ordered]@{
        claim_id               = $Id
        claim_label            = if ($Context.ClaimLabel) { $Context.ClaimLabel } else { $ClaimText.Substring(0, [Math]::Min(80, $ClaimText.Length)) }
        description            = $ClaimText
        status                 = "open"
        linked_taxonomy_nodes  = $Context.LinkedNodes
        instances              = @($Context.Instance)
        human_notes            = @()
    }
}

# ── Step 7: console summary ──────────────────────────────────────────────────

function Write-POVSummaryConsole {
    param([string]$DocId, [string]$TaxonomyVersion, [string]$Model, $SummaryObject, $UnmappedConceptCount,
          $FactualClaimCount, [string]$SnapshotFile, [switch]$FilesWritten)
    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    Write-Host "  POV SUMMARY: $DocId" -ForegroundColor White
    Write-Host "  Taxonomy v$TaxonomyVersion  |  Model: $Model" -ForegroundColor Gray
    Write-Host "$('═' * 72)" -ForegroundColor Cyan

    foreach ($Camp in @('accelerationist', 'safetyist', 'skeptic')) {
        $CampData = Get-POVSummaryCampData -SummaryObject $SummaryObject -Camp $Camp
        if (-not $CampData) { continue }
        Write-POVSummaryCampKeyPoint -Camp $Camp -CampData $CampData
    }

    if ($UnmappedConceptCount -gt 0) {
        Write-POVSummaryUnmappedConceptList -SummaryObject $SummaryObject
    }

    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    if ($FilesWritten) {
        Write-POVSummaryWrittenFileList -DocId $DocId -FactualClaimCount $FactualClaimCount -SnapshotFile $SnapshotFile
    }
    else {
        # -WhatIf, or -Confirm declined: nothing was written, so say so (t/4070).
        Write-Host "  No files written." -ForegroundColor Yellow
    }
    Write-Host "$('═' * 72)`n" -ForegroundColor Cyan
}

function Write-POVSummaryWrittenFileList {
    param([string]$DocId, $FactualClaimCount, [string]$SnapshotFile)
    Write-Host "  Files written:" -ForegroundColor White
    Write-Host "    summaries/$DocId.json" -ForegroundColor Green
    $FinalStatus = if ($FactualClaimCount -lt 3 -and ([Math]::Round((Get-Item $SnapshotFile).Length / 1024, 1)) -gt 30) { 'needs_reextraction' } else { 'current' }
    $StatusColor = if ($FinalStatus -eq 'current') { 'Green' } else { 'Yellow' }
    Write-Host "    sources/$DocId/metadata.json  (summary_status=$FinalStatus)" -ForegroundColor $StatusColor
}

function Write-POVSummaryCampKeyPoint {
    param([string]$Camp, $CampData)
    Write-Host "`n  [$($Camp.ToUpper())]" -ForegroundColor $script:POVSummaryCampColors[$Camp]

    if (-not ($CampData.PSObject.Properties['key_points'] -and $CampData.key_points)) {
        Write-Host "    (no key points extracted)" -ForegroundColor DarkGray
        return
    }
    $ByCategory = $CampData.key_points | Group-Object category
    foreach ($Group in $ByCategory) {
        Write-Host "    $($Group.Name):" -ForegroundColor White
        foreach ($Pt in $Group.Group) { Write-POVSummaryKeyPoint -Point $Pt }
    }
}

function Write-POVSummaryKeyPoint {
    param($Point)
    $Props = $Point.PSObject.Properties
    $Missing = @(foreach ($Name in 'taxonomy_node_id', 'stance', 'point') { if (-not $Props[$Name]) { $Name } })
    if ($Missing.Count -gt 0) {
        # Fallback (t/4070): show the same defaults as for a null value, instead of throwing after
        # every file has already been written.
        Write-Warning "Invoke-POVSummary: a key point is missing $($Missing -join ', '); the console summary shows it as unmapped/neutral."
    }
    $NodeId = if ($Props['taxonomy_node_id']) { $Point.taxonomy_node_id } else { $null }
    $Stance = if ($Props['stance']) { $Point.stance } else { $null }
    $Text   = if ($Props['point']) { $Point.point } else { '' }
    if ($NodeId) { $NodeTag = "[$NodeId]" } else { $NodeTag = "[UNMAPPED]" }
    if ($Stance) { $PtStance = $Stance } else { $PtStance = 'neutral' }
    Write-Host "      $NodeTag ($PtStance) $Text" -ForegroundColor Gray
    if (-not ($Point.PSObject.Properties['verbatim'] -and $Point.verbatim)) { return }
    if ($Point.verbatim -is [array]) {
        foreach ($Span in $Point.verbatim) {
            Write-Host "        `"$Span`"" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "        `"$($Point.verbatim)`"" -ForegroundColor DarkGray
    }
}

function Write-POVSummaryUnmappedConceptList {
    param($SummaryObject)
    Write-Host "`n  UNMAPPED CONCEPTS (potential new taxonomy nodes):" -ForegroundColor Magenta
    foreach ($Concept in @(Get-POVSummaryOptionalArray -SummaryObject $SummaryObject -Name 'unmapped_concepts')) {
        $CProps = $Concept.PSObject.Properties
        $PovCat = "[$( if ($CProps['suggested_pov']) { $Concept.suggested_pov } else { '?' } ) / $( if ($CProps['suggested_category']) { $Concept.suggested_category } else { '?' } )]"
        if ($CProps['concept']) { $Desc = $Concept.concept } elseif ($CProps['suggested_description']) { $Desc = $Concept.suggested_description } else { $Desc = '' }
        if ($CProps['reason']) { $Reason = $Concept.reason } else { $Reason = '' }
        Write-Host "    $PovCat" -ForegroundColor Magenta
        if ($Desc) { Write-Host "    $Desc" -ForegroundColor Gray }
        if ($Reason) { Write-Host "    Reason: $Reason" -ForegroundColor DarkGray }
    }
}
