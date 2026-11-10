# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Spend measurement and the budget stop for run_batch.ps1 (t/106, backlog t/4882). Dot-sourced by the
# harness and by tests/RunBatchBudget.Tests.ps1, so the stop logic is testable without real AI calls.
#
# FAIL CLOSED. The old harness read a usage log that nothing wrote any more, returned $0 when the file
# was missing, and never compared real numbers against the cap. Now, spend that can't be measured is an
# error, never $0:
#   - before the run, the AI call log writer must be able to record token counts (Test-SpendSourceReady);
#   - after each doc, the call log must hold token-bearing entries for this run, and every entry in the
#     run window must carry tokens (Get-RunSpendUsd throws otherwise).
# Spend comes from the AI call log (AI_CALL_LOG_ENABLED, ai-call-log.jsonl under the data root), filtered
# to this run by its start time, priced per entry from ai-models.json `pricing`, input tokens included.
# Entries from another process sharing the data root inside the window are counted too, which can only
# over-count, so it errs toward stopping early.

. (Join-Path $PSScriptRoot '../../scripts/AITriad/Private/New-ActionableError.ps1')  # private to AITriad; the stop paths need it (same as judge/run_judge.ps1)

# Token fields the call-log record must carry for spend to be measurable (t/106 child, PowerShell).
$script:SpendTokenFields = @('InputTokens', 'OutputTokens')

