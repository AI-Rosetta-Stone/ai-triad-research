# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-NodeIndexForKeyPoint {
    <#
    .SYNOPSIS
        Applies one key point's mapped-node citation/stance mutation to $NodeIndex
        (t/5326 extraction from Add-SummaryKeyPointCitations). Mutates in place.
        No-op when the key point has no node id or an unmapped node id.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Point,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][hashtable]$NodeIndex,
        [switch]$OncePerDoc
    )

    Set-StrictMode -Version Latest

    $NodeId = if ($Point.PSObject.Properties['taxonomy_node_id']) { $Point.taxonomy_node_id } else { $null }
    if (-not $NodeId) { return }
    if (-not $NodeIndex.ContainsKey($NodeId)) { return }

    $Entry = $NodeIndex[$NodeId]
    if ($OncePerDoc) {
        if ($DocId -notin $Entry.DocIds) { $Entry.Citations++; $Entry.DocIds.Add($DocId) }
        return
    }

    $Entry.Citations++
    if ($DocId -notin $Entry.DocIds) {
        $Entry.DocIds.Add($DocId)
    }
    if ($Point.PSObject.Properties['stance'] -and $Point.stance) {
        $Entry.Stances.Add($Point.stance)
    }
}

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
        $PovData = Get-SummaryField $Summary.pov_summaries $PovName
        if (-not $PovData -or -not $PovData.PSObject.Properties['key_points'] -or -not $PovData.key_points) { continue }

        foreach ($Point in @($PovData.key_points)) {
            $DocKeyPoints++
            Update-NodeIndexForKeyPoint -Point $Point -DocId $DocId -NodeIndex $NodeIndex -OncePerDoc:$OncePerDoc
        }
    }

    return $DocKeyPoints
}
