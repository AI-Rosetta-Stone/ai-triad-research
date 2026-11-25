# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/379: pre-push-checks.sh runs `vitest related` under a machine-wide lock with a worker cap.

.DESCRIPTION
    Concurrent agent pushes on one box each started a full vitest fork pool and starved one
    another ('Failed to start forks worker', unrelated failures, 25-minute runs). These tests run
    the real script against a stub pnpm that records when its vitest runs start and end:
      - three concurrent pushes all pass, and their vitest runs never overlap;
      - vitest gets --pool=forks and --maxWorkers;
      - a lock whose holder is dead, or that outlived the stale age, is taken over with a WARN;
      - a lock busy past the wait limit skips vitest with a WARN and never fails the push;
      - a failing vitest still releases the lock.
    The lock directory is a per-test temp path (AITRIAD_PREPUSH_LOCK_DIR), never the machine's.
#>

Describe 'pre-push-checks.sh machine-wide vitest lock (t/379)' -Tag 'devops' {

    BeforeAll {
        function Get-AppPath([string]$Name) {
            Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path
        }
        $script:Sh = Get-AppPath 'sh'
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        if (-not $script:Sh) { Write-Warning 'PrePushVitestLock: no POSIX sh found; every test in this suite will be skipped.' }
        $script:Src = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
        $script:Sep = [IO.Path]::PathSeparator
        $script:Temps = [System.Collections.Generic.List[string]]::new()
        function New-TempDir([string]$Prefix) {
            $d = Join-Path ([IO.Path]::GetTempPath()) "$Prefix-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
            New-Item -ItemType Directory -Path $d | Out-Null
            $script:Temps.Add($d)
            $d
        }
        # MSYS sh wants /c/... paths in env values it uses as file names; Linux paths pass through.
        function ConvertTo-ShPath([string]$p) {
            $p = $p -replace '\\', '/'
            if ($p -match '^([A-Za-z]):/(.*)$') { "/$($Matches[1].ToLower())/$($Matches[2])" } else { $p }
        }

        # Stub pnpm: eslint/tsc succeed at once; vitest logs start/end (ms) around a sleep and
        # exits with AITRIAD_TEST_VITEST_RC.
        # t/436: the stamp is `date +%s%N` cut to ms, never `date +%s%3N`. The uutils `date`
        # (0.10.0, the default on ubuntu-26.04) drops the leading zeros of the nanoseconds
        # before it truncates, so about 1 stamp in 10 came out up to 0.9 s late and the
        # overlap check below failed on a lock that had serialized the runs correctly.
        $script:StubDir = New-TempDir 't379-stub'
        [IO.File]::WriteAllText((Join-Path $script:StubDir 'pnpm'), @'
#!/bin/sh
now_ms() { _ns=$(date +%s%N); echo "${_ns%??????}"; }
case " $* " in
  *" vitest "*)
    echo "start $$ $(now_ms) $*" >>"$AITRIAD_TEST_LOG"
    sleep "${AITRIAD_TEST_VITEST_SECS:-2}"
    echo "end $$ $(now_ms)" >>"$AITRIAD_TEST_LOG"
    exit "${AITRIAD_TEST_VITEST_RC:-0}" ;;
esac
exit 0
'@.Replace("`r`n", "`n"))
        if (-not $IsWindows) { chmod +x (Join-Path $script:StubDir 'pnpm') }

        # A scratch repo whose last commit changes one taxonomy-editor TS file, so the plan has a
        # vitest-related step. node_modules exists so the precondition passes.
        function New-PushRepo {
            $r = New-TempDir 't379-repo'
            & git -C $r init -q -b main
            & git -C $r config core.autocrlf false
            foreach ($rel in 'operations/devops/pre-push-checks.sh', 'operations/devops/Test-PowerShellSyntax.ps1') {
                $dest = Join-Path $r $rel
                New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
                Copy-Item (Join-Path $script:Src $rel) $dest
            }
            Set-Content -Path (Join-Path $r 'README.md') -Value 'scratch'
            & git -C $r add -A
            & git -C $r -c user.email=t@example.invalid -c user.name=t commit -q -m base
            $f = Join-Path $r 'taxonomy-editor/src/a.ts'
            New-Item -ItemType Directory -Path (Split-Path $f) -Force | Out-Null
            [IO.File]::WriteAllText($f, "export const a = 1;`n")
            & git -C $r add -- taxonomy-editor/src/a.ts
            & git -C $r -c user.email=t@example.invalid -c user.name=t commit -q -m change
            New-Item -ItemType Directory -Path (Join-Path $r 'taxonomy-editor/node_modules') | Out-Null
            $r
        }

        # Starts the real script in $Repo without waiting; returns the Process.
        function Start-Push([string]$Repo, [hashtable]$Env) {
            $psi = [Diagnostics.ProcessStartInfo]::new($script:Sh)
            $psi.ArgumentList.Add((Join-Path $Repo 'operations/devops/pre-push-checks.sh'))
            $psi.ArgumentList.Add((& git -C $Repo rev-parse HEAD~1).Trim())
            $psi.ArgumentList.Add((& git -C $Repo rev-parse HEAD).Trim())
            $psi.WorkingDirectory = $Repo
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.Environment['PATH'] = "$($script:StubDir)$($script:Sep)$env:PATH"
            foreach ($k in $Env.Keys) { $psi.Environment[$k] = [string]$Env[$k] }
            $p = [Diagnostics.Process]::Start($psi)
            # Drain both pipes asynchronously so a chatty run can never block on a full pipe.
            $p | Add-Member -NotePropertyName OutTask -NotePropertyValue $p.StandardOutput.ReadToEndAsync()
            $p | Add-Member -NotePropertyName ErrTask -NotePropertyValue $p.StandardError.ReadToEndAsync()
            $p
        }
        function Wait-Push($p, [int]$TimeoutSec = 120) {
            if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill($true); throw "pre-push run did not finish in ${TimeoutSec}s" }
            $p.WaitForExit()
            [pscustomobject]@{ Code = $p.ExitCode; Out = $p.OutTask.Result + $p.ErrTask.Result }
        }

        # Parses the stub's log into one interval per vitest run.
        function Get-VitestRuns([string]$Log) {
            if (-not (Test-Path $Log)) { return @() }
            $starts = @{}; $runs = @()
            foreach ($line in Get-Content $Log) {
                $f = $line -split ' '
                if ($f[0] -eq 'start') { $starts[$f[1]] = @{ Start = [long]$f[2]; Args = ($f[3..($f.Count - 1)] -join ' ') } }
                elseif ($f[0] -eq 'end') { $runs += [pscustomobject]@{ Start = $starts[$f[1]].Start; End = [long]$f[2]; Args = $starts[$f[1]].Args } }
            }
            $runs
        }

        # A live sh process to stand in for a lock holder; its MSYS/Linux pid is what kill -0 sees.
        function Start-Holder {
            $pidFile = Join-Path (New-TempDir 't379-holder') 'pid'
            $psi = [Diagnostics.ProcessStartInfo]::new($script:Sh)
            $psi.ArgumentList.Add('-c'); $psi.ArgumentList.Add("echo `$`$ > '$(ConvertTo-ShPath $pidFile)'; exec sleep 60")
            $psi.UseShellExecute = $false
            $p = [Diagnostics.Process]::Start($psi)
            for ($i = 0; $i -lt 50 -and -not ((Test-Path $pidFile) -and (Get-Content $pidFile)); $i++) { Start-Sleep -Milliseconds 100 }
            $p | Add-Member -NotePropertyName ShPid -NotePropertyValue ((Get-Content $pidFile).Trim())
            $p
        }
    }

    AfterAll {
        foreach ($d in @($script:Temps)) { if ($d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
        $script:Work = New-TempDir 't379-work'
        $script:LockDir = Join-Path $script:Work 'prepush.lock'
        $script:Log = Join-Path $script:Work 'vitest.log'
        $script:Env = @{ AITRIAD_PREPUSH_LOCK_DIR = (ConvertTo-ShPath $script:LockDir); AITRIAD_TEST_LOG = (ConvertTo-ShPath $script:Log) }
    }

    # BLOCKING (t/436). It was non-blocking from #5277 until the lock fix (#5270) had 107 consecutive green
    # runs on the runner (t/436#33). A failure here fails test-powershell like any other test, after the
    # verdict's one rerun.
    It 'THREE CONCURRENT PUSHES: all pass, and their vitest runs never overlap (serialized by the lock)' {
        $repos = 1..3 | ForEach-Object { New-PushRepo }
        $procs = $repos | ForEach-Object { Start-Push $_ $script:Env }
        $results = $procs | ForEach-Object { Wait-Push $_ }

        foreach ($r in $results) {
            $r.Code | Should -Be 0 -Because $r.Out
            $r.Out | Should -Match 'ok    taxonomy-editor: vitest related \(max \d+ workers\)'
        }
        $runs = @(Get-VitestRuns $script:Log | Sort-Object Start)
        $runs.Count | Should -Be 3
        for ($i = 1; $i -lt $runs.Count; $i++) {
            $runs[$i].Start | Should -BeGreaterOrEqual $runs[$i - 1].End -Because 'a vitest run started before the previous one ended: the lock did not serialize them'
        }
        ($results.Out -join "`n") | Should -Match 'waiting for the machine-wide vitest lock'
        ($results.Out -join "`n") | Should -Match 'got the vitest lock after waiting \d+s'
        Test-Path $script:LockDir | Should -BeFalse -Because 'the last owner must release the lock'
    }

    # t/436 (TL p/9#314, option a). A waiter judges a dead holder's lock stale, pauses, and meanwhile
    # the dead holder releases and a live holder takes the lock. The waiter must not delete the live
    # holder's lock: it must wait behind it. Before the fix it deleted it, and a third push ran at once
    # (the overlap seen on CI). The pause is the AITRIAD_TEST_STALE_PAUSE hook, which marks the window.
    It 't436: a stale-judged waiter does not delete a live holder that took the lock in the window' {
        New-Item -ItemType Directory -Path $script:LockDir | Out-Null
        Set-Content -Path (Join-Path $script:LockDir 'owner') -Value '999999 0 /gone/worktree' -NoNewline
        $p = Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0; AITRIAD_TEST_STALE_PAUSE = 3 })
        $marker = "$script:LockDir.paused"
        for ($i = 0; $i -lt 600 -and -not (Test-Path $marker); $i++) { Start-Sleep -Milliseconds 100 }
        Test-Path $marker | Should -BeTrue -Because 'the waiter must reach the window'

        # The dead holder is gone; a live holder takes the lock inside the window.
        # t/481: the live holder is a real sh process (Start-Holder), and the owner line carries its
        # own $$. The waiter judges it with kill -0, which on Windows Git Bash sees only MSYS pids,
        # so the test process's own $PID (a Windows pid there) read as dead and the test failed.
        $h = Start-Holder
        try {
            Remove-Item -Recurse -Force $script:LockDir
            New-Item -ItemType Directory -Path $script:LockDir | Out-Null
            Set-Content -Path (Join-Path $script:LockDir 'owner') -Value "$($h.ShPid) 0 /live" -NoNewline
            Start-Sleep -Seconds 5
            $h.HasExited | Should -BeFalse -Because 'the stand-in holder must be alive while the waiter judges it'
            Test-Path (Join-Path $script:LockDir 'owner') | Should -BeTrue -Because 'the live lock must survive the waiter'
            # Release it by removing its lock dir, as its own exit trap would.
            Remove-Item -Recurse -Force $script:LockDir
            $r = Wait-Push $p
            $r.Code | Should -Be 0 -Because $r.Out
            $r.Out | Should -Match 'waiting for the machine-wide vitest lock' -Because 'the waiter must wait behind the live holder, not remove its lock'
            @(Get-VitestRuns $script:Log).Count | Should -Be 1
        } finally { if (-not $h.HasExited) { $h.Kill($true) } }
    }

    # t/436 (Quality t/436#23). A holder reads its own owner line at release and pauses. Meanwhile
    # its lock is taken over and a live holder owns the lock. The releasing push must not delete the
    # live holder's lock. With "check the owner, then rm -rf" it did. The pause is the
    # AITRIAD_TEST_RELEASE_PAUSE hook, which marks the window.
    It 't436: a releasing holder does not delete a live holder that took the lock in the window' {
        $p = Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0; AITRIAD_TEST_RELEASE_PAUSE = 3 })
        $marker = "$script:LockDir.releasing"
        for ($i = 0; $i -lt 600 -and -not (Test-Path $marker); $i++) { Start-Sleep -Milliseconds 100 }
        Test-Path $marker | Should -BeTrue -Because 'the holder must reach the release window'

        # The lock changes hands inside the window. The live holder is this test process itself.
        Remove-Item -Recurse -Force $script:LockDir
        New-Item -ItemType Directory -Path $script:LockDir | Out-Null
        Set-Content -Path (Join-Path $script:LockDir 'owner') -Value "$PID 0 /live" -NoNewline
        $r = Wait-Push $p
        $r.Code | Should -Be 0 -Because $r.Out
        @(Get-VitestRuns $script:Log).Count | Should -Be 1
        Test-Path (Join-Path $script:LockDir 'owner') | Should -BeTrue -Because 'the live lock must survive the release'
        (Get-Content (Join-Path $script:LockDir 'owner')) | Should -Be "$PID 0 /live"
        @(Get-ChildItem -Path $script:Work -Filter 'prepush.lock.reap.*').Count | Should -Be 0 -Because 'the live lock must be put back under its own name'
    }

    It 'caps vitest workers: --pool=forks --maxWorkers set to half the cores, at least 1' {
        $r = Wait-Push (Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0 }))
        $r.Code | Should -Be 0 -Because $r.Out
        $run = @(Get-VitestRuns $script:Log)[0]
        $run.Args | Should -Match '--pool=forks'
        $run.Args | Should -Match '--maxWorkers=([1-9]\d*)'
    }

    It 'STALE (dead holder): takes over a lock whose process is gone, with a WARN' {
        New-Item -ItemType Directory -Path $script:LockDir | Out-Null
        Set-Content -Path (Join-Path $script:LockDir 'owner') -Value '999999 0 /gone/worktree' -NoNewline
        $r = Wait-Push (Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0 }))
        $r.Code | Should -Be 0 -Because $r.Out
        $r.Out | Should -Match 'WARN removing a stale vitest lock \(holder: 999999 0 /gone/worktree'
        @(Get-VitestRuns $script:Log).Count | Should -Be 1
        Test-Path $script:LockDir | Should -BeFalse
    }

    It 'STALE (too old): takes over a lock older than AITRIAD_PREPUSH_LOCK_STALE even if its holder lives' {
        $h = Start-Holder
        try {
            New-Item -ItemType Directory -Path $script:LockDir | Out-Null
            Set-Content -Path (Join-Path $script:LockDir 'owner') -Value "$($h.ShPid) 0 /old" -NoNewline
            Start-Sleep -Seconds 2
            $r = Wait-Push (Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0; AITRIAD_PREPUSH_LOCK_STALE = 1 }))
            $r.Code | Should -Be 0 -Because $r.Out
            $r.Out | Should -Match 'WARN removing a stale vitest lock'
            @(Get-VitestRuns $script:Log).Count | Should -Be 1
        } finally { if (-not $h.HasExited) { $h.Kill($true) } }
    }

    It 'BUSY past the wait limit: WARNs and skips vitest, never fails the push, never touches the live holder''s lock' {
        $h = Start-Holder
        try {
            New-Item -ItemType Directory -Path $script:LockDir | Out-Null
            Set-Content -Path (Join-Path $script:LockDir 'owner') -Value "$($h.ShPid) 0 /busy" -NoNewline
            $r = Wait-Push (Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_PREPUSH_LOCK_WAIT = 3 }))
            $r.Code | Should -Be 0 -Because $r.Out
            $r.Out | Should -Match 'waiting for the machine-wide vitest lock \(held by: \d+ 0 /busy'
            $r.Out | Should -Match 'WARN waited \d+s for the machine-wide vitest lock .*skipping vitest for this push'
            $r.Out | Should -Not -Match 'BLOCKED'
            @(Get-VitestRuns $script:Log).Count | Should -Be 0
            (Get-Content (Join-Path $script:LockDir 'owner')) | Should -Be "$($h.ShPid) 0 /busy"
        } finally { if (-not $h.HasExited) { $h.Kill($true) } }
    }

    It 'a FAILING vitest still blocks the push and still releases the lock' {
        $r = Wait-Push (Start-Push (New-PushRepo) ($script:Env + @{ AITRIAD_TEST_VITEST_SECS = 0; AITRIAD_TEST_VITEST_RC = 1 }))
        $r.Code | Should -Be 1
        $r.Out | Should -Match 'FAIL  taxonomy-editor: vitest related'
        Test-Path $script:LockDir | Should -BeFalse -Because 'a failed run must not leave the lock behind'
    }
}
