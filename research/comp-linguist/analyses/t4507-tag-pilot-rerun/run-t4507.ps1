#Requires -Version 7
<#
.SYNOPSIS
    Runs the remaining t/4507 POV-tag pilot re-run debates, one at a time, with a progress bar. Safe to stop
    at any time and to resume: re-run this script and it continues from where it left off.

.DESCRIPTION
    PI-approved spend with a $25 cap (t/4507#1, #2). Pre-registered in PREREG.md and AMENDMENT-1.md.

    Every spend safeguard lives in paid_batch_runner.py: the approval check, a reserve booked before each
    debate, a refusal of any debate that could cross the $25 cap, a pin check on each finished debate, and a
    lock so only one runner works this ledger at a time.

    STOPPING
      - Clean stop (recommended): create a file named STOP next to this script, for example
          New-Item "<this folder>\STOP"
        The current debate finishes, then the run stops. Nothing is wasted.
      - Immediate stop: Ctrl+C. The debate in progress is abandoned. Its reserve stays booked (its spend
        can't be proven), and it is re-run from the start on resume.
    RESUMING
      Run this script again. Finished debates are skipped, an interrupted debate is re-run, and the progress
      bar picks up the totals from the ledger.

    Writes debates to ai-triad-data/debates/t4507-tag-pilot-rerun/ and updates ledger.json next to this
    script. Writes nothing to git; the CL commits and analyses afterwards.

.PARAMETER Force
    Skip the "continue?" prompt that appears when less than 3 GB of memory is available.

.PARAMETER PreflightOnly
    Run every pre-flight check and print the ledger, then stop before any debate runs. No spend.

.EXAMPLE
    pwsh -File C:\Users\jsnov\repos\ai-triad-research\.worktrees\t4507\research\comp-linguist\analyses\t4507-tag-pilot-rerun\run-t4507.ps1
#>
[CmdletBinding()]
param([switch]$Force, [switch]$PreflightOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here     = $PSScriptRoot
$Repo     = (Resolve-Path (Join-Path $Here '..\..\..\..')).Path
$Runner   = Join-Path $Repo 'research\comp-linguist\scripts\paid_batch_runner.py'
$Plan     = Join-Path $Here 'plan.json'
$Ledger   = Join-Path $Here 'ledger.json'
$StopFile = Join-Path $Here 'STOP'
$CodeRoot = 'C:\Users\jsnov\repos\ai-triad-research\.worktrees\cl-arm-00aff3a6'
$Log      = Join-Path $Here ('run-{0:yyyyMMdd-HHmm}.log' -f (Get-Date))
$CapUsd   = 25.0
$RunnerArgs = @('-u', $Runner, '--plan', $Plan, '--ledger', $Ledger, '--code-root', $CodeRoot,
                '--budget', '25', '--max-debates', '50', '--reserve', '0.6', '--timeout', '1800')

function Write-Log([string]$Message, [string]$Color = 'Gray') {
    $line = '{0:HH:mm:ss}  {1}' -f (Get-Date), $Message
    Write-Host $line -ForegroundColor $Color
    Add-Content -Path $Log -Value $line -Encoding utf8
}

function Get-RunState {
    # Totals for the progress bar and the summary, read from the ledger (the runner's source of truth).
    $total = @((Get-Content $Plan -Raw | ConvertFrom-Json).debates).Count
    $rows = @()
    if (Test-Path $Ledger) { $rows = @((Get-Content $Ledger -Raw | ConvertFrom-Json).debates) }
    $usd = 0.0
    foreach ($r in $rows) { $u = $r.PSObject.Properties['usd']; if ($u -and $null -ne $u.Value) { $usd += [double]$u.Value } }
    $okRows = @($rows | Where-Object status -eq 'ok')
    $secs = @($okRows | ForEach-Object { $s = $_.PSObject.Properties['secs']; if ($s -and $s.Value) { [double]$s.Value } } | Sort-Object)
    $typical = if ($secs.Count) { $secs[[int][Math]::Floor($secs.Count / 2)] } else { 540.0 }
    [pscustomobject]@{
        Total       = $total
        Done        = $okRows.Count
        Failed      = @($rows | Where-Object status -eq 'failed').Count
        Interrupted = @($rows | Where-Object { $_.status -in @('interrupted', 'in-flight') }).Count
        Spent       = [Math]::Round($usd, 2)
        TypicalSecs = $typical
    }
}

function Show-Progress($State, [string]$Slug, [double]$Elapsed) {
    $left = [Math]::Max(0, $State.Total - $State.Done)
    $etaMin = [Math]::Round(($left * $State.TypicalSecs - $Elapsed) / 60)
    $finish = (Get-Date).AddMinutes([Math]::Max(0, $etaMin)).ToString('HH:mm')
    Write-Progress -Id 1 -Activity "t/4507 POV-tag re-run" `
        -Status ("{0} of {1} debates done | `${2:N2} of `${3:N0} spent | about {4} min left (done ~{5})" -f
                 $State.Done, $State.Total, $State.Spent, $CapUsd, $etaMin, $finish) `
        -PercentComplete ([int](100 * $State.Done / [Math]::Max(1, $State.Total)))
    if ($Slug) {
        $pct = [int][Math]::Min(99, 100 * $Elapsed / [Math]::Max(1, $State.TypicalSecs))
        Write-Progress -Id 2 -ParentId 1 -Activity "Debate $($State.Done + 1): $Slug" `
            -Status ("{0:mm\:ss} elapsed (a debate usually takes about {1:N0} min)" -f
                     [TimeSpan]::FromSeconds($Elapsed), ($State.TypicalSecs / 60)) -PercentComplete $pct
    } else {
        Write-Progress -Id 2 -ParentId 1 -Activity 'Between debates' -Completed
    }
}

function Stop-ProcessTree([int]$ProcessId) {
    # A stopped runner must not leave npx/node running and spending (t/4507: an orphan outlived its runner).
    & taskkill /T /F /PID $ProcessId 2>&1 | Out-Null
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
Write-Log "t/4507 POV-tag re-run. Log: $Log" 'Cyan'
foreach ($p in @($Plan, $Runner, $CodeRoot)) { if (-not (Test-Path $p)) { throw "Pre-flight: missing $p" } }
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

# A debate left running by a closed window would write the same files as the resumed one.
$stray = @(Get-CimInstance Win32_Process |
           Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 't4507-tag-pilot-rerun' })
if ($stray.Count) {
    $ids = ($stray | ForEach-Object ProcessId) -join ', '
    throw "Pre-flight: $($stray.Count) t/4507 debate process(es) still running (PID $ids), probably from a closed window. Stop them first: taskkill /T /F /PID <pid>. Then re-run."
}
$availGB = [Math]::Round((Get-Counter '\Memory\Available MBytes').CounterSamples[0].CookedValue / 1024, 1)
Write-Log "Memory available: $availGB GB"
if ($availGB -lt 3 -and -not $Force) {
    $ans = Read-Host "Only $availGB GB available (3+ recommended). Continue anyway? [y/N]"
    if ($ans -notmatch '^(y|yes)$') { Write-Log 'Stopped at the memory check. Nothing ran.' 'Yellow'; return }
}
if (Test-Path $StopFile) {
    Remove-Item $StopFile
    Write-Log 'Removed a leftover STOP file from an earlier run.' 'Yellow'
}

$s = Get-RunState
$resume = if ($s.Done -or $s.Failed -or $s.Interrupted) { 'Resuming' } else { 'Starting' }
Write-Log ("{0}: {1} of {2} done, {3} failed attempt(s), {4} interrupted, `${5} of `${6} spent" -f
           $resume, $s.Done, $s.Total, $s.Failed, $s.Interrupted, $s.Spent, $CapUsd) 'Cyan'
Write-Log "To stop cleanly after the current debate: New-Item `"$StopFile`"   (Ctrl+C stops at once.)" 'Cyan'
if ($PreflightOnly) { Write-Log 'Pre-flight passed. -PreflightOnly set, so no debate ran.' 'Green'; return }

# ── Run ──────────────────────────────────────────────────────────────────────
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[void][Win32.Power]::SetThreadExecutionState([uint32]'0x80000001')   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

$failStreak = 0
$why = $null
$child = $null
$outFile = Join-Path $Here '.runner-stdout.tmp'
$errFile = Join-Path $Here '.runner-stderr.tmp'
try {
    while ($true) {
        if (Test-Path $StopFile) {
            Remove-Item $StopFile
            $why = 'STOPPED on request (STOP file). Re-run this script to resume.'; break
        }
        $s = Get-RunState
        Show-Progress $s $null 0

        # The runner runs as a child so the progress bar can move during a debate. -NoNewWindow keeps it in
        # this console, so Ctrl+C reaches it too.
        # Start-Process joins arguments with spaces and doesn't quote them, so quote any that contain one.
        $argLine = ($RunnerArgs | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
        $child = Start-Process -FilePath 'python' -ArgumentList $argLine -NoNewWindow -PassThru `
                     -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $null = $child.Handle   # cache the handle so ExitCode is readable after exit
        $t0 = Get-Date
        $slug = $null
        while (-not $child.HasExited) {
            if (-not $slug -and (Test-Path $outFile)) {
                $m = Select-String -Path $outFile -Pattern '^RUN \S+ (\S+) \(' -List
                if ($m) { $slug = $m.Matches[0].Groups[1].Value }
            }
            Show-Progress $s $slug ((Get-Date) - $t0).TotalSeconds
            Start-Sleep -Seconds 2
        }
        $child.WaitForExit()
        $rc = $child.ExitCode
        $child = $null
        foreach ($f in @($outFile, $errFile)) {
            if (Test-Path $f) { $text = (Get-Content $f -Raw); if ($text) { Add-Content -Path $Log -Value $text.TrimEnd() -Encoding utf8 } }
        }
        $summary = if (Test-Path $outFile) { (Select-String -Path $outFile -Pattern '^(OK|FAILED|ABORT|HARD STOP|PLAN COMPLETE|REFUSED)' | Select-Object -Last 1).Line } else { $null }
        if ($summary) { Write-Log $summary ($(if ($rc -eq 0) { 'Green' } else { 'Yellow' })) }

        switch ($rc) {
            0  { $failStreak = 0; continue }
            4  { $failStreak++
                 if ($failStreak -ge 3) { $why = '3 failures in a row; stopping for a human look. Re-run this script to resume.' } }
            10 { $why = 'PLAN COMPLETE: every debate in the plan is done.' }
            11 { $why = 'HARD STOP: the $25 cap (or the count cap) refused the next debate. A safe, expected stop.' }
            3  { $why = 'ABORTED: a finished debate did not match the plan (pin mismatch). Tell the CL.' }
            5  { $why = 'REFUSED: the plan has no recorded approval reference. Tell the CL.' }
            6  { $why = 'REFUSED: another runner is already working this ledger. Close it, or wait for it, then re-run.' }
            default { $why = "Runner exited with code $rc. Tell the CL." }
        }
        if ($why) { break }
    }
}
finally {
    if ($child -and -not $child.HasExited) {
        # Ctrl+C or an error while a debate ran: stop the whole tree so nothing keeps spending.
        Stop-ProcessTree $child.Id
        $why = 'INTERRUPTED during a debate. Its reserve stays booked; re-run this script to resume (it re-runs that debate).'
    }
    foreach ($f in @($outFile, $errFile)) { if (Test-Path $f) { Remove-Item $f -ErrorAction SilentlyContinue } }
    Write-Progress -Id 2 -Activity 'done' -Completed
    Write-Progress -Id 1 -Activity 'done' -Completed
    [void][Win32.Power]::SetThreadExecutionState([uint32]'0x80000000')
    $s = Get-RunState
    if (-not $why) { $why = 'Stopped.' }
    $color = if ($why -match '^(PLAN COMPLETE|HARD STOP|STOPPED)') { 'Green' } else { 'Yellow' }
    Write-Log $why $color
    Write-Log ("Ledger: {0} of {1} done, {2} failed attempt(s), {3} interrupted, `${4} of `${5} spent" -f
               $s.Done, $s.Total, $s.Failed, $s.Interrupted, $s.Spent, $CapUsd) $color
    Write-Log "When it's finished (or stopped), tell the CL: 't/4507 run stopped, see $Log'." 'Cyan'
}
