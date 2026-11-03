#Requires -Version 7
<#
.SYNOPSIS
    t/4473 spec §5: re-extract the sample docs on post-t/4519 code, scratch roots only.
.DESCRIPTION
    Imports the AITriad module from this worktree, points AI_TRIAD_DATA_ROOT and
    AI_TRIAD_SOURCES_ROOT at scratch copies, and runs Invoke-POVSummary -Force per document
    with the model and temperature of its saved summary. Each run's verbose/warning stream
    goes to logs/<doc>.log. After every document, isolation_check.py must pass or the loop stops.
#>
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [Parameter(Mandatory)][string]$SourcesRoot,
    [Parameter(Mandatory)][string]$IsoBaseline,
    [Parameter(Mandatory)][string]$LogDir,
    [int]$Limit = 0,
    # Code checkout to import AITriad from; defaults to this worktree. The pre-#3867 arm passes a
    # detached worktree at cbfc37be^.
    [string]$CodeRoot = ''
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Repo = if ($CodeRoot) { $CodeRoot } else { (Resolve-Path (Join-Path $Here '../../../../..')).Path }
$env:AI_TRIAD_DATA_ROOT = $DataRoot
$env:AI_TRIAD_SOURCES_ROOT = $SourcesRoot
Import-Module (Join-Path $Repo 'scripts/AITriad/AITriad.psd1') -Force
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Sample = @((Get-Content (Join-Path $Here 'sample.json') -Raw | ConvertFrom-Json).sample)
if ($Limit -gt 0) { $Sample = @($Sample | Select-Object -First $Limit) }
foreach ($S in $Sample) {
    $Log = Join-Path $LogDir "$($S.doc).log"
    if (Test-Path $Log) { Write-Host "skip (logged): $($S.doc)"; continue }
    Write-Host "re-extract: $($S.doc) [$($S.model)]"
    $Sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        # -ApiKey is passed explicitly: the FIRE path binds a Mandatory [string]$ApiKey, and
        # Resolve-POVSummaryApiKey forwards '' for env-sourced keys (t/4087), so FIRE fails without it.
        Invoke-POVSummary -DocId $S.doc -Model $S.model -Temperature $S.temperature -ApiKey $env:GEMINI_API_KEY -Force -Verbose *>&1 |
            ForEach-Object { "$_" } | Set-Content -Path $Log -Encoding utf8
    }
    catch {
        "RUN FAILED: $($_.Exception.Message)" | Add-Content -Path $Log -Encoding utf8
        Write-Warning "WARN: $($S.doc) failed: $($_.Exception.Message)"
    }
    "ELAPSED_S: $([int]$Sw.Elapsed.TotalSeconds)" | Add-Content -Path $Log -Encoding utf8
    python (Join-Path $Here 'isolation_check.py') check $IsoBaseline
    if ($LASTEXITCODE -ne 0) { throw "Isolation breach after $($S.doc); stopping." }
}
