#Requires -Version 7
<#
.SYNOPSIS
    t/4603 re-measure: re-extract the t/4473 §5 sample through Invoke-BatchSummary (default
    flags) on top of the landed camp-bridge-ban prompt fix (t/4600#1, PR #4112).
.DESCRIPTION
    Same sample, same default-batch-path methodology as t/4473's own §5 "after-chunked" run, so
    the resulting off-tag share is directly comparable to that run's 53%. PI-approved spend, cap
    $1.50 (TL p/360#721), stop-before-exceed logic identical to the t/4473/t/4556 precedent.

    Spend (t/106): measured from the AI call log for this run, priced from ai-models.json, and it
    FAILS CLOSED. The harness refuses to start unless the call-log writer records token counts, and
    stops with an error if a doc's spend can't be measured. The old T4556_USAGE_LOG source was
    retired, so every doc used to log $0 and the cap never fired. See BatchBudget.ps1.
.PARAMETER DefaultPerDocUsd
    Conservative per-doc spend estimate for the stop check until a doc has been measured.
#>
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SourcesRoot,
    [Parameter(Mandatory)][string]$IsoBaseline,
    [Parameter(Mandatory)][string]$LogDir,
    [double]$BudgetUsd = 1.5,
    [double]$DefaultPerDocUsd = 0.25,
    [string]$CodeRoot = ''
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Repo = if ($CodeRoot) { $CodeRoot } else { (Resolve-Path (Join-Path $Here '../..')).Path }
$env:AI_TRIAD_DATA_ROOT = $DataRoot
$env:AI_TRIAD_SOURCES_ROOT = $SourcesRoot
$env:AI_CALL_LOG_ENABLED = '1'  # this process only: the call log is the spend source
Import-Module (Join-Path $Repo 'scripts/AITriad/AITriad.psd1') -Force
. (Join-Path $Here 'BatchBudget.ps1')
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$ModelsJson = Join-Path $Repo 'ai-models.json'
$Module = Get-Module AITriad
$CallLog = & $Module { Get-AICallLogPath }
$WriterParams = @(& $Module { (Get-Command Write-AICallLogEntry).Parameters.Keys })
if (-not (Test-SpendSourceReady -WriterParameterNames $WriterParams)) {
    New-ActionableError -Goal 'Run the t/4603 batch within the PI-approved cap' `
        -Problem "No spend source: the AI call log writer can't record token counts (needs $($script:SpendTokenFields -join '/')), so this paid run would be unguarded" `
        -Location 'analyses/t4603-camp-bridge/run_batch.ps1' `
        -NextSteps @('Wait for the t/106 child ticket: token fields in the call-log record, and the summary pipeline logging its Invoke-AIApi calls',
                     'Do not bypass this check; the cap never fired the last time spend was unmeasured (t/4882)') -Throw
}
# Every model in the sample must be priced before the first paid call.
foreach ($M in @((Get-Content (Join-Path $Here 'sample.json') -Raw | ConvertFrom-Json).sample.model | Sort-Object -Unique)) {
    $null = Get-ModelPricing -ModelsJsonPath $ModelsJson -Model $M
}

$RunStart = [datetime]::UtcNow
function Get-SpendUsd { param([switch]$RequireLog) Get-RunSpendUsd -LogPath $CallLog -Since $RunStart -ModelsJsonPath $ModelsJson -RequireLog:$RequireLog }

$Sample = @((Get-Content (Join-Path $Here 'sample.json') -Raw | ConvertFrom-Json).sample)
$PerDoc = 0.0
foreach ($S in $Sample) {
    $Log = Join-Path $LogDir "$($S.doc).log"
    if (Test-Path $Log) { Write-Host "skip (logged): $($S.doc)"; continue }
    $Before = Get-SpendUsd
    $Spent = $Before.Usd
    $Est = Get-PerDocEstimateUsd -ObservedMaxUsd $PerDoc -DefaultUsd $DefaultPerDocUsd
    if (Test-BudgetStop -SpentUsd $Spent -PerDocEstimateUsd $Est -BudgetUsd $BudgetUsd) {
        Write-Warning "WARN: budget stop before $($S.doc): spent `$$([math]::Round($Spent,3)), next doc est. `$$([math]::Round(1.5*$Est,3)), cap `$$BudgetUsd"
        break
    }
    Write-Host "batch: $($S.doc) [$($S.model)] spent so far `$$([math]::Round($Spent,3))"
    $Sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-BatchSummary -DocId $S.doc -Model $S.model -Temperature $S.temperature -SkipConflictDetection -Verbose *>&1 |
            ForEach-Object { "$_" } | Set-Content -Path $Log -Encoding utf8
    }
    catch {
        "RUN FAILED: $($_.Exception.Message)" | Add-Content -Path $Log -Encoding utf8
        Write-Warning "WARN: $($S.doc) failed: $($_.Exception.Message)"
    }
    $After = Get-SpendUsd -RequireLog
    if ($After.Entries -le $Before.Entries) {
        "SPEND_USD: UNMEASURED (no call-log entries for this doc)" | Add-Content -Path $Log -Encoding utf8
        New-ActionableError -Goal 'Measure the spend of every batch doc' `
            -Problem "$($S.doc) left no AI call-log entries, so its spend is unknown; continuing would run the cap blind" `
            -Location 'analyses/t4603-camp-bridge/run_batch.ps1' `
            -NextSteps @("Check $Log for where the doc failed", 'Confirm the summary pipeline logs its Invoke-AIApi calls (t/106 child)', 'Re-run; logged docs are skipped') -Throw
    }
    $DocUsd = $After.Usd - $Before.Usd
    $PerDoc = [math]::Max($PerDoc, $DocUsd)
    "ELAPSED_S: $([int]$Sw.Elapsed.TotalSeconds)" | Add-Content -Path $Log -Encoding utf8
    "SPEND_USD: $([math]::Round($DocUsd, 4)) (cumulative $([math]::Round($After.Usd, 4)))" | Add-Content -Path $Log -Encoding utf8
    Write-Host "  done, doc `$$([math]::Round($DocUsd,4)), cumulative `$$([math]::Round($After.Usd,4))"
    python (Join-Path $Here 'isolation_check.py') check $IsoBaseline
    if ($LASTEXITCODE -ne 0) { throw "Isolation breach after $($S.doc); stopping." }
}
Write-Host "total spend `$$([math]::Round((Get-SpendUsd).Usd,4))"
