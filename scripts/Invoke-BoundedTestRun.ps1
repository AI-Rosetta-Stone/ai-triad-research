# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Runs Invoke-Pester in a child process under a wall-clock and memory ceiling (t/4626).
.DESCRIPTION
    t/4626: an unbounded `Invoke-Pester -Path tests/` run grew to 15 GB RSS over ~4h, starved the
    host to under 500 MB free, and OOM-crash-looped the Orca server fleet. Pester has no built-in
    run-level timeout or memory ceiling, so this wraps it in a child process this script can kill.

    The child is a separate `pwsh` process (not a background job in this process) specifically so
    its working set is visible to, and independently killable by, the parent -- a runaway Pester
    run must not be able to take this process down with it.

    On a timeout or memory-ceiling breach the child is force-killed and this throws an
    ActionableError; it does NOT retry or fall back silently (docs/error-handling.md: an
    unrecoverable condition here is exactly "the run cannot be trusted to finish on its own").
.PARAMETER Path
    Passed through to Invoke-Pester -Path. Default: @('tests/') (the whole suite).
.PARAMETER TimeoutMinutes
    Wall-clock ceiling. Default 30 -- generous for a legitimately slow full run across hundreds of
    test files, but a hard stop well short of "hours."
.PARAMETER MaxMemoryMB
    Working-set ceiling for the child pwsh process. Default 3072 (3 GB) -- comfortably above any
    single test file's normal footprint (dozens to low hundreds of MB observed per-file in this
    repo) and far below the 15 GB the t/4626 run reached before anyone noticed.
.PARAMETER PollSeconds
    How often to sample the child's memory/elapsed time. Default 5.
.OUTPUTS
    [pscustomobject] { ExitCode; Output; KilledReason (null|'Timeout'|'MemoryCeiling'); ElapsedSeconds; PeakMemoryMB }
#>
[CmdletBinding()]
param(
    [string[]]$Path = @('tests/'),
    [string]$OutputLevel = 'Minimal',
    [int]$TimeoutMinutes = 30,
    [int]$MaxMemoryMB = 3072,
    [int]$PollSeconds = 5
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Dot-sourced directly (not Import-Module): New-ActionableError is a Private, unexported module
# helper, and this script runs standalone, outside the AITriad module.
. (Join-Path $PSScriptRoot 'AITriad' 'Private' 'New-ActionableError.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stdout = [System.IO.Path]::GetTempFileName()
$stderr = [System.IO.Path]::GetTempFileName()

$quotedPaths = ($Path | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
$pesterCommand = "Invoke-Pester -Path @($quotedPaths) -Output $OutputLevel"
# Timed with a Stopwatch, not $proc.StartTime: StartTime is unreliable for a just-launched
# process on some platforms (observed: Linux CI throws "Cannot find an overload for
# op_Subtraction" when it's read back for the elapsed-time calculation below).
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath 'pwsh' `
    -ArgumentList @('-NoProfile', '-Command', $pesterCommand) `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -PassThru -NoNewWindow

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$maxBytes = [int64]$MaxMemoryMB * 1MB
$peakMB = 0
$killedReason = $null

try {
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds $PollSeconds
        try { $proc.Refresh() } catch { continue }   # process may have exited between checks
        if ($proc.HasExited) { break }

        $memMB = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        if ($memMB -gt $peakMB) { $peakMB = $memMB }

        if ($proc.WorkingSet64 -gt $maxBytes) {
            $killedReason = 'MemoryCeiling'
            break
        }
        if ((Get-Date) -gt $deadline) {
            $killedReason = 'Timeout'
            break
        }
    }

    if ($killedReason) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300   # let the OS release the handle before reading temp files
    }
}
finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

$stopwatch.Stop()
$elapsed = [int]$stopwatch.Elapsed.TotalSeconds
$output = @()
if (Test-Path -LiteralPath $stdout) { $output += (Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) }
if (Test-Path -LiteralPath $stderr) { $output += (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue) }
Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue

$result = [pscustomobject]@{
    ExitCode       = if ($killedReason) { -1 } else { $proc.ExitCode }
    Output         = ($output -join "`n")
    KilledReason   = $killedReason
    ElapsedSeconds = $elapsed
    PeakMemoryMB   = $peakMB
}

if ($killedReason -eq 'MemoryCeiling') {
    New-ActionableError -Throw `
        -Goal "Run Pester over '$Path' without starving the host" `
        -Problem "the test run's working set reached ${peakMB}MB, over the ${MaxMemoryMB}MB ceiling, and was killed after ${elapsed}s (t/4626)" `
        -Location 'Invoke-BoundedTestRun.ps1' `
        -NextSteps @(
            'Narrow -Path to bisect which test file is accumulating memory',
            'Check for an unbounded in-process accumulator (a growing array/string/log never cleared across test files in the same Pester session)',
            'File/update t/4626 with the narrowed file once found'
        )
}
if ($killedReason -eq 'Timeout') {
    New-ActionableError -Throw `
        -Goal "Run Pester over '$Path' without hanging indefinitely" `
        -Problem "the test run exceeded the ${TimeoutMinutes}-minute ceiling and was killed after ${elapsed}s (peak ${peakMB}MB) (t/4626)" `
        -Location 'Invoke-BoundedTestRun.ps1' `
        -NextSteps @(
            'Narrow -Path to bisect which test file is hanging',
            'Check for an unmocked network/AI call with no -TimeoutSec, or a retry/backoff loop with no cap',
            'File/update t/4626 with the narrowed file once found'
        )
}

$result
