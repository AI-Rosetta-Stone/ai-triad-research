# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-PovAttributes {
    <#
    .SYNOPSIS
        Fills missing graph_attributes on POV taxonomy nodes using AI.
    .DESCRIPTION
        Scans POV nodes for missing graph_attributes fields and uses AI to generate them.

        Priority order:
          1. Nodes with NO graph_attributes at all (all fields needed)
          2. Missing steelman_vulnerability + intellectual_lineage
          3. Missing possible_fallacies (lower priority, many legitimately have none)

        The steelman_vulnerability is generated as a per-opponent-POV object.
    .PARAMETER POV
        Filter to a specific POV file.
    .PARAMETER Category
        Filter to a specific BDI category.
    .PARAMETER Priority
        Which priority level to fix: 'all' (default), 'critical' (no GA + missing steelman/lineage),
        or 'full' (includes possible_fallacies).
    .PARAMETER Model
        AI model. Default: gemini-3.5-flash-lite.
    .PARAMETER ApiKey
        AI API key.
    .PARAMETER BatchSize
        Nodes per AI call. Default: 10.
    .EXAMPLE
        Repair-PovAttributes -WhatIf
    .EXAMPLE
        Repair-PovAttributes -POV safetyist -Priority critical
    .EXAMPLE
        Repair-PovAttributes -Priority full
    .LINK
        Show-AITriadHelp
    .LINK
        Repair-PovDescriptions
    .LINK
        Repair-PovLineage
    .LINK
        Repair-ResolvedBackfill
    .LINK
        Repair-UnmappedConcepts
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic')]
        [string]$POV,

        [ValidateSet('Beliefs', 'Desires', 'Intentions')]
        [string]$Category,

        [ValidateSet('all', 'critical', 'full')]
        [string]$Priority = 'all',

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey,

        [ValidateRange(1, 20)]
        [int]$BatchSize = 10
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir = Get-TaxonomyDir
    $PovFiles = @('accelerationist', 'safetyist', 'skeptic')
    if ($POV) { $PovFiles = @($POV) }

    $OtherPovs = @{
        accelerationist = @('safetyist', 'skeptic')
        safetyist       = @('accelerationist', 'skeptic')
        skeptic         = @('accelerationist', 'safetyist')
    }

    $RequiredFields = @('epistemic_type', 'rhetorical_strategy', 'node_scope',
                        'intellectual_lineage', 'steelman_vulnerability')
    if ($Priority -eq 'full') { $RequiredFields += 'possible_fallacies' }

    # ── Collect nodes needing repair ──────────────────────────────────────────
    $NodesToFix = [System.Collections.Generic.List[PSObject]]::new()
    $TaxData = @{}

    foreach ($PovName in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $Data = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)
        $TaxData[$PovName] = $Data

        foreach ($Node in $Data.nodes) {
            if ($Node.PSObject.Properties['children'] -and $Node.children -and @($Node.children).Count -gt 0) { continue }
            if ($Category -and $Node.category -ne $Category) { continue }
            if (Test-TaxonomyNodeSuperseded $Node) { continue }   # no AI repair of a retired node; $Data keeps it (t/4356)

            $HasGA = $Node.PSObject.Properties['graph_attributes'] -and $null -ne $Node.graph_attributes
            $MissingFields = [System.Collections.Generic.List[string]]::new()

            if (-not $HasGA) {
                foreach ($F in $RequiredFields) { $MissingFields.Add($F) }
            }
            else {
                $GA = $Node.graph_attributes
                foreach ($F in $RequiredFields) {
                    if (-not $GA.PSObject.Properties[$F] -or $null -eq $GA.$F -or
                        ($GA.$F -is [string] -and [string]::IsNullOrWhiteSpace($GA.$F)) -or
                        ($GA.$F -is [array] -and @($GA.$F).Count -eq 0)) {
                        $MissingFields.Add($F)
                    }
                }
            }

            if ($MissingFields.Count -eq 0) { continue }

            # Priority filtering
            if ($Priority -eq 'critical') {
                $IsCritical = (-not $HasGA) -or
                              $MissingFields.Contains('steelman_vulnerability') -or
                              $MissingFields.Contains('intellectual_lineage')
                if (-not $IsCritical) { continue }
            }

            $NodesToFix.Add([PSCustomObject]@{
                Node          = $Node
                POV           = $PovName
                MissingFields = @($MissingFields)
                HasGA         = $HasGA
            })
        }
    }

    # ── Summary ───────────────────────────────────────────────────────────────
    $NoGACount = @($NodesToFix | Where-Object { -not $_.HasGA }).Count
    $SteelmanCount = @($NodesToFix | Where-Object { $_.MissingFields -contains 'steelman_vulnerability' }).Count
    $LineageCount = @($NodesToFix | Where-Object { $_.MissingFields -contains 'intellectual_lineage' }).Count
    $FallacyCount = @($NodesToFix | Where-Object { $_.MissingFields -contains 'possible_fallacies' }).Count

    Write-Host "=== Attribute Gaps (priority: $Priority) ===" -ForegroundColor Cyan
    Write-Host "  Nodes to fix: $($NodesToFix.Count)"
    Write-Host "  No graph_attributes: $NoGACount"
    Write-Host "  Missing steelman_vulnerability: $SteelmanCount"
    Write-Host "  Missing intellectual_lineage: $LineageCount"
    if ($Priority -eq 'full') { Write-Host "  Missing possible_fallacies: $FallacyCount" }

    if ($NodesToFix.Count -eq 0) {
        Write-Host "  Nothing to fix!" -ForegroundColor Green
        return
    }

    # Per-POV breakdown
    foreach ($PovName in $PovFiles) {
        $PovNodes = @($NodesToFix | Where-Object { $_.POV -eq $PovName })
        if ($PovNodes.Count -gt 0) {
            Write-Host "  $PovName`: $($PovNodes.Count) nodes"
        }
    }

    $TotalBatches = [Math]::Ceiling($NodesToFix.Count / $BatchSize)
    Write-Host "  Batches: $TotalBatches ($BatchSize/batch)"

    if ($WhatIfPreference) {
        Write-Host "`n── Nodes to fix ────────────────────────────────" -ForegroundColor Yellow
        foreach ($Item in $NodesToFix) {
            $FieldList = $Item.MissingFields -join ', '
            Write-Host "  $($Item.Node.id) [$($Item.POV)/$($Item.Node.category)] — missing: $FieldList" -ForegroundColor Gray
        }
        return
    }

    # ── Resolve API key ───────────────────────────────────────────────────────
    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Warning "No API key — cannot generate attributes"
        return
    }

    # ── Process in batches ────────────────────────────────────────────────────
    $BatchNum = 0
    $TotalFixed = 0

    for ($i = 0; $i -lt $NodesToFix.Count; $i += $BatchSize) {
        $BatchNum++
        $Batch = @($NodesToFix[$i..[Math]::Min($i + $BatchSize - 1, $NodesToFix.Count - 1)])
        Write-Host "`nBatch $BatchNum/$TotalBatches ($($Batch.Count) nodes)..." -ForegroundColor Cyan

        $NodeDescriptions = ($Batch | ForEach-Object {
            $N = $_.Node
            $Missing = $_.MissingFields -join ', '
            "- id: $($N.id) | pov: $($_.POV) | category: $($N.category) | label: $($N.label)`n  description: $($N.description)`n  missing: $Missing"
        }) -join "`n`n"

        $Prompt = @"
Generate missing graph_attributes for these taxonomy nodes. For each node, provide ONLY the missing fields listed.

FIELD DEFINITIONS:
- epistemic_type: one of: empirical_claim, normative_prescription, causal_mechanism, definitional, predictive, methodological
- rhetorical_strategy: comma-separated list from: structural_critique, appeal_to_evidence, precautionary_framing, moral_imperative, cost_benefit_analysis, techno_optimism, credibility_framing, analogical_reasoning, appeal_to_fear, inevitability_framing, appeal_to_authority, appeal_to_justice, appeal_to_sovereignty, rights_based, pragmatic_framing, systemic_critique
- node_scope: one of: narrow_technical, domain_specific, cross_domain, systemic
- intellectual_lineage: array of 2-5 intellectual traditions (e.g., ["Effective Altruism", "Longtermism"])
- steelman_vulnerability: object with per-opponent-POV vulnerabilities:
  { "from_accelerationist": "1-2 sentences: strongest accelerationist critique",
    "from_safetyist": "1-2 sentences: strongest safetyist critique",
    "from_skeptic": "1-2 sentences: strongest skeptic critique" }
  (omit the node's own POV — e.g., for a safetyist node, include from_accelerationist and from_skeptic only)
- possible_fallacies: array of 0-3 fallacy names from: appeal_to_authority, slippery_slope, false_dilemma, straw_man, appeal_to_fear, naturalistic_fallacy, is_ought_fallacy, composition_fallacy, hasty_generalization, tu_quoque, appeal_to_novelty, nirvana_fallacy
  (use empty array [] if none apply)

NODES:
$NodeDescriptions

Return a JSON array. Each element: { "id": "node-id", "fields": { ...only the missing fields... } }
No markdown fences, no explanation.
"@

        try {
            $Result = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ApiKey `
                -Temperature 0.3 -MaxTokens 8192 -JsonMode -TimeoutSec 60
            if (-not $Result -or -not $Result.Text) {
                Write-Warning "  No response for batch $BatchNum"
                continue
            }

            $CleanText = $Result.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            $Responses = $CleanText | ConvertFrom-Json

            foreach ($Resp in @($Responses)) {
                $NodeId = $Resp.id
                $Fields = $Resp.fields

                # Find the matching item
                $Item = $Batch | Where-Object { $_.Node.id -eq $NodeId } | Select-Object -First 1
                if (-not $Item) { continue }

                $Node = $Item.Node

                if ($PSCmdlet.ShouldProcess("$NodeId (fill $($Item.MissingFields -join ', '))", 'Set graph_attributes')) {
                    # Ensure graph_attributes exists
                    if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) {
                        $Node | Add-Member -NotePropertyName 'graph_attributes' -NotePropertyValue ([PSCustomObject]@{}) -Force
                    }
                    $GA = $Node.graph_attributes

                    foreach ($FieldName in $Item.MissingFields) {
                        if ($Fields.PSObject.Properties[$FieldName] -and $null -ne $Fields.$FieldName) {
                            if ($GA.PSObject.Properties[$FieldName]) {
                                $GA.$FieldName = $Fields.$FieldName
                            }
                            else {
                                $GA | Add-Member -NotePropertyName $FieldName -NotePropertyValue $Fields.$FieldName -Force
                            }
                        }
                    }
                    $TotalFixed++
                    Write-Host "  FIXED $NodeId [$($Item.MissingFields -join ', ')]" -ForegroundColor Green
                }
            }
        }
        catch {
            Write-Warning "  Batch $BatchNum failed: $($_.Exception.Message)"
        }

        if ($BatchNum -lt $TotalBatches) { Start-Sleep -Seconds 2 }
    }

    # ── Write modified files ──────────────────────────────────────────────────
    if ($TotalFixed -gt 0 -and -not $WhatIfPreference) {
        foreach ($PovName in $TaxData.Keys) {
            $FilePath = Join-Path $TaxDir "$PovName.json"
            Write-PovTaxonomyFile -Path $FilePath -Data $TaxData[$PovName]   # canonical TS format (t/4356)
        }
        Write-Host "`nSaved taxonomy files" -ForegroundColor Green
    }

    Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
    Write-Host "  Nodes processed: $($NodesToFix.Count)"
    Write-Host "  Fixed: $TotalFixed"
}
