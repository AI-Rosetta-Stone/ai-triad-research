# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Find-PolicyAction {
    <#
    .SYNOPSIS
        Uses AI to identify concrete policy actions implied by taxonomy nodes.
    .DESCRIPTION
        Sends taxonomy nodes to an LLM to generate specific, actionable policy
        recommendations that each node's claim supports or implies. Results are
        stored in each node's graph_attributes.policy_actions field.

        Each policy action includes a concrete action statement (5-20 words) and
        a framing explanation connecting the node's claim to the policy lever.

        Nodes that are purely theoretical or definitional get an empty array.
    .PARAMETER POV
        Process only this POV file. If omitted, processes all POV files and cross-cutting.
    .PARAMETER Id
        One or more node IDs to analyse. If omitted, analyses all nodes in scope.
    .PARAMETER BatchSize
        Number of nodes to process per API call. Default: 8.
    .PARAMETER Model
        AI model to use.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.2.
    .PARAMETER DryRun
        Build and display the prompt for the first batch without calling the API.
    .PARAMETER Force
        Re-analyse nodes that already have policy_actions.
    .PARAMETER RepoRoot
        Path to the repository root.
    .PARAMETER PassThru
        Return a summary object.
    .EXAMPLE
        Find-PolicyAction -DryRun
    .EXAMPLE
        Find-PolicyAction -POV accelerationist
    .EXAMPLE
        Find-PolicyAction -Id acc-desires-001, saf-desires-001
    .EXAMPLE
        Find-PolicyAction -Force -Model 'groq-openai-gpt-oss-120b'
    .LINK
        Show-AITriadHelp
    .LINK
        Get-Policy
    .LINK
        Update-PolicyRegistry
    .LINK
        Invoke-PolicyRefinement
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
    $SystemPrompt = Get-Prompt -Name 'policy-actions'
    $SchemaPrompt = Get-Prompt -Name 'policy-actions-schema'

    # ── Load policy registry ──
    $RegistryPath = Join-Path $TaxDir 'policy_actions.json'
    $Registry = $null
    $RegistrySummary = ''
    if (Test-Path $RegistryPath) {
        $Registry = Get-Content -Raw -Path $RegistryPath | ConvertFrom-Json
        Write-OK "Policy registry loaded: $($Registry.policies.Count) policies"
        # Build compact summary for prompt context (ID + action only, no vectors)
        $RegistrySummary = ($Registry.policies | ForEach-Object {
            "$($_.id): $($_.action)"
        }) -join "`n"
    }
    else {
        Write-Info 'No policy registry found — all actions will get new IDs'
    }

    # ── Process each taxonomy file ──
    $TotalProcessed = 0
    $TotalSkipped   = 0
    $TotalFailed    = 0
    $TotalActions   = 0
    # t/4004: nodes actually written, and the policy ids they held before, for registration.
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
        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json

        # Work list only: superseded nodes get no AI call; $FileData (the written file) keeps them (t/4356).
        $AllNodes = @(Select-SelectableTaxonomyNode -Nodes @($FileData.nodes) -Pov $PovKey)

        # Filter by -Id if specified
        if ($Id -and $Id.Count -gt 0) {
            $AllNodes = @($AllNodes | Where-Object { $_.id -in $Id })
        }

        # Skip nodes that already have policy_actions unless -Force
        if ($Force) {
            $NodesToProcess = $AllNodes
        }
        else {
            $NodesToProcess = @($AllNodes | Where-Object {
                -not $_.PSObject.Properties['graph_attributes'] -or
                $null -eq $_.graph_attributes -or
                -not $_.graph_attributes.PSObject.Properties['policy_actions']
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

            # Build node context
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
                if ($PovKey -eq 'situations' -and $Node.PSObject.Properties['interpretations']) {
                    $Entry['interpretations'] = $Node.interpretations
                }
                $Entry
            }

            $NodeJson = $NodeContext | ConvertTo-Json -Depth 10

            $RegistryBlock = ''
            if ($RegistrySummary) {
                $RegistryBlock = @"

--- EXISTING POLICY REGISTRY ---
Reuse these pol-NNN IDs when the action matches. Set policy_id to null only for genuinely new policies.

$RegistrySummary
"@
            }

            $FullPrompt = @"
$SystemPrompt
$RegistryBlock

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
                $ActionData = $ResponseText | ConvertFrom-Json
            }
            catch {
                Write-Warn 'JSON parse failed, attempting repair...'
                $Repaired = Repair-TruncatedJson -Text $ResponseText
                try {
                    $ActionData = $Repaired | ConvertFrom-Json
                }
                catch {
                    Write-Fail "Could not parse API response for batch $BatchNum ($($Batch.Count) nodes) after JSON repair: $($_.Exception.Message)"
                    Write-Info 'The AI model returned malformed JSON. Try re-running the batch or using a different -Model.'
                    $TotalFailed += $Batch.Count
                    continue
                }
            }

            # ── Apply policy actions to nodes ──
            # Build registry ID set for Gap 6.1 validation
            $RegistryIdSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            if ($Registry -and $Registry.policies) {
                foreach ($pol in $Registry.policies) {
                    if ($pol.id) { [void]$RegistryIdSet.Add($pol.id) }
                }
            }

            foreach ($Node in $Batch) {
                $NodeId = $Node.id
                if (-not $ActionData.PSObject.Properties[$NodeId]) {
                    Write-Warn "$NodeId`: not found in API response"
                    $TotalFailed++
                    continue
                }

                $NodeResult = $ActionData.$NodeId
                $Actions    = @()
                if ($NodeResult.PSObject.Properties['policy_actions'] -and $NodeResult.policy_actions) {
                    $Actions = @($NodeResult.policy_actions)
                }

                # Gap 6.2: Validate action text word count (warn >25, truncate >30)
                foreach ($Act in $Actions) {
                    if ($Act.PSObject.Properties['action'] -and $Act.action) {
                        $Words = @($Act.action -split '\s+' | Where-Object { $_ })
                        if ($Words.Count -gt 30) {
                            Write-Warn "$NodeId`: action truncated from $($Words.Count) to 30 words: '$($Act.action.Substring(0, [Math]::Min(60, $Act.action.Length)))...'"
                            $Act.action = ($Words[0..29] -join ' ') + '...'
                        } elseif ($Words.Count -gt 25) {
                            Write-Warn "$NodeId`: action is $($Words.Count) words (target 5-20): '$($Act.action.Substring(0, [Math]::Min(60, $Act.action.Length)))...'"
                        }
                    }
                }

                # Gap 6.1: Validate reused policy_id references exist in registry.
                # New actions (policy_id null or missing) are left null here and get their ids from the
                # shared primitive after the taxonomy write (t/4004) -- this cmdlet no longer mints.
                foreach ($Act in $Actions) {
                    if ($Act.PSObject.Properties['policy_id'] -and $null -ne $Act.policy_id) {
                        if ($RegistryIdSet.Count -gt 0 -and -not $RegistryIdSet.Contains($Act.policy_id)) {
                            Write-Warn "$NodeId`: dangling policy_id '$($Act.policy_id)' not in registry — treating as new"
                            $Act.policy_id = $null
                        }
                    }
                    if ($Act.PSObject.Properties['policy_id'] -and $null -ne $Act.policy_id) {
                        Write-Info "  Reused $($Act.policy_id)"
                    }
                    else {
                        $Text = [string]$Act.action
                        Write-Info "  New policy (id assigned at registration): $($Text.Substring(0, [Math]::Min(60, $Text.Length)))"
                    }
                }

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
                # t/4004: ids this node held before the overwrite, so a dropped id's member_count goes down.
                foreach ($PriorId in (Get-GraphAttributePolicyIds -GraphAttributes $OrigNode.graph_attributes)) { $FilePriorIds.Add($PriorId) }
                $FileNodeIds.Add([string]$NodeId)

                if ($OrigNode.graph_attributes.PSObject.Properties['policy_actions']) {
                    $OrigNode.graph_attributes.policy_actions = $Actions
                }
                else {
                    $OrigNode.graph_attributes | Add-Member -NotePropertyName 'policy_actions' -NotePropertyValue $Actions
                }

                $TotalProcessed++
                $TotalActions += $Actions.Count

                if ($Actions.Count -eq 0) {
                    Write-OK "$NodeId — no policy actions (theoretical/definitional)"
                }
                else {
                    $ActionNames = ($Actions | ForEach-Object { $_.action.Substring(0, [Math]::Min(50, $_.action.Length)) }) -join '; '
                    Write-OK "$NodeId — $($Actions.Count) action(s): $ActionNames"
                }
            }
        }

        # ── Write updated file ──
        if ($TotalProcessed -gt 0 -or $Force) {
            if ($PSCmdlet.ShouldProcess($FilePath, 'Write updated taxonomy file with policy actions')) {
                $FileData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
                $Json = $FileData | ConvertTo-Json -Depth 20
                try {
                    Write-Utf8NoBom -Path $FilePath -Value $Json
                    Write-OK "Saved $PovKey ($FilePath)"
                    $WrittenNodeIds.AddRange($FileNodeIds)
                    $PriorPolicyIds.AddRange($FilePriorIds)
                }
                catch {
                    Write-Fail "Failed to write $PovKey taxonomy file — $($_.Exception.Message)"
                    throw
                }
            }
        }
    }

    # ── Register the written nodes' policy actions (t/4004) ──
    # The shared primitive mints new ids, re-adds missing entries and recounts member_count;
    # it also writes the registry, so this cmdlet no longer does.
    Invoke-NodePolicyRegistration -NodeId $WrittenNodeIds.ToArray() -PriorPolicyIds $PriorPolicyIds.ToArray() -Caller 'Find-PolicyAction'

    # ── Summary ──
    Write-Host ''
    Write-Host '=== Policy Action Extraction Complete ===' -ForegroundColor Cyan
    Write-Host "  Analysed:        $TotalProcessed nodes" -ForegroundColor Green
    Write-Host "  Skipped:         $TotalSkipped nodes (already analysed)" -ForegroundColor Yellow
    Write-Host "  Failed:          $TotalFailed nodes" -ForegroundColor $(if ($TotalFailed -gt 0) { 'Red' } else { 'Green' })
    Write-Host "  Actions found:   $TotalActions across all nodes" -ForegroundColor White
    Write-Host ''

    if ($PassThru) {
        [PSCustomObject]@{
            Processed    = $TotalProcessed
            Skipped      = $TotalSkipped
            Failed       = $TotalFailed
            ActionsFound = $TotalActions
        }
    }
}
