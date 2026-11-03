# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deduplicates key_points and factual_claims within a single summary using
    embedding-based cosine similarity.
.DESCRIPTION
    After extraction (single-shot or FIRE), a summary may contain semantically
    duplicate claims — the same idea restated in slightly different words.
    This function:

    1. Embeds all key_point.point texts and all factual_claim.claim texts
       using the local all-MiniLM-L6-v2 model (same as taxonomy embeddings).
    2. Finds pairs above the cosine similarity threshold (default 0.85).
    3. Keeps the higher-confidence version (or longer text as tiebreaker).
    4. Returns the deduplicated summary + metrics.

    Falls back to string-prefix dedup if the local embedding model is
    unavailable (same strategy as Merge-ChunkSummaries).
.PARAMETER SummaryObject
    Parsed summary PSObject with pov_summaries and factual_claims.
.PARAMETER SimilarityThreshold
    Cosine similarity above which two claims are considered duplicates.
    Default: 0.85 (same as Merge-ChunkSummaries).
.OUTPUTS
    [hashtable] with keys:
      Summary  — the deduplicated summary object (mutated in place)
      Metrics  — hashtable of dedup counts per category
#>
function Remove-DuplicateClaims {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][PSObject]$SummaryObject,
        [double]$SimilarityThreshold = 0.85
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $Metrics = @{
        points_before    = 0
        points_after     = 0
        points_removed   = 0
        claims_before    = 0
        claims_after     = 0
        claims_removed   = 0
        used_embeddings  = $false
    }

    # Cosine similarity via the shared Private Get-CosineSimilarity helper (t/1806).

    # ── Get confidence score from a claim/point ──────────────────────────────
    function Get-ClaimConfidence($Item) {
        if ($Item.PSObject.Properties['extraction_confidence'] -and $null -ne $Item.extraction_confidence) {
            return [double]$Item.extraction_confidence
        }
        if ($Item.PSObject.Properties['fire_confidence'] -and $null -ne $Item.fire_confidence) {
            return [double]$Item.fire_confidence
        }
        return 0.5
    }

    # ── Try batch embedding ──────────────────────────────────────────────────
    $AllTexts = [System.Collections.Generic.List[string]]::new()
    $AllIds   = [System.Collections.Generic.List[string]]::new()

    $Camps = @('accelerationist', 'safetyist', 'skeptic')
    $PovSums = Get-SummaryField $SummaryObject 'pov_summaries'
    foreach ($Camp in $Camps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if (-not $CampData -or -not $CampData.PSObject.Properties['key_points'] -or -not $CampData.key_points) { continue }
        $Points = @($CampData.key_points)
        for ($i = 0; $i -lt $Points.Count; $i++) {
            if ($Points[$i].PSObject.Properties['point'] -and $Points[$i].point) {
                $AllTexts.Add($Points[$i].point)
                $AllIds.Add("kp-$Camp-$i")
            }
        }
    }

    if ($SummaryObject.PSObject.Properties['factual_claims'] -and $SummaryObject.factual_claims) {
        $Claims = @($SummaryObject.factual_claims)
        for ($i = 0; $i -lt $Claims.Count; $i++) {
            if ($Claims[$i].claim) {
                $AllTexts.Add($Claims[$i].claim)
                $AllIds.Add("fc-$i")
            }
        }
    }

    # Count items before any dedup
    foreach ($Camp in $Camps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if ($CampData -and $CampData.PSObject.Properties['key_points'] -and $CampData.key_points) {
            $Metrics.points_before += @($CampData.key_points).Count
        }
    }
    if ($SummaryObject.PSObject.Properties['factual_claims'] -and $SummaryObject.factual_claims) {
        $Metrics.claims_before = @($SummaryObject.factual_claims).Count
    }

    # Not enough items to have duplicates
    if ($AllTexts.Count -lt 2) {
        $Metrics.points_after = $Metrics.points_before
        $Metrics.claims_after = $Metrics.claims_before
        return @{ Summary = $SummaryObject; Metrics = $Metrics }
    }

    # Batch-embed all texts at once (one Python call)
    $Embeddings = Get-TextEmbedding -Texts @($AllTexts) -Ids @($AllIds)
    $UseEmbeddings = $null -ne $Embeddings
    $Metrics.used_embeddings = $UseEmbeddings

    if ($UseEmbeddings) {
        Write-Verbose "Remove-DuplicateClaims: using embedding dedup (cosine > $SimilarityThreshold) on $($AllTexts.Count) items"
    } else {
        Write-Verbose 'Remove-DuplicateClaims: falling back to string-prefix dedup (local model unavailable)'
    }

    # ── Dedup key_points per camp ────────────────────────────────────────────
    foreach ($Camp in $Camps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if (-not $CampData -or -not $CampData.PSObject.Properties['key_points'] -or -not $CampData.key_points) { continue }
        $Points = @($CampData.key_points)

        if ($Points.Count -lt 2) {
            $Metrics.points_after += $Points.Count
            continue
        }

        $Kept = [System.Collections.Generic.List[object]]::new()
        $KeptVectors = [System.Collections.Generic.List[object]]::new()
        $SeenPrefixes = [System.Collections.Generic.HashSet[string]]::new()

        for ($i = 0; $i -lt $Points.Count; $i++) {
            $kp = $Points[$i]
            $IsDuplicate = $false

            if ($UseEmbeddings) {
                $EmbId = "kp-$Camp-$i"
                $Vec = if ($Embeddings.ContainsKey($EmbId)) { $Embeddings[$EmbId] } else { $null }
                if ($Vec) {
                    for ($j = 0; $j -lt $KeptVectors.Count; $j++) {
                        $Sim = Get-CosineSimilarity $Vec $KeptVectors[$j].Vector
                        if ($Sim -gt $SimilarityThreshold) {
                            $Existing = $KeptVectors[$j]
                            $ExistingConf = Get-ClaimConfidence $Existing.Item
                            $NewConf = Get-ClaimConfidence $kp
                            # Replace if new one has higher confidence, or same confidence but longer text
                            if ($NewConf -gt $ExistingConf -or ($NewConf -eq $ExistingConf -and $kp.point.Length -gt $Existing.Item.point.Length)) {
                                $Idx = $Kept.IndexOf($Existing.Item)
                                if ($Idx -ge 0) { $Kept[$Idx] = $kp }
                                $Existing.Item = $kp
                                $Existing.Vector = $Vec
                            }
                            $IsDuplicate = $true
                            break
                        }
                    }
                    if (-not $IsDuplicate) {
                        $Kept.Add($kp)
                        $KeptVectors.Add(@{ Item = $kp; Vector = $Vec })
                    }
                    continue
                }
            }

            # Fallback: string-prefix dedup
            if (-not $IsDuplicate) {
                if ($kp.point.Length -gt 80) { $Prefix = $kp.point.Substring(0, 80) } else { $Prefix = $kp.point }
                $DedupKey = "$($kp.taxonomy_node_id)|$($Prefix.ToLowerInvariant().Trim())"
                if ($SeenPrefixes.Add($DedupKey)) {
                    $Kept.Add($kp)
                } else {
                    $IsDuplicate = $true
                }
            }
        }

        $CampData.key_points = @($Kept)
        $Metrics.points_after += $Kept.Count
    }

    # ── Dedup factual_claims ─────────────────────────────────────────────────
    if ($SummaryObject.PSObject.Properties['factual_claims'] -and $SummaryObject.factual_claims) {
        $Claims = @($SummaryObject.factual_claims)

        if ($Claims.Count -ge 2) {
            $Kept = [System.Collections.Generic.List[object]]::new()
            $KeptVectors = [System.Collections.Generic.List[object]]::new()
            $SeenLabels = [System.Collections.Generic.HashSet[string]]::new()

            for ($i = 0; $i -lt $Claims.Count; $i++) {
                $Claim = $Claims[$i]
                $IsDuplicate = $false

                if ($UseEmbeddings) {
                    $EmbId = "fc-$i"
                    $Vec = if ($Embeddings.ContainsKey($EmbId)) { $Embeddings[$EmbId] } else { $null }
                    if ($Vec) {
                        for ($j = 0; $j -lt $KeptVectors.Count; $j++) {
                            $Sim = Get-CosineSimilarity $Vec $KeptVectors[$j].Vector
                            if ($Sim -gt $SimilarityThreshold) {
                                $Existing = $KeptVectors[$j]
                                $ExistingConf = Get-ClaimConfidence $Existing.Item
                                $NewConf = Get-ClaimConfidence $Claim
                                if ($NewConf -gt $ExistingConf -or ($NewConf -eq $ExistingConf -and $Claim.claim.Length -gt $Existing.Item.claim.Length)) {
                                    $Idx = $Kept.IndexOf($Existing.Item)
                                    if ($Idx -ge 0) { $Kept[$Idx] = $Claim }
                                    $Existing.Item = $Claim
                                    $Existing.Vector = $Vec
                                }
                                $IsDuplicate = $true
                                break
                            }
                        }
                        if (-not $IsDuplicate) {
                            $Kept.Add($Claim)
                            $KeptVectors.Add(@{ Item = $Claim; Vector = $Vec })
                        }
                        continue
                    }
                }

                # Fallback: claim_label dedup
                if (-not $IsDuplicate) {
                    if ($Claim.claim_label) {
                        $LabelKey = $Claim.claim_label.ToLowerInvariant().Trim()
                    } else {
                        if ($Claim.claim.Length -gt 60) { $ClaimText = $Claim.claim.Substring(0, 60) } else { $ClaimText = $Claim.claim }
                        $LabelKey = $ClaimText.ToLowerInvariant().Trim()
                    }
                    if ($SeenLabels.Add($LabelKey)) {
                        $Kept.Add($Claim)
                    }
                }
            }

            $SummaryObject.factual_claims = @($Kept)
            $Metrics.claims_after = $Kept.Count
        } else {
            $Metrics.claims_after = $Claims.Count
        }
    }

    $Metrics.points_removed = $Metrics.points_before - $Metrics.points_after
    $Metrics.claims_removed = $Metrics.claims_before - $Metrics.claims_after

    $TotalRemoved = $Metrics.points_removed + $Metrics.claims_removed
    if ($TotalRemoved -gt 0) {
        Write-Verbose "Remove-DuplicateClaims: removed $($Metrics.points_removed) duplicate key_points, $($Metrics.claims_removed) duplicate factual_claims"
    }

    return @{ Summary = $SummaryObject; Metrics = $Metrics }
}
