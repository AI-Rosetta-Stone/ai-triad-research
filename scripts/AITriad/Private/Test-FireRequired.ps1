# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Two-stage FIRE sniff: determines whether iterative extraction is worth the cost.
# Stage 1: Pre-extraction (zero API cost) — checks document characteristics.
# Stage 2: Post-extraction — evaluates single-shot output quality signals.
# Design: CL recommendation (p/41#7), 2-signal decision rule.
# Dot-sourced by AITriad.psm1 — do NOT export.

function Test-FireRequired {
    <#
    .SYNOPSIS
        Determines whether FIRE iterative extraction should be used for a document.
    .DESCRIPTION
        Two-stage evaluation:

        Stage 1 (pre-extraction, zero API cost):
          Checks document-level signals that predict single-shot will fail.
          If ANY signal fires → recommend FIRE immediately (skip single-shot).

        Stage 2 (post-extraction, evaluates single-shot output):
          Checks 5 quality signals on the AI's output. If 2+ signals fire →
          recommend re-running with FIRE.

        The 2-signal decision rule is fixed. Individual thresholds are configurable
        via the $Thresholds parameter.
    .PARAMETER WordCount
        Estimated word count of the document (for Stage 1).
    .PARAMETER IsChunked
        Whether the document was split into multiple chunks (for Stage 1).
    .PARAMETER SourceType
        Source format: 'pdf', 'html', 'docx', etc. (for Stage 1).
    .PARAMETER SummaryObject
        The single-shot summary result (for Stage 2). Pass $null for Stage 1 only.
    .PARAMETER Thresholds
        Hashtable of configurable thresholds. Defaults provided for all signals.
    .OUTPUTS
        PSCustomObject with: ShouldFire (bool), Stage (1 or 2), Signals (which fired),
        Reason (human-readable explanation).
    #>
    [CmdletBinding()]
    param(
        [int]$WordCount = 0,

        [switch]$IsChunked,

        [string]$SourceType = 'unknown',

        [object]$SummaryObject = $null,

        [hashtable]$Thresholds = @{}
    )

    Set-StrictMode -Version Latest

    # ── Default thresholds (configurable) ─────────────────────────────────────
    $T = @{
        # Stage 1
        word_count_min          = 8000    # Documents above this are likely complex
        complex_source_types    = @('pdf') # Source types with layout complexity

        # Stage 2
        low_confidence_rate     = 0.30    # >30% of claims have fire_confidence < 0.5
        specificity_collapse    = 0.40    # >40% of claims rated "vague"
        warrant_deficit         = 0.50    # >50% of claims have has_warrant=false
        unmapped_concept_rate   = 0.40    # >40% of key_points are unmapped
        claim_clustering        = 0.60    # >60% of claims map to same 3 nodes

        # Decision
        min_signals_required    = 2       # Stage 2: how many signals must fire
    }

    # Override with caller-provided thresholds
    foreach ($Key in $Thresholds.Keys) {
        if ($T.ContainsKey($Key)) { $T[$Key] = $Thresholds[$Key] }
    }

    $FiredSignals = [System.Collections.Generic.List[string]]::new()

    # ── Stage 1: Pre-extraction (zero API cost) ───────────────────────────────
    $WordCountMin = $T['word_count_min']
    if ($WordCount -gt $WordCountMin) {
        $FiredSignals.Add("word_count=$WordCount (>$WordCountMin)")
    }

    if ($IsChunked) {
        $FiredSignals.Add('document_chunked')
    }

    if ($SourceType -in $T['complex_source_types']) {
        $FiredSignals.Add("complex_source_type=$SourceType")
    }

    # Stage 1 decision: ANY signal → go directly to FIRE
    if ($FiredSignals.Count -gt 0) {
        Write-Verbose "FIRE sniff Stage 1: $($FiredSignals.Count) signal(s) fired — $($FiredSignals -join ', ')"
        return [PSCustomObject][ordered]@{
            ShouldFire = $true
            Stage      = 1
            Signals    = @($FiredSignals)
            Reason     = "Stage 1 pre-extraction: $($FiredSignals -join '; ')"
        }
    }

    # ── Stage 2: Post-extraction (requires SummaryObject) ─────────────────────
    if ($null -eq $SummaryObject) {
        # No summary to evaluate — Stage 1 didn't fire, can't do Stage 2
        return [PSCustomObject][ordered]@{
            ShouldFire = $false
            Stage      = 1
            Signals    = @()
            Reason     = 'Stage 1: no pre-extraction signals fired; no summary to evaluate for Stage 2'
        }
    }

    $Stage2Signals = [System.Collections.Generic.List[string]]::new()

    # Collect all claims across POV camps
    $AllKeyPoints = [System.Collections.Generic.List[object]]::new()
    $Camps = @('accelerationist', 'safetyist', 'skeptic')
    $PovSums = Get-SummaryField $SummaryObject 'pov_summaries'
    foreach ($Camp in $Camps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if ($CampData -and $CampData.PSObject.Properties['key_points'] -and $CampData.key_points) {
            foreach ($KP in @($CampData.key_points)) { $AllKeyPoints.Add($KP) }
        }
    }

    if ($SummaryObject.PSObject.Properties['factual_claims'] -and $SummaryObject.factual_claims) { $AllClaims = @($SummaryObject.factual_claims) } else { $AllClaims = @() }
    $TotalKP = $AllKeyPoints.Count
    $TotalClaims = $AllClaims.Count

    # Signal 1: Low-confidence rate
    if ($TotalClaims -gt 0) {
        $LowConf = @($AllClaims | Where-Object {
            if ($_.PSObject.Properties['fire_confidence']) { $FC = $_.fire_confidence } else { $FC = 0.5 }
            $FC -lt 0.5
        }).Count
        $LowConfRate = $LowConf / $TotalClaims
        if ($LowConfRate -gt $T['low_confidence_rate']) {
            $Stage2Signals.Add("low_confidence_rate=$([Math]::Round($LowConfRate * 100))% ($LowConf/$TotalClaims claims)")
        }
    }

    # Signal 2: Specificity collapse
    if ($TotalClaims -gt 0) {
        $VagueClaims = @($AllClaims | Where-Object {
            $_.PSObject.Properties['evidence_criteria'] -and
            $_.evidence_criteria.PSObject.Properties['specificity'] -and
            $_.evidence_criteria.specificity -eq 'vague'
        }).Count
        $VagueRate = $VagueClaims / $TotalClaims
        if ($VagueRate -gt $T['specificity_collapse']) {
            $Stage2Signals.Add("specificity_collapse=$([Math]::Round($VagueRate * 100))% ($VagueClaims/$TotalClaims claims)")
        }
    }

    # Signal 3: Warrant deficit
    if ($TotalClaims -gt 0) {
        $NoWarrant = @($AllClaims | Where-Object {
            $_.PSObject.Properties['evidence_criteria'] -and
            $_.evidence_criteria.PSObject.Properties['has_warrant'] -and
            -not $_.evidence_criteria.has_warrant
        }).Count
        $NoWarrantRate = $NoWarrant / $TotalClaims
        if ($NoWarrantRate -gt $T['warrant_deficit']) {
            $Stage2Signals.Add("warrant_deficit=$([Math]::Round($NoWarrantRate * 100))% ($NoWarrant/$TotalClaims claims)")
        }
    }

    # Signal 4: Unmapped concept rate
    if ($TotalKP -gt 0) {
        $Unmapped = @($AllKeyPoints | Where-Object { -not ($_.PSObject.Properties['taxonomy_node_id'] -and $_.taxonomy_node_id) }).Count
        $UnmappedRate = $Unmapped / $TotalKP
        if ($UnmappedRate -gt $T['unmapped_concept_rate']) {
            $Stage2Signals.Add("unmapped_concept_rate=$([Math]::Round($UnmappedRate * 100))% ($Unmapped/$TotalKP key_points)")
        }
    }

    # Signal 5: Claim clustering (>60% map to same 3 nodes)
    if ($TotalClaims -gt 3) {
        $NodeCounts = @{}
        foreach ($Claim in $AllClaims) {
            if ($Claim.PSObject.Properties['linked_taxonomy_nodes']) {
                foreach ($NodeId in @($Claim.linked_taxonomy_nodes)) {
                    if (-not $NodeCounts.ContainsKey($NodeId)) { $NodeCounts[$NodeId] = 0 }
                    $NodeCounts[$NodeId]++
                }
            }
        }
        $Top3Count = ($NodeCounts.Values | Sort-Object -Descending | Select-Object -First 3 | Measure-Object -Sum).Sum
        $TotalMappings = ($NodeCounts.Values | Measure-Object -Sum).Sum
        if ($TotalMappings -gt 0) {
            $ClusterRate = $Top3Count / $TotalMappings
            if ($ClusterRate -gt $T['claim_clustering']) {
                $Stage2Signals.Add("claim_clustering=$([Math]::Round($ClusterRate * 100))% (top 3 nodes cover $Top3Count/$TotalMappings mappings)")
            }
        }
    }

    # Stage 2 decision: 2+ signals → recommend FIRE
    $ShouldFire = $Stage2Signals.Count -ge $T['min_signals_required']

    if ($Stage2Signals.Count -gt 0) {
        Write-Verbose "FIRE sniff Stage 2: $($Stage2Signals.Count) signal(s) fired — $($Stage2Signals -join ', ')"
    }
    else {
        Write-Verbose 'FIRE sniff Stage 2: no signals fired — single-shot quality is adequate'
    }

    if ($ShouldFire) {
        $ReasonMsg = "Stage 2: $($Stage2Signals.Count) signals fired (>=$($T['min_signals_required']) required) — $($Stage2Signals -join '; ')"
    }
    else {
        $ReasonMsg = "Stage 2: $($Stage2Signals.Count) signal(s) fired (<$($T['min_signals_required']) required) — single-shot adequate"
    }
    return [PSCustomObject][ordered]@{
        ShouldFire = $ShouldFire
        Stage      = 2
        Signals    = @($Stage2Signals)
        Reason     = $ReasonMsg
    }
}
