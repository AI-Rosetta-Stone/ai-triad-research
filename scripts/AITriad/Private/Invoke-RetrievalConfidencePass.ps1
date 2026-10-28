# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-BatchEmbedAttribution {
    # Isolated wrapper so Pester tests can mock this without touching Python.
    # Input:  list of @{EmbedId='kp_N'; Text='attribution text...'}
    # Output: hashtable EmbedId -> double[] (null on failure)
    [CmdletBinding()]
    param([System.Collections.Generic.List[hashtable]]$Items)

    $EmbedScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'embed_taxonomy.py'
    if (-not (Test-Path $EmbedScript)) {
        $EmbedScript = Join-Path $script:ModuleRoot 'embed_taxonomy.py'
    }
    if (-not (Test-Path $EmbedScript)) { return $null }

    $BatchItems = [System.Collections.Generic.List[object]]::new()
    foreach ($Item in $Items) {
        $BatchItems.Add([ordered]@{ id = $Item.EmbedId; text = $Item.Text })
    }
    $BatchJson = $BatchItems | ConvertTo-Json -Compress -Depth 3

    try {
        $Raw = $BatchJson | & python $EmbedScript batch-encode 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Raw)) { return $null }
        $Parsed = $Raw | ConvertFrom-Json
        $Map = @{}
        foreach ($Prop in $Parsed.PSObject.Properties) {
            $Map[$Prop.Name] = [double[]]@($Prop.Value)
        }
        return $Map
    } catch {
        return $null
    }
}

function Set-KeyPointField {
    param([object]$KeyPoint, [string]$Name, $Value)
    if ($KeyPoint.PSObject.Properties[$Name]) {
        $KeyPoint.$Name = $Value
    } else {
        $KeyPoint | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
    }
}

function Measure-CachedCosine {
    # Cosine of $QueryVec (with precomputed norm $QNorm) against the cached vector for $NodeId.
    # All inputs explicit params -- no $script: closures, no captured loop variables -- so this is
    # safe to call per-candidate inside a tight scoring loop.
    param(
        [double[]]$QueryVec, [double]$QNorm, [int]$Dim,
        [hashtable]$Embeddings, [string]$NodeId
    )
    if (-not $Embeddings.ContainsKey($NodeId)) { return 0.0 }
    $NodeVec = [double[]]$Embeddings[$NodeId]
    if ($NodeVec.Count -ne $Dim) { return 0.0 }
    $Dot = 0.0; $NNormSq = 0.0
    for ($i = 0; $i -lt $Dim; $i++) {
        $Dot     += $QueryVec[$i] * $NodeVec[$i]
        $NNormSq += $NodeVec[$i]  * $NodeVec[$i]
    }
    $D = $QNorm * [Math]::Sqrt($NNormSq)
    if ($D -gt 0.0) { [Math]::Round($Dot / $D, 4) } else { 0.0 }
}

# t/4478: shared with Invoke-Mechanism5RetrievalPass -- the valid BDI category names, and the
# node-id prefix each POV camp uses (Test-PovNodeId / AGENTS.md: {pov}-{category}-{NNN}).
$script:BdiValidCategories = @('Beliefs', 'Desires', 'Intentions')
$script:BdiPovPrefixMap = @{ accelerationist = 'acc-'; safetyist = 'saf-'; skeptic = 'skp-' }

function Get-BdiCategoryMap {
    # node-id -> category ('Beliefs'/'Desires'/'Intentions'/other), from TaxonomyData.
    $Map = @{}
    foreach ($PovKey in $script:TaxonomyData.Keys) {
        $PovObj = $script:TaxonomyData[$PovKey]
        if (-not $PovObj.PSObject.Properties['nodes']) { continue }
        foreach ($N in @($PovObj.nodes)) {
            if ($N.PSObject.Properties['id'] -and $N.PSObject.Properties['category']) {
                $Map[[string]$N.id] = [string]$N.category
            }
        }
    }
    $Map
}

