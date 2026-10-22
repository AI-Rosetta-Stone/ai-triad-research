# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-PolicyRefinement {
    <#
    .SYNOPSIS
        Refines canonical policy action text using LLM analysis of all framings.
    .DESCRIPTION
        Finds all policies with member_count > 1 (i.e., referenced by multiple
        taxonomy nodes), collects the POV-specific framings from every referencing
        node, and asks an LLM to generate a POV-neutral canonical action statement
        (5-15 words).

        In DryRun mode, displays the prompt and current vs proposed text without
        calling the API. In normal mode, calls the API, updates policy_actions.json,
        and cascades the refined action text to all referencing nodes.
    .PARAMETER Model
        AI model to use. Defaults to AI_MODEL env var, then "gemini-3.5-flash-lite".
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER DryRun
        Show prompts and current text without calling the API.
    .PARAMETER PassThru
        Return a summary object with refinement details.
    .EXAMPLE
        Invoke-PolicyRefinement -DryRun
    .EXAMPLE
        Invoke-PolicyRefinement -Model 'claude-sonnet-4-6'
    .EXAMPLE
        Invoke-PolicyRefinement -PassThru
    .LINK
        Show-AITriadHelp
    .LINK
        Find-PolicyAction
    .LINK
        Get-Policy
    .LINK
        Update-PolicyRegistry
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = '',

        [string]$ApiKey = '',

        [switch]$DryRun,

        [switch]$StaleOnly,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $Model) {
        if ($env:AI_MODEL) { $Model = $env:AI_MODEL } else { $Model = (Get-AITierModel -Tier basic) }
    }

    # -- Validate environment --------------------------------------------------
    Write-Step 'Validating environment'

    $TaxDir       = Get-TaxonomyDir
    $RegistryPath = Join-Path $TaxDir 'policy_actions.json'

    if (-not (Test-Path $RegistryPath)) {
        Write-Fail 'Policy registry not found. Run Update-PolicyRegistry -Fix first.'
        throw 'Policy registry not found'
    }

    if (-not $DryRun) {
        # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
        $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
        if (-not $KeyStatus.HasKey) {
            Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
            throw 'No API key configured'
        }
    }

    # -- Load registry and taxonomy files --------------------------------------
    Write-Step 'Loading policy registry and taxonomy'

    $Registry = Get-Content -Raw -Path $RegistryPath | ConvertFrom-Json
    Write-OK "Registry loaded: $($Registry.policies.Count) policies"

    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    $TaxData  = @{}
    foreach ($PovKey in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (Test-Path $FilePath) {
            $TaxData[$PovKey] = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read (t/4356)
        }
    }

    # -- Find multi-member policies --------------------------------------------
    Write-Step 'Finding policies with multiple framings'

    $MultiPolicies = @($Registry.policies | Where-Object { $_.member_count -gt 1 })

    if ($StaleOnly) {
        $Before = $MultiPolicies.Count
        $MultiPolicies = @($MultiPolicies | Where-Object {
            $RefAt = if ($_.PSObject.Properties['framing_count_at_refinement']) { [int]$_.framing_count_at_refinement } else { 0 }
            ($_.member_count - $RefAt) -ge 3
        })
        Write-Info "StaleOnly filter: $Before multi-member -> $($MultiPolicies.Count) stale (member_count grew by >=3 since last refinement)"
    }

    if ($MultiPolicies.Count -eq 0) {
        Write-OK 'No policies with member_count > 1 found. Nothing to refine.'
        if ($PassThru) {
            return [PSCustomObject]@{
                PoliciesFound = 0
                Refined       = 0
                Failed        = 0
            }
        }
        return
    }

    Write-OK "Found $($MultiPolicies.Count) policies with multiple framings"

    # -- Collect framings for each policy --------------------------------------
    Write-Step 'Collecting framings from referencing nodes'

    $PolicyFramings = @{}  # policy_id -> list of { NodeId, POV, Action, Framing }

    foreach ($PovKey in $PovFiles) {
        if (-not $TaxData.ContainsKey($PovKey)) { continue }
        foreach ($Node in $TaxData[$PovKey].nodes) {
            if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) { continue }
            if (-not $Node.graph_attributes.PSObject.Properties['policy_actions']) { continue }

            foreach ($PA in $Node.graph_attributes.policy_actions) {
                if ($PA.PSObject.Properties['policy_id']) { $PolicyId = $PA.policy_id } else { $PolicyId = $null }
                if (-not $PolicyId) { continue }

                if (-not $PolicyFramings.ContainsKey($PolicyId)) {
                    $PolicyFramings[$PolicyId] = [System.Collections.Generic.List[object]]::new()
                }
                $PolicyFramings[$PolicyId].Add([PSCustomObject]@{
                    NodeId  = $Node.id
                    POV     = $PovKey
                    Action  = $PA.action
                    Framing = if ($PA.PSObject.Properties['framing']) { $PA.framing } else { '' }
                })
            }
        }
    }

    # -- Process each multi-member policy --------------------------------------
    $Refined = 0
    $Failed  = 0
    $Results = [System.Collections.Generic.List[object]]::new()

    foreach ($Policy in $MultiPolicies) {
        $PolicyId = $Policy.id
        $CurrentAction = $Policy.action

        if (-not $PolicyFramings.ContainsKey($PolicyId)) {
            Write-Warn "$PolicyId`: no framings found in taxonomy files"
            $Failed++
            continue
        }

        $Framings = $PolicyFramings[$PolicyId]

        Write-Step "$PolicyId`: $CurrentAction ($($Framings.Count) framings)"

        # Build the refinement prompt
        $FramingBlock = ($Framings | ForEach-Object {
            "- Node $($_.NodeId) [$($_.POV)]: action=`"$($_.Action)`" framing=`"$($_.Framing)`""
        }) -join "`n"

        $Prompt = @"
You are a policy language editor. Your task is to write a single canonical
policy action statement that is POV-neutral (not biased toward any camp:
accelerationist, safetyist, or skeptic).

CURRENT canonical action: "$CurrentAction"

This policy ($PolicyId) is referenced by $($Framings.Count) nodes across different POVs.
Here are all the framings:

$FramingBlock

INSTRUCTIONS:
1. Synthesize a single POV-neutral canonical action statement.
2. The statement must be 5-15 words, concrete, and actionable.
3. Do not favor any single POV's framing. Find the neutral common ground.
4. Return ONLY a JSON object: {"refined_action": "<your 5-15 word statement>"}
5. If the current action is already neutral and well-formed, return it unchanged.
"@

        # -- DryRun: show prompt and skip API call --
        if ($DryRun) {
            Write-Host ''
            Write-Host "--- $PolicyId ---" -ForegroundColor Cyan
            Write-Host "  Current : $CurrentAction" -ForegroundColor Yellow
            Write-Host "  Framings:" -ForegroundColor Gray
            foreach ($F in $Framings) {
                Write-Host "    $($F.NodeId) [$($F.POV)]: $($F.Action)" -ForegroundColor DarkGray
                if ($F.Framing) {
                    Write-Host "      framing: $($F.Framing.Substring(0, [Math]::Min(100, $F.Framing.Length)))" -ForegroundColor DarkGray
                }
            }
            Write-Host "  Prompt length: ~$($Prompt.Length) chars" -ForegroundColor Gray
            continue
        }

        # -- Call LLM --
        $RefinementSchema = @{
            type       = 'object'
            properties = @{
                refined_action = @{ type = 'string'; description = 'POV-neutral canonical action statement, 5-15 words' }
            }
            required   = @('refined_action')
        }
        try {
            $AIResult = Invoke-AIApi `
                -Prompt    $Prompt `
                -Model     $Model `
                -ApiKey    $ApiKey `
                -Temperature 0.1 `
                -MaxTokens 2048 `
                -ResponseSchema $RefinementSchema

            $ResponseText = $AIResult.Text
            if (-not $ResponseText) {
                Write-Warn "$PolicyId`: empty API response"
                $Failed++
                continue
            }

            # Strip markdown fences and extract JSON
            $ResponseText = $ResponseText -replace '(?s)^\s*```json\s*', '' -replace '(?s)\s*```\s*$', ''
            # Find the first complete JSON object (handles multi-line values)
            $JsonMatch = [regex]::Match($ResponseText, '(?s)\{[^{}]*"refined_action"\s*:\s*"[^"]*"[^{}]*\}')
            if (-not $JsonMatch.Success) {
                # Fallback: try to find any JSON object
                $JsonMatch = [regex]::Match($ResponseText, '(?s)\{.*?\}')
            }
            if (-not $JsonMatch.Success) {
                Write-Warn "$PolicyId`: no JSON object found in response: $($ResponseText.Substring(0, [Math]::Min(100, $ResponseText.Length)))"
                $Failed++
                continue
            }

            $Parsed = $JsonMatch.Value | ConvertFrom-Json

            if (-not $Parsed.PSObject.Properties['refined_action'] -or [string]::IsNullOrWhiteSpace($Parsed.refined_action)) {
                Write-Warn "$PolicyId`: LLM returned empty or missing refined_action"
                $Failed++
                continue
            }

            $RefinedAction = $Parsed.refined_action.Trim()
        }
        catch {
            Write-Fail "$PolicyId`: API call or parse failed -- $_"
            $Failed++
            continue
        }

        Write-Info "$PolicyId`: `"$CurrentAction`" -> `"$RefinedAction`""

        # -- Update policy_actions.json --
        if ($PSCmdlet.ShouldProcess("$PolicyId in policy_actions.json", "Update action to '$RefinedAction'")) {
            $Policy.action = $RefinedAction
            # Track refinement timestamp and framing count for incremental refinement
            if ($Policy.PSObject.Properties['last_refined_at']) {
                $Policy.last_refined_at = (Get-Date).ToString('yyyy-MM-dd')
            } else {
                $Policy | Add-Member -NotePropertyName 'last_refined_at' -NotePropertyValue (Get-Date).ToString('yyyy-MM-dd')
            }
            if ($Policy.PSObject.Properties['framing_count_at_refinement']) {
                $Policy.framing_count_at_refinement = $Policy.member_count
            } else {
                $Policy | Add-Member -NotePropertyName 'framing_count_at_refinement' -NotePropertyValue $Policy.member_count
            }
        }

        # -- Cascade to all referencing nodes --
        foreach ($F in $Framings) {
            $PovKey  = $F.POV
            if (-not $TaxData.ContainsKey($PovKey)) { continue }
            foreach ($Node in $TaxData[$PovKey].nodes) {
                if ($Node.id -ne $F.NodeId) { continue }
                if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) { continue }
                if (-not $Node.graph_attributes.PSObject.Properties['policy_actions']) { continue }

                foreach ($PA in $Node.graph_attributes.policy_actions) {
                    if ($PA.PSObject.Properties['policy_id'] -and $PA.policy_id -eq $PolicyId) {
                        if ($PSCmdlet.ShouldProcess("$($Node.id) [$PovKey]", "Update action text for $PolicyId")) {
                            $PA.action = $RefinedAction
                        }
                    }
                }
            }
        }

        $Refined++
        $Results.Add([PSCustomObject]@{
            PolicyId       = $PolicyId
            OriginalAction = $CurrentAction
            RefinedAction  = $RefinedAction
            FramingCount   = $Framings.Count
        })
    }

    # -- Write updated files ---------------------------------------------------
    if (-not $DryRun -and $Refined -gt 0) {
        Write-Step 'Writing updated files'

        # Save registry
        if ($PSCmdlet.ShouldProcess($RegistryPath, 'Write updated policy registry')) {
            $Registry | ConvertTo-Json -Depth 10 | Write-Utf8NoBom -Path $RegistryPath 
            Write-OK "Registry saved: $($Registry.policies.Count) policies"
        }

        # Save taxonomy files
        foreach ($PovKey in $PovFiles) {
            if (-not $TaxData.ContainsKey($PovKey)) { continue }
            $FilePath = Join-Path $TaxDir "$PovKey.json"
            if ($PSCmdlet.ShouldProcess($FilePath, 'Write updated taxonomy file')) {
                Write-PovTaxonomyFile -Path $FilePath -Data $TaxData[$PovKey]   # canonical TS format (t/4356)
                Write-OK "Saved $PovKey"
            }
        }
    }

    # -- Summary ---------------------------------------------------------------
    Write-Host ''
    Write-Host '=== Policy Refinement Complete ===' -ForegroundColor Cyan
    Write-Host "  Multi-member policies : $($MultiPolicies.Count)" -ForegroundColor White
    Write-Host "  Refined               : $Refined" -ForegroundColor $(if ($Refined -gt 0) { 'Green' } else { 'Gray' })
    Write-Host "  Failed                : $Failed" -ForegroundColor $(if ($Failed -gt 0) { 'Red' } else { 'Green' })
    if ($DryRun) {
        Write-Host '  Mode                  : DRY RUN (no changes made)' -ForegroundColor Yellow
    }
    Write-Host ''

    if ($PassThru) {
        [PSCustomObject]@{
            PoliciesFound = $MultiPolicies.Count
            Refined       = $Refined
            Failed        = $Failed
            Details       = $Results
        }
    }
}
