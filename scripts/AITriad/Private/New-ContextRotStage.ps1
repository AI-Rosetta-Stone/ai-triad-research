# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Context-rot instrumentation helper.
# Builds a stage measurement matching the ContextRotStage TypeScript interface.
# Dot-sourced by AITriad.psm1 — do NOT export.

function New-ContextRotStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][string]$InUnits,
        [Parameter(Mandatory)][double]$InCount,
        [Parameter(Mandatory)][string]$OutUnits,
        [Parameter(Mandatory)][double]$OutCount,
        [hashtable]$Flags = @{}
    )
    $Ratio = if ($InCount -gt 0) { [Math]::Round($OutCount / $InCount, 4) } else { 0 }
    # Flags arrive as a plain @{}, whose key order is randomized per process. Copy them in ordinal key
    # order so the serialized stage is byte-identical across runs (t/4144).
    $FlagKeys = [string[]]@($Flags.Keys)
    [Array]::Sort($FlagKeys, [System.StringComparer]::Ordinal)
    $OrderedFlags = [ordered]@{}
    foreach ($k in $FlagKeys) { $OrderedFlags[$k] = $Flags[$k] }
    [ordered]@{
        stage    = $Stage
        in_units = $InUnits
        in_count = $InCount
        out_units = $OutUnits
        out_count = $OutCount
        ratio    = $Ratio
        flags    = $OrderedFlags
    }
}

function New-ContextRotMetrics {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Pipeline,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][array]$Stages
    )
    $CumulativeRetention = 1.0
    foreach ($s in $Stages) {
        # Only multiply stages with comparable in/out units (actual retention).
        # Mixed-unit stages (e.g. extraction: chars→items) are density metrics,
        # not retention — including them collapses the product to near-zero.
        if ($s.in_units -ne $s.out_units) { continue }
        if ($s.ratio -gt 0 -and $s.ratio -le 1) {
            $CumulativeRetention *= $s.ratio
        }
    }
    [ordered]@{
        schema_version       = 1
        pipeline             = $Pipeline
        doc_id               = $DocId
        measured_at          = (Get-Date -Format 'o')
        stages               = @($Stages)
        cumulative_retention = [Math]::Round($CumulativeRetention, 4)
    }
}
