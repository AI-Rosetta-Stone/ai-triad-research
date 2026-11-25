# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# ── Fixed factual_claims thresholds + numeric-token pattern (t/4472) ─────────
# Templated survey statistics ("Asian adults (57%)... " vs "(36%)...") score
# >= 0.95 cosine despite stating different facts -- cosine alone is never
# trusted for factual_claims (CL, 140-pair calibration). A numeric token is
# any run of digits, optionally with a decimal point or trailing '%'.
$script:CmFactualFoldThreshold     = 0.90
$script:CmFactualNoNumberThreshold = 0.95
$script:CmNumericTokenPattern      = [regex]'\d+(?:\.\d+)?%?'

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

    Structure note (Refactorer): the merge is decomposed into private `Cm*`
    helpers below (each dot-sourced with this file, none exported). The split
    is purely structural — the observable contract above is unchanged.
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

    # ── Pre-dedup counts (for context-rot metrics) + collect texts for ONE ──
    # batch embed call (key_point canonical_proposition/point AND factual_claim
    # claim text together) — model loads once rather than per-item. Uses local
    # all-MiniLM-L6-v2 (no API key needed).
    $Corpus = Get-CmEmbedCorpus -ChunkResults $ChunkResults -Camps $Camps

    # One batch subprocess: text → vector for every key_point/claim text.
    # Empty map ⇒ model unavailable ⇒ fall back to first-occurrence dedup.
    $Embeddings = Invoke-BatchEmbeddings -Texts $Corpus.EmbedTexts
    $UseEmbeddings = $Embeddings.Count -gt 0
    if ($UseEmbeddings) {
        Write-Verbose "Merge-ChunkSummaries: batch-embedded $($Embeddings.Count) text(s); clustering key_points (cosine > $SimilarityThreshold within camp+category) and factual_claims (cosine >= $($script:CmFactualFoldThreshold) + numeric guard, or >= $($script:CmFactualNoNumberThreshold) with no numbers)"
    }
    else {
        Write-Warning 'Merge-ChunkSummaries: local embedding model unavailable; falling back to first-occurrence string-prefix/claim_label dedup -- duplicate evidence spans will be DISCARDED, not folded, for this document (t/4472)'
    }

    $MergedPovSummaries = Merge-CmKeyPoints -ChunkResults $ChunkResults -Camps $Camps -Embeddings $Embeddings -UseEmbeddings $UseEmbeddings -SimilarityThreshold $SimilarityThreshold
    $AllClaims = Merge-CmFactualClaims -ChunkResults $ChunkResults -Embeddings $Embeddings -UseEmbeddings $UseEmbeddings
    $AllUnmapped = Merge-CmUnmappedConcepts -ChunkResults $ChunkResults
    $MergedEmptyCells = Merge-CmEmptyCells -ChunkResults $ChunkResults -MergedPovSummaries $MergedPovSummaries -Camps $Camps -Categories $Categories

    # ── Context-rot: merge/dedup metrics ─────────────────────────────────────
    $PostDedupPoints = 0
    foreach ($c in $Camps) {
        $kp = if ($MergedPovSummaries[$c].Contains('key_points')) { $MergedPovSummaries[$c].key_points } else { @() }
        $PostDedupPoints += @($kp).Count
    }
    $PostDedupClaims = @($AllClaims).Count
    $PostDedupConcepts = @($AllUnmapped).Count
    $TotalIn = $Corpus.PreDedupPoints + $Corpus.PreDedupClaims + $Corpus.PreDedupConcepts
    $TotalOut = $PostDedupPoints + $PostDedupClaims + $PostDedupConcepts
    $MergeMetrics = New-ContextRotStage `
        -Stage 'merge_dedup' -InUnits 'items' -InCount $TotalIn `
        -OutUnits 'items' -OutCount $TotalOut `
        -Flags @{
            points_deduped   = $Corpus.PreDedupPoints - $PostDedupPoints
            claims_deduped   = $Corpus.PreDedupClaims - $PostDedupClaims
            concepts_deduped = $Corpus.PreDedupConcepts - $PostDedupConcepts
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

# ─────────────────────────────────────────────────────────────────────────────
# Private helpers (Cm = ChunkMerge). Dot-sourced with this file, NOT exported.
# Each is behavior-equivalent to the inline block it replaces.
# ─────────────────────────────────────────────────────────────────────────────

# Cosine similarity between two vectors.
function Get-CmCosineSimilarity {
    param([double[]]$A, [double[]]$B)
    if ($A.Count -ne $B.Count -or $A.Count -eq 0) { return 0.0 }
    $Dot = 0.0; $NA = 0.0; $NB = 0.0
    for ($i = 0; $i -lt $A.Count; $i++) {
        $Dot += $A[$i] * $B[$i]; $NA += $A[$i] * $A[$i]; $NB += $B[$i] * $B[$i]
    }
    $Denom = [Math]::Sqrt($NA) * [Math]::Sqrt($NB)
    if ($Denom -gt 0) { return $Dot / $Denom } else { return 0.0 }
}

# anchors helpers (t/4472 fold veto). 'anchors' is forensic/additive (t/4482) --
# no corpus key_point carries it yet, so these are defensive/forward-compatible.
function Get-CmAnchorSet {
    param($Obj)
    $A = Get-SummaryProp $Obj 'anchors'
    if (-not $A) { return @() }
    @($A | ForEach-Object { [string]$_ } | Where-Object { $_ })
}

function Test-CmAnchorsDisjoint {
    param([string[]]$A, [string[]]$B)
    if ($A.Count -eq 0 -or $B.Count -eq 0) { return $false }
    $SetB = [System.Collections.Generic.HashSet[string]]::new([string[]]$B, [System.StringComparer]::Ordinal)
    -not ($A | Where-Object { $SetB.Contains($_) })
}

# numeric-token helpers (t/4472 factual_claims guard).
function Get-CmNumericTokens {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    @($script:CmNumericTokenPattern.Matches($Text) | ForEach-Object { $_.Value })
}

# True iff $A's numeric tokens are a (non-strict) superset of $B's.
function Test-CmNumericSuperset {
    param([string[]]$A, [string[]]$B)
    if ($B.Count -eq 0) { return $true }
    $SetA = [System.Collections.Generic.HashSet[string]]::new([string[]]$A, [System.StringComparer]::Ordinal)
    -not ($B | Where-Object { -not $SetA.Contains($_) })
}

# Builds an ordered-hashtable copy of $Primary with $Overrides applied — safe to
# add a new key (evidence_spans) or replace one (anchors) regardless of whether
# $Primary is a PSCustomObject or a hashtable, without touching the original.
function Copy-CmWithOverrides {
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

# Resolve the clustering text for a key_point: canonical_proposition, else point.
function Get-CmKeyPointClusterText {
    param($Kp)
    $Cp = Get-SummaryProp $Kp 'canonical_proposition'
    if ([string]::IsNullOrWhiteSpace($Cp)) { $Cp = Get-SummaryProp $Kp 'point' }
    return $Cp
}

# All key_points for one camp across every chunk, in original order.
function Get-CmCampAllPoints {
    param([object[]]$ChunkResults, [string]$Camp)
    $CampAllPoints = [System.Collections.Generic.List[object]]::new()
    foreach ($Chunk in $ChunkResults) {
        $CampPoints = Get-SummaryProp (Get-SummaryProp $Chunk 'pov_summaries') $Camp
        $CampPoints = Get-SummaryProp $CampPoints 'key_points'
        if ($CampPoints) { foreach ($kp in $CampPoints) { $CampAllPoints.Add($kp) } }
    }
    return ,$CampAllPoints
}

# Append each key_point's clustering text to $Texts, WARN once on point fallback.
function Add-CmKeyPointEmbedTexts {
    param($CampPoints, $Texts, [ref]$Warned)
    foreach ($kp in $CampPoints) {
        $Cp = Get-SummaryProp $kp 'canonical_proposition'
        if ([string]::IsNullOrWhiteSpace($Cp)) {
            $Cp = Get-SummaryProp $kp 'point'
            if (-not [string]::IsNullOrWhiteSpace($Cp) -and -not $Warned.Value) {
                Write-Warning "Merge-ChunkSummaries: at least one key_point has no canonical_proposition; falling back to 'point' text for clustering (t/4472)"
                $Warned.Value = $true
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($Cp)) { $Texts.Add($Cp) }
    }
}

# Pre-dedup counts + the batch embed text corpus (key_point + claim text).
function Get-CmEmbedCorpus {
    param([object[]]$ChunkResults, [string[]]$Camps)
    $PreDedupPoints = 0; $PreDedupClaims = 0; $PreDedupConcepts = 0
    $AllEmbedTexts = [System.Collections.Generic.List[string]]::new()
    $PointFallbackWarned = $false
    foreach ($Chunk in $ChunkResults) {
        $PovSummaries = Get-SummaryProp $Chunk 'pov_summaries'
        foreach ($c in $Camps) {
            $CampPoints = Get-SummaryProp (Get-SummaryProp $PovSummaries $c) 'key_points'
            if ($CampPoints) {
                $PreDedupPoints += @($CampPoints).Count
                Add-CmKeyPointEmbedTexts -CampPoints $CampPoints -Texts $AllEmbedTexts -Warned ([ref]$PointFallbackWarned)
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
    return [pscustomobject]@{
        PreDedupPoints   = $PreDedupPoints
        PreDedupClaims   = $PreDedupClaims
        PreDedupConcepts = $PreDedupConcepts
        EmbedTexts       = $AllEmbedTexts.ToArray()
    }
}

# Pre-t/4472 fallback for one camp: first-occurrence string-prefix dedup.
function Get-CmFallbackDedupPoints {
    param($CampAllPoints)
    $FinalPoints = [System.Collections.Generic.List[object]]::new()
    $SeenKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($kp in $CampAllPoints) {
        $KpPoint = Get-SummaryProp $kp 'point'
        if ($KpPoint) { $PointText = $KpPoint } else { $PointText = '' }
        if ($PointText.Length -gt 80) { $PointPrefix = $PointText.Substring(0, 80) } else { $PointPrefix = $PointText }
        $DedupKey = "$(Get-SummaryProp $kp 'taxonomy_node_id')|$($PointPrefix.ToLowerInvariant().Trim())"
        if ($SeenKeys.Add($DedupKey)) { $FinalPoints.Add($kp) }
    }
    return ,$FinalPoints
}

# Group a camp's key_points by their ACTUAL category value (t/1186: unknown /
# missing categories survive in their own cell, never silently dropped).
function Group-CmPointsByCategory {
    param($CampAllPoints)
    $CellGroups = [ordered]@{}
    foreach ($kp in $CampAllPoints) {
        $CatKey = [string](Get-SummaryProp $kp 'category')
        if (-not $CellGroups.Contains($CatKey)) { $CellGroups[$CatKey] = [System.Collections.Generic.List[object]]::new() }
        $CellGroups[$CatKey].Add($kp)
    }
    return $CellGroups
}

# Find the first existing cluster $Kp folds into, or $null. Honors the cosine
# threshold and the anchors disjoint veto (t/4472).
function Find-CmMatchingPointCluster {
    param($Kp, $Vec, $Clusters, [double]$SimilarityThreshold)
    if (-not $Vec) { return $null }
    $KpAnchors = @(Get-CmAnchorSet $Kp)
    foreach ($Cl in $Clusters) {
        if (-not $Cl.Vector) { continue }  # founding member had no embeddable text
        $Sim = Get-CmCosineSimilarity $Vec $Cl.Vector
        if ($Sim -le $SimilarityThreshold) { continue }
        $PrimaryAnchors = @(Get-CmAnchorSet $Cl.Members[0])
        if (Test-CmAnchorsDisjoint $KpAnchors $PrimaryAnchors) { continue }  # t/4472 veto
        return $Cl
    }
    return $null
}

# Cluster one (camp, category) cell's key_points into greedy first-match clusters.
function Get-CmPointClusters {
    param($CellPoints, $Embeddings, [double]$SimilarityThreshold)
    $Clusters = [System.Collections.Generic.List[object]]::new()
    foreach ($kp in $CellPoints) {
        $Cp = Get-CmKeyPointClusterText $kp
        $Vec = $null
        if (-not [string]::IsNullOrWhiteSpace($Cp) -and $Embeddings.ContainsKey($Cp)) { $Vec = $Embeddings[$Cp] }
        $MatchedCluster = Find-CmMatchingPointCluster -Kp $kp -Vec $Vec -Clusters $Clusters -SimilarityThreshold $SimilarityThreshold
        if ($MatchedCluster) {
            $MatchedCluster.Members.Add($kp)
        } else {
            $Clusters.Add([pscustomobject]@{ Members = [System.Collections.Generic.List[object]]::new(@($kp)); Vector = $Vec })
        }
    }
    return ,$Clusters
}

# Primary = index of the member with the longest 'point' text (t/4472).
function Get-CmLongestPointIndex {
    param($Members)
    $PrimaryIdx = 0
    $PrimaryLen = [string](Get-SummaryProp $Members[0] 'point')
    for ($i = 1; $i -lt $Members.Count; $i++) {
        $Text = [string](Get-SummaryProp $Members[$i] 'point')
        if ($Text.Length -gt $PrimaryLen.Length) { $PrimaryIdx = $i; $PrimaryLen = $Text }
    }
    return $PrimaryIdx
}

# One folded key_point evidence span (the member's own fields).
function New-CmKeyPointSpan {
    param($M)
    $Span = [ordered]@{}
    foreach ($Field in 'point', 'canonical_proposition', 'verbatim', 'excerpt_context', 'taxonomy_node_id') {
        $V = Get-SummaryProp $M $Field
        if ($null -ne $V) { $Span[$Field] = $V }
    }
    return $Span
}

# Collapse a multi-member key_point cluster into its primary with folded
# evidence_spans and unioned anchors.
function Resolve-CmPointCluster {
    param($Members)
    $PrimaryIdx = Get-CmLongestPointIndex $Members
    $Primary = $Members[$PrimaryIdx]

    $EvidenceSpans = [System.Collections.Generic.List[object]]::new()
    $AnchorUnion = [System.Collections.Generic.List[string]]::new()
    foreach ($a in (Get-CmAnchorSet $Primary)) { $AnchorUnion.Add($a) }
    for ($i = 0; $i -lt $Members.Count; $i++) {
        if ($i -eq $PrimaryIdx) { continue }
        $m = $Members[$i]
        $EvidenceSpans.Add((New-CmKeyPointSpan $m))
        foreach ($a in (Get-CmAnchorSet $m)) { if (-not $AnchorUnion.Contains($a)) { $AnchorUnion.Add($a) } }
    }

    $Overrides = @{ evidence_spans = @($EvidenceSpans) }
    if ($AnchorUnion.Count -gt 0) { $Overrides['anchors'] = @($AnchorUnion) }
    return (Copy-CmWithOverrides $Primary $Overrides)
}

# Cluster + fold one camp's key_points (embeddings path).
function Get-CmClusteredCampPoints {
    param($CampAllPoints, $Embeddings, [double]$SimilarityThreshold)
    $FinalPoints = [System.Collections.Generic.List[object]]::new()
    $CellGroups = Group-CmPointsByCategory $CampAllPoints
    foreach ($CatKey in $CellGroups.Keys) {
        $Clusters = Get-CmPointClusters -CellPoints @($CellGroups[$CatKey]) -Embeddings $Embeddings -SimilarityThreshold $SimilarityThreshold
        foreach ($Cl in $Clusters) {
            if ($Cl.Members.Count -eq 1) { $FinalPoints.Add($Cl.Members[0]); continue }
            $FinalPoints.Add((Resolve-CmPointCluster $Cl.Members))
        }
    }
    return ,$FinalPoints
}

# Merge key_points per camp into the ordered pov_summaries structure.
function Merge-CmKeyPoints {
    param([object[]]$ChunkResults, [string[]]$Camps, $Embeddings, [bool]$UseEmbeddings, [double]$SimilarityThreshold)
    $MergedPovSummaries = [ordered]@{}
    foreach ($Camp in $Camps) {
        $CampAllPoints = Get-CmCampAllPoints -ChunkResults $ChunkResults -Camp $Camp
        if (-not $UseEmbeddings) {
            $FallbackPoints = Get-CmFallbackDedupPoints $CampAllPoints
            $MergedPovSummaries[$Camp] = [ordered]@{ key_points = @($FallbackPoints) }
            continue
        }
        $FinalPoints = Get-CmClusteredCampPoints -CampAllPoints $CampAllPoints -Embeddings $Embeddings -SimilarityThreshold $SimilarityThreshold
        $MergedPovSummaries[$Camp] = [ordered]@{ key_points = @($FinalPoints) }
    }
    return $MergedPovSummaries
}

# All factual_claims across every chunk, in original order.
function Get-CmAllRawClaims {
    param([object[]]$ChunkResults)
    $AllClaimsRaw = [System.Collections.Generic.List[object]]::new()
    foreach ($Chunk in $ChunkResults) {
        $ChunkClaims = Get-SummaryProp $Chunk 'factual_claims'
        if ($ChunkClaims) { foreach ($Claim in $ChunkClaims) { $AllClaimsRaw.Add($Claim) } }
    }
    return ,$AllClaimsRaw
}

# Pre-t/4472 fallback: first-occurrence claim_label (else claim-prefix) dedup.
function Get-CmFallbackDedupClaims {
    param($AllClaimsRaw)
    $AllClaims = [System.Collections.Generic.List[object]]::new()
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
    return ,$AllClaims
}

# Decide whether a claim with similarity $Sim folds into a primary, applying
# the numeric-token subset guard (t/4472).
function Test-CmClaimFold {
    param([double]$Sim, $Tokens, $PrimaryTokens)
    if ($Tokens.Count -eq 0 -and $PrimaryTokens.Count -eq 0) {
        return ($Sim -ge $script:CmFactualNoNumberThreshold)
    }
    if ($Sim -ge $script:CmFactualFoldThreshold) {
        # Numeric-subset guard (t/4472): never cosine alone.
        if ((Test-CmNumericSuperset $Tokens $PrimaryTokens) -or (Test-CmNumericSuperset $PrimaryTokens $Tokens)) {
            return $true
        }
    }
    return $false
}

# Find the first existing claim cluster $Claim folds into, or $null.
function Find-CmMatchingClaimCluster {
    param($Vec, $Tokens, $ClaimClusters, $Embeddings)
    if (-not $Vec) { return $null }
    foreach ($Cl in $ClaimClusters) {
        $PrimaryClaim = $Cl.Members[$Cl.PrimaryIdx]
        $PrimaryText = Get-SummaryProp $PrimaryClaim 'claim'
        $PrimaryVec = $null
        if (-not [string]::IsNullOrWhiteSpace($PrimaryText) -and $Embeddings.ContainsKey($PrimaryText)) { $PrimaryVec = $Embeddings[$PrimaryText] }
        if (-not $PrimaryVec) { continue }
        $Sim = Get-CmCosineSimilarity $Vec $PrimaryVec
        $PrimaryTokens = @(Get-CmNumericTokens $PrimaryText)
        if (Test-CmClaimFold $Sim $Tokens $PrimaryTokens) { return $Cl }
    }
    return $null
}

# Re-pick a claim cluster's primary: most numeric tokens wins (superset side,
# t/4472); ties keep the longer claim text.
function Get-CmClaimPrimaryIndex {
    param($Members)
    $BestIdx = 0; $BestTokenCount = -1; $BestLen = -1
    for ($i = 0; $i -lt $Members.Count; $i++) {
        $Text = [string](Get-SummaryProp $Members[$i] 'claim')
        $TokenCount = @(Get-CmNumericTokens $Text).Count
        if ($TokenCount -gt $BestTokenCount -or ($TokenCount -eq $BestTokenCount -and $Text.Length -gt $BestLen)) {
            $BestIdx = $i; $BestTokenCount = $TokenCount; $BestLen = $Text.Length
        }
    }
    return $BestIdx
}

# Cluster all factual_claims globally (embeddings path).
function Get-CmClaimClusters {
    param($AllClaimsRaw, $Embeddings)
    $ClaimClusters = [System.Collections.Generic.List[object]]::new()
    foreach ($Claim in $AllClaimsRaw) {
        $ClaimText = Get-SummaryProp $Claim 'claim'
        $Vec = $null
        if (-not [string]::IsNullOrWhiteSpace($ClaimText) -and $Embeddings.ContainsKey($ClaimText)) { $Vec = $Embeddings[$ClaimText] }
        $Tokens = @(Get-CmNumericTokens $ClaimText)
        $MatchedCluster = Find-CmMatchingClaimCluster -Vec $Vec -Tokens $Tokens -ClaimClusters $ClaimClusters -Embeddings $Embeddings
        if ($MatchedCluster) {
            $MatchedCluster.Members.Add($Claim)
            $MatchedCluster.PrimaryIdx = Get-CmClaimPrimaryIndex $MatchedCluster.Members
        } else {
            $ClaimClusters.Add([pscustomobject]@{ Members = [System.Collections.Generic.List[object]]::new(@($Claim)); PrimaryIdx = 0 })
        }
    }
    return ,$ClaimClusters
}

# One folded factual_claim evidence span (the member's own fields).
function New-CmClaimSpan {
    param($M)
    $Span = [ordered]@{}
    foreach ($Field in 'claim', 'claim_label', 'doc_position') {
        $V = Get-SummaryProp $M $Field
        if ($null -ne $V) { $Span[$Field] = $V }
    }
    return $Span
}

# Collapse claim clusters into primaries with folded evidence_spans.
function Resolve-CmClaimClusters {
    param($ClaimClusters)
    $AllClaims = [System.Collections.Generic.List[object]]::new()
    foreach ($Cl in $ClaimClusters) {
        $Members = $Cl.Members
        if ($Members.Count -eq 1) { $AllClaims.Add($Members[0]); continue }
        $Primary = $Members[$Cl.PrimaryIdx]
        $EvidenceSpans = [System.Collections.Generic.List[object]]::new()
        for ($i = 0; $i -lt $Members.Count; $i++) {
            if ($i -eq $Cl.PrimaryIdx) { continue }
            $EvidenceSpans.Add((New-CmClaimSpan $Members[$i]))
        }
        $AllClaims.Add((Copy-CmWithOverrides $Primary @{ evidence_spans = @($EvidenceSpans) }))
    }
    return ,$AllClaims
}

# Merge factual_claims, clustering globally (t/4472).
function Merge-CmFactualClaims {
    param([object[]]$ChunkResults, $Embeddings, [bool]$UseEmbeddings)
    $AllClaimsRaw = Get-CmAllRawClaims -ChunkResults $ChunkResults
    if (-not $UseEmbeddings) {
        return ,(Get-CmFallbackDedupClaims $AllClaimsRaw)
    }
    $ClaimClusters = Get-CmClaimClusters -AllClaimsRaw $AllClaimsRaw -Embeddings $Embeddings
    return ,(Resolve-CmClaimClusters $ClaimClusters)
}

# Merge unmapped_concepts, deduping by suggested_label and dropping bare nulls.
function Merge-CmUnmappedConcepts {
    param([object[]]$ChunkResults)
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
            if ($SeenLabels.Add($LabelKey)) { $AllUnmapped.Add($Concept) }
        }
    }
    if ($NullConceptsDropped -gt 0) {
        Write-Warning "Merge-ChunkSummaries: dropped $NullConceptsDropped null unmapped_concepts entry/entries during merge (t/3907)"
    }
    return ,$AllUnmapped
}

# Does any merged key_point in this camp fall in category $Cat?
function Test-CmCampHasPointInCategory {
    param($CampKeyPoints, [string]$Cat)
    foreach ($kp in $CampKeyPoints) {
        if ((Get-SummaryProp $kp 'category') -eq $Cat) { return $true }
    }
    return $false
}

# Across chunks, whether a (camp, category) cell was declared empty / left
# silent, and the first declaring chunk's reason (t/4601).
function Get-CmEmptyCellDeclaration {
    param([object[]]$ChunkResults, [string]$Camp, [string]$Cat)
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
    return [pscustomobject]@{
        AnyDeclaredEmpty = $AnyChunkDeclaredEmpty
        AnySilent        = $AnyChunkSilent
        FirstReason      = $FirstReason
    }
}

# Merge empty_cells (t/4473/t/4519/t/4601). A cell is empty for the document if
# ANY chunk declared it empty AND the merged key_points for that camp have no
# point in that category. Keep the first declaring chunk's reason; WARN on
# disagreement so the rate stays visible.
function Merge-CmEmptyCells {
    param([object[]]$ChunkResults, [System.Collections.IDictionary]$MergedPovSummaries, [string[]]$Camps, [string[]]$Categories)
    $MergedEmptyCells = [System.Collections.Generic.List[object]]::new()
    $DisagreementCount = 0
    foreach ($Camp in $Camps) {
        $CampKeyPoints = @($MergedPovSummaries[$Camp].key_points)
        foreach ($Cat in $Categories) {
            if (Test-CmCampHasPointInCategory -CampKeyPoints $CampKeyPoints -Cat $Cat) { continue }
            $Decl = Get-CmEmptyCellDeclaration -ChunkResults $ChunkResults -Camp $Camp -Cat $Cat
            if ($Decl.AnyDeclaredEmpty -and $Decl.AnySilent) { $DisagreementCount++ }
            if ($Decl.AnyDeclaredEmpty) {
                $MergedEmptyCells.Add([ordered]@{ camp = $Camp; category = $Cat; reason = $Decl.FirstReason })
            }
        }
    }
    if ($DisagreementCount -gt 0) {
        Write-Warning "Merge-ChunkSummaries: $DisagreementCount camp/category cell(s) had chunks disagree on emptiness (some declared empty, some silent) -- kept as empty per the any-chunk rule (t/4601)"
    }
    return ,$MergedEmptyCells
}