function Test-SpendSourceReady {
    <#
    .SYNOPSIS
        True when the AI call log writer can record per-call token counts (the run's only spend source).
    .PARAMETER WriterParameterNames
        Parameter names of the module's Write-AICallLogEntry.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowEmptyCollection()][string[]]$WriterParameterNames)
    foreach ($f in $script:SpendTokenFields) {
        if ($WriterParameterNames -notcontains $f) { return $false }
    }
    return $true
}

function Get-ModelPricing {
    <#
    .SYNOPSIS
        USD-per-1M-token rates for a registry model id, from ai-models.json `pricing`. Throws if unpriced.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ModelsJsonPath,
        [Parameter(Mandatory)][string]$Model
    )
    $Pricing = (Get-Content -LiteralPath $ModelsJsonPath -Raw | ConvertFrom-Json).pricing
    $P = if ($Pricing) { $Pricing.PSObject.Properties[$Model] } else { $null }
    if (-not $P -or $null -eq $P.Value.inputPer1M -or $null -eq $P.Value.outputPer1M) {
        New-ActionableError -Goal 'Price the batch run from the repo price table' `
            -Problem "Model '$Model' has no inputPer1M/outputPer1M entry in ai-models.json pricing, so its spend can't be measured" `
            -Location 'analyses/t4603-camp-bridge/BatchBudget.ps1:Get-ModelPricing' `
            -NextSteps @("Add '$Model' to ai-models.json pricing (see _pricing_provenance)", 'Or run the batch with a priced model') -Throw
    }
    $In = [double]$P.Value.inputPer1M
    $Cached = if ($null -ne $P.Value.cachedInputPer1M) { [double]$P.Value.cachedInputPer1M } else { $In }
    return [pscustomobject]@{ InputPer1M = $In; OutputPer1M = [double]$P.Value.outputPer1M; CachedInputPer1M = $Cached }
}

function Get-RunSpendUsd {
    <#
    .SYNOPSIS
        Total USD spent by this run, from AI call log entries at or after -Since. Throws when spend
        can't be measured.
    .DESCRIPTION
        Per entry: (InputTokens - CachedInputTokens) * input rate + CachedInputTokens * cached rate +
        OutputTokens * output rate, priced by the entry's own Model. Throws when the log is missing or
        unreadable (and -RequireLog is set), when a line won't parse (it could hide spend), or when an
        entry in the window lacks token counts (a call whose spend isn't recorded). Returns the total and
        the count of entries in the window.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][datetime]$Since,
        [Parameter(Mandatory)][string]$ModelsJsonPath,
        [switch]$RequireLog
    )
    $Loc = 'analyses/t4603-camp-bridge/BatchBudget.ps1:Get-RunSpendUsd'
    if (-not (Test-Path -LiteralPath $LogPath)) {
        if ($RequireLog) {
            New-ActionableError -Goal 'Measure batch spend from the AI call log' `
                -Problem "The AI call log '$LogPath' doesn't exist after AI work ran, so this run's spend is unknown" `
                -Location $Loc `
                -NextSteps @('Check AI_CALL_LOG_ENABLED reached the AI calls', 'Check the summary pipeline logs its Invoke-AIApi calls (t/106 child)') -Throw
        }
        return [pscustomobject]@{ Usd = 0.0; Entries = 0 }
    }
    try { $Lines = @(Get-Content -LiteralPath $LogPath -Encoding utf8 -ErrorAction Stop) }
    catch {
        New-ActionableError -Goal 'Measure batch spend from the AI call log' `
            -Problem "Couldn't read '$LogPath' ($($_.Exception.Message)); treating unreadable spend as `$0 would defeat the cap" `
            -Location $Loc -NextSteps @('Fix the file permissions or lock', 'Re-run; logged docs are skipped') -Throw
    }
    $SinceUtc = $Since.ToUniversalTime()
    $Prices = @{}
    $Usd = 0.0; $Entries = 0; $LineNo = 0
    foreach ($Line in $Lines) {
        $LineNo++
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }
        try { $Rec = $Line | ConvertFrom-Json -ErrorAction Stop }
        catch {
            New-ActionableError -Goal 'Measure batch spend from the AI call log' `
                -Problem "Line $LineNo of '$LogPath' won't parse, and an unreadable record could hide spend" `
                -Location $Loc -NextSteps @('Inspect or rotate the log (Clear-AICallLog), then re-run; logged docs are skipped') -Throw
        }
        $When = if ($Rec.Datetime -is [datetime]) { $Rec.Datetime.ToUniversalTime() }
                elseif ($Rec.Datetime) { ([datetime]::Parse([string]$Rec.Datetime, [cultureinfo]::InvariantCulture, 'RoundtripKind')).ToUniversalTime() }
                else { [datetime]::MinValue }
        if ($When -lt $SinceUtc) { continue }
        $Entries++
        $Missing = @($script:SpendTokenFields | Where-Object { $null -eq $Rec.PSObject.Properties[$_] -or $null -eq $Rec.$_ })
        if ($Missing.Count -gt 0) {
            New-ActionableError -Goal 'Measure batch spend from the AI call log' `
                -Problem "Call-log entry ID $($Rec.ID) (model '$($Rec.Model)', $($Rec.Datetime)) has no $($Missing -join '/'), so that call's spend is unknown" `
                -Location $Loc `
                -NextSteps @('The backend reported no usage; pick a model whose backend returns token counts', 'Or confirm the call-log writer records tokens (t/106 child)') -Throw
        }
        $Model = [string]$Rec.Model
        if (-not $Prices.ContainsKey($Model)) { $Prices[$Model] = Get-ModelPricing -ModelsJsonPath $ModelsJsonPath -Model $Model }
        $P = $Prices[$Model]
        $In = [double]$Rec.InputTokens
        $Cached = if ($Rec.PSObject.Properties['CachedInputTokens'] -and $null -ne $Rec.CachedInputTokens) { [math]::Min([double]$Rec.CachedInputTokens, $In) } else { 0.0 }
        $Usd += (($In - $Cached) * $P.InputPer1M + $Cached * $P.CachedInputPer1M + [double]$Rec.OutputTokens * $P.OutputPer1M) / 1e6
    }
    return [pscustomobject]@{ Usd = $Usd; Entries = $Entries }
}

function Get-PerDocEstimateUsd {
    <#
    .SYNOPSIS
        The per-doc spend estimate for the stop check: the largest observed doc, or a conservative
        default (with a WARN) until a doc has been measured.
    #>
    [CmdletBinding()]
    [OutputType([double])]
    param(
        [Parameter(Mandatory)][double]$ObservedMaxUsd,
        [Parameter(Mandatory)][double]$DefaultUsd
    )
    if ($ObservedMaxUsd -gt 0) { return $ObservedMaxUsd }
    Write-Warning "WARN: no measured doc yet; using the conservative default per-doc estimate `$$DefaultUsd for the budget stop (t/106)"
    return $DefaultUsd
}

function Test-BudgetStop {
    <#
    .SYNOPSIS
        True when running the next doc could exceed the cap: spent + Factor * per-doc estimate > budget.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][double]$SpentUsd,
        [Parameter(Mandatory)][double]$PerDocEstimateUsd,
        [Parameter(Mandatory)][double]$BudgetUsd,
        [double]$Factor = 1.5
    )
    return (($SpentUsd + $Factor * $PerDocEstimateUsd) -gt $BudgetUsd)
}