function Get-BdiScopedNodeIds {
    <#
    .SYNOPSIS
        t/4478: the candidate node-id pool for one key_point, scoped to its POV and (when valid)
        its BDI category. Falls back to POV-only with a WARN when the category is missing or not
        one of Beliefs/Desires/Intentions -- never throws, never drops the key_point.
    .PARAMETER AllNodeIds
        Every node id in $script:CachedEmbeddings.Keys (pillar nodes already excluded by the caller).
    .PARAMETER Pov
        The key_point's POV camp (accelerationist/safetyist/skeptic), or $null/unrecognized.
    .PARAMETER Category
        The key_point's own category field (e.g. 'Beliefs'), or $null/blank.
    .PARAMETER CategoryMap
        node-id -> category, from Get-BdiCategoryMap.
    .PARAMETER Context
        Short label for the WARN (identifies which key_point/pass triggered the fallback).
    #>
    param(
        [string[]]$AllNodeIds,
        [AllowNull()][string]$Pov,
        [AllowNull()][string]$Category,
        [hashtable]$CategoryMap,
        [string]$Context
    )
    $PovPrefix = if ($script:BdiPovPrefixMap.ContainsKey($Pov)) { $script:BdiPovPrefixMap[$Pov] } else { $null }
    $PovScoped = if ($PovPrefix) { @($AllNodeIds | Where-Object { $_.StartsWith($PovPrefix) }) } else { $AllNodeIds }

    if ([string]::IsNullOrWhiteSpace($Category) -or $Category -notin $script:BdiValidCategories) {
        if (-not [string]::IsNullOrWhiteSpace($Category)) {
            Write-Warning "$Context`: category '$Category' is not a valid BDI value (Beliefs/Desires/Intentions) -- falling back to POV-only retrieval"
        }
        return $PovScoped
    }
    return @($PovScoped | Where-Object { $CategoryMap.ContainsKey($_) -and $CategoryMap[$_] -eq $Category })
}

