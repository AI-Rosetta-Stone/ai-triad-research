# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Add-SummaryKeyPointCitations {
    <#
    .SYNOPSIS
        Scans one summary's pov_summaries.*.key_points, incrementing citations/DocIds/Stances
        on $NodeIndex for every mapped key point (t/3910 extraction from
        Get-TaxonomyHealthData). Mutates $NodeIndex in place (hashtable, reference type).
    .PARAMETER Summary
        The parsed summary document.
    .PARAMETER DocId
        The doc id attributing citations/stances.
    .PARAMETER NodeIndex
        The citation-tracking index (from New-TaxonomyNodeIndex), mutated in place.
    .PARAMETER OncePerDoc
        For a marked copy's summary under the duplicate-group evidence union (spec 7.5, t/4337): a
        key point counts only on a node where DocId (the canonical) isn't counted yet, and then
        once (Citations +1, DocIds += DocId, no stance). The canonical's own counts are untouched,
        so the copy can only add a (node, group) the canonical's run missed, never inflate one.
    .OUTPUTS
        [int] the total key points scanned across all POVs (mapped or not) -- the caller's
        per-doc DocKeyPoints counter.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][AllowNull()]$Summary,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][hashtable]$NodeIndex,
        [switch]$OncePerDoc
    )

    Set-StrictMode -Version Latest

    $DocKeyPoints = 0
    $HasPovSummaries = $Summary.PSObject.Properties['pov_summaries'] -and $Summary.pov_summaries
    if (-not $HasPovSummaries) { return $DocKeyPoints }

    foreach ($PovName in @('accelerationist', 'safetyist', 'skeptic')) {
        $PovData = $Summary.pov_summaries.$PovName
        if (-not $PovData -or -not $PovData.PSObject.Properties['key_points'] -or -not $PovData.key_points) { continue }

        foreach ($Point in @($PovData.key_points)) {
            $DocKeyPoints++
            $NodeId = if ($Point.PSObject.Properties['taxonomy_node_id']) { $Point.taxonomy_node_id } else { $null }
            if (-not $NodeId) { continue }
            if (-not $NodeIndex.ContainsKey($NodeId)) { continue }
            if ($OncePerDoc) {
                if ($DocId -notin $NodeIndex[$NodeId].DocIds) { $NodeIndex[$NodeId].Citations++; $NodeIndex[$NodeId].DocIds.Add($DocId) }
                continue
            }

            $NodeIndex[$NodeId].Citations++
            if ($DocId -notin $NodeIndex[$NodeId].DocIds) {
                $NodeIndex[$NodeId].DocIds.Add($DocId)
            }
            if ($Point.PSObject.Properties['stance'] -and $Point.stance) {
                $NodeIndex[$NodeId].Stances.Add($Point.stance)
            }
        }
    }

    return $DocKeyPoints
}
