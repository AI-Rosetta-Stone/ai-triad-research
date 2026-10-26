# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-PovWindowSimilarityCheck {
    <#
    .SYNOPSIS
        Free, local, per-window POV camp similarity — a forensic cross-check only (t/4477).
    .DESCRIPTION
        Computes each camp's mean node-description embedding (accelerationist / safetyist / skeptic) and
        scores every window's embedding against each camp's mean via cosine. This is NOT used to choose
        which windows feed CHESS's classification sample (CL t/4477#3: a camp-mean vector averages
        hundreds of node descriptions into a near-generic centroid, so selecting by it would feed the
        classifier the embedder's own bias and confound the before/after measurement). It exists only as
        a logged, additive diagnostic alongside CHESS's verdict.

        T0 exemption note: no consumer branches on this field's value. The exemption lapses the moment a
        consumer branches on it — see lib/ai-client/types.ts for the model of this note.
    .PARAMETER WindowVectors
        Per-window embeddings, in window order.
    .OUTPUTS
        [hashtable] camp name -> double[] per-window cosine similarity, same order as -WindowVectors.
        $null if the node embeddings cache is unavailable (never throws).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][double[][]]$WindowVectors
    )

    Set-StrictMode -Version Latest

    if (-not $script:CachedEmbeddings -or $script:CachedEmbeddings.Count -eq 0) {
        Write-Verbose 'Get-PovWindowSimilarityCheck: node embeddings cache unavailable — skipping cross-check'
        return $null
    }

    $CampVectors = @{ accelerationist = @(); safetyist = @(); skeptic = @() }
    foreach ($NodeId in $script:CachedEmbeddings.Keys) {
        $Camp = if ($NodeId -match '^acc-') { 'accelerationist' } elseif ($NodeId -match '^saf-') { 'safetyist' } elseif ($NodeId -match '^skp-') { 'skeptic' } else { $null }
        if ($Camp) { $CampVectors[$Camp] += , [double[]]$script:CachedEmbeddings[$NodeId] }
    }

    $CampMeans = @{}
    foreach ($Camp in $CampVectors.Keys) {
        $Vecs = @($CampVectors[$Camp])
        if ($Vecs.Count -eq 0) { continue }
        $Dim = $Vecs[0].Count
        $Mean = [double[]]::new($Dim)
        foreach ($V in $Vecs) { for ($d = 0; $d -lt $Dim; $d++) { $Mean[$d] += $V[$d] } }
        $Norm = [Math]::Sqrt((($Mean | ForEach-Object { $_ * $_ }) | Measure-Object -Sum).Sum)
        if ($Norm -gt 0) { for ($d = 0; $d -lt $Dim; $d++) { $Mean[$d] = $Mean[$d] / $Norm } }
        $CampMeans[$Camp] = $Mean
    }
    if ($CampMeans.Count -eq 0) { return $null }

    function script:Get-Cosine([double[]]$A, [double[]]$B) {
        if ($A.Count -ne $B.Count) { return 0.0 }
        $Dot = 0.0; $NA = 0.0; $NB = 0.0
        for ($d = 0; $d -lt $A.Count; $d++) { $Dot += $A[$d] * $B[$d]; $NA += $A[$d] * $A[$d]; $NB += $B[$d] * $B[$d] }
        if ($NA -eq 0 -or $NB -eq 0) { return 0.0 }
        $Dot / ([Math]::Sqrt($NA) * [Math]::Sqrt($NB))
    }

    $Result = @{}
    foreach ($Camp in $CampMeans.Keys) {
        $Scores = [double[]]::new(@($WindowVectors).Count)
        for ($i = 0; $i -lt @($WindowVectors).Count; $i++) { $Scores[$i] = Get-Cosine $WindowVectors[$i] $CampMeans[$Camp] }
        $Result[$Camp] = $Scores
    }
    $Result
}
