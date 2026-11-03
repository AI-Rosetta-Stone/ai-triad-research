#Requires -Version 7
<#
.SYNOPSIS
    t/4556 AC1: run each sample doc through both production entry points, on scratch roots only.
.DESCRIPTION
    FIRE arm:    Invoke-POVSummary -Force (whole-doc pipeline; AutoFire Stage 1 routes large docs to FIRE).
    Chunked arm: Invoke-BatchSummary -DocId (default path; large docs go to Invoke-ChunkedSummary).
    Same model, temperature and code (a detached origin/main worktree whose only local edit appends
    Gemini usageMetadata to $env:T4556_USAGE_LOG, so spend is measured, not estimated). Each arm has
    its own detached ai-triad-data worktree and its own scratch sources copy. isolation_check.py runs
    after every arm and stops the loop on any change to the real repos. The spend guard stops the
    loop before a doc whose worst-case reserve would push the running total past the cap.
#>
param(
    [Parameter(Mandatory)][string]$CodeRoot,
    [Parameter(Mandatory)][string]$Scratch,
    [string]$Model = 'gemini-3.5-flash-lite',
    [double]$Temperature = 0.1,
    [double]$PlanStop = 1.5,     # stop starting new docs once spend passes the plan
    [double]$HardCap = 3.0,      # PI cap (t/4556#3)
    [double]$PerDocReserve = 0.40
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$DataRoot = 'C:/Users/jsnov/repos/ai-triad-data/.worktrees'
$env:T4556_USAGE_LOG = Join-Path $Scratch 'usage.jsonl'
Import-Module (Join-Path $CodeRoot 'scripts/AITriad/AITriad.psd1') -Force
$Key = $env:GEMINI_API_KEY
if (-not $Key) { throw 'GEMINI_API_KEY not set.' }

function Get-Spend {
    # Upper-bound flash-lite list pricing, as in t/4473: $0.30/M input, $2.50/M output (thoughts billed as output).
    if (-not (Test-Path $env:T4556_USAGE_LOG)) { return 0.0 }
    $c = 0.0
    foreach ($l in Get-Content $env:T4556_USAGE_LOG) {
        $u = ($l | ConvertFrom-Json).um
        $in = [double]$u.promptTokenCount
        $c += $in * 0.30 / 1e6 + ([double]$u.totalTokenCount - $in) * 2.50 / 1e6
    }
    [math]::Round($c, 4)
}

function Use-Arm([string]$Arm) {
    $env:AI_TRIAD_DATA_ROOT    = "$DataRoot/data-t4556-$Arm"
    $env:AI_TRIAD_SOURCES_ROOT = Join-Path $Scratch "src-$Arm"
    $mod = Get-Module AITriad
    $d = & $mod { Get-DataRoot }; $s = & $mod { Get-SourcesDir }
    if ($d -notlike "*data-t4556-$Arm*" -or $s -notlike "*src-$Arm*") { throw "Roots not redirected for $Arm ($d | $s); aborting." }
}

python (Join-Path $Here 'isolation_check.py') snap (Join-Path $Scratch 'iso_base.json')
$Sample = @((Get-Content (Join-Path $Here 'sample.json') -Raw | ConvertFrom-Json).sample)
foreach ($S in $Sample) {
    $Spent = Get-Spend
    if ($Spent -ge $PlanStop -or ($Spent + $PerDocReserve) -gt $HardCap) {
        Write-Warning "WARN: spend guard stop before $($S.doc): spent `$$Spent (plan `$$PlanStop, cap `$$HardCap)"
        break
    }
    foreach ($Arm in 'fire', 'chunk') {
        $Log = Join-Path $Scratch "logs/$($S.doc).$Arm.log"
        if (Test-Path $Log) { Write-Host "skip (logged): $($S.doc) $Arm"; continue }
        Use-Arm $Arm
        Write-Host "=== $Arm $($S.doc)  (spent so far `$$(Get-Spend))"
        $Sw = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ($Arm -eq 'fire') {
                Invoke-POVSummary -DocId $S.doc -Model $Model -Temperature $Temperature -ApiKey $Key -Force -Verbose *>&1 |
                    ForEach-Object { "$_" } | Set-Content -Path $Log -Encoding utf8
            } else {
                Invoke-BatchSummary -DocId $S.doc -Model $Model -Temperature $Temperature -SkipConflictDetection -Verbose *>&1 |
                    ForEach-Object { "$_" } | Set-Content -Path $Log -Encoding utf8
            }
        }
        catch {
            "RUN FAILED: $($_.Exception.Message)" | Add-Content -Path $Log -Encoding utf8
            Write-Warning "WARN: $Arm $($S.doc) failed: $($_.Exception.Message)"
        }
        "ELAPSED_S: $([int]$Sw.Elapsed.TotalSeconds)" | Add-Content -Path $Log -Encoding utf8
        python (Join-Path $Here 'isolation_check.py') check (Join-Path $Scratch 'iso_base.json')
        if ($LASTEXITCODE -ne 0) { throw "Isolation breach after $Arm $($S.doc); stopping." }
    }
}
Write-Host "TOTAL SPEND (upper bound): `$$(Get-Spend)"
