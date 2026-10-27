# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Measure-DensityDistribution {
    <#
    .SYNOPSIS
        Metric 2 of Measure-TaxonomyBaseline (t/3910 decomposition; no behavior
        change): key-point density per 1K source words, by doc and camp.
    .PARAMETER Summaries
        Doc id -> summary lookup.
    .PARAMETER Camps
        The three POV camp names.
    .PARAMETER SourcesDir
        Directory containing each doc's snapshot.md (for word counts).
    .OUTPUTS
        [ordered hashtable] the density report section.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Summaries,

        [Parameter(Mandatory)]
        [string[]]$Camps,

        [Parameter(Mandatory)]
        [string]$SourcesDir
    )

    Set-StrictMode -Version Latest

    $DensityRecords = [System.Collections.Generic.List[object]]::new()

    foreach ($DocId in $Summaries.Keys) {
        $Sum = $Summaries[$DocId]
        $SnapPath = Join-Path (Join-Path $SourcesDir $DocId) 'snapshot.md'
        $WordCount = 0
        if (Test-Path $SnapPath) {
            $Text = Get-Content -Raw $SnapPath
            $WordCount = ($Text -split '\s+').Count
        }

        foreach ($Camp in $Camps) {
            $CampData = Get-SummaryField $Sum.pov_summaries $Camp
            if ($CampData -and $CampData.PSObject.Properties['key_points'] -and $CampData.key_points) { $KPCount = @($CampData.key_points).Count } else { $KPCount = 0 }
            $DensityRecords.Add([PSCustomObject]@{
                DocId     = $DocId
                Camp      = $Camp
                WordCount = $WordCount
                KPCount   = $KPCount
                KPPer1K   = if ($WordCount -gt 0) { [Math]::Round($KPCount / ($WordCount / 1000), 2) } else { 0 }
            })
        }
    }

    $AllKPPer1K = @($DensityRecords | Where-Object { $_.WordCount -gt 0 } | ForEach-Object { $_.KPPer1K })
    # @() wrap: piping an empty array through Sort-Object yields $null, and $null.Count throws under
    # StrictMode (t/3998) -- hit when every doc in the (-SampleDocIds-filtered) set has zero word count.
    $SortedKP = @($AllKPPer1K | Sort-Object)

    return [ordered]@{
        doc_count            = $Summaries.Count
        median_kp_per_1k     = if ($SortedKP.Count -gt 0) { $SortedKP[[int]($SortedKP.Count / 2)] } else { 0 }
        p10_kp_per_1k        = if ($SortedKP.Count -gt 9) { $SortedKP[[int]($SortedKP.Count * 0.1)] } else { 0 }
        p90_kp_per_1k        = if ($SortedKP.Count -gt 9) { $SortedKP[[int]($SortedKP.Count * 0.9)] } else { 0 }
        zero_kp_camp_entries = @($DensityRecords | Where-Object { $_.KPCount -eq 0 }).Count
        low_density_docs     = @($DensityRecords |
            Where-Object { $_.WordCount -gt 2000 -and $_.KPPer1K -lt 1.0 } |
            Sort-Object KPPer1K |
            Select-Object -First 10 DocId, Camp, WordCount, KPCount, KPPer1K)
        high_density_docs    = @($DensityRecords |
            Where-Object { $_.WordCount -gt 500 -and $_.KPPer1K -gt 15 } |
            Sort-Object KPPer1K -Descending |
            Select-Object -First 10 DocId, Camp, WordCount, KPCount, KPPer1K)
    }
}
