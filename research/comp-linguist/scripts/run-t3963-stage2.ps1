#Requires -Version 7
<#
.SYNOPSIS
    Runs the remaining t/3963 POV-tag pilot stage-2 debates on their own, without Orca, so its memory is free.

.DESCRIPTION
    Approved by the PI on t/3963#11 (option B: 54 debates, fixed 3 rounds, $12.50 hard stop).

    It drives the same runner the CL uses (scripts/paid_batch_runner.py), one debate at a time, against
    the same frozen code (7ffb7c3f) and the same ledger. So every safeguard still applies:
      - the plan's approval reference is checked before any spend;
      - each debate's reserve is booked BEFORE it starts, and a debate that could cross the $12.50 hard
        stop is refused;
      - each finished debate's model, protocol, seats and tags are checked against the plan, and the run
        aborts on any mismatch.
    It's safe to stop with Ctrl+C at any time: the in-flight debate stays booked at its reserve, and a
    re-run skips every finished debate.

    It writes nothing to git. It writes debates to ai-triad-data/debates/t3963-tag-pilot-stage2/ and
    updates the ledger. The CL commits and analyses the results afterwards.

.PARAMETER Force
    Skip the "continue?" prompt that appears when less than 3 GB of memory is available.

.PARAMETER PreflightOnly
    Run every pre-flight check and print the ledger, then stop before any debate runs. No spend.

.EXAMPLE
    pwsh -File C:\Users\jsnov\repos\ai-triad-research\.worktrees\cl-rerun\research\comp-linguist\scripts\run-t3963-stage2.ps1
#>
[CmdletBinding()]
param([switch]$Force, [switch]$PreflightOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CL       = Split-Path -Parent $PSScriptRoot                     # ...\research\comp-linguist
$CodeRoot = 'C:\Users\jsnov\repos\ai-triad-research\.worktrees\cl-arm-7ffb7c3f'
$Batch    = Join-Path $CL 'analyses\paid-batch-20261020'
$Plan     = Join-Path $Batch 't3963-stage2-plan.json'
$Ledger   = Join-Path $Batch 'ledger-stage2.json'
$Log      = Join-Path $Batch ("stage2-run-{0:yyyyMMdd-HHmm}.log" -f (Get-Date))
# The plan's 54 slots and the $12.50 stop are the real limits. NOTE: --max-debates applies only to a new
# ledger. ledger-stage2.json was created with max_debates 54, so the 2026-10-22 run stopped at 54 counted
# attempts (53 completed + 1 failed) and m10-a5 never ran. The runner now WARNs when a flag is ignored.
$RunnerArgs = @('scripts\paid_batch_runner.py', '--plan', $Plan, '--ledger', $Ledger, '--code-root', $CodeRoot,
                '--budget', '12.5', '--max-debates', '60', '--reserve', '0.25', '--timeout', '1200')

function Write-Log([string]$Message, [string]$Color = 'Gray') {
    $line = '{0:HH:mm:ss}  {1}' -f (Get-Date), $Message
    Write-Host $line -ForegroundColor $Color
    Add-Content -Path $Log -Value $line -Encoding utf8
}

function Get-LedgerSummary {
    $d = Get-Content $Ledger -Raw | ConvertFrom-Json
    $rows = @($d.debates)
    [pscustomobject]@{
        Ok      = @($rows | Where-Object status -eq 'ok').Count
        Failed  = @($rows | Where-Object status -eq 'failed').Count
        Spent   = [math]::Round((@($rows | ForEach-Object {
                      $u = $_.PSObject.Properties['usd']; if ($u -and $null -ne $u.Value) { [double]$u.Value } else { 0 } }) |
                      Measure-Object -Sum).Sum, 2)
    }
}

# Keep Windows awake while debates run (released on exit).
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

# ── Pre-flight ───────────────────────────────────────────────────────────────
Write-Log "t/3963 stage 2 standalone run. Log: $Log" 'Cyan'
foreach ($p in @($Plan, $Ledger, (Join-Path $CL 'scripts\paid_batch_runner.py'), $CodeRoot)) {
    if (-not (Test-Path $p)) { throw "Pre-flight: missing $p" }
}
foreach ($cmd in @('python', 'npx')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Pre-flight: '$cmd' isn't on PATH" }
}
if (-not ($env:GEMINI_API_KEY -or $env:AI_API_KEY)) {
    throw 'Pre-flight: no GEMINI_API_KEY (or AI_API_KEY) in this window. Open a terminal that has it set.'
}
Write-Log 'API key: present (not shown)'

try {
    $resp = Invoke-WebRequest 'https://generativelanguage.googleapis.com/v1beta/models' -TimeoutSec 20 -SkipHttpErrorCheck
    Write-Log "Gemini endpoint reachable (HTTP $($resp.StatusCode); 403 without a key is expected)"
} catch { throw "Pre-flight: Gemini endpoint unreachable ($($_.Exception.Message)). Check the network and re-run." }

$stray = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'lib/debate/cli.ts' })
if ($stray.Count -gt 0) { throw "Pre-flight: $($stray.Count) debate process(es) already running. Wait for them, or stop them, then re-run." }

$availGB = [math]::Round((Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue / 1024, 1)
Write-Log "Memory available: $availGB GB"
if ($availGB -lt 3 -and -not $Force) {
    $ans = Read-Host "Only $availGB GB available (3+ recommended). Continue anyway? [y/N]"
    if ($ans -notmatch '^(y|yes)$') { Write-Log 'Stopped at the memory check. Nothing ran.' 'Yellow'; return }
}

$s = Get-LedgerSummary
Write-Log ("Ledger before: {0} completed, {1} failed attempts, `${2} of `$12.50 spent" -f $s.Ok, $s.Failed, $s.Spent)
if ($PreflightOnly) { Write-Log 'Pre-flight passed. -PreflightOnly set, so no debate ran.' 'Green'; return }

# ── Run ──────────────────────────────────────────────────────────────────────
$null = [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
$exit = $null
Push-Location $CL
try {
    while ($true) {
        & python -u @RunnerArgs 2>&1 | ForEach-Object { Write-Log "  $_" }
        $exit = $LASTEXITCODE
        if ($exit -ne 0) { break }
    }
} finally {
    Pop-Location
    $null = [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}

# ── Outcome ──────────────────────────────────────────────────────────────────
$s = Get-LedgerSummary
$what = switch ($exit) {
    10 { 'PLAN COMPLETE: all 54 stage-2 debates are done.' }
    11 { 'HARD STOP: the $12.50 cap (or the count cap) refused the next debate. This is a safe, expected stop.' }
    3  { 'ABORTED: a finished debate did not match the plan (pin mismatch). Nothing more ran. Tell the CL.' }
    4  { 'A debate FAILED (often a temporary API or network fault). Its reserve is booked. Re-run this script to continue.' }
    5  { 'REFUSED: the plan has no recorded approval reference. Nothing ran. Tell the CL.' }
    default { "Runner exited with code $exit. Tell the CL." }
}
$color = if ($exit -eq 10 -or $exit -eq 11) { 'Green' } else { 'Yellow' }
Write-Log $what $color
Write-Log ("Ledger after: {0} completed, {1} failed attempts, `${2} of `$12.50 spent" -f $s.Ok, $s.Failed, $s.Spent) $color
Write-Log "When Orca is back, tell the CL: 'stage 2 run finished, see $Log'." 'Cyan'
