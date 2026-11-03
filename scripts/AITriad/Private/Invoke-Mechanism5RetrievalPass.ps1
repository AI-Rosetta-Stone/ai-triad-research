# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-Mechanism5RetrievalPass {
    <#
    .SYNOPSIS
        Per-key_point re-retrieval pass (Mechanism #5, t/2357) — margin-triggered flag + surface.
    .DESCRIPTION
        After Invoke-RetrievalConfidencePass has scored every key_point, this pass identifies
        assignments where a better candidate exists and surfaces per-key_point top-3 POV-filtered
        candidates for the t/2289 override path.

        A key_point is flagged when:
          (top1_score − assigned_score) > MarginThreshold  (default 0.06, calibrated by CL t/2357)

        where top1_score = taxonomy_node_candidates[0].score (per-key_point max, from t/2288 pass)
        and   assigned_score = retrieval_confidence (cosine of assigned node, from t/2288 pass).

        ALL key_points are evaluated — high-confidence misfires are the primary target (real
        misfires typically have good assigned-node confidence but a clearly dominant alternative).
        A conf-gated pre-filter would miss them entirely.

        Query for POV-filtered surfacing: attribution_text (primary) / verbatim (fallback).
        All flagged queries are batch-embedded in one Python subprocess.

        Sets on each flagged key_point:
          mechanism5_flag       = $true
          mechanism5_candidates = top-3 [PSCustomObject]@{id; label; score} filtered to key_point's POV

        Auto-correct is cancelled (no safe band identified; near-synonyms regress). t/2357.
        Degrades gracefully — never throws, never modifies other fields on failure.
    .PARAMETER KeyPointItems
        Array of hashtables @{KeyPoint=<PSObject>; POV='accelerationist'|'safetyist'|'skeptic'}.
    .PARAMETER MarginThreshold
        Surface when top1_score exceeds assigned_score by more than this value.
        Default 0.06 — calibrated from t/2341 adjudication study (CL, t/2357#8).
        Registered: metric-provenance-register keypoint_surfacing_margin (provisional).
    #>
    [CmdletBinding()]
    param(
        [object[]]$KeyPointItems,
        [double]$MarginThreshold = 0.06
    )

    # Guard: embeddings must be loaded (Get-RelevantTaxonomyNodes always runs first)
    if (-not $script:CachedEmbeddings -or $script:CachedEmbeddings.Count -eq 0) {
        Write-Verbose 'Invoke-Mechanism5RetrievalPass: CachedEmbeddings not loaded — skipping'
        return
    }

    # Evaluate ALL key_points for the margin condition (high-conf misfires won't fire on a
    # conf-gated pre-filter). Build query text only for those that exceed the threshold.
    $Flagged = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($Item in $KeyPointItems) {
        $kp  = $Item.KeyPoint
        $Pov = [string]$Item.POV
        if (-not ($kp.PSObject.Properties['taxonomy_node_id'] -and $kp.taxonomy_node_id)) { continue }

        # top1_score from the t/2288 candidates list ([0] is the per-key_point max)
        $Top1Score = $null
        if ($kp.PSObject.Properties['taxonomy_node_candidates'] -and $kp.taxonomy_node_candidates) {
            $Cands = @($kp.taxonomy_node_candidates)
            if ($Cands.Count -gt 0 -and $Cands[0].PSObject.Properties['score']) {
                $Top1Score = [double]$Cands[0].score
            }
        }
        if ($null -eq $Top1Score) { continue }

        # assigned_score = retrieval_confidence (cosine of assigned node, same scoring pass)
        $AssignedScore = $null
        if ($kp.PSObject.Properties['retrieval_confidence'] -and
            $null -ne $kp.retrieval_confidence) {
            $AssignedScore = [double]$kp.retrieval_confidence
        }
        if ($null -eq $AssignedScore) { continue }

        if (($Top1Score - $AssignedScore) -le $MarginThreshold) { continue }

        # Query: attribution_text (primary) / verbatim (fallback) — NOT canonical_proposition
        $QueryText = $null
        if ($kp.PSObject.Properties['attribution_text'] -and
            -not [string]::IsNullOrWhiteSpace($kp.attribution_text)) {
            $QueryText = [string]$kp.attribution_text
        } elseif ($kp.PSObject.Properties['verbatim'] -and
                  -not [string]::IsNullOrWhiteSpace($kp.verbatim)) {
            if ($kp.verbatim -is [array]) { $QueryText = $kp.verbatim -join ' ' }
            else                          { $QueryText = [string]$kp.verbatim }
        }
        if ([string]::IsNullOrWhiteSpace($QueryText)) { continue }

        $Flagged.Add(@{
            KeyPoint = $kp
            POV      = $Pov
            Query    = $QueryText
            EmbedId  = "m5_$($Flagged.Count)"
        })
    }

    if ($Flagged.Count -eq 0) { return }

    Write-Verbose "Mechanism5: $($Flagged.Count) key_point(s) exceed margin $MarginThreshold — surfacing POV candidates"

    # Batch-embed all flagged queries in one subprocess
    $EmbedItems = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($F in $Flagged) {
        $EmbedItems.Add(@{ EmbedId = $F.EmbedId; Text = $F.Query })
    }
    $VectorMap = Invoke-BatchEmbedAttribution -Items $EmbedItems
    if ($null -eq $VectorMap) {
        Write-Verbose 'Mechanism5: batch-encode failed — skipping'
        return
    }

    # t/4478: node-id -> category, for the BDI scoping Get-BdiScopedNodeIds applies below
    # (POV prefix map lives there too, shared with Invoke-RetrievalConfidencePass).
    $CategoryMap = Get-BdiCategoryMap

    # Node label map (guaranteed populated by Assert-TaxonomyCacheFresh earlier)
    $LabelMap = @{}
    if ($script:TaxonomyData -and $script:TaxonomyData.Count -gt 0) {
        foreach ($PovKey in $script:TaxonomyData.Keys) {
            $PovObj = $script:TaxonomyData[$PovKey]
            if (-not $PovObj.PSObject.Properties['nodes']) { continue }
            foreach ($N in @($PovObj.nodes)) {
                if ($N.PSObject.Properties['id'] -and $N.PSObject.Properties['label']) {
                    $LabelMap[[string]$N.id] = [string]$N.label
                }
            }
        }
    }

    # Dimensionality from any cached vector
    $SampleVec = $null
    foreach ($V in $script:CachedEmbeddings.Values) { $SampleVec = [double[]]$V; break }
    if ($null -eq $SampleVec) { return }
    $Dim = $SampleVec.Count

    $SurfacedCount = 0
    foreach ($F in $Flagged) {
        $kp      = $F.KeyPoint
        $EmbedId = $F.EmbedId
        $Pov     = $F.POV

        if (-not $VectorMap.ContainsKey($EmbedId)) { continue }
        $QueryVec = [double[]]$VectorMap[$EmbedId]
        if ($QueryVec.Count -ne $Dim) { continue }

        # Query L2 norm
        $QNormSq = 0.0
        for ($i = 0; $i -lt $Dim; $i++) { $QNormSq += $QueryVec[$i] * $QueryVec[$i] }
        $QNorm = [Math]::Sqrt($QNormSq)
        if ($QNorm -eq 0) { continue }

        # Score nodes filtered to this key_point's POV and (t/4478) BDI category, WARN-fallback to
        # POV-only when the key_point's category isn't a valid B/D/I value.
        $AllNodeIds = @($script:CachedEmbeddings.Keys | Where-Object { -not ($script:PillarNodeIds -and $script:PillarNodeIds.Contains($_)) })  # t/2369
        $KpCategory = if ($kp.PSObject.Properties['category']) { [string]$kp.category } else { $null }
        $ScopedIds = Get-BdiScopedNodeIds -AllNodeIds $AllNodeIds -Pov $Pov -Category $KpCategory `
            -CategoryMap $CategoryMap -Context "Invoke-Mechanism5RetrievalPass ($($kp.taxonomy_node_id))"
        $Scores = [System.Collections.Generic.List[PSObject]]::new()
        foreach ($NodeId in $ScopedIds) {
            $NodeVec = [double[]]$script:CachedEmbeddings[$NodeId]
            if ($NodeVec.Count -ne $Dim) { continue }

            $Dot = 0.0; $NNormSq = 0.0
            for ($i = 0; $i -lt $Dim; $i++) {
                $Dot     += $QueryVec[$i] * $NodeVec[$i]
                $NNormSq += $NodeVec[$i]  * $NodeVec[$i]
            }
            $D   = $QNorm * [Math]::Sqrt($NNormSq)
            $Sim = if ($D -gt 0.0) { [Math]::Round($Dot / $D, 4) } else { 0.0 }
            $Scores.Add([PSCustomObject]@{ Id = $NodeId; Score = $Sim })
        }

        $Top3 = @($Scores | Sort-Object Score -Descending | Select-Object -First 3 | ForEach-Object {
            $CId = $_.Id; $CScore = $_.Score
            [PSCustomObject]@{
                id    = $CId
                label = if ($LabelMap.ContainsKey($CId)) { $LabelMap[$CId] } else { '' }
                score = $CScore
            }
        })

        Set-KeyPointField $kp 'mechanism5_flag'       $true
        Set-KeyPointField $kp 'mechanism5_candidates' $Top3
        $SurfacedCount++
    }

    if ($SurfacedCount -gt 0) {
        Write-Host "  │  mechanism5: $SurfacedCount key_point(s) flagged + surfaced" -ForegroundColor DarkCyan
    }
}
