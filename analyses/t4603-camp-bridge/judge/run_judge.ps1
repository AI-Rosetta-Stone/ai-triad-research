#Requires -Version 7
<#
.SYNOPSIS
    t/4880: run the camp-bridge judge over items.json with a fail-closed spend cap.
.DESCRIPTION
    Spend is computed from the token usage each response returns, priced at deliberately
    high rates (input $1.00/1M, output $4.00/1M), so the cap binds early rather than late.
    A response with no usage metadata stops the run: an unmeasured call can't be counted
    against the cap (t/4882).
#>
param(
    [Parameter(Mandatory)][string]$ItemsPath,
    [Parameter(Mandatory)][string]$OutPath,
    [string]$Model = 'gemini-3.5-flash-lite',
    [double]$CapUsd = 3.0,
    [double]$SpentSoFarUsd = 0.0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot '../../../scripts/AIEnrich.psm1') -Force -DisableNameChecking
. (Join-Path $PSScriptRoot '../../../scripts/AITriad/Private/New-ActionableError.ps1')  # private to AITriad; the stop paths need it

$InPricePerTok  = 1.00 / 1e6
$OutPricePerTok = 4.00 / 1e6
$Spent = $SpentSoFarUsd
$Items = Get-Content -Raw -Path $ItemsPath | ConvertFrom-Json
if (Test-Path $OutPath) { Remove-Item $OutPath }

foreach ($It in $Items) {
    if ($Spent -ge $CapUsd) {
        New-ActionableError -Goal 'Run the t/4880 judge within the PI-approved cap' `
            -Problem "Spend estimate $([math]::Round($Spent,4)) USD reached the cap $CapUsd before item $($It.id)" `
            -Location 'run_judge.ps1' -NextSteps @('Score the partial output', 'Ask the PI before raising the cap')
        break
    }
    $R = Invoke-AIApi -Prompt $It.prompt -Model $Model -Temperature 0 -MaxTokens 400 -JsonMode
    if ($null -eq $R -or $null -eq $R.Usage) {
        New-ActionableError -Goal 'Measure spend for every judge call' `
            -Problem "Item $($It.id): no response or no usage metadata, so spend can't be measured" `
            -Location 'run_judge.ps1' -NextSteps @('Check the model/backend', 'Re-run from this item with -SpentSoFarUsd')
        break
    }
    $Cost = $R.Usage.InputTokens * $InPricePerTok + $R.Usage.OutputTokens * $OutPricePerTok
    $Spent += $Cost
    [pscustomobject]@{
        id = $It.id; text = $R.Text; input_tokens = $R.Usage.InputTokens
        output_tokens = $R.Usage.OutputTokens; cost_usd_upper = [math]::Round($Cost, 6)
    } | ConvertTo-Json -Compress | Add-Content -Path $OutPath -Encoding utf8
}
$Lines = if (Test-Path $OutPath) { @(Get-Content $OutPath).Count } else { 0 }
Write-Host ("done: {0} lines, spend upper-bound {1:N4} USD (cap {2})" -f $Lines, $Spent, $CapUsd)
