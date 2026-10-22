# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Find-PossibleFallacy {
    <#
    .SYNOPSIS
        Uses AI to identify possible logical fallacies in taxonomy nodes.
    .DESCRIPTION
        Sends taxonomy nodes to an LLM to analyse their reasoning for potential
        logical fallacies or cognitive biases. Results are stored in each node's
        graph_attributes.possible_fallacies field.

        The analysis is conservative — nodes with sound reasoning get an empty
        fallacy list. Each flagged fallacy includes a confidence level and a
        specific explanation grounded in the node's content.

        Use Show-FallacyInfo to open the Wikipedia page for any identified fallacy.
    .PARAMETER POV
        Process only this POV file. If omitted, processes all POV files and cross-cutting.
    .PARAMETER Id
        One or more node IDs to analyse. If omitted, analyses all nodes in scope.
    .PARAMETER BatchSize
        Number of nodes to process per API call. Default: 8.
    .PARAMETER Model
        AI model to use. Defaults to 'gemini-3.5-flash-lite'.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.2.
    .PARAMETER DryRun
        Build and display the prompt for the first batch without calling the API.
    .PARAMETER Force
        Re-analyse nodes that already have possible_fallacies.
    .PARAMETER RepoRoot
        Path to the repository root.
    .PARAMETER PassThru
        Return a summary object.
    .EXAMPLE
        Find-PossibleFallacy -DryRun
        # Preview the prompt without calling the API
    .EXAMPLE
        Find-PossibleFallacy -POV accelerationist
        # Analyse only accelerationist nodes
    .EXAMPLE
        Find-PossibleFallacy -Id acc-desires-001, saf-desires-001
        # Analyse specific nodes
    .EXAMPLE
        Find-PossibleFallacy -Force -Model 'gemini-2.5-pro'
        # Re-analyse all nodes with a more capable model
    .EXAMPLE
        Get-Tax -Id acc-desires-001 | Select-Object -ExpandProperty GraphAttributes | Select-Object -ExpandProperty possible_fallacies
        # View fallacies after analysis
    .EXAMPLE
        Show-FallacyInfo 'slippery_slope'
        # Open Wikipedia page for a flagged fallacy
    .LINK
        Show-AITriadHelp
    .LINK
        Show-FallacyInfo
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations')]
        [string]$POV = '',

        [string[]]$Id,

        [ValidateRange(1, 20)]
        [int]$BatchSize = 8,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = '',

        [string]$ApiKey = '',

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.2,

        [switch]$DryRun,

        [switch]$Force,

        [string]$RepoRoot = $script:RepoRoot,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $Model) {
        if ($env:AI_MODEL) { $Model = $env:AI_MODEL } else { $Model = (Get-AITierModel -Tier basic) }
    }

    # ── Validate environment ──
    Write-Step 'Validating environment'

    $TaxDir = Get-TaxonomyDir
    if (-not (Test-Path $TaxDir)) {
        Write-Fail "Taxonomy directory not found: $TaxDir"
        throw 'Taxonomy directory not found'
    }

    if (-not $DryRun) {
        # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
        $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
        if (-not $KeyStatus.HasKey) {
            Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
            throw 'No API key configured'
        }
    }

    # ── Determine which files to process ──
    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    if ($POV) { $PovFiles = @($POV) }

    Write-OK "Processing: $($PovFiles -join ', ')"

    # ── Load prompts ──
    $SystemPrompt = Get-Prompt -Name 'fallacy-analysis'
    $SchemaPrompt = Get-Prompt -Name 'fallacy-analysis-schema'

    # ── Canonical fallacy registry (Gap 5.1) ──
    $CanonicalFallacies = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]@(
            'ad_hominem','appeal_to_authority','appeal_to_consequences','appeal_to_emotion',
            'appeal_to_fear','appeal_to_nature','appeal_to_novelty','appeal_to_popularity',
            'appeal_to_tradition','argument_from_analogy','argument_from_ignorance',
            'argument_from_incredulity','argument_from_silence','bandwagon_fallacy',
            'begging_the_question','burden_of_proof','cherry_picking','circular_reasoning',
            'composition_division','continuum_fallacy','correlation_causation','equivocation',
            'false_cause','false_dilemma','false_equivalence','gambler_fallacy',
            'genetic_fallacy','guilt_by_association','hasty_generalization','is_ought_problem',
            'loaded_question','middle_ground','moralistic_fallacy','moving_the_goalposts',
            'naturalistic_fallacy','nirvana_fallacy','no_true_scotsman','red_herring',
            'reification','slippery_slope','special_pleading','straw_man','sunk_cost',
            'texas_sharpshooter','tu_quoque','unfalsifiability',
            'affirming_the_consequent','denying_the_antecedent','affirming_a_disjunct',
            'undistributed_middle',
            'base_rate_neglect','anchoring_bias','availability_heuristic','confirmation_bias',
            'dunning_kruger','hindsight_bias','optimism_bias','status_quo_bias',
            'survivorship_bias'
        ), [System.StringComparer]::OrdinalIgnoreCase
    )
    $ValidConfidences = @('likely', 'possible', 'borderline')

    # ── Process each taxonomy file ──
    $TotalProcessed = 0
    $TotalSkipped   = 0
    $TotalFailed    = 0
    $TotalFallacies = 0

    foreach ($PovKey in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) {
            Write-Warn "File not found, skipping: $FilePath"
            continue
        }

        Write-Step "Loading $PovKey"
        $FileData = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)

        # Work list only: superseded nodes get no AI call; $FileData (the written file) keeps them (t/4356).
        $AllNodes = @(Select-SelectableTaxonomyNode -Nodes @($FileData.nodes) -Pov $PovKey)

        # Filter by -Id if specified
        if ($Id -and $Id.Count -gt 0) {
            $AllNodes = @($AllNodes | Where-Object { $_.id -in $Id })
        }

        # Skip nodes that already have fallacy analysis unless -Force
        if ($Force) {
            $NodesToProcess = $AllNodes
        }
        else {
            $NodesToProcess = @($AllNodes | Where-Object {
                -not $_.PSObject.Properties['graph_attributes'] -or
                $null -eq $_.graph_attributes -or
                -not $_.graph_attributes.PSObject.Properties['possible_fallacies']
            })
        }

        $AlreadyDone = $AllNodes.Count - $NodesToProcess.Count
        if ($AlreadyDone -gt 0) {
            Write-Info "$AlreadyDone nodes already analysed (use -Force to re-analyse)"
        }

        if ($NodesToProcess.Count -eq 0) {
            Write-OK "$PovKey — nothing to process"
            $TotalSkipped += $AllNodes.Count
            continue
        }

        Write-Info "$($NodesToProcess.Count) nodes to analyse in $PovKey"

        # ── Batch processing ──
        $Batches = [System.Collections.Generic.List[object[]]]::new()
        for ($i = 0; $i -lt $NodesToProcess.Count; $i += $BatchSize) {
            $End   = [Math]::Min($i + $BatchSize, $NodesToProcess.Count)
            $Batch = @($NodesToProcess[$i..($End - 1)])
            $Batches.Add($Batch)
        }

        Write-Info "$($Batches.Count) batch(es) of up to $BatchSize nodes"

        $BatchNum = 0
        foreach ($Batch in $Batches) {
            $BatchNum++
            $NodeIds = ($Batch | ForEach-Object { $_.id }) -join ', '
            Write-Step "Batch $BatchNum/$($Batches.Count): $NodeIds"

            # Build node context — include graph_attributes for richer analysis
            $NodeContext = foreach ($Node in $Batch) {
                $Entry = [ordered]@{
                    id          = $Node.id
                    pov         = $PovKey
                    label       = $Node.label
                    description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
                }
                if ($Node.PSObject.Properties['category']) {
                    $Entry['category'] = $Node.category
                }
                if ($Node.PSObject.Properties['graph_attributes'] -and $Node.graph_attributes) {
                    $GA = $Node.graph_attributes
                    if ($GA.PSObject.Properties['epistemic_type'])      { $Entry['epistemic_type']      = $GA.epistemic_type }
                    if ($GA.PSObject.Properties['rhetorical_strategy']) { $Entry['rhetorical_strategy'] = $GA.rhetorical_strategy }
                    if ($GA.PSObject.Properties['assumes'])             { $Entry['assumes']             = $GA.assumes }
                }
                if ($PovKey -eq 'situations' -and $Node.PSObject.Properties['interpretations']) {
                    $Entry['interpretations'] = $Node.interpretations
                }
                $Entry
            }

            $NodeJson = $NodeContext | ConvertTo-Json -Depth 10

            $FullPrompt = @"
$SystemPrompt

--- INPUT NODES ---
$NodeJson

$SchemaPrompt
"@

            # ── DryRun ──
            if ($DryRun) {
                Write-Host ''
                Write-Host '=== PROMPT PREVIEW (first batch) ===' -ForegroundColor Cyan
                Write-Host ''
                $Lines = $SystemPrompt -split "`n"
                if ($Lines.Count -gt 15) {
                    Write-Host ($Lines[0..14] -join "`n") -ForegroundColor DarkGray
                    Write-Host "  ... ($($Lines.Count) total lines)" -ForegroundColor DarkGray
                }
                else {
                    Write-Host $SystemPrompt -ForegroundColor DarkGray
                }
                Write-Host ''
                Write-Host '--- INPUT NODES ---' -ForegroundColor Yellow
                Write-Host $NodeJson -ForegroundColor White
                Write-Host ''
                Write-Host '--- SCHEMA ---' -ForegroundColor Yellow
                Write-Host ($SchemaPrompt.Substring(0, [Math]::Min(500, $SchemaPrompt.Length))) -ForegroundColor DarkGray
                Write-Host ''
                Write-Host "Total prompt length: ~$($FullPrompt.Length) chars (~$([Math]::Round($FullPrompt.Length / 4)) tokens est.)" -ForegroundColor Cyan
                Write-Host "Nodes in this batch: $($Batch.Count)" -ForegroundColor Cyan
                Write-Host "Total batches needed: $($Batches.Count) across $($PovFiles.Count) file(s)" -ForegroundColor Cyan
                return
            }

            # ── Call AI API ──
            $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $Result = Invoke-AIApi `
                    -Prompt $FullPrompt `
                    -Model $Model `
                    -ApiKey $ApiKey `
                    -Temperature $Temperature `
                    -MaxTokens 16384 `
                    -JsonMode
            }
            catch {
                Write-Fail "API call failed for batch $BatchNum`: $_"
                $TotalFailed += $Batch.Count
                continue
            }
            $Stopwatch.Stop()
            Write-Info "API response in $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"

            # ── Parse response ──
            $ResponseText = $Result.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            try {
                $FallacyData = $ResponseText | ConvertFrom-Json
            }
            catch {
                Write-Warn 'JSON parse failed, attempting repair...'
                $Repaired = Repair-TruncatedJson -Text $ResponseText
                try {
                    $FallacyData = $Repaired | ConvertFrom-Json
                }
                catch {
                    Write-Fail "Could not parse response for batch $BatchNum"
                    $TotalFailed += $Batch.Count
                    continue
                }
            }

            # ── Apply fallacies to nodes ──
            foreach ($Node in $Batch) {
                $NodeId = $Node.id
                if (-not $FallacyData.PSObject.Properties[$NodeId]) {
                    Write-Warn "$NodeId`: not found in API response"
                    $TotalFailed++
                    continue
                }

                $NodeResult = $FallacyData.$NodeId
                $Fallacies  = @()
                if ($NodeResult.PSObject.Properties['possible_fallacies'] -and $NodeResult.possible_fallacies) {
                    $Fallacies = @($NodeResult.possible_fallacies)
                }

                # Gap 5.1: Validate fallacy names against canonical registry
                # Gap 5.2: Validate confidence values
                $ValidatedFallacies = [System.Collections.Generic.List[object]]::new()
                foreach ($f in $Fallacies) {
                    $FallacyName = if ($f.PSObject.Properties['fallacy']) { $f.fallacy } else { $null }
                    if (-not $FallacyName) { continue }

                    $NormalizedName = $FallacyName.Trim().ToLowerInvariant() -replace '[\s\-]+','_'
                    if (-not $CanonicalFallacies.Contains($NormalizedName)) {
                        $BestMatch = $null; $BestScore = 0.0
                        $NameWords = [System.Collections.Generic.HashSet[string]]::new(
                            [string[]]($NormalizedName -split '_'),
                            [System.StringComparer]::OrdinalIgnoreCase
                        )
                        foreach ($Canonical in $CanonicalFallacies) {
                            $CanonWords = [System.Collections.Generic.HashSet[string]]::new(
                                [string[]]($Canonical -split '_'),
                                [System.StringComparer]::OrdinalIgnoreCase
                            )
                            $Intersection = [System.Collections.Generic.HashSet[string]]::new($NameWords)
                            $Intersection.IntersectWith($CanonWords)
                            $Union = [System.Collections.Generic.HashSet[string]]::new($NameWords)
                            $Union.UnionWith($CanonWords)
                            if ($Union.Count -gt 0) {
                                $Jaccard = $Intersection.Count / $Union.Count
                                if ($Jaccard -gt $BestScore) { $BestScore = $Jaccard; $BestMatch = $Canonical }
                            }
                        }
                        if ($BestMatch -and $BestScore -ge 0.5) {
                            Write-Warn "$NodeId`: normalized fallacy '$FallacyName' → '$BestMatch' (Jaccard $([Math]::Round($BestScore, 2)))"
                            $f.fallacy = $BestMatch
                        } else {
                            Write-Warn "$NodeId`: unrecognized fallacy '$FallacyName' (kept as-is, no close match)"
                        }
                    } else {
                        $f.fallacy = $NormalizedName
                    }

                    if ($f.PSObject.Properties['confidence']) {
                        $ConfLower = $f.confidence.ToString().Trim().ToLowerInvariant()
                        if ($ConfLower -notin $ValidConfidences) {
                            Write-Warn "$NodeId`: invalid confidence '$($f.confidence)' → defaulting to 'possible'"
                            $f.confidence = 'possible'
                        } else {
                            $f.confidence = $ConfLower
                        }
                    } else {
                        $f | Add-Member -NotePropertyName 'confidence' -NotePropertyValue 'possible' -Force
                    }

                    $ValidatedFallacies.Add($f)
                }
                $Fallacies = @($ValidatedFallacies)

                # Ensure the node has graph_attributes
                $OrigNode = $FileData.nodes | Where-Object { $_.id -eq $NodeId }
                if (-not $OrigNode) {
                    Write-Warn "$NodeId`: not found in taxonomy file"
                    $TotalFailed++
                    continue
                }

                if (-not $OrigNode.PSObject.Properties['graph_attributes'] -or $null -eq $OrigNode.graph_attributes) {
                    $OrigNode | Add-Member -NotePropertyName 'graph_attributes' -NotePropertyValue ([PSCustomObject]@{})
                }

                if ($OrigNode.graph_attributes.PSObject.Properties['possible_fallacies']) {
                    $OrigNode.graph_attributes.possible_fallacies = $Fallacies
                }
                else {
                    $OrigNode.graph_attributes | Add-Member -NotePropertyName 'possible_fallacies' -NotePropertyValue $Fallacies
                }

                $TotalProcessed++
                $TotalFallacies += $Fallacies.Count

                if ($Fallacies.Count -eq 0) {
                    Write-OK "$NodeId — no fallacies detected"
                }
                else {
                    $FallacyNames = ($Fallacies | ForEach-Object { $_.fallacy }) -join ', '
                    Write-OK "$NodeId — $($Fallacies.Count) possible: $FallacyNames"
                }
            }
        }

        # ── Write updated file ──
        if ($TotalProcessed -gt 0 -or $Force) {
            if ($PSCmdlet.ShouldProcess($FilePath, 'Write updated taxonomy file with fallacy analysis')) {
                $FileData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
                try {
                    Write-PovTaxonomyFile -Path $FilePath -Data $FileData   # canonical TS format (t/4356)
                    Write-OK "Saved $PovKey ($FilePath)"
                }
                catch {
                    Write-Fail "Failed to write $PovKey taxonomy file — $($_.Exception.Message)"
                    throw
                }
            }
        }
    }

    # ── Summary ──
    Write-Host ''
    Write-Host '=== Fallacy Analysis Complete ===' -ForegroundColor Cyan
    Write-Host "  Analysed:       $TotalProcessed nodes" -ForegroundColor Green
    Write-Host "  Skipped:        $TotalSkipped nodes (already analysed)" -ForegroundColor Yellow
    Write-Host "  Failed:         $TotalFailed nodes" -ForegroundColor $(if ($TotalFailed -gt 0) { 'Red' } else { 'Green' })
    Write-Host "  Fallacies found: $TotalFallacies across all nodes" -ForegroundColor White
    Write-Host ''

    if ($PassThru) {
        [PSCustomObject]@{
            Processed      = $TotalProcessed
            Skipped        = $TotalSkipped
            Failed         = $TotalFailed
            FallaciesFound = $TotalFallacies
        }
    }
}
