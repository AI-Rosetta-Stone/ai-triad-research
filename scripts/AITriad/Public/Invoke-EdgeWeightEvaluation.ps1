# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-EdgeWeightEvaluation {
    <#
    .SYNOPSIS
        AI-powered batch evaluation of edge weights.
    .DESCRIPTION
        Sends batches of edges to an LLM to assign relationship weights (0.0-1.0).
        Weight measures how strong the relationship is, independent of confidence
        (which measures whether the edge exists at all). Only evaluates edges that
        don't already have a weight assigned.
    .PARAMETER Model
        AI model to use. Default: gemini-3.5-flash-lite.
    .PARAMETER BatchSize
        Number of edges per API call. Default: 15.
    .PARAMETER Status
        Only evaluate edges with this status. Default: approved.
    .PARAMETER MaxBatches
        Stop after this many batches (0 = unlimited). Default: 0.
    .PARAMETER Force
        Re-evaluate edges that already have weights.
    .PARAMETER ApiKey
        API key override.
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Invoke-EdgeWeightEvaluation
        # Evaluate all approved edges without weights.
    .EXAMPLE
        Invoke-EdgeWeightEvaluation -Force -MaxBatches 10
        # Re-evaluate first 150 approved edges.
    .EXAMPLE
        Invoke-EdgeWeightEvaluation -Status proposed
        # Evaluate proposed edges.
    .LINK
        Show-AITriadHelp
    .LINK
        Approve-Edge
    .LINK
        Get-Edge
    .LINK
        Set-Edge
    .LINK
        Test-EdgeDirection
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Invoke-AIByUsage
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$Model = (Get-AITierModel -Tier basic),

        [int]$BatchSize = 30,

        [ValidateSet('proposed', 'approved', 'rejected', '')]
        [string]$Status = 'approved',

        [int]$MaxBatches = 0,

        [switch]$Force,

        [string]$ApiKey = '',

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir    = Get-TaxonomyDir
    $EdgesPath = Join-Path $TaxDir 'edges.json'

    if (-not (Test-Path $EdgesPath)) {
        Write-Fail 'No edges.json found.'
        return
    }

    # ── Load data ──
    $EdgesData = Read-EdgesFile -Path $EdgesPath   # t/2974: coercion-free read (preserve discovered_at strings)
    $AllEdges  = $EdgesData.edges

    # ── Build label + description lookup ──
    $Labels = @{}
    $Descriptions = @{}
    foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }
        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        foreach ($Node in $FileData.nodes) {
            $Labels[$Node.id] = $Node.label
            if ($Node.PSObject.Properties['description'] -and $Node.description) {
                $Desc = $Node.description
                if ($Desc.Length -gt 120) { $Desc = $Desc.Substring(0, 120) + '...' }
                $Descriptions[$Node.id] = $Desc
            }
        }
    }

    # ── Build node index for edge weight modulation ──
    $NodeIndex = @{}  # id → @{ Category, Confidence, Priority, Doctrinal }
    foreach ($PovName in @('accelerationist', 'safetyist', 'skeptic')) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $PovData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        foreach ($Node in $PovData.nodes) {
            $NodeIndex[$Node.id] = @{
                Category   = if ($Node.PSObject.Properties['category'])   { $Node.category }   else { $null }
                Confidence = if ($Node.PSObject.Properties['confidence']) { $Node.confidence } else { $null }
                Priority   = if ($Node.PSObject.Properties['priority'])   { $Node.priority }   else { $null }
                Doctrinal  = if ($Node.PSObject.Properties['doctrinally_anchored']) { $Node.doctrinally_anchored } else { $false }
            }
        }
    }
    $HasModulationData = ($NodeIndex.Values | Where-Object { $null -ne $_.Confidence -or $null -ne $_.Priority } | Select-Object -First 1) -ne $null
    if ($HasModulationData) {
        Write-Info "Edge weight modulation: ENABLED (confidence/priority data available)"
    } else {
        Write-Info "Edge weight modulation: SKIPPED (no confidence/priority on nodes)"
    }

    # ── Filter to edges needing weight ──
    $Candidates = [System.Collections.Generic.List[PSObject]]::new()
    $Superseded = Get-SupersededNodeIdSet   # no AI call for an edge with a retired endpoint; the file keeps it (t/4356)
    for ($i = 0; $i -lt $AllEdges.Count; $i++) {
        $E = $AllEdges[$i]
        if ($Superseded.Contains([string]$E.source) -or $Superseded.Contains([string]$E.target)) { continue }
        if ($Status -and $E.status -ne $Status) { continue }
        if (-not $Force -and $E.PSObject.Properties['weight'] -and $null -ne $E.weight) { continue }
        $Candidates.Add([PSCustomObject]@{ Index = $i; Edge = $E })
    }

    $TotalCandidates = $Candidates.Count
    Write-Info "Found $TotalCandidates edges needing weight evaluation (status=$Status, force=$Force)"

    if ($TotalCandidates -eq 0) {
        Write-Info 'Nothing to evaluate.'
        return
    }

    # ── Resolve API key ──
    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Fail "No API key found for $($KeyStatus.Backend). Set `$env:$($KeyStatus.EnvHint)."
        return
    }

    # ── Load prompt template ──
    $PromptTemplate = Get-Prompt -Name 'edge-weight-evaluation' -AllowUnresolved

    # ── Batch processing ──
    $TotalBatches  = [Math]::Ceiling($TotalCandidates / $BatchSize)
    if ($MaxBatches -gt 0) { $TotalBatches = [Math]::Min($TotalBatches, $MaxBatches) }
    $EvaluatedCount = 0
    $ErrorCount     = 0

    for ($b = 0; $b -lt $TotalBatches; $b++) {
        $Start = $b * $BatchSize
        $End   = [Math]::Min($Start + $BatchSize, $TotalCandidates) - 1
        $Batch = $Candidates[$Start..$End]

        # Build edge descriptions with node context
        $EdgeLines = [System.Collections.Generic.List[string]]::new()
        foreach ($Item in $Batch) {
            $E = $Item.Edge
            $SrcLabel = if ($Labels.ContainsKey($E.source)) { $Labels[$E.source] } else { $E.source }
            $TgtLabel = if ($Labels.ContainsKey($E.target)) { $Labels[$E.target] } else { $E.target }
            $SrcDesc  = if ($Descriptions.ContainsKey($E.source)) { " — $($Descriptions[$E.source])" } else { '' }
            $TgtDesc  = if ($Descriptions.ContainsKey($E.target)) { " — $($Descriptions[$E.target])" } else { '' }
            $Dir      = if ($E.bidirectional) { '↔' } else { '→' }
            $EdgeLines.Add("  index=$($Item.Index) | $($E.type) | `"$SrcLabel`" ($($E.source))$SrcDesc $Dir `"$TgtLabel`" ($($E.target))$TgtDesc | Rationale: $($E.rationale)")
        }

        $FullPrompt = $PromptTemplate -replace '\{\{EDGES\}\}', ($EdgeLines -join "`n")

        Write-Progress -Activity 'Evaluating edge weights' `
            -Status "Batch $($b + 1) / $TotalBatches — $EvaluatedCount evaluated so far" `
            -PercentComplete ([int](($b / $TotalBatches) * 100))

        if (-not $PSCmdlet.ShouldProcess("Batch $($b + 1) ($($Batch.Count) edges)", 'Evaluate weights')) {
            continue
        }

        try {
            $Response = Invoke-AIApi `
                -Prompt     $FullPrompt `
                -Model      $Model `
                -ApiKey     $ApiKey `
                -Temperature 0.2 `
                -MaxTokens  4096

            if ($null -eq $Response) {
                Write-Warning "Batch $($b + 1): API returned null"
                $ErrorCount++
                continue
            }

            $Text = $Response.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            $Results = $null
            try {
                $Results = $Text | ConvertFrom-Json
            } catch {
                $Repaired = Repair-TruncatedJson -Text $Text
                if ($Repaired) {
                    $Results = $Repaired | ConvertFrom-Json
                } else {
                    Write-Warning "Batch $($b + 1): Failed to parse response"
                    $ErrorCount++
                    continue
                }
            }

            if ($Results -and $Results.Count -gt 0) {
                foreach ($R in $Results) {
                    $Idx = [int]$R.index
                    $W   = [double]$R.weight
                    if ($W -lt 0.0 -or $W -gt 1.0) {
                        Write-Warning "  edg-$($Idx + 1): weight $W out of range, clamping"
                        $W = [Math]::Max(0.0, [Math]::Min(1.0, $W))
                    }
                    $AllEdges[$Idx] | Add-Member -NotePropertyName 'weight' -NotePropertyValue $W -Force

                    # ── Edge weight modulation ──
                    if ($HasModulationData) {
                        $Edge = $AllEdges[$Idx]
                        $SrcInfo = $NodeIndex[$Edge.source]
                        $TgtInfo = $NodeIndex[$Edge.target]
                        $SrcCat = if ($SrcInfo) { $SrcInfo.Category } else { $null }
                        $TgtCat = if ($TgtInfo) { $TgtInfo.Category } else { $null }
                        $EType  = $Edge.type
                        $Factor = 1.0

                        $IsAttack  = $EType -in 'CONTRADICTS', 'WEAKENS'
                        $IsSupport = $EType -in 'SUPPORTS', 'ASSUMES'

                        if ($SrcCat -eq 'Beliefs' -and $TgtCat -eq 'Beliefs') {
                            if ($IsAttack -and $null -ne $SrcInfo.Confidence -and $null -ne $TgtInfo.Confidence) {
                                $Factor = [Math]::Min($SrcInfo.Confidence, $TgtInfo.Confidence)
                            } elseif ($IsSupport -and $null -ne $SrcInfo.Confidence) {
                                $Factor = $SrcInfo.Confidence
                            }
                        } elseif ($SrcCat -eq 'Desires' -and $TgtCat -eq 'Intentions') {
                            if ($IsSupport -and $null -ne $SrcInfo.Priority) {
                                $Factor = $SrcInfo.Priority / 5.0
                            }
                        } elseif ($SrcCat -eq 'Beliefs' -and $TgtCat -eq 'Intentions') {
                            if ($IsSupport -and $null -ne $SrcInfo.Confidence) {
                                $Factor = $SrcInfo.Confidence
                            }
                        } elseif ($SrcCat -eq 'Beliefs' -and $TgtCat -eq 'Desires') {
                            if ($null -ne $SrcInfo.Confidence) {
                                $Factor = $SrcInfo.Confidence
                            }
                        }

                        # Doctrinal anchoring multiplier
                        if ($IsAttack -and $TgtInfo -and $TgtInfo.Doctrinal) {
                            $Factor = [Math]::Min(1.0, $Factor * 1.2)
                        } elseif ($IsSupport -and $SrcInfo -and $SrcInfo.Doctrinal) {
                            $Factor = [Math]::Min(1.0, $Factor * 1.1)
                        }

                        $Factor = [Math]::Round($Factor, 3)
                        $ModWeight = [Math]::Round($W * $Factor, 3)
                        $Edge | Add-Member -NotePropertyName 'modulated_weight' -NotePropertyValue $ModWeight -Force
                    }

                    $EvaluatedCount++
                    $SrcLabel = if ($Labels.ContainsKey($AllEdges[$Idx].source)) { $Labels[$AllEdges[$Idx].source] } else { $AllEdges[$Idx].source }
                    $TgtLabel = if ($Labels.ContainsKey($AllEdges[$Idx].target)) { $Labels[$AllEdges[$Idx].target] } else { $AllEdges[$Idx].target }
                    $ModStr = if ($HasModulationData -and $AllEdges[$Idx].PSObject.Properties['modulated_weight']) { " mw=$($AllEdges[$Idx].modulated_weight.ToString('F3'))" } else { '' }
                    Write-Info "  edg-$($Idx + 1): w=$($W.ToString('F2'))$ModStr — $SrcLabel → $TgtLabel"
                }
            }

        } catch {
            Write-Warning "Batch $($b + 1): Exception — $_"
            $ErrorCount++
        }

        # Checkpoint every 10 batches
        if (($b + 1) % 10 -eq 0) {
            $EdgesData.edges = $AllEdges
            $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
            Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
            Write-Info "Checkpoint at batch $($b + 1): $EvaluatedCount evaluated"
        }
    }

    Write-Progress -Activity 'Evaluating edge weights' -Completed

    # ── Final save ──
    $EdgesData.edges = $AllEdges
    $EdgesData.last_modified = (Get-Date).ToString('yyyy-MM-dd')
    Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath

    Write-OK "Done: $EvaluatedCount edges evaluated, $ErrorCount errors"
}
