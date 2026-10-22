# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-AttributeExtraction {
    <#
    .SYNOPSIS
        Uses AI to generate rich graph attributes for taxonomy nodes (Phase 1 of LAG proposal).
    .DESCRIPTION
        Reads taxonomy JSON files, sends nodes in batches to an LLM, and writes
        graph_attributes back to each node. Attributes include epistemic_type,
        rhetorical_strategy, assumes, falsifiability, audience, emotional_register,
        policy_actionability, intellectual_lineage, and steelman_vulnerability.

        Attributes are stored as a new "graph_attributes" key on each node object,
        which is backwards-compatible with all existing tooling.

        Nodes that already have graph_attributes are skipped unless -Force is specified.
    .PARAMETER POV
        Process only this POV file. If omitted, processes all POV files and cross-cutting.
        Valid values: accelerationist, safetyist, skeptic, cross-cutting.
    .PARAMETER BatchSize
        Number of nodes to process per API call. Default: 8.
    .PARAMETER Model
        AI model to use. Defaults to 'gemini-3.5-flash-lite'.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.2 (precise analytical output).
    .PARAMETER DryRun
        Build and display the prompt for the first batch, but do NOT call the API.
    .PARAMETER Force
        Re-generate attributes even for nodes that already have them.
    .PARAMETER RepoRoot
        Path to the repository root. Defaults to the module-resolved repo root.
    .EXAMPLE
        Invoke-AttributeExtraction -DryRun
    .EXAMPLE
        Invoke-AttributeExtraction -POV accelerationist
    .EXAMPLE
        Invoke-AttributeExtraction -Force -Model 'gemini-2.5-pro'
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Save-WaybackUrl
    .LINK
        Update-Snapshot
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations')]
        [string]$POV = '',

        [ValidateRange(1, 20)]
        [int]$BatchSize = 8,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey = '',

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.2,

        [switch]$DryRun,

        [switch]$Force,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Step 1: Validate environment ──
    Write-Step 'Validating environment'

    if (-not (Test-Path $RepoRoot)) {
        Write-Fail "Repo root not found: $RepoRoot"
        throw "Repo root not found"
    }

    $TaxDir = Get-TaxonomyDir
    if (-not (Test-Path $TaxDir)) {
        Write-Fail "Taxonomy directory not found: $TaxDir"
        throw "Taxonomy directory not found"
    }

    if (-not $DryRun) {
        # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
        $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
        if (-not $KeyStatus.HasKey) {
            Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
            throw 'No API key configured'
        }
    }

    # ── Step 2: Determine which files to process ──
    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    if ($POV) {
        $PovFiles = @($POV)
    }

    Write-OK "Processing: $($PovFiles -join ', ')"

    # ── Step 3: Load prompts ──
    $SystemPrompt = Get-Prompt -Name 'attribute-extraction'
    $SchemaPrompt = Get-Prompt -Name 'attribute-extraction-schema'

    # ── Step 4: Process each taxonomy file ──
    $TotalProcessed = 0
    $TotalSkipped   = 0
    $TotalFailed    = 0
    # t/4004: nodes actually written, and the policy ids they held before the merge, for registration.
    $WrittenNodeIds = [System.Collections.Generic.List[string]]::new()
    $PriorPolicyIds = [System.Collections.Generic.List[string]]::new()

    foreach ($PovKey in $PovFiles) {
        $FileNodeIds  = [System.Collections.Generic.List[string]]::new()
        $FilePriorIds = [System.Collections.Generic.List[string]]::new()
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) {
            Write-Warn "File not found, skipping: $FilePath"
            continue
        }

        Write-Step "Loading $PovKey"
        $FileData = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)

        # Identify nodes needing attributes. Work list only: superseded nodes get no AI call;
        # $FileData (the written file) keeps them (t/4356).
        $AllNodes = @(Select-SelectableTaxonomyNode -Nodes @($FileData.nodes) -Pov $PovKey)
        if ($Force) {
            $NodesToProcess = $AllNodes
        } else {
            $NodesToProcess = @($AllNodes | Where-Object {
                -not $_.PSObject.Properties['graph_attributes'] -or
                $null -eq $_.graph_attributes
            })
        }

        $AlreadyDone = $AllNodes.Count - $NodesToProcess.Count
        if ($AlreadyDone -gt 0) {
            Write-Info "$AlreadyDone nodes already have attributes (use -Force to regenerate)"
        }

        if ($NodesToProcess.Count -eq 0) {
            Write-OK "$PovKey — nothing to process"
            $TotalSkipped += $AllNodes.Count
            continue
        }

        Write-Info "$($NodesToProcess.Count) nodes to process in $PovKey"

        # ── Step 5: Process in batches ──
        $Batches = [System.Collections.Generic.List[object[]]]::new()
        for ($i = 0; $i -lt $NodesToProcess.Count; $i += $BatchSize) {
            $End = [Math]::Min($i + $BatchSize, $NodesToProcess.Count)
            $Batch = @($NodesToProcess[$i..($End - 1)])
            $Batches.Add($Batch)
        }

        Write-Info "$($Batches.Count) batch(es) of up to $BatchSize nodes"

        # Single shared list (t/3964 condition 1): used both to validate the
        # model's response AND as the merge-ownership contract in
        # Merge-NodeGraphAttributes, so the two can never drift apart.
        $OwnedFields = @(
            'epistemic_type', 'rhetorical_strategy', 'assumes',
            'falsifiability', 'audience', 'emotional_register',
            'policy_actions', 'intellectual_lineage',
            'steelman_vulnerability', 'possible_fallacies'
        )

        $BatchNum = 0
        foreach ($Batch in $Batches) {
            $BatchNum++
            $NodeIds = ($Batch | ForEach-Object { $_.id }) -join ', '
            Write-Step "Batch $BatchNum/$($Batches.Count): $NodeIds"

            # Build node context for the prompt
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
                # Include interpretations for cross-cutting nodes
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

            # ── DryRun: show first batch prompt and exit ──
            if ($DryRun) {
                Write-Host ''
                Write-Host '=== PROMPT PREVIEW (first batch) ===' -ForegroundColor Cyan
                Write-Host ''
                # Show system prompt (truncated)
                $Lines = $SystemPrompt -split "`n"
                if ($Lines.Count -gt 15) {
                    Write-Host ($Lines[0..14] -join "`n") -ForegroundColor DarkGray
                    Write-Host "  ... ($($Lines.Count) total lines)" -ForegroundColor DarkGray
                } else {
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
            } catch {
                Write-Fail "API call failed for batch $BatchNum ($($Batch.Count) nodes) using model '$Model': $($_.Exception.Message)"
                Write-Info 'Check that your API key is valid and you have not exceeded your quota. Re-run with -Verbose for details.'
                $TotalFailed += $Batch.Count
                continue
            }
            $Stopwatch.Stop()
            Write-Info "API response in $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"

            # ── Parse response ──
            $ResponseText = $Result.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            try {
                $Attributes = $ResponseText | ConvertFrom-Json
            } catch {
                Write-Warn "JSON parse failed, attempting repair..."
                $Repaired = Repair-TruncatedJson -Text $ResponseText
                try {
                    $Attributes = $Repaired | ConvertFrom-Json
                } catch {
                    Write-Fail "Could not parse API response for batch $BatchNum ($($Batch.Count) nodes) after JSON repair: $($_.Exception.Message)"
                    Write-Info 'The AI model returned malformed JSON. Try re-running the batch or using a different -Model.'
                    $TotalFailed += $Batch.Count
                    continue
                }
            }

            # ── Apply attributes to nodes ──
            foreach ($Node in $Batch) {
                $NodeId = $Node.id
                if ($Attributes.PSObject.Properties[$NodeId]) {
                    $AttrObj = $Attributes.$NodeId

                    # Validate required fields
                    $Missing = @($OwnedFields | Where-Object {
                        -not $AttrObj.PSObject.Properties[$_]
                    })
                    if ($Missing.Count -gt 0) {
                        Write-Warn "$NodeId`: missing fields: $($Missing -join ', ')"
                    }

                    # Find the node in the original file data and set attributes
                    $OrigNode = $FileData.nodes | Where-Object { $_.id -eq $NodeId }
                    if ($OrigNode) {
                        # t/3964: MERGE, never replace -- a wholesale replace erases
                        # anything the extraction prompt doesn't regenerate (registry
                        # policy_id's, debate-harvest fields under graph_attributes).
                        $ExistingAttrs = if ($OrigNode.PSObject.Properties['graph_attributes']) { $OrigNode.graph_attributes } else { $null }
                        foreach ($PriorId in (Get-GraphAttributePolicyIds -GraphAttributes $ExistingAttrs)) { $FilePriorIds.Add($PriorId) }
                        $FileNodeIds.Add([string]$NodeId)
                        $MergedAttrs = Merge-NodeGraphAttributes -Existing $ExistingAttrs -New $AttrObj -OwnedFields $OwnedFields -NodeId $NodeId
                        if ($OrigNode.PSObject.Properties['graph_attributes']) {
                            $OrigNode.graph_attributes = $MergedAttrs
                        } else {
                            $OrigNode | Add-Member -NotePropertyName 'graph_attributes' -NotePropertyValue $MergedAttrs
                        }
                        $TotalProcessed++
                        Write-OK "$NodeId"
                    }
                } else {
                    Write-Warn "$NodeId`: not found in API response"
                    $TotalFailed++
                }
            }
        }

        # ── Step 6: Write updated file ──
        if ($TotalProcessed -gt 0 -or $Force) {
            if ($PSCmdlet.ShouldProcess($FilePath, 'Write updated taxonomy file')) {
                # Update last_modified
                $FileData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
                try {
                    Write-PovTaxonomyFile -Path $FilePath -Data $FileData   # canonical TS format (t/4356)
                    Write-OK "Saved $PovKey ($FilePath)"
                    $WrittenNodeIds.AddRange($FileNodeIds)
                    $PriorPolicyIds.AddRange($FilePriorIds)
                }
                catch {
                    Write-Fail "Failed to write $PovKey taxonomy file — $($_.Exception.Message)"
                    Write-Info "Attributes were extracted but NOT saved to disk."
                    throw
                }
            }
        }
    }

    # ── Step 7: Register the written nodes' policy actions (t/4004) ──
    # Without this, extracted actions kept a null policy_id until an unrelated corpus-wide -Fix.
    Invoke-NodePolicyRegistration -NodeId $WrittenNodeIds.ToArray() -PriorPolicyIds $PriorPolicyIds.ToArray() -Caller 'Invoke-AttributeExtraction'

    # ── Summary ──
    Write-Host ''
    Write-Host '=== Attribute Extraction Complete ===' -ForegroundColor Cyan
    Write-Host "  Processed:  $TotalProcessed nodes" -ForegroundColor Green
    Write-Host "  Skipped:    $TotalSkipped nodes (already had attributes)" -ForegroundColor Yellow
    Write-Host "  Failed:     $TotalFailed nodes" -ForegroundColor $(if ($TotalFailed -gt 0) { 'Red' } else { 'Green' })
    Write-Host ''
}