function Invoke-RetrievalConfidencePass {
    <#
    .SYNOPSIS
        Adds retrieval_confidence, taxonomy_node_candidates, and retrieval_low_confidence
        to each key_point that has a valid taxonomy_node_id and attribution_text.
    .DESCRIPTION
        Called from Invoke-DocumentSummary after the hallucinated-ID nulling pass (which
        has already set invalid taxonomy_node_id values to $null). Only key_points with
        a non-null node ID and non-empty attribution_text are processed.

        All attribution_text values are batch-embedded in one Python subprocess call
        (embed_taxonomy.py batch-encode). Cosine similarity is then computed in-memory
        against $script:CachedEmbeddings (loaded earlier by Get-RelevantTaxonomyNodes).

        t/4478: the candidate pool for taxonomy_node_candidates (top-3) is scoped to the
        key_point's POV and BDI category (Get-BdiScopedNodeIds) -- raises Hit@5 of the
        assigned node 5-11 points per the t/4469 spike. retrieval_confidence (the assigned
        node's own score) is always computed directly against the assigned node, independent
        of the scoped pool, so a key_point is never penalized when its own node falls outside
        the pool (the 0.7% case the spike measured).

        Degrades gracefully on any failure — never throws, never modifies existing fields
        on error. $script:TaxonomyData is guaranteed loaded by Assert-TaxonomyCacheFresh
        (called inside Get-RelevantTaxonomyNodes earlier in the same pipeline run).
    .PARAMETER KeyPointItems
        Array of hashtables @{KeyPoint=<PSObject>; POV='accelerationist'|'safetyist'|'skeptic'},
        one per key_point from all POV camps for a single document (t/4478: POV is needed for
        the BDI-scoped pool; was a flat array of bare key_points before).
    .PARAMETER Threshold
        Confidence value below which retrieval_low_confidence is set to $true.
        Provisional — calibrate against SAF-167 repro case and a good-vs-bad
        attribution distribution. Caller should pass $script:RetrievalConfidenceThreshold.
    #>
    [CmdletBinding()]
    param(
        [object[]]$KeyPointItems,
        [double]$Threshold = 0.45
    )

    # Guard: CachedEmbeddings must be loaded (Get-RelevantTaxonomyNodes always runs first)
    if (-not $script:CachedEmbeddings -or $script:CachedEmbeddings.Count -eq 0) {
        Write-Verbose 'Invoke-RetrievalConfidencePass: CachedEmbeddings not loaded — skipping confidence pass'
        return
    }

    # Collect workable key_points
    $WorkItems = [System.Collections.Generic.List[hashtable]]::new()
    for ($Idx = 0; $Idx -lt $KeyPointItems.Count; $Idx++) {
        $kp  = $KeyPointItems[$Idx].KeyPoint
        $Pov = [string]$KeyPointItems[$Idx].POV
        if (-not $kp.taxonomy_node_id) { continue }
        if (-not $kp.PSObject.Properties['attribution_text']) { continue }
        $AttrText = [string]$kp.attribution_text
        if ([string]::IsNullOrWhiteSpace($AttrText)) { continue }
        if (-not $script:CachedEmbeddings.ContainsKey($kp.taxonomy_node_id)) { continue }
        $WorkItems.Add(@{ Idx = $Idx; KeyPoint = $kp; POV = $Pov; EmbedId = "kp_$Idx"; Text = $AttrText })
    }
    if ($WorkItems.Count -eq 0) { return }

    # Batch-embed all attribution_texts in one subprocess call
    $VectorMap = Invoke-BatchEmbedAttribution -Items $WorkItems
    if ($null -eq $VectorMap) {
        Write-Verbose 'Invoke-RetrievalConfidencePass: batch-encode failed — skipping confidence pass'
        return
    }

    # Build node-id → label map from TaxonomyData (guaranteed populated by Assert-TaxonomyCacheFresh)
    $LabelMap = @{}
    foreach ($PovKey in $script:TaxonomyData.Keys) {
        $PovObj = $script:TaxonomyData[$PovKey]
        if (-not $PovObj.PSObject.Properties['nodes']) { continue }
        foreach ($N in @($PovObj.nodes)) {
            if ($N.PSObject.Properties['id'] -and $N.PSObject.Properties['label']) {
                $LabelMap[[string]$N.id] = [string]$N.label
            }
        }
    }
    $CategoryMap = Get-BdiCategoryMap
    $AllNodeIds = @($script:CachedEmbeddings.Keys | Where-Object { -not ($script:PillarNodeIds -and $script:PillarNodeIds.Contains($_)) })  # t/2369

    # Determine vector dimensionality from any cached embedding
    $SampleVec = $null
    foreach ($V in $script:CachedEmbeddings.Values) { $SampleVec = [double[]]$V; break }
    if ($null -eq $SampleVec) { return }
    $Dim = $SampleVec.Count

    foreach ($Item in $WorkItems) {
        $kp      = $Item.KeyPoint
        $EmbedId = $Item.EmbedId
        if (-not $VectorMap.ContainsKey($EmbedId)) { continue }

        $QueryVec = [double[]]$VectorMap[$EmbedId]
        if ($QueryVec.Count -ne $Dim) { continue }

        # Compute query L2 norm
        $QNormSq = 0.0
        for ($i = 0; $i -lt $Dim; $i++) { $QNormSq += $QueryVec[$i] * $QueryVec[$i] }
        $QNorm = [Math]::Sqrt($QNormSq)
        if ($QNorm -eq 0) { continue }

        # retrieval_confidence: the ASSIGNED node's own score, always -- independent of the
        # BDI-scoped pool below, so a key_point is never penalized when its own node is outside it.
        $Confidence = Measure-CachedCosine -QueryVec $QueryVec -QNorm $QNorm -Dim $Dim `
            -Embeddings $script:CachedEmbeddings -NodeId $kp.taxonomy_node_id

        # taxonomy_node_candidates: top-3 from the POV+BDI-scoped pool (t/4478), WARN-fallback to
        # POV-only when the key_point's category isn't a valid B/D/I value.
        $KpCategory = if ($kp.PSObject.Properties['category']) { [string]$kp.category } else { $null }
        $ScopedIds = Get-BdiScopedNodeIds -AllNodeIds $AllNodeIds -Pov $Item.POV -Category $KpCategory `
            -CategoryMap $CategoryMap -Context "Invoke-RetrievalConfidencePass ($($kp.taxonomy_node_id))"

        $Scores = [System.Collections.Generic.List[PSObject]]::new()
        foreach ($NodeId in $ScopedIds) {
            $Score = Measure-CachedCosine -QueryVec $QueryVec -QNorm $QNorm -Dim $Dim `
                -Embeddings $script:CachedEmbeddings -NodeId $NodeId
            $Scores.Add([PSCustomObject]@{ Id = $NodeId; Score = $Score })
        }
        $Ranked = @($Scores | Sort-Object Score -Descending)

        $Top3 = @($Ranked | Select-Object -First 3 | ForEach-Object {
            $CId = $_.Id; $CScore = $_.Score
            [PSCustomObject]@{
                id    = $CId
                label = if ($LabelMap.ContainsKey($CId)) { $LabelMap[$CId] } else { '' }
                score = $CScore
            }
        })

        Set-KeyPointField $kp 'retrieval_confidence'     $Confidence
        Set-KeyPointField $kp 'taxonomy_node_candidates' $Top3
        Set-KeyPointField $kp 'retrieval_low_confidence' ($Confidence -lt $Threshold)
    }
}
