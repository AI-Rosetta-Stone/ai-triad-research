# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Merges chunk-level POV summaries into a single consolidated summary.
.DESCRIPTION
    When a large document is processed via the chunked pipeline in
    Invoke-DocumentSummary, each chunk produces an independent summary object.
    This function combines them into one unified summary by:

    1. Merging key_points per POV camp: semantic clustering within one
       (camp, BDI category) cell, on the `canonical_proposition` embedding
       (fallback `point`, with a WARN), cosine > $SimilarityThreshold
       (0.90, t/4472 CL calibration — see metric-provenance-register.md).
       A cluster's primary is its longest `point`; the other members' own
       evidence (point/canonical_proposition/verbatim/excerpt_context/
       taxonomy_node_id) is folded into an `evidence_spans` array ON the
       primary, never discarded. `anchors` fold veto: two members whose
       `anchors` are both non-empty and disjoint never cluster together
       (treated as genuinely different claims); when they do fold, their
       anchors are unioned onto the primary.
    2. Merging factual_claims: semantic clustering GLOBALLY (not per camp),
       on the `claim` embedding, with a numeric-token subset guard — cosine
       ≥ 0.90 only folds when one side's numeric tokens are a superset of
       the other's (the superset side becomes primary); ≥ 0.95 is required
       when neither side has numbers; cosine alone never folds (t/4472,
       templated survey-statistic false positives). Other members' own
       claim/claim_label/doc_position fold into `evidence_spans` on the
       primary.
    3. Merging unmapped_concepts, deduplicating by suggested_label.

    The merged result has the same schema as a single-call summary (plus the
    additive `evidence_spans` field — t/4482 exemption model: no consumer
    branches on it yet, the exemption lapses the moment one does) and can be
    passed directly to Finalize-Summary.

    If the local embedding model is unavailable, this falls all the way back
    to first-occurrence string-prefix/claim_label dedup (the pre-t/4472
    behavior) — no clustering, no evidence_spans, loud WARN. Semantic
    clustering needs the model; there's no safe halfway point.
.PARAMETER ChunkResults
    Array of PSObjects — each is a parsed summary from one document chunk.
    Must have pov_summaries, factual_claims, and unmapped_concepts properties.
.PARAMETER SimilarityThreshold
    Cosine threshold for key_point clustering. Default 0.90 (t/4472,
    human-validated — the originally stipulated 0.85 was rejected: P 16/30
    with no paraphrase pairs in the 0.85-0.90 band). Factual_claims use a
    fixed internal 0.90/0.95 pair (see DESCRIPTION) regardless of this
    parameter, since that rule is guard-gated, not a single cosine cutoff.
.EXAMPLE
    $Merged = Merge-ChunkSummaries -ChunkResults @($Chunk1, $Chunk2, $Chunk3)

    Merges three chunk summaries into one, clustering overlapping points and
    claims and folding their evidence rather than discarding it.
