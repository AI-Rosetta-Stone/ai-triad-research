# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AITClaim {
    <#
    .SYNOPSIS
        Retrieves extracted claims from POV summary files.
    .DESCRIPTION
        Reads summary JSON files and extracts individual claims from both
        factual_claims and pov_summaries key_points. Returns typed AITClaim
        objects suitable for pipeline filtering and analysis.

        By default returns both factual claims and key points.
        Use -Type to restrict to one claim type.
    .PARAMETER DocId
        Wildcard pattern matched against the summary doc_id.
    .PARAMETER Type
        Restrict to FactualClaim or KeyPoint (default: both).
    .PARAMETER Pov
        Filter key_points by POV. Factual claims are POV-independent and
        always included unless -Type KeyPoint is specified.
    .PARAMETER TaxonomyNode
        Wildcard pattern matched against linked taxonomy node IDs.
    .PARAMETER MinConfidence
        Minimum extraction_confidence threshold (0.0-1.0).
    .PARAMETER DocPosition
        Filter factual claims by document position (supports, contradicts, discusses).
    .PARAMETER Stance
        Filter key_points by stance (aligned, neutral, opposed).
    .PARAMETER TemporalScope
        Filter factual claims by temporal scope (historical, predictive, timeless).
    .PARAMETER IncludeDuplicates
        Also return claims from documents marked duplicate_of another document. They're left out
        by default, so a copy's claims aren't returned twice; an exact -DocId always finds them.
    .EXAMPLE
        Get-AITClaim
        # All claims from all summaries.
    .EXAMPLE
        Get-AITClaim -Type FactualClaim -MinConfidence 0.9
        # High-confidence factual claims only.
    .EXAMPLE
        Get-AITClaim '*fairness*' -TaxonomyNode 'saf-beliefs-*'
        # Claims from fairness docs linked to safetyist beliefs.
    .EXAMPLE
        Get-AITClaim -Pov skeptic -Stance opposed
        # Skeptic key_points with opposed stance.
    .EXAMPLE
        Get-AITClaim -DocPosition contradicts | Sort-Object Confidence
        # All contradicting factual claims sorted by confidence.
    .LINK
        Show-AITriadHelp
    .LINK
        Show-DebateDiagnostics
    .LINK
        Show-DebateHarvest
    .LINK
        Convert-DebateToAudio
    .LINK
        Get-CriticalInteraction
    .LINK
        Test-CriticalInteractions
    .LINK
        Get-TopicFrequency
    #>
    [CmdletBinding()]
    [OutputType('AITClaim')]
    param(
        [Parameter(Position = 0)]
        [string]$DocId,

        [ValidateSet('FactualClaim', 'KeyPoint')]
        [string]$Type,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic')]
        [string]$Pov,

        [string]$TaxonomyNode,

        [ValidateRange(0.0, 1.0)]
        [double]$MinConfidence,

        [string]$DocPosition,

        [string]$Stance,

        [string]$TemporalScope,

        [switch]$IncludeDuplicates
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SummariesDir = Get-SummariesDir

    if (-not (Test-Path $SummariesDir)) {
        Write-Warning "Summaries directory not found: $SummariesDir"
        return
    }

    # duplicate_of (t/4337 C1): a listing skips marked copies' summaries.
    $SummaryFiles = @(Get-ListedSummaryFile -SummariesDir $SummariesDir -DocId $DocId -IncludeDuplicates:$IncludeDuplicates -Caller 'Get-AITClaim')
    if ($SummaryFiles.Count -eq 0) {
        Write-Warning "No summary files found in $SummariesDir"
        return
    }

    $IncludeFactual  = (-not $Type -or $Type -eq 'FactualClaim') -and -not $Stance -and -not $Pov
    $IncludeKeyPoint = (-not $Type -or $Type -eq 'KeyPoint') -and -not $DocPosition -and -not $TemporalScope

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        }
        catch {
            Write-Warning "Failed to parse $($File.Name): $_"
            continue
        }

        $SummaryDocId = $Summary.doc_id
        if ($DocId -and $SummaryDocId -notlike $DocId) { continue }

        # ── Factual Claims ──────────────────────────────────────────
        if ($IncludeFactual -and $Summary.PSObject.Properties['factual_claims']) {
            foreach ($fc in @($Summary.factual_claims)) {
                $fcConf = if ($fc.PSObject.Properties['extraction_confidence']) { $fc.extraction_confidence } else { 0.0 }
                if ($MinConfidence -and $fcConf -lt $MinConfidence) { continue }
                if ($DocPosition -and $fc.PSObject.Properties['doc_position'] -and $fc.doc_position -ne $DocPosition) { continue }
                if ($DocPosition -and -not $fc.PSObject.Properties['doc_position']) { continue }
                if ($TemporalScope -and $fc.PSObject.Properties['temporal_scope'] -and $fc.temporal_scope -ne $TemporalScope) { continue }
                if ($TemporalScope -and -not $fc.PSObject.Properties['temporal_scope']) { continue }

                $nodes = @()
                if ($fc.PSObject.Properties['linked_taxonomy_nodes']) {
                    $nodes = @($fc.linked_taxonomy_nodes)
                }
                if ($TaxonomyNode) {
                    $matched = $false
                    foreach ($n in $nodes) { if ($n -like $TaxonomyNode) { $matched = $true; break } }
                    if (-not $matched) { continue }
                }

                $specificity = $null
                $hasWarrant = $false
                $evidenceLevel = $null
                if ($fc.PSObject.Properties['evidence_criteria']) {
                    $ec = $fc.evidence_criteria
                    if ($ec.PSObject.Properties['specificity'])    { $specificity = $ec.specificity }
                    if ($ec.PSObject.Properties['has_warrant'])     { $hasWarrant = $ec.has_warrant }
                    if ($ec.PSObject.Properties['category_criteria']) {
                        $cc = $ec.category_criteria
                        if ($cc.PSObject.Properties['evidence_level']) { $evidenceLevel = $cc.evidence_level }
                    }
                }

                $claim = [AITClaim]::new()
                $claim.DocId          = $SummaryDocId
                $claim.Type           = 'FactualClaim'
                $claim.Text           = $fc.claim
                $claim.Label          = if ($fc.PSObject.Properties['claim_label']) { $fc.claim_label } else { $null }
                $claim.Confidence     = $fcConf
                $claim.LinkedNodes    = $nodes
                $claim.DocPosition    = if ($fc.PSObject.Properties['doc_position']) { $fc.doc_position } else { $null }
                $claim.TemporalScope  = if ($fc.PSObject.Properties['temporal_scope']) { $fc.temporal_scope } else { $null }
                $claim.TemporalBound  = if ($fc.PSObject.Properties['temporal_bound']) { $fc.temporal_bound } else { $null }
                $claim.FireConfidence = if ($fc.PSObject.Properties['fire_confidence']) { $fc.fire_confidence } else { 0.0 }
                $claim.Specificity    = $specificity
                $claim.HasWarrant     = $hasWarrant
                $claim.EvidenceLevel  = $evidenceLevel
                $claim | Write-Output
            }
        }

        # ── Key Points ──────────────────────────────────────────────
        if ($IncludeKeyPoint -and $Summary.PSObject.Properties['pov_summaries']) {
            $PovNames = @('accelerationist', 'safetyist', 'skeptic')
            foreach ($PovName in $PovNames) {
                if ($Pov -and $PovName -ne $Pov) { continue }

                if (-not $Summary.pov_summaries.PSObject.Properties[$PovName]) { continue }
                $PovData = $Summary.pov_summaries.$PovName
                if (-not $PovData.PSObject.Properties['key_points']) { continue }

                foreach ($kp in @($PovData.key_points)) {
                    $kpConf = if ($kp.PSObject.Properties['extraction_confidence']) { $kp.extraction_confidence } else { 0.0 }
                    if ($MinConfidence -and $kpConf -lt $MinConfidence) { continue }
                    if ($Stance -and $kp.PSObject.Properties['stance'] -and $kp.stance -ne $Stance) { continue }
                    if ($Stance -and -not $kp.PSObject.Properties['stance']) { continue }

                    $nodeId = if ($kp.PSObject.Properties['taxonomy_node_id']) { $kp.taxonomy_node_id } else { $null }
                    if ($TaxonomyNode -and (-not $nodeId -or $nodeId -notlike $TaxonomyNode)) { continue }

                    $claim = [AITClaim]::new()
                    $claim.DocId        = $SummaryDocId
                    $claim.Type         = 'KeyPoint'
                    $claim.Text         = $kp.point
                    $claim.POV          = $PovName
                    $claim.Category     = if ($kp.PSObject.Properties['category']) { $kp.category } else { $null }
                    $claim.Stance       = if ($kp.PSObject.Properties['stance']) { $kp.stance } else { $null }
                    $claim.Confidence   = $kpConf
                    $claim.LinkedNodes  = if ($nodeId) { @($nodeId) } else { @() }
                    if ($kp.PSObject.Properties['verbatim'] -and $null -ne $kp.verbatim) {
                        if ($kp.verbatim -is [array]) {
                            $claim.Verbatim = ($kp.verbatim -join ' [...] ')
                        } else {
                            $claim.Verbatim = $kp.verbatim
                        }
                    }
                    $claim | Write-Output
                }
            }
        }
    }
}
