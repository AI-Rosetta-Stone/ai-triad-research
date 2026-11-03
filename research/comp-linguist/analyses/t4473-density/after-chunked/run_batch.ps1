#Requires -Version 7
<#
.SYNOPSIS
    t/4473 spec §5, chunked re-run (t/4473#6): re-extract the sample docs through the default
    production batch path, Invoke-BatchSummary, scratch roots only.
.DESCRIPTION
    The first §5 run called Invoke-POVSummary, which always goes through AutoFire Stage 1 and sent
    13 of 15 docs to FIRE. This runner calls Invoke-BatchSummary -DocId <doc> with default flags
    (no -AutoFire, no -IterativeExtraction, -MaxConcurrent 1), so a large doc takes the chunked
    pipeline, as in production. -SkipConflictDetection is the only non-default flag: conflict
    detection runs after the summary is written, so it doesn't affect what is measured.

    The uncommitted token-logging patch in AIEnrich.psm1 appends each Gemini usageMetadata to
    $env:T4556_USAGE_LOG. After every doc this script prices the cumulative usage and stops before
    the next doc if it would pass -BudgetUsd, and isolation_check.py must pass or the loop stops.
#>
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SourcesRoot,
    [Parameter(Mandatory)][string]$IsoBaseline,
    [Parameter(Mandatory)][string]$LogDir,
    [double]$BudgetUsd = 1.8,
    # Upper-bound flash-lite list prices, $/M tokens (same basis as t/4556).
    [double]$InPerM = 0.30,
    [double]$OutPerM = 2.50,
    [string]$CodeRoot = ''
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Repo = if ($CodeRoot) { $CodeRoot } else { (Resolve-Path (Join-Path $Here '../../../../..')).Path }
$env:AI_TRIAD_DATA_ROOT = $DataRoot
$env:AI_TRIAD_SOURCES_ROOT = $SourcesRoot
$env:T4556_USAGE_LOG = Join-Path $LogDir 'usage.jsonl'
Import-Module (Join-Path $Repo 'scripts/AITriad/AITriad.psd1') -Force
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-SpendUsd {
    if (-not (Test-Path $env:T4556_USAGE_LOG)) { return 0.0 }
    $In = 0L; $Out = 0L
    foreach ($Line in Get-Content $env:T4556_USAGE_LOG) {
        $Um = ($Line | ConvertFrom-Json).um
        $In += [long]($Um.promptTokenCount ?? 0)
        $Out += [long]($Um.candidatesTokenCount ?? 0) + [long]($Um.thoughtsTokenCount ?? 0)
    }
    return ($In * $InPerM + $Out * $OutPerM) / 1e6
}

$Sample = @((Get-Content (Join-Path $Here 'sample.json') -Raw | ConvertFrom-Json).sample)
$PerDoc = 0.0
foreach ($S in $Sample) {
    $Log = Join-Path $LogDir "$($S.doc).log"
    if (Test-Path $Log) { Write-Host "skip (logged): $($S.doc)"; continue }
    $Spent = Get-SpendUsd
    if ($PerDoc -gt 0 -and ($Spent + 1.5 * $PerDoc) -gt $BudgetUsd) {
        Write-Warning "WARN: budget stop before $($S.doc): spent `$$([math]::Round($Spent,3)), next doc est. `$$([math]::Round(1.5*$PerDoc,3)), cap `$$BudgetUsd"
        break
    }
    Write-Host "batch: $($S.doc) [$($S.model)] spent so far `$$([math]::Round($Spent,3))"
    $Before = $Spent
    $Sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-BatchSummary -DocId $S.doc -Model $S.model -Temperature $S.temperature -SkipConflictDetection -Verbose *>&1 |
            ForEach-Object { "$_" } | Set-Content -Path $Log -Encoding utf8
    }
    catch {
        "RUN FAILED: $($_.Exception.Message)" | Add-Content -Path $Log -Encoding utf8
        Write-Warning "WARN: $($S.doc) failed: $($_.Exception.Message)"
    }
    $After = Get-SpendUsd
    $PerDoc = [math]::Max($PerDoc, $After - $Before)
    "ELAPSED_S: $([int]$Sw.Elapsed.TotalSeconds)" | Add-Content -Path $Log -Encoding utf8
    "SPEND_USD: $([math]::Round($After - $Before, 4)) (cumulative $([math]::Round($After, 4)))" | Add-Content -Path $Log -Encoding utf8
    Write-Host "  done, doc `$$([math]::Round($After - $Before,4)), cumulative `$$([math]::Round($After,4))"
    python (Join-Path $Here 'isolation_check.py') check $IsoBaseline
    if ($LASTEXITCODE -ne 0) { throw "Isolation breach after $($S.doc); stopping." }
}
Write-Host "total spend `$$([math]::Round((Get-SpendUsd),4))"
