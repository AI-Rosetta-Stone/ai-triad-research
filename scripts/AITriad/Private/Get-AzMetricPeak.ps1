# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AzMetricPeak {
    <#
    .SYNOPSIS
        The peak value of one aggregation across an `az monitor metrics list -o json` response,
        or $null when no datapoint carries it (t/4282).
    .DESCRIPTION
        Azure Monitor returns only the aggregation that was requested, and omits even that field
        on a minute with no value. Under Set-StrictMode, reading `.average` / `.maximum` on such a
        datapoint throws "The property '...' cannot be found", which failed every step of the
        10-19 staging run (t/4263#4). This reads each level through PSObject.Properties so a
        missing field is skipped rather than fatal. $null means "no data yet" (ingestion lag,
        t/4239), which the caller retries.
    .PARAMETER MetricResponse
        The parsed (ConvertFrom-Json) output of `az monitor metrics list`.
    .PARAMETER Aggregation
        The datapoint field to read: maximum, average, minimum or total.
    #>
    [CmdletBinding()]
    [OutputType([double])]
    param(
        $MetricResponse,
        [ValidateSet('maximum', 'average', 'minimum', 'total')]
        [string]$Aggregation = 'maximum'
    )
    $Peak = $null
    if ($null -eq $MetricResponse -or -not $MetricResponse.PSObject.Properties['value']) { return $null }
    foreach ($Metric in @($MetricResponse.value)) {
        if ($null -eq $Metric -or -not $Metric.PSObject.Properties['timeseries']) { continue }
        foreach ($Series in @($Metric.timeseries)) {
            if ($null -eq $Series -or -not $Series.PSObject.Properties['data']) { continue }
            foreach ($Point in @($Series.data)) {
                if ($null -eq $Point) { continue }
                $Prop = $Point.PSObject.Properties[$Aggregation]
                if (-not $Prop -or $null -eq $Prop.Value) { continue }
                $Value = [double]$Prop.Value
                if ($null -eq $Peak -or $Value -gt $Peak) { $Peak = $Value }
            }
        }
    }
    return $Peak
}
