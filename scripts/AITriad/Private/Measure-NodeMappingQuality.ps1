# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Measure-NodeMappingQuality {
    <#
    .SYNOPSIS
        Metric 1 of Measure-TaxonomyBaseline (t/3910 decomposition; no behavior
        change): null-mapped / invalid / category-inconsistent key points, and
        unreferenced taxonomy nodes.
    .PARAMETER AllNodes
        Node id -> node lookup (from Get-TaxonomyBaselineAllNodes).
    .PARAMETER Summaries
        Doc id -> summary lookup (from Get-TaxonomyBaselineSummaries).
    .PARAMETER Camps
        The three POV camp names to scan under each summary's pov_summaries.
    .OUTPUTS
        [ordered hashtable] the node_mapping report section.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$AllNodes,

        [Parameter(Mandatory)]
        [hashtable]$Summaries,

        [Parameter(Mandatory)]
        [string[]]$Camps
    )

    Set-StrictMode -Version Latest

    $TotalKP = 0; $NullMapped = 0; $InvalidNodeRef = 0
    $NodeRefCounts = @{}
    $CategoryPerNode = @{}

    foreach ($Sum in $Summaries.Values) {
        foreach ($Camp in $Camps) {
            $CampData = Get-SummaryField $Sum.pov_summaries $Camp
            if (-not $CampData -or -not $CampData.PSObject.Properties['key_points'] -or -not $CampData.key_points) { continue }
            foreach ($KP in @($CampData.key_points)) {
                $TotalKP++
                $NodeId = $KP.taxonomy_node_id
                if ($null -eq $NodeId -or $NodeId -eq '') {
                    $NullMapped++
                    continue
                }
                if (-not $AllNodes.ContainsKey($NodeId)) { $InvalidNodeRef++ }
                if (-not $NodeRefCounts.ContainsKey($NodeId)) { $NodeRefCounts[$NodeId] = 0 }
                $NodeRefCounts[$NodeId]++
                if ($KP.category) {
                    if (-not $CategoryPerNode.ContainsKey($NodeId)) {
                        $CategoryPerNode[$NodeId] = [System.Collections.Generic.HashSet[string]]::new()
                    }
                    [void]$CategoryPerNode[$NodeId].Add($KP.category)
                }
            }
        }
    }

    $CategoryInconsistencies = @($CategoryPerNode.GetEnumerator() | Where-Object { $_.Value.Count -gt 1 })
    $UnreferencedNodes = @($AllNodes.Keys | Where-Object { -not $NodeRefCounts.ContainsKey($_) })

    return [ordered]@{
        total_key_points          = $TotalKP
        null_mapped               = $NullMapped
        null_mapped_pct           = if ($TotalKP -gt 0) { [Math]::Round($NullMapped / $TotalKP * 100, 1) } else { 0 }
        invalid_node_refs         = $InvalidNodeRef
        category_inconsistencies  = $CategoryInconsistencies.Count
        category_inconsistent_ids = @($CategoryInconsistencies | ForEach-Object { $_.Key })
        unreferenced_node_count   = $UnreferencedNodes.Count
        unreferenced_node_pct     = [Math]::Round($UnreferencedNodes.Count / $AllNodes.Count * 100, 1)
    }
}
