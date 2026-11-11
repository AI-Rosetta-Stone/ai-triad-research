# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Output formatters for Compare-DebateQuality results.

.DESCRIPTION
    Private helper functions for formatting debate quality comparison output.
    These are extracted from Compare-DebateQuality to reduce complexity.
#>

function Format-DebateQualityCsv {
    <#
    .SYNOPSIS
        Format comparison result as CSV.
    .PARAMETER Result
        The structured comparison result object from Compare-DebateQuality.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][psobject]$Result)
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $Rows = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($Key in $Result.deltas.Keys) {
        $D = $Result.deltas[$Key]
        $Rows.Add([PSCustomObject]@{
            Metric    = $Key
            Baseline  = $D.baseline
            Treatment = $D.treatment
            Delta     = $D.delta
            PctChange = $D.pct
        })
    }
    return ($Rows | ConvertTo-Csv -NoTypeInformation)
}

function Format-DebateQualityJson {
    <#
    .SYNOPSIS
        Format comparison result as JSON.
    .PARAMETER Result
        The structured comparison result object from Compare-DebateQuality.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][psobject]$Result)
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    return ($Result | ConvertTo-Json -Depth 10)
}

function Format-DebateQualityTable {
    <#
    .SYNOPSIS
        Format comparison result as a formatted table.
    .PARAMETER Result
        The structured comparison result object from Compare-DebateQuality.
    .PARAMETER BaselineMetrics
        Baseline metrics object.
    .PARAMETER TreatmentMetrics
        Treatment metrics object.
    .PARAMETER Confounds
        List of confounding factors.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$Result,
        [Parameter(Mandatory)][psobject]$BaselineMetrics,
        [Parameter(Mandatory)][psobject]$TreatmentMetrics,
        [Parameter(Mandatory)][object[]]$Confounds
    )
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    foreach ($C in $Confounds) { Write-Warning $C }

    Write-Host ""
    Write-Host "  DEBATE QUALITY COMPARISON" -ForegroundColor White
    Write-Host "  $('─' * 80)" -ForegroundColor DarkGray

    Write-DebateQualityTableHeader $BaselineMetrics $TreatmentMetrics

    $LowerIsBetter = @('repetition_rate', 'claims_forgotten_rate', 'concession_cascades', 'prm_stddev')
    Write-DebateQualityMetricRows $Result.deltas $LowerIsBetter

    Write-DebateQualityPrmComponents $BaselineMetrics.prm_components $TreatmentMetrics.prm_components

    Write-DebateQualityAgentUtilities $BaselineMetrics.agents $TreatmentMetrics.agents

    Write-Host "  $('─' * 80)" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-DebateQualityTableHeader {
    <#
    .SYNOPSIS
        Write table header for quality comparison.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][psobject]$BaselineMetrics,
        [Parameter(Mandatory)][psobject]$TreatmentMetrics
    )
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    Write-Host ('  {0,-28} {1,-24} {2,-24}' -f '', 'Baseline', 'Treatment') -ForegroundColor Cyan
    foreach ($Key in $BaselineMetrics.header.Keys) {
        $VA = $BaselineMetrics.header[$Key] ?? '—'
        $VB = $TreatmentMetrics.header[$Key] ?? '—'
        Write-Host ('  {0,-28} {1,-24} {2,-24}' -f $Key, $VA, $VB) -ForegroundColor Gray
    }
    Write-Host "  $('─' * 80)" -ForegroundColor DarkGray
    Write-Host ('  {0,-28} {1,10} {2,10} {3,8} {4,8}' -f 'Metric', 'Baseline', 'Treatment', 'Delta', '%Chg') -ForegroundColor Cyan
}

