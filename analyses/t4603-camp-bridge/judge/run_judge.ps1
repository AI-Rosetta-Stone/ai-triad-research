#Requires -Version 7
<#
.SYNOPSIS
    t/4880: run the camp-bridge judge over items.json with a fail-closed spend cap.
.DESCRIPTION
    Spend goes through the same guard as run_batch.ps1 (t/150, TL p/7#30): since #4848 every
    Invoke-AIApi call logs exactly once in any import order, and spend is read back from the call log
    for this run, priced from ai-models.json (BatchBudget.ps1). Before t/150 the judge imported only
    AIEnrich, so its paid calls never reached the call log and a concurrent guarded batch couldn't see them.

    FAILS CLOSED:
      - refuses to start unless Test-AICallLogReady says the Invoke-AIApi it resolves logs every call, the
        writer records token counts, and the judge model is priced;
      - after every call, the call log must hold THIS call's entry (PromptStart = the item's prompt, at or
        after the call started; t/151), else it stops: at most one call can ever go unaccounted, and a
        concurrent process's entry can't stand in for it;
      - a response with no usage metadata stops the run (t/4882).
    Entries another process writes to the same log inside the run window are counted too, so a judge and
    a batch running together each see the combined spend (an over-count, which only stops earlier).
.PARAMETER SpentSoFarUsd
    Spend from earlier runs against the same cap; added to this run's measured spend.
.PARAMETER DefaultPerCallUsd
    Conservative per-call estimate for the headroom check until a call has been measured.
#>
param(
    [Parameter(Mandatory)][string]$ItemsPath,
    [Parameter(Mandatory)][string]$OutPath,
    [string]$Model = 'gemini-3.5-flash-lite',
    [double]$CapUsd = 3.0,
    [double]$SpentSoFarUsd = 0.0,
    [double]$DefaultPerCallUsd = 0.01,
    [string]$CodeRoot = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = if ($CodeRoot) { $CodeRoot } else { (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path }
$env:AI_CALL_LOG_ENABLED = '1'  # this process only: the call log is the spend source
Import-Module (Join-Path $Repo 'scripts/AITriad/AITriad.psd1') -Force
. (Join-Path $PSScriptRoot '../BatchBudget.ps1')   # Test-SpendSourceReady, Get-ModelPricing, Get-RunSpendUsd, ...

$ModelsJson = Join-Path $Repo 'ai-models.json'
$Module = Get-Module AITriad
$CallLog = & $Module { Get-AICallLogPath }
$Ready = Test-AICallLogReady -Detailed
if (-not $Ready.Ready) {
    New-ActionableError -Goal 'Run the t/4880 judge within the PI-approved cap' `
        -Problem "The AI call log won't record every judge call: $($Ready.Reason)" `
        -Location 'analyses/t4603-camp-bridge/judge/run_judge.ps1' `
        -NextSteps @('Use a main that includes t/150 (#4848)', 'Do not bypass this check (t/150)') -Throw
}
$WriterParams = @(& $Module { (Get-Command Write-AICallLogEntry).Parameters.Keys })
if (-not (Test-SpendSourceReady -WriterParameterNames $WriterParams)) {
    New-ActionableError -Goal 'Run the t/4880 judge within the PI-approved cap' `
        -Problem "No spend source: the AI call log writer can't record token counts (needs $($script:SpendTokenFields -join '/'))" `
        -Location 'analyses/t4603-camp-bridge/judge/run_judge.ps1' `
        -NextSteps @('Use a main that includes t/107 (#4799)', 'Do not bypass this check (t/150)') -Throw
}
$null = Get-ModelPricing -ModelsJsonPath $ModelsJson -Model $Model   # throws if the judge model is unpriced

$RunStart = [datetime]::UtcNow
function Get-JudgeSpend { param([switch]$RequireLog) Get-RunSpendUsd -LogPath $CallLog -Since $RunStart -ModelsJsonPath $ModelsJson -RequireLog:$RequireLog }

$Items = Get-Content -Raw -Path $ItemsPath | ConvertFrom-Json
if (Test-Path $OutPath) { Remove-Item $OutPath }
$PerCall = 0.0
$Before = Get-JudgeSpend

foreach ($It in $Items) {
    $Spent = $SpentSoFarUsd + $Before.Usd
    $Est = Get-PerDocEstimateUsd -ObservedMaxUsd $PerCall -DefaultUsd $DefaultPerCallUsd
    if (Test-BudgetStop -SpentUsd $Spent -PerDocEstimateUsd $Est -BudgetUsd $CapUsd) {
        New-ActionableError -Goal 'Run the t/4880 judge within the PI-approved cap' `
            -Problem "Spend $([math]::Round($Spent,4)) USD plus the next call's estimate would pass the cap $CapUsd before item $($It.id)" `
            -Location 'run_judge.ps1' -NextSteps @('Score the partial output', 'Ask the PI before raising the cap')
        break
    }
    $Call = @{ Prompt = $It.prompt; Model = $Model; Temperature = 0; MaxTokens = 400; JsonMode = $true }
    $CallStart = [datetime]::UtcNow
    $R = Invoke-AIApi @Call   # AITriad re-exports it; it logs every call (t/150, #4848)
    $After = Get-JudgeSpend -RequireLog
    if (-not (Test-CallLogged -LogPath $CallLog -Since $CallStart -Prompt ([string]$It.prompt))) {
        New-ActionableError -Goal 'Measure spend for every judge call' `
            -Problem "Item $($It.id): the call left no AI call-log entry of its own, so its spend is invisible to the cap and to any concurrent guarded batch" `
            -Location 'run_judge.ps1' -NextSteps @('Check Test-AICallLogReady -Detailed', "Re-run from this item with -SpentSoFarUsd") -Throw
    }
    if ($null -eq $R -or $null -eq $R.Usage) {
        New-ActionableError -Goal 'Measure spend for every judge call' `
            -Problem "Item $($It.id): no response or no usage metadata, so spend can't be measured" `
            -Location 'run_judge.ps1' -NextSteps @('Check the model/backend', 'Re-run from this item with -SpentSoFarUsd')
        break
    }
    $Cost = $After.Usd - $Before.Usd
    $PerCall = [math]::Max($PerCall, $Cost)
    $Before = $After
    [pscustomobject]@{
        id = $It.id; text = $R.Text; input_tokens = $R.Usage.InputTokens
        output_tokens = $R.Usage.OutputTokens; cost_usd = [math]::Round($Cost, 6)
    } | ConvertTo-Json -Compress | Add-Content -Path $OutPath -Encoding utf8
}
$Lines = if (Test-Path $OutPath) { @(Get-Content $OutPath).Count } else { 0 }
Write-Host ("done: {0} lines, measured spend {1:N4} USD this run (+{2} earlier; cap {3})" -f $Lines, (Get-JudgeSpend).Usd, $SpentSoFarUsd, $CapUsd)