#>
function Merge-ChunkSummaries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$ChunkResults,
        [double]$SimilarityThreshold = 0.90
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
    $Categories = $script:AITriadPovCategories
    $FactualFoldThreshold = 0.90
    $FactualNoNumberThreshold = 0.95

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

    # ── anchors helpers (t/4472 fold veto) ───────────────────────────────────
    # 'anchors' is forensic/additive (t/4482) -- no corpus key_point carries it
    # yet (CL, metric-provenance-register.md), so these are defensive/forward-
    # compatible, not exercised by today's real data.
    $GetAnchorSet = {
        param($Obj)
        $A = Get-SummaryProp $Obj 'anchors'
        if (-not $A) { return @() }
        @($A | ForEach-Object { [string]$_ } | Where-Object { $_ })
    }
    $AnchorsAreDisjoint = {
        param([string[]]$A, [string[]]$B)
        if ($A.Count -eq 0 -or $B.Count -eq 0) { return $false }
        $SetB = [System.Collections.Generic.HashSet[string]]::new([string[]]$B, [System.StringComparer]::Ordinal)
        -not ($A | Where-Object { $SetB.Contains($_) })
    }

    # ── numeric-token helpers (t/4472 factual_claims guard) ──────────────────
    # Templated survey statistics ("Asian adults (57%)... " vs "(36%)...") score
    # >= 0.95 cosine despite stating different facts -- cosine alone is never
    # trusted for factual_claims (CL, 140-pair calibration). A numeric token is
    # any run of digits, optionally with a decimal point or trailing '%'.
    $NumericTokenPattern = [regex]'\d+(?:\.\d+)?%?'
    $GetNumericTokens = {
        param([string]$Text)
        if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
        @($NumericTokenPattern.Matches($Text) | ForEach-Object { $_.Value })
    }
    # True iff $A's numeric tokens are a (non-strict) superset of $B's.
    $IsNumericSuperset = {
        param([string[]]$A, [string[]]$B)
        if ($B.Count -eq 0) { return $true }
        $SetA = [System.Collections.Generic.HashSet[string]]::new([string[]]$A, [System.StringComparer]::Ordinal)
        -not ($B | Where-Object { -not $SetA.Contains($_) })
    }

    # Builds an ordered-hashtable copy of $Primary with $Overrides applied —
    # safe to add a new key (evidence_spans) or replace one (anchors)
    # regardless of whether $Primary is a PSCustomObject (from ConvertFrom-Json)
    # or already a hashtable, without touching the original caller's object.
    $CloneWithOverrides = {
        param($Primary, [hashtable]$Overrides)
        $Out = [ordered]@{}
        if ($Primary -is [System.Collections.IDictionary]) {
            foreach ($k in $Primary.Keys) { $Out[$k] = $Primary[$k] }
        } else {
            foreach ($p in $Primary.PSObject.Properties) { $Out[$p.Name] = $p.Value }
        }
        foreach ($k in $Overrides.Keys) { $Out[$k] = $Overrides[$k] }
        $Out
    }

    # ── Pre-dedup counts (for context-rot metrics) + collect texts for ONE ──
    # batch embed call (key_point canonical_proposition/point AND factual_claim
    # claim text together) — model loads once rather than per-item. Uses local
    # all-MiniLM-L6-v2 (no API key needed).
    $PreDedupPoints = 0; $PreDedupClaims = 0; $PreDedupConcepts = 0
    $AllEmbedTexts = [System.Collections.Generic.List[string]]::new()
    $PointFallbackWarned = $false
    foreach ($Chunk in $ChunkResults) {
        $PovSummaries = Get-SummaryProp $Chunk 'pov_summaries'
        foreach ($c in $Camps) {
            $CampPoints = Get-SummaryProp (Get-SummaryProp $PovSummaries $c) 'key_points'
            if ($CampPoints) {
                $PreDedupPoints += @($CampPoints).Count
                foreach ($kp in $CampPoints) {
                    $Cp = Get-SummaryProp $kp 'canonical_proposition'
                    if ([string]::IsNullOrWhiteSpace($Cp)) {
                        $Cp = Get-SummaryProp $kp 'point'
                        if (-not [string]::IsNullOrWhiteSpace($Cp) -and -not $PointFallbackWarned) {
                            Write-Warning "Merge-ChunkSummaries: at least one key_point has no canonical_proposition; falling back to 'point' text for clustering (t/4472)"
                            $PointFallbackWarned = $true
                        }
                    }
                    if (-not [string]::IsNullOrWhiteSpace($Cp)) { $AllEmbedTexts.Add($Cp) }
                }
            }
        }
        $ChunkClaims = Get-SummaryProp $Chunk 'factual_claims'
        if ($ChunkClaims) {
            $PreDedupClaims += @($ChunkClaims).Count
            foreach ($Claim in $ChunkClaims) {
                $ClaimText = Get-SummaryProp $Claim 'claim'
                if (-not [string]::IsNullOrWhiteSpace($ClaimText)) { $AllEmbedTexts.Add($ClaimText) }
            }
        }
        $ChunkConcepts = Get-SummaryProp $Chunk 'unmapped_concepts'
        if ($ChunkConcepts) { $PreDedupConcepts += @($ChunkConcepts).Count }
    }

    # One batch subprocess: text → vector for every key_point/claim text.
    # Empty map ⇒ model unavailable ⇒ fall back to first-occurrence dedup.
    $Embeddings = Invoke-BatchEmbeddings -Texts $AllEmbedTexts.ToArray()
    $UseEmbeddings = $Embeddings.Count -gt 0
    if ($UseEmbeddings) {
        Write-Verbose "Merge-ChunkSummaries: batch-embedded $($Embeddings.Count) text(s); clustering key_points (cosine > $SimilarityThreshold within camp+category) and factual_claims (cosine >= $FactualFoldThreshold + numeric guard, or >= $FactualNoNumberThreshold with no numbers)"
    }
    else {
        Write-Warning 'Merge-ChunkSummaries: local embedding model unavailable; falling back to first-occurrence string-prefix/claim_label dedup -- duplicate evidence spans will be DISCARDED, not folded, for this document (t/4472)'
    }

    # ── Merge key_points per camp, clustering within (camp, category) ───────
    $MergedPovSummaries = [ordered]@{}

    foreach ($Camp in $Camps) {
        # All key_points for this camp, across every chunk, in original order.
        $CampAllPoints = [System.Collections.Generic.List[object]]::new()
        foreach ($Chunk in $ChunkResults) {
            $CampPoints = Get-SummaryProp (Get-SummaryProp $Chunk 'pov_summaries') $Camp
            $CampPoints = Get-SummaryProp $CampPoints 'key_points'
            if ($CampPoints) { foreach ($kp in $CampPoints) { $CampAllPoints.Add($kp) } }
        }

        $FinalPoints = [System.Collections.Generic.List[object]]::new()

        if (-not $UseEmbeddings) {
            # Pre-t/4472 fallback: first-occurrence string-prefix dedup, no folding.
            $SeenKeys = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($kp in $CampAllPoints) {
                $KpPoint = Get-SummaryProp $kp 'point'
                if ($KpPoint) { $PointText = $KpPoint } else { $PointText = '' }
                if ($PointText.Length -gt 80) { $PointPrefix = $PointText.Substring(0, 80) } else { $PointPrefix = $PointText }
                $DedupKey = "$(Get-SummaryProp $kp 'taxonomy_node_id')|$($PointPrefix.ToLowerInvariant().Trim())"
                if ($SeenKeys.Add($DedupKey)) { $FinalPoints.Add($kp) }
            }
            $MergedPovSummaries[$Camp] = [ordered]@{ key_points = @($FinalPoints) }
            continue
        }

        # Cluster within each BDI category cell (t/4472: CL calibrated on
        # within-cell pairs; cross-category false positives were not measured).
        # Grouped by the ACTUAL category value present, not just the 3 known
        # categories -- a truncated/malformed chunk's key_point with a missing
        # or unrecognized category must still survive the merge, in its own
        # cell, rather than being silently dropped (t/1186 malformed-chunk
        # resilience contract).
        $CellGroups = [ordered]@{}
        foreach ($kp in $CampAllPoints) {
            $CatKey = [string](Get-SummaryProp $kp 'category')
            if (-not $CellGroups.Contains($CatKey)) { $CellGroups[$CatKey] = [System.Collections.Generic.List[object]]::new() }
            $CellGroups[$CatKey].Add($kp)
        }
        foreach ($CatKey in $CellGroups.Keys) {
            $CellPoints = @($CellGroups[$CatKey])

            # Clusters: list of { Members = List[kp]; Vector = double[] (primary's) }
            $Clusters = [System.Collections.Generic.List[object]]::new()

            foreach ($kp in $CellPoints) {
                $Cp = Get-SummaryProp $kp 'canonical_proposition'
                if ([string]::IsNullOrWhiteSpace($Cp)) { $Cp = Get-SummaryProp $kp 'point' }
                $Vec = $null
                if (-not [string]::IsNullOrWhiteSpace($Cp) -and $Embeddings.ContainsKey($Cp)) { $Vec = $Embeddings[$Cp] }

                $MatchedCluster = $null
                if ($Vec) {
                    $KpAnchors = @(& $GetAnchorSet $kp)
                    foreach ($Cl in $Clusters) {
                        if (-not $Cl.Vector) { continue }  # founding member had no embeddable text
                        $Sim = & $GetCosineSimilarity $Vec $Cl.Vector
                        if ($Sim -le $SimilarityThreshold) { continue }
                        $PrimaryAnchors = @(& $GetAnchorSet $Cl.Members[0])
                        if (& $AnchorsAreDisjoint $KpAnchors $PrimaryAnchors) { continue }  # t/4472 veto
                        $MatchedCluster = $Cl
                        break
                    }
                }

                if ($MatchedCluster) {
                    $MatchedCluster.Members.Add($kp)
                } else {
                    $Clusters.Add([pscustomobject]@{ Members = [System.Collections.Generic.List[object]]::new(@($kp)); Vector = $Vec })
                }
            }

            foreach ($Cl in $Clusters) {
                $Members = $Cl.Members
                if ($Members.Count -eq 1) { $FinalPoints.Add($Members[0]); continue }

                # Primary = longest 'point' text (representativeness proxy, t/4472).
                # Tracked by INDEX, not object identity -- PSCustomObjects from
                # ConvertFrom-Json have no custom Equals, so '-eq' would fall back
                # to reference equality by luck, not by design.
                $PrimaryIdx = 0
                $PrimaryLen = [string](Get-SummaryProp $Members[0] 'point')
                for ($i = 1; $i -lt $Members.Count; $i++) {
                    $Text = [string](Get-SummaryProp $Members[$i] 'point')
                    if ($Text.Length -gt $PrimaryLen.Length) { $PrimaryIdx = $i; $PrimaryLen = $Text }
                }
                $Primary = $Members[$PrimaryIdx]

                $EvidenceSpans = [System.Collections.Generic.List[object]]::new()
                $AnchorUnion = [System.Collections.Generic.List[string]]::new()
                foreach ($a in (& $GetAnchorSet $Primary)) { $AnchorUnion.Add($a) }
                for ($i = 0; $i -lt $Members.Count; $i++) {
                    if ($i -eq $PrimaryIdx) { continue }
                    $m = $Members[$i]
                    $Span = [ordered]@{}
                    foreach ($Field in 'point', 'canonical_proposition', 'verbatim', 'excerpt_context', 'taxonomy_node_id') {
                        $V = Get-SummaryProp $m $Field
                        if ($null -ne $V) { $Span[$Field] = $V }
                    }
                    $EvidenceSpans.Add($Span)
                    foreach ($a in (& $GetAnchorSet $m)) { if (-not $AnchorUnion.Contains($a)) { $AnchorUnion.Add($a) } }
                }

                $Overrides = @{ evidence_spans = @($EvidenceSpans) }
                if ($AnchorUnion.Count -gt 0) { $Overrides['anchors'] = @($AnchorUnion) }
                $FinalPoints.Add((& $CloneWithOverrides $Primary $Overrides))
            }
        }

        $MergedPovSummaries[$Camp] = [ordered]@{ key_points = @($FinalPoints) }
    }

    # ── Merge factual_claims, clustering globally ────────────────────────────
    $AllClaimsRaw = [System.Collections.Generic.List[object]]::new()
    foreach ($Chunk in $ChunkResults) {
        $ChunkClaims = Get-SummaryProp $Chunk 'factual_claims'
        if ($ChunkClaims) { foreach ($Claim in $ChunkClaims) { $AllClaimsRaw.Add($Claim) } }
    }

    $AllClaims = [System.Collections.Generic.List[object]]::new()

    if (-not $UseEmbeddings) {
        # Pre-t/4472 fallback: first-occurrence claim_label dedup, no folding.
        $SeenClaimLabels = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($Claim in $AllClaimsRaw) {
            $ClaimLabel = Get-SummaryProp $Claim 'claim_label'
            if ($ClaimLabel) {
                $ClaimKey = $ClaimLabel.ToLowerInvariant().Trim()
            } else {
                $ClaimRaw = Get-SummaryProp $Claim 'claim'
                if (-not $ClaimRaw) { $ClaimRaw = '' }
                if ($ClaimRaw.Length -gt 60) { $ClaimText = $ClaimRaw.Substring(0, 60) } else { $ClaimText = $ClaimRaw }
                $ClaimKey = $ClaimText.ToLowerInvariant().Trim()
            }
            if ($SeenClaimLabels.Add($ClaimKey)) { $AllClaims.Add($Claim) }
        }
    } else {
        # Clusters: { Members = List[claim]; PrimaryIdx = int (index into Members) }
        $ClaimClusters = [System.Collections.Generic.List[object]]::new()

        foreach ($Claim in $AllClaimsRaw) {
            $ClaimText = Get-SummaryProp $Claim 'claim'
            $Vec = $null
            if (-not [string]::IsNullOrWhiteSpace($ClaimText) -and $Embeddings.ContainsKey($ClaimText)) { $Vec = $Embeddings[$ClaimText] }
            $Tokens = @(& $GetNumericTokens $ClaimText)

            $MatchedCluster = $null
            if ($Vec) {
                foreach ($Cl in $ClaimClusters) {
                    $PrimaryClaim = $Cl.Members[$Cl.PrimaryIdx]
                    $PrimaryText = Get-SummaryProp $PrimaryClaim 'claim'
                    $PrimaryVec = $null
                    if (-not [string]::IsNullOrWhiteSpace($PrimaryText) -and $Embeddings.ContainsKey($PrimaryText)) { $PrimaryVec = $Embeddings[$PrimaryText] }
                    if (-not $PrimaryVec) { continue }
                    $Sim = & $GetCosineSimilarity $Vec $PrimaryVec
                    $PrimaryTokens = @(& $GetNumericTokens $PrimaryText)

                    $Fold = $false
                    if ($Tokens.Count -eq 0 -and $PrimaryTokens.Count -eq 0) {
                        $Fold = $Sim -ge $FactualNoNumberThreshold
                    } elseif ($Sim -ge $FactualFoldThreshold) {
                        # Numeric-subset guard (t/4472): never cosine alone.
                        if ((& $IsNumericSuperset $Tokens $PrimaryTokens) -or (& $IsNumericSuperset $PrimaryTokens $Tokens)) {
                            $Fold = $true
                        }
                    }
                    if ($Fold) { $MatchedCluster = $Cl; break }
                }
            }

            if ($MatchedCluster) {
                $MatchedCluster.Members.Add($Claim)
                # Re-pick the primary: whichever member has the most numeric
                # tokens is the superset side (t/4472); ties keep the longer
                # claim text.
                $BestIdx = 0; $BestTokenCount = -1; $BestLen = -1
                for ($i = 0; $i -lt $MatchedCluster.Members.Count; $i++) {
                    $Text = [string](Get-SummaryProp $MatchedCluster.Members[$i] 'claim')
                    $TokenCount = @(& $GetNumericTokens $Text).Count
                    if ($TokenCount -gt $BestTokenCount -or ($TokenCount -eq $BestTokenCount -and $Text.Length -gt $BestLen)) {
                        $BestIdx = $i; $BestTokenCount = $TokenCount; $BestLen = $Text.Length
                    }
                }
                $MatchedCluster.PrimaryIdx = $BestIdx
            } else {
                $ClaimClusters.Add([pscustomobject]@{ Members = [System.Collections.Generic.List[object]]::new(@($Claim)); PrimaryIdx = 0 })
            }
        }

        foreach ($Cl in $ClaimClusters) {
            $Members = $Cl.Members
            if ($Members.Count -eq 1) { $AllClaims.Add($Members[0]); continue }

            $Primary = $Members[$Cl.PrimaryIdx]
            $EvidenceSpans = [System.Collections.Generic.List[object]]::new()
            for ($i = 0; $i -lt $Members.Count; $i++) {
                if ($i -eq $Cl.PrimaryIdx) { continue }
                $m = $Members[$i]
                $Span = [ordered]@{}
                foreach ($Field in 'claim', 'claim_label', 'doc_position') {
                    $V = Get-SummaryProp $m $Field
                    if ($null -ne $V) { $Span[$Field] = $V }
                }
                $EvidenceSpans.Add($Span)
            }
            $AllClaims.Add((& $CloneWithOverrides $Primary @{ evidence_spans = @($EvidenceSpans) }))
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