function Write-DebateQualityMetricRows {
    <#
    .SYNOPSIS
        Write metric comparison rows.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Deltas,
        [Parameter(Mandatory)][string[]]$LowerIsBetter
    )
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    foreach ($Key in $Deltas.Keys) {
        $D = $Deltas[$Key]
        $DeltaStr = if ($D.delta -gt 0) { "+$($D.delta)" } elseif ($D.delta -eq 0) { '=' } else { "$($D.delta)" }
        $PctStr = if ($null -ne $D.pct) { "$($D.pct)%" } else { '—' }

        $Color = if ($Key -in $LowerIsBetter) {
            if ($D.delta -le 0) { 'Green' } else { 'Yellow' }
        } else {
            if ($D.delta -gt 0) { 'Green' } elseif ($D.delta -lt 0) { 'Yellow' } else { 'Gray' }
        }

        Write-Host ('  {0,-28} {1,10} {2,10} ' -f $Key, $D.baseline, $D.treatment) -ForegroundColor Gray -NoNewline
        Write-Host ('{0,8} {1,8}' -f $DeltaStr, $PctStr) -ForegroundColor $Color
    }
}

function Write-DebateQualityPrmComponents {
    <#
    .SYNOPSIS
        Write PRM components comparison.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$ComponentsA,
        [Parameter(Mandatory)][hashtable]$ComponentsB
    )
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $AllCompKeys = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($K in $ComponentsA.Keys) { [void]$AllCompKeys.Add($K) }
    foreach ($K in $ComponentsB.Keys) { [void]$AllCompKeys.Add($K) }

    if ($AllCompKeys.Count -eq 0) { return }

    Write-Host "  $('─' * 80)" -ForegroundColor DarkGray
    Write-Host "  PRM COMPONENTS" -ForegroundColor White
    foreach ($Key in ($AllCompKeys | Sort-Object)) {
        $VA = if ($ComponentsA.Contains($Key)) { $ComponentsA[$Key] } else { 0 }
        $VB = if ($ComponentsB.Contains($Key)) { $ComponentsB[$Key] } else { 0 }
        $Delta = [Math]::Round($VB - $VA, 4)
        $DeltaStr = if ($Delta -gt 0) { "+$Delta" } elseif ($Delta -eq 0) { '=' } else { "$Delta" }
        $Color = if ($Delta -gt 0) { 'Green' } elseif ($Delta -lt 0) { 'Yellow' } else { 'Gray' }
        Write-Host ('  {0,-28} {1,10} {2,10} ' -f "  $Key", $VA, $VB) -ForegroundColor Gray -NoNewline
        Write-Host ('{0,8}' -f $DeltaStr) -ForegroundColor $Color
    }
}

function Write-DebateQualityAgentUtilities {
    <#
    .SYNOPSIS
        Write per-agent utilities comparison.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$AgentA,
        [Parameter(Mandatory)][hashtable]$AgentB
    )
    
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $AllAgents = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($K in $AgentA.Keys) { [void]$AllAgents.Add($K) }
    foreach ($K in $AgentB.Keys) { [void]$AllAgents.Add($K) }

    if ($AllAgents.Count -eq 0) { return }

    Write-Host "  $('─' * 80)" -ForegroundColor DarkGray
    Write-Host "  PER-AGENT UTILITIES" -ForegroundColor White
    foreach ($Agent in ($AllAgents | Sort-Object)) {
        Write-Host "    $Agent" -ForegroundColor Cyan
        $SubA = if ($AgentA.Contains($Agent)) { $AgentA[$Agent] } else { [ordered]@{ composite = 0; crux_engagement = 0; topic_coherence = 0 } }
        $SubB = if ($AgentB.Contains($Agent)) { $AgentB[$Agent] } else { [ordered]@{ composite = 0; crux_engagement = 0; topic_coherence = 0 } }
        foreach ($Metric in @('composite', 'crux_engagement', 'topic_coherence')) {
            $VA = $SubA[$Metric]; $VB = $SubB[$Metric]
            $Delta = [Math]::Round($VB - $VA, 4)
            $DeltaStr = if ($Delta -gt 0) { "+$Delta" } elseif ($Delta -eq 0) { '=' } else { "$Delta" }
            $Color = if ($Delta -gt 0) { 'Green' } elseif ($Delta -lt 0) { 'Yellow' } else { 'Gray' }
            Write-Host ('  {0,-28} {1,10} {2,10} ' -f "    $Metric", $VA, $VB) -ForegroundColor Gray -NoNewline
            Write-Host ('{0,8}' -f $DeltaStr) -ForegroundColor $Color
        }
    }
}
