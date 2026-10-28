# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Merges chunk-level POV summaries into a single consolidated summary.
.DESCRIPTION
    When a large document is processed via the chunked pipeline in
    Invoke-DocumentSummary, each chunk produces an independent summary object.
    This function combines them into one unified summary by:

    1. Merging key_points per POV camp, deduplicating by taxonomy_node_id +
       first 80 characters of the point text (case-insensitive).
    2. Merging factual_claims, deduplicating by claim_label (or first 60 chars
       of claim text as fallback).
    3. Merging unmapped_concepts, deduplicating by suggested_label.

    The merged result has the same schema as a single-call summary and can be
    passed directly to Finalize-Summary.
.PARAMETER ChunkResults
    Array of PSObjects — each is a parsed summary from one document chunk.
    Must have pov_summaries, factual_claims, and unmapped_concepts properties.
.EXAMPLE
    $Merged = Merge-ChunkSummaries -ChunkResults @($Chunk1, $Chunk2, $Chunk3)

    Merges three chunk summaries into one, deduplicating overlapping points.
#>
function Merge-ChunkSummaries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$ChunkResults,
        [double]$SimilarityThreshold = 0.85
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Safe property access ───────────────────────────────────────────────
    # Chunk summaries come from AI-generated (and sometimes repair-salvaged)
    # JSON, so their shape is not guaranteed — a truncated chunk may yield a
    # pov_summaries camp object with no 'key_points', a claim with no 'claim',
    # etc. Under StrictMode, touching a missing property throws and kills the
    # whole document merge. Get-SummaryProp (Get-SummaryProp.ps1) returns $null
    # instead so a single malformed chunk degrades gracefully rather than
    # aborting the run. The density checker (Test-SummaryDensity) reads the
    # merged structure through the SAME accessor and camp constant, so the two
    # can never disagree about the pov_summaries → camp → key_points path — the
    # divergence that produced the t/1646 false-positive density warning.

    $Camps = $script:AITriadPovCamps

    # ── Cosine similarity between two vectors ───────────────────────────────
    $GetCosineSimilarity = {
        param([double[]]$A, [double[]]$B)
        if ($A.Count -ne $B.Count -or $A.Count -eq 0) { return 0.0 }
        $Dot = 0.0; $NA = 0.0; $NB = 0.0
        for ($i = 0; $i -lt $A.Count; $i++) {
            $Dot += $A[$i] * $B[$i]; $NA += $A[$i] * $A[$i]; $NB += $B[$i] * $B[$i]
        }
        $Denom = [Math]::Sqrt($NA) * [Math]::Sqrt($NB)
        if ($Denom -gt 0) { return $Dot / $Denom } else { return 0.0 }
    }

    # ── Pre-dedup counts (for context-rot metrics) + collect point texts ─────
    # All key_point texts are embedded in ONE batch subprocess below (model loads
    # once) rather than spawning a cold `encode -` process per point — the latter
    # cost ~6s × N points. Uses local all-MiniLM-L6-v2 (no API key needed).
    $PreDedupPoints = 0; $PreDedupClaims = 0; $PreDedupConcepts = 0
    $AllPointTexts = [System.Collections.Generic.List[string]]::new()
    foreach ($Chunk in $ChunkResults) {
        $PovSummaries = Get-SummaryProp $Chunk 'pov_summaries'
        foreach ($c in $Camps) {
            $CampPoints = Get-SummaryProp (Get-SummaryProp $PovSummaries $c) 'key_points'
            if ($CampPoints) {
                $PreDedupPoints += @($CampPoints).Count
                foreach ($kp in $CampPoints) {
                    $P = Get-SummaryProp $kp 'point'
                    if (-not [string]::IsNullOrWhiteSpace($P)) { $AllPointTexts.Add($P) }
                }
            }
        }
        $ChunkClaims = Get-SummaryProp $Chunk 'factual_claims'
        if ($ChunkClaims) { $PreDedupClaims += @($ChunkClaims).Count }
        $ChunkConcepts = Get-SummaryProp $Chunk 'unmapped_concepts'
        if ($ChunkConcepts) { $PreDedupConcepts += @($ChunkConcepts).Count }
    }

    # One batch subprocess: text → vector for every point. Empty map ⇒ model
    # unavailable ⇒ fall back to string-prefix dedup.
    $PointEmbeddings = Invoke-BatchEmbeddings -Texts $AllPointTexts.ToArray()
    $UseEmbeddings = $PointEmbeddings.Count -gt 0
    if ($UseEmbeddings) {
        Write-Verbose "Merge-ChunkSummaries: batch-embedded $($PointEmbeddings.Count) points; using embedding dedup (cosine > 0.85)"
    }
    else {
        Write-Verbose 'Merge-ChunkSummaries: falling back to string-prefix dedup (local model unavailable)'
    }

    # ── Merge key_points per camp ────────────────────────────────────────────
    $MergedPovSummaries = [ordered]@{}

    foreach ($Camp in $Camps) {
        $AllPoints = [System.Collections.Generic.List[object]]::new()
        $SeenKeys  = [System.Collections.Generic.HashSet[string]]::new()
        $PointVectors = [System.Collections.Generic.List[object]]::new()  # {point, vector}

        foreach ($Chunk in $ChunkResults) {
            $CampPoints = Get-SummaryProp (Get-SummaryProp $Chunk 'pov_summaries') $Camp
            $CampPoints = Get-SummaryProp $CampPoints 'key_points'
            if (-not $CampPoints) { continue }

            foreach ($kp in $CampPoints) {
                $IsDuplicate = $false
                $KpPoint = Get-SummaryProp $kp 'point'

                if ($UseEmbeddings -and $KpPoint -and $PointEmbeddings.ContainsKey($KpPoint)) {
                    # Embedding-based dedup: compare against all accepted points
                    $Vec = $PointEmbeddings[$KpPoint]
                    if ($Vec) {
                        foreach ($Existing in $PointVectors) {
                            $Sim = & $GetCosineSimilarity $Vec $Existing.Vector
                            if ($Sim -gt $SimilarityThreshold) {
                                # Keep the longer version
                                if ($KpPoint.Length -gt $Existing.Text.Length) {
                                    $Idx = $AllPoints.IndexOf($Existing.Point)
                                    if ($Idx -ge 0) { $AllPoints[$Idx] = $kp; $Existing.Point = $kp; $Existing.Vector = $Vec; $Existing.Text = $KpPoint }
                                }
                                $IsDuplicate = $true
                                break
                            }
                        }
                        if (-not $IsDuplicate) {
                            $AllPoints.Add($kp)
                            $PointVectors.Add(@{ Point = $kp; Vector = $Vec; Text = $KpPoint })
                        }
                        continue
                    }
                }

                # Fallback: string-prefix dedup
                if (-not $IsDuplicate) {
                    if ($KpPoint) { $PointText = $KpPoint } else { $PointText = '' }
                    if ($PointText.Length -gt 80) { $PointPrefix = $PointText.Substring(0, 80) } else { $PointPrefix = $PointText }
                    $DedupKey = "$(Get-SummaryProp $kp 'taxonomy_node_id')|$($PointPrefix.ToLowerInvariant().Trim())"

                    if ($SeenKeys.Add($DedupKey)) {
                        $AllPoints.Add($kp)
                    }
                }
            }
        }

        $MergedPovSummaries[$Camp] = [ordered]@{
            key_points = @($AllPoints)
        }
    }

    # ── Merge factual_claims ─────────────────────────────────────────────────
    $AllClaims = [System.Collections.Generic.List[object]]::new()
    $SeenClaimLabels = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($Chunk in $ChunkResults) {
        $ChunkClaims = Get-SummaryProp $Chunk 'factual_claims'
        if (-not $ChunkClaims) { continue }

        foreach ($Claim in $ChunkClaims) {
            $ClaimLabel = Get-SummaryProp $Claim 'claim_label'
            # Dedup on claim_label (lowercased)
            if ($ClaimLabel) {
                $ClaimKey = $ClaimLabel.ToLowerInvariant().Trim()
            } else {
                # Fallback: first 60 chars of claim text
                $ClaimRaw = Get-SummaryProp $Claim 'claim'
                if (-not $ClaimRaw) { $ClaimRaw = '' }
                if ($ClaimRaw.Length -gt 60) { $ClaimText = $ClaimRaw.Substring(0, 60) } else { $ClaimText = $ClaimRaw }
                $ClaimKey = $ClaimText.ToLowerInvariant().Trim()
            }

            if ($SeenClaimLabels.Add($ClaimKey)) {
                $AllClaims.Add($Claim)
            }
        }
    }

    # ── Merge unmapped_concepts ──────────────────────────────────────────────
    $AllUnmapped = [System.Collections.Generic.List[object]]::new()
    $SeenLabels  = [System.Collections.Generic.HashSet[string]]::new()

    $NullConceptsDropped = 0
    foreach ($Chunk in $ChunkResults) {
        $ChunkConcepts = Get-SummaryProp $Chunk 'unmapped_concepts'
        if (-not $ChunkConcepts) { continue }

        foreach ($Concept in $ChunkConcepts) {
            if ($null -eq $Concept) {
                # t/3907: a chunk's unmapped_concepts can contain a bare null
                # (model/serialization artifact). Carrying it through produces
                # unmapped_concepts: [null], which later throws under
                # StrictMode wherever a reader touches .PSObject.Properties.
                $NullConceptsDropped++
                continue
            }
            $SuggestedLabel = Get-SummaryProp $Concept 'suggested_label'
            if ($SuggestedLabel) {
                $LabelKey = $SuggestedLabel.ToLowerInvariant().Trim()
            } else {
                $LabelKey = "unknown-$($AllUnmapped.Count)"
            }

            if ($SeenLabels.Add($LabelKey)) {
                $AllUnmapped.Add($Concept)
            }
        }
    }
    if ($NullConceptsDropped -gt 0) {
        Write-Warning "Merge-ChunkSummaries: dropped $NullConceptsDropped null unmapped_concepts entry/entries during merge (t/3907)"
    }

    # ── Merge empty_cells (t/4473/t/4519/t/4601) ─────────────────────────────
    # A cell is empty for the document if ANY chunk declared it empty AND the
    # merged key_points for that camp have no point in that category. Unanimity
    # was too strict (t/4601): one chunk that simply doesn't address a camp
    # (silent, not an explicit non-empty claim) used to erase another chunk's
    # genuine empty-declaration for the whole doc. A silent chunk is not
    # evidence the camp is non-empty -- it just didn't cover it. Keep the
    # first declaring chunk's reason. WARN when chunks disagree (some declare
    # empty, some stay silent) so the rate stays visible.
    $MergedEmptyCells = [System.Collections.Generic.List[object]]::new()
    $Categories = $script:AITriadPovCategories
    $DisagreementCount = 0
    foreach ($Camp in $Camps) {
        $CampKeyPoints = @($MergedPovSummaries[$Camp].key_points)
        foreach ($Cat in $Categories) {
            $HasPointInCat = $false
            foreach ($kp in $CampKeyPoints) {
                if ((Get-SummaryProp $kp 'category') -eq $Cat) { $HasPointInCat = $true; break }
            }
            if ($HasPointInCat) { continue }

            $AnyChunkDeclaredEmpty = $false
            $AnyChunkSilent = $false
            $FirstReason = $null
            foreach ($Chunk in $ChunkResults) {
                $ChunkEmptyCells = Get-SummaryProp $Chunk 'empty_cells'
                $Declared = $false
                if ($ChunkEmptyCells) {
                    foreach ($ec in @($ChunkEmptyCells)) {
                        if ((Get-SummaryProp $ec 'camp') -eq $Camp -and (Get-SummaryProp $ec 'category') -eq $Cat) {
                            $Declared = $true
                            if ($null -eq $FirstReason) { $FirstReason = Get-SummaryProp $ec 'reason' }
                            break
                        }
                    }
                }
                if ($Declared) { $AnyChunkDeclaredEmpty = $true } else { $AnyChunkSilent = $true }
            }
            if ($AnyChunkDeclaredEmpty -and $AnyChunkSilent) { $DisagreementCount++ }
            if ($AnyChunkDeclaredEmpty) {
                $MergedEmptyCells.Add([ordered]@{ camp = $Camp; category = $Cat; reason = $FirstReason })
            }
        }
    }
    if ($DisagreementCount -gt 0) {
        Write-Warning "Merge-ChunkSummaries: $DisagreementCount camp/category cell(s) had chunks disagree on emptiness (some declared empty, some silent) -- kept as empty per the any-chunk rule (t/4601)"
    }

    # ── Context-rot: merge/dedup metrics ─────────────────────────────────────
    $PostDedupPoints = 0
    foreach ($c in $Camps) {
        $kp = if ($MergedPovSummaries[$c].Contains('key_points')) { $MergedPovSummaries[$c].key_points } else { @() }
        $PostDedupPoints += @($kp).Count
    }
    $PostDedupClaims = $AllClaims.Count
    $PostDedupConcepts = $AllUnmapped.Count
    $TotalIn = $PreDedupPoints + $PreDedupClaims + $PreDedupConcepts
    $TotalOut = $PostDedupPoints + $PostDedupClaims + $PostDedupConcepts
    $MergeMetrics = New-ContextRotStage `
        -Stage 'merge_dedup' -InUnits 'items' -InCount $TotalIn `
        -OutUnits 'items' -OutCount $TotalOut `
        -Flags @{
            points_deduped   = $PreDedupPoints - $PostDedupPoints
            claims_deduped   = $PreDedupClaims - $PostDedupClaims
            concepts_deduped = $PreDedupConcepts - $PostDedupConcepts
            used_embeddings  = [int]$UseEmbeddings
        }

    # ── Return merged structure ──────────────────────────────────────────────
    return [ordered]@{
        pov_summaries    = $MergedPovSummaries
        factual_claims   = @($AllClaims)
        unmapped_concepts = @($AllUnmapped)
        empty_cells      = @($MergedEmptyCells)
        _merge_metrics   = $MergeMetrics
    }
}
