# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Compare-DebateQuality {
    <#
    .SYNOPSIS
        Side-by-side quality comparison of two debate sessions.
    .DESCRIPTION
        Accepts debate IDs (resolved via Get-AITDebate) or file paths.
        Compares header metadata, calibration metrics, PRM statistics,
        per-agent utilities, and flags confounds (model/temperature/protocol).
    .PARAMETER Baseline
        Debate ID or path to the baseline debate JSON file.
    .PARAMETER Treatment
        Debate ID or path to the treatment (changed) debate JSON file.
    .PARAMETER Format
        Output format: Table (default), Json, or Csv.
    .PARAMETER PassThru
        Return structured comparison object for pipeline use.
    .EXAMPLE
        Compare-DebateQuality -Baseline debate-abc.json -Treatment debate-xyz.json
    .EXAMPLE
        Compare-DebateQuality -Baseline abc123 -Treatment xyz456 -Format Json
    .LINK
        Show-AITriadHelp
    .LINK
        Compare-DebateRuns
    .LINK
        Measure-DebateQuality
    .LINK
        Invoke-DebateAB
    .LINK
        Test-SynthesisCompleteness
    .LINK
        Get-CalibrationTrend
    .LINK
        Test-AITJudgeModel
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Baseline,
        [Parameter(Mandatory)][string]$Treatment,
        [ValidateSet('Table', 'Json', 'Csv')][string]$Format = 'Table',
        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # NOTE: Path resolution and metric extraction moved to private helpers
    # (Resolve-DebatePath, Get-DebateQualityMetrics) so Measure-DebateQuality
    # can share them. The local function below is retained only to preserve
    # the order-of-operations inside the original Extract-QualityMetrics body
    # that follows; new callers should use Get-DebateQualityMetrics instead.

    function Get-SafeProp($Obj, [string]$Name, $Default = $null) {
        if ($null -eq $Obj) { return $Default }
        if ($Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
        return $Default
    }

    function Extract-QualityMetrics([string]$Path) {
        $S = Get-Content $Path -Raw | ConvertFrom-Json

        $Header = [ordered]@{
            topic       = Get-SafeProp $S 'title'
            model       = Get-SafeProp $S 'debate_model'
            temperature = Get-SafeProp $S 'debate_temperature'
            protocol    = Get-SafeProp $S 'protocol_id'
            app_version = Get-SafeProp $S 'app_version'
            created_at  = Get-SafeProp $S 'created_at'
            total_rounds = if ($S.PSObject.Properties['transcript'] -and $S.transcript) { @($S.transcript).Count } else { 0 }
        }

        $CL = Get-SafeProp $S 'calibration_log'
        $Calibration = [ordered]@{
            crux_addressed_ratio      = if ($CL) { [Math]::Round((Get-SafeProp $CL 'crux_addressed_ratio' 0), 4) } else { 0 }
            repetition_rate           = if ($CL) { [Math]::Round((Get-SafeProp $CL 'repetition_rate' 0), 4) } else { 0 }
            claims_forgotten_rate     = if ($CL) { [Math]::Round((Get-SafeProp $CL 'claims_forgotten_rate' 0), 4) } else { 0 }
            taxonomy_mapped_ratio     = if ($CL) { [Math]::Round((Get-SafeProp $CL 'taxonomy_mapped_ratio' 0), 4) } else { 0 }
            avg_utilization_rate      = if ($CL) { [Math]::Round((Get-SafeProp $CL 'avg_utilization_rate' 0), 4) } else { 0 }
            situation_crux_alignment  = if ($CL) { [Math]::Round((Get-SafeProp $CL 'situation_crux_alignment' 0), 4) } else { 0 }
            avg_branch_cohesion       = if ($CL) { [Math]::Round((Get-SafeProp $CL 'avg_branch_cohesion' 0), 4) } else { 0 }
            draft_repair_rate         = if ($CL) { [Math]::Round((Get-SafeProp $CL 'draft_repair_rate' 0), 4) } else { 0 }
            concession_cascades       = if ($CL) { [int](Get-SafeProp $CL 'concession_cascades' 0) } else { 0 }
            topic_alignment_rate      = if ($CL) { [Math]::Round((Get-SafeProp $CL 'topic_alignment_rate' 0), 4) } else { 0 }
        }

        $PRM = [ordered]@{
            mean   = if ($CL) { [Math]::Round((Get-SafeProp $CL 'process_reward_mean' 0), 4) } else { 0 }
            stddev = if ($CL) { [Math]::Round((Get-SafeProp $CL 'process_reward_stddev' 0), 4) } else { 0 }
            min    = if ($CL) { [Math]::Round((Get-SafeProp $CL 'process_reward_min' 0), 4) } else { 0 }
        }

        $PRMComponents = [ordered]@{}
        if ($S.PSObject.Properties['process_rewards'] -and $S.process_rewards) {
            $CompSums = @{}; $CompCounts = @{}
            foreach ($PR in @($S.process_rewards)) {
                if ($null -eq $PR) { continue }
                $Comps = Get-SafeProp $PR 'components'
                if ($null -eq $Comps) { continue }
                foreach ($Prop in $Comps.PSObject.Properties) {
                    if (-not $CompSums.ContainsKey($Prop.Name)) {
                        $CompSums[$Prop.Name] = 0.0
                        $CompCounts[$Prop.Name] = 0
                    }
                    $CompSums[$Prop.Name] += [double]$Prop.Value
                    $CompCounts[$Prop.Name]++
                }
            }
            foreach ($Key in ($CompSums.Keys | Sort-Object)) {
                $PRMComponents[$Key] = [Math]::Round($CompSums[$Key] / $CompCounts[$Key], 4)
            }
        }

        $Agents = [ordered]@{}
        if ($CL -and $CL.PSObject.Properties['agent_utilities'] -and $CL.agent_utilities) {
            foreach ($Prop in $CL.agent_utilities.PSObject.Properties) {
                $AU = $Prop.Value
                $Agents[$Prop.Name] = [ordered]@{
                    composite       = [Math]::Round((Get-SafeProp $AU 'composite' 0), 4)
                    crux_engagement = [Math]::Round((Get-SafeProp $AU 'crux_engagement' 0), 4)
                    topic_coherence = [Math]::Round((Get-SafeProp $AU 'topic_coherence' 0), 4)
                }
            }
        }
        if ($CL -and $CL.PSObject.Properties['topic_coherence_per_speaker'] -and $CL.topic_coherence_per_speaker) {
            foreach ($Prop in $CL.topic_coherence_per_speaker.PSObject.Properties) {
                if (-not $Agents.Contains($Prop.Name)) {
                    $Agents[$Prop.Name] = [ordered]@{ composite = 0; crux_engagement = 0; topic_coherence = 0 }
                }
                $Agents[$Prop.Name]['topic_coherence'] = [Math]::Round([double]$Prop.Value, 4)
            }
        }

        return [ordered]@{
            header         = $Header
            calibration    = $Calibration
            prm            = $PRM
            prm_components = $PRMComponents
            agents         = $Agents
        }
    }

    $PathA = Resolve-DebatePath -IdOrPath $Baseline
    $PathB = Resolve-DebatePath -IdOrPath $Treatment

    $MA = Extract-QualityMetrics $PathA
    $MB = Extract-QualityMetrics $PathB

    # Confound detection
    $Confounds = [System.Collections.Generic.List[string]]::new()
    if ($MA.header.model -ne $MB.header.model) {
        $Confounds.Add("Model differs: $($MA.header.model) vs $($MB.header.model)")
    }
    if ($MA.header.temperature -ne $MB.header.temperature) {
        $Confounds.Add("Temperature differs: $($MA.header.temperature) vs $($MB.header.temperature)")
    }
    if ($MA.header.protocol -ne $MB.header.protocol) {
        $Confounds.Add("Protocol differs: $($MA.header.protocol) vs $($MB.header.protocol)")
    }

    $Result = [ordered]@{
        baseline   = [ordered]@{ path = $PathA; metrics = $MA }
        treatment  = [ordered]@{ path = $PathB; metrics = $MB }
        confounds  = @($Confounds)
        deltas     = [ordered]@{}
    }

    foreach ($Key in $MA.calibration.Keys) {
        $VA = $MA.calibration[$Key]; $VB = $MB.calibration[$Key]
        $Delta = [Math]::Round($VB - $VA, 4)
        $Pct = if ($VA -ne 0) { [Math]::Round(($Delta / [Math]::Abs($VA)) * 100, 1) } else { $null }
        $Result.deltas[$Key] = [ordered]@{ baseline = $VA; treatment = $VB; delta = $Delta; pct = $Pct }
    }
    foreach ($Key in $MA.prm.Keys) {
        $VA = $MA.prm[$Key]; $VB = $MB.prm[$Key]
        $Delta = [Math]::Round($VB - $VA, 4)
        $Pct = if ($VA -ne 0) { [Math]::Round(($Delta / [Math]::Abs($VA)) * 100, 1) } else { $null }
        $Result.deltas["prm_$Key"] = [ordered]@{ baseline = $VA; treatment = $VB; delta = $Delta; pct = $Pct }
    }

    if ($PassThru) { return $Result }

    # Dispatch to format handler
    switch ($Format) {
        'Json'  { return Format-DebateQualityJson $Result }
        'Csv'   { return Format-DebateQualityCsv $Result }
        'Table' { return Format-DebateQualityTable $Result $MA $MB $Confounds }
    }
}
