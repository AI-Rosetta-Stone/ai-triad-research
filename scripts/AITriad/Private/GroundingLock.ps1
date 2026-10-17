# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Advisory cross-tool write-lock for entity_mentions.json (t/3203) and policy_actions.json (t/4028).
    Protocol v2 (t/4193): heartbeat plus identity-checked stale break.
.DESCRIPTION
    entity_mentions.json is a SHARED read-merge-write: CL's reconcile_grounding.py owns node:*
    and Update-EntityMentionIndex owns {sei:*, summary:*}. Both tools honor the SAME advisory
    lockfile (`entity_mentions.lock` beside it) with matching semantics. The protocol is a
    cross-tool contract (TL t/3163#1; v2 design t/4193#3, TL conditions t/4193#4); the Python
    reference is reconcile_grounding.py grounding_lock(). Constants mirror it exactly.

      acquire    Atomic exclusive create ([IO.File]::Open CreateNew == O_CREAT|O_EXCL), write a JSON
                 payload {holder, pid, host, nonce, acquired_at}, then CLOSE the handle so other
                 processes can read (identity check) and rename (break) the file. An acquire-side
                 IOException / UnauthorizedAccess is contention: poll and retry within WaitSec.
      liveness   The holder's heartbeat touches the file's mtime (LastWriteTimeUtc) every StaleSec/4.
                 It never rewrites the JSON (TL condition 3). A lock whose mtime is older than
                 StaleSec (120s) has a dead holder, or one held past MaxHoldSec (TL condition 4).
      break      A waiter that judges the lock stale reads its contents, then renames it to
                 `<path>.breaking.<pid>.<nonce>` without overwrite (only one waiter wins). Same
                 contents: delete it and acquire normally. Moved file missing (concurrent renames on
                 NTFS can all report success): lost the race, retry. Different contents: a fresh lock
                 was taken in between, so restore it with a NON-overwriting move; if a newer lock
                 already exists the restored holder has lost its lock (TL condition 1).
      ownership  The heartbeat and Assert-GroundingLockHeld compare the file's raw text with the
                 holder's own payload text. Missing or different: the lock is lost, and the caller
                 must not write (TL condition 2). Every caller calls Assert-GroundingLockHeld
                 immediately before its final write.
      release    Exit-GroundingLock stops the heartbeat and deletes the file only if it still carries
                 this holder's payload; a sharing violation is retried briefly, then WARNed. It never
                 throws into the caller.

    Each runtime compares raw file text against its OWN payload, so the PowerShell and Python
    payload serializations never need to match byte for byte.

    THREADING: the heartbeat is a System.Threading.Timer inside a small compiled C# class
    (AITriad.GroundingLockV2.LockHandle). A PowerShell scriptblock cannot run on a thread-pool
    thread (no runspace there), and System.Timers.Timer + Register-ObjectEvent only runs its action
    when the main pipeline yields, which a long busy statement never does. The C# callback touches
    no PowerShell state: flags are volatile, warnings go to a ConcurrentQueue that the main thread
    drains (Assert-GroundingLockHeld, Exit-GroundingLock) and emits with Write-Warning, a Monitor
    gate makes Stop() wait out an in-flight tick (so a release never races a touch), and a catch-all
    keeps an unexpected exception from crashing the process from the timer thread.

    STILL OPEN (accepted, t/4193#4): clock skew between hosts (harmless for writes because of the
    ownership check) and non-atomic rename on some network filesystems. OS locks are required before
    this lock serves more than one host.
#>

Set-Variable -Name 'GroundingLockWaitSec'    -Value 60   -Scope Script -Option ReadOnly -Force
Set-Variable -Name 'GroundingLockStaleSec'   -Value 120  -Scope Script -Option ReadOnly -Force
Set-Variable -Name 'GroundingLockPollSec'    -Value 0.5  -Scope Script -Option ReadOnly -Force
Set-Variable -Name 'GroundingLockMaxHoldSec' -Value 1800 -Scope Script -Option ReadOnly -Force
# Stands in for "present but unreadable" when re-reading a renamed lock, so it never equals real contents.
Set-Variable -Name 'GroundingLockUnreadable' -Value "`0unreadable`0" -Scope Script -Option ReadOnly -Force

# Versioned type name: Add-Type cannot redefine a type in one AppDomain, and AITriad.psm1 is
# Import-Module -Force'd many times per session (every test file), so a changed definition gets a new name.
$script:GroundingLockTypeName = 'AITriad.GroundingLockV2.LockHandle'
$script:GroundingLockTypeSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace AITriad.GroundingLockV2
{
    public sealed class LockHandle : IDisposable
    {
        private readonly object _gate = new object();
        private readonly ConcurrentQueue<string> _warnings = new ConcurrentQueue<string>();
        private readonly Stopwatch _held = Stopwatch.StartNew();
        private Timer _timer;
        private volatile bool _lost;
        private volatile bool _stopped;
        private volatile string _lostReason = "";
        private volatile string _stopReason = "";
        private int _lostOnce;
        private int _beats;

        public string Path { get; private set; }
        public string Nonce { get; private set; }
        public string Payload { get; private set; }
        public string Purpose { get; private set; }
        public double IntervalSec { get; private set; }
        public double MaxHoldSec { get; private set; }
        public bool Lost { get { return _lost; } }
        public string LostReason { get { return _lostReason; } }
        public bool HeartbeatStopped { get { return _stopped; } }
        public string HeartbeatStopReason { get { return _stopReason; } }
        public int BeatCount { get { return Volatile.Read(ref _beats); } }

        public LockHandle(string path, string nonce, string payload, string purpose, double intervalSec, double maxHoldSec)
        {
            Path = path; Nonce = nonce; Payload = payload; Purpose = purpose;
            IntervalSec = intervalSec; MaxHoldSec = maxHoldSec;
        }

        public void Start()
        {
            int ms = Math.Max(1, (int)(IntervalSec * 1000));
            lock (_gate) { if (!_stopped && _timer == null) { _timer = new Timer(Tick, null, ms, ms); } }
        }

        // The lockfile's raw text, or null when it is gone. IOException / UnauthorizedAccessException
        // (a Windows open or delete in progress) propagate; the caller decides whether it is contention.
        public static string ReadOrNull(string path)
        {
            try { return File.ReadAllText(path, new UTF8Encoding(false)); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        }

        public bool MarkLost(string why)
        {
            if (Interlocked.CompareExchange(ref _lostOnce, 1, 0) != 0) { return false; }
            _lostReason = why;
            _lost = true;
            _warnings.Enqueue("lock at '" + Path + "' lost while held (" + why + "); this holder will refuse its write.");
            return true;
        }

        public string[] DrainWarnings()
        {
            var list = new List<string>();
            string w;
            while (_warnings.TryDequeue(out w)) { list.Add(w); }
            return list.ToArray();
        }

        // Stops the heartbeat. Takes the gate, so it returns only after any in-flight tick finished.
        public void Stop() { lock (_gate) { StopCore("released"); } }

        public void Dispose() { Stop(); }

        private void StopCore(string reason)
        {
            if (_stopped) { return; }
            _stopReason = reason;
            _stopped = true;
            if (_timer != null) { _timer.Dispose(); _timer = null; }
        }

        private void Tick(object state)
        {
            if (!Monitor.TryEnter(_gate)) { return; }   // a slow tick or Stop() is running: skip this beat
            try
            {
                if (_stopped) { return; }
                if (_held.Elapsed.TotalSeconds > MaxHoldSec)
                {
                    _warnings.Enqueue("held > MaxHoldSec (" + MaxHoldSec + "s) at '" + Path +
                        "'; heartbeat stopped, so the lock will go stale and can be broken.");
                    StopCore("max_hold");
                    return;
                }
                string current;
                try { current = ReadOrNull(Path); }
                catch (IOException) { return; }                 // momentary open by a reader/breaker: next beat
                catch (UnauthorizedAccessException) { return; }
                if (!string.Equals(current, Payload, StringComparison.Ordinal))
                {
                    MarkLost(current == null ? "lockfile missing" : "lockfile replaced");
                    StopCore("lost");
                    return;
                }
                try { File.SetLastWriteTimeUtc(Path, DateTime.UtcNow); Interlocked.Increment(ref _beats); }
                catch (FileNotFoundException) { MarkLost("lockfile missing"); StopCore("lost"); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            catch (Exception ex)
            {
                // An exception escaping a thread-pool timer callback terminates the process.
                _warnings.Enqueue("heartbeat error at '" + Path + "': " + ex.Message);
            }
            finally { Monitor.Exit(_gate); }
        }
    }
}
'@

function Initialize-GroundingLockType {
    # Compiles the heartbeat/handle type once per process, on first use (not at module import).
    [CmdletBinding()]
    param()
    if (-not ([System.Management.Automation.PSTypeName]$script:GroundingLockTypeName).Type) {
        Add-Type -Language CSharp -TypeDefinition $script:GroundingLockTypeSource
    }
    return ([System.Management.Automation.PSTypeName]$script:GroundingLockTypeName).Type
}

function Read-GroundingLockText {
    # Raw lockfile text, or $null when it is gone. IO / access errors propagate (contention).
    param([Parameter(Mandatory)][string]$Path)
    return (Initialize-GroundingLockType)::ReadOrNull($Path)
}

function New-GroundingLockPayload {
    param([Parameter(Mandatory)][string]$Holder, [Parameter(Mandatory)][string]$Nonce)
    return ([ordered]@{
            holder      = $Holder
            pid         = $PID
            host        = [System.Environment]::MachineName
            nonce       = $Nonce
            acquired_at = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Compress)
}

function Invoke-GroundingLockCreate {
    # One atomic create attempt. $true: created, payload written, handle CLOSED. $false: contention.
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Payload)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] { return $false }
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Payload)
        $fs.Write($bytes, 0, $bytes.Length)
        $fs.Flush()
    }
    catch {
        $writeError = $_
        $fs.Dispose()
        try { [System.IO.File]::Delete($Path) }
        catch { Write-Warning "Enter-GroundingLock: could not remove half-written lock '$Path': $($_.Exception.GetBaseException().Message). It goes stale and is broken normally." }
        throw (New-ActionableError -PassThru -Goal 'Acquire the advisory write-lock' `
                -Problem "Created '$Path' but could not write its payload: $($writeError.Exception.GetBaseException().Message)" `
                -Location 'Invoke-GroundingLockCreate' -NextSteps @('Check disk space and that the directory is writable.') -InnerError $writeError)
    }
    $fs.Dispose()
    return $true
}

function Get-GroundingLockAgeSec {
    # Seconds since the lockfile's mtime; $null when it is gone; 0 when it cannot be read (treated as live).
    param([Parameter(Mandatory)][string]$Path)
    try {
        $fi = [System.IO.FileInfo]::new($Path)
        if (-not $fi.Exists) { return $null }
        return ([DateTime]::UtcNow - $fi.LastWriteTimeUtc).TotalSeconds
    }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] { return [double]0 }
}

function Wait-GroundingLockPoll {
    # One bounded wait step. Throws the ActionableError once WaitSec has elapsed; otherwise sleeps.
    param([Parameter(Mandatory)][hashtable]$State, [double]$Age, [int]$SleepMs = -1)
    if ($State.Clock.Elapsed.TotalSeconds -ge $State.WaitSec) {
        $problem = if ($State.BreakFailure) {
            "Stale lock '$($State.Path)' (mtime age $([int]$Age)s) could not be deleted for >$($State.WaitSec)s: $($State.BreakFailure)."
        }
        else {
            "Lock '$($State.Path)' held by another writer for >$($State.WaitSec)s and not stale (mtime age $([int]$Age)s)."
        }
        throw (New-ActionableError -PassThru `
                -Goal     "Serialize $($State.Purpose)" `
                -Problem  $problem `
                -Location 'Enter-GroundingLock' `
                -NextSteps @(
                    "Wait for the other writer ($($State.OtherWriters)) to finish.",
                    "If no writer is actually running, the lock is stale; remove it: $($State.Path)"
                ))
    }
    $ms = if ($SleepMs -ge 0) { $SleepMs } else { [int]($State.PollSec * 1000) }
    Start-Sleep -Milliseconds $ms
}

function Set-GroundingLockBreakFailure {
    # Records why a stale lock could not be broken (named in the timeout error), WARNing once per acquire.
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][string]$Reason)
    if ($State.BreakFailure) { return }
    $State.BreakFailure = $Reason
    Write-Warning "Enter-GroundingLock: could not delete stale lock '$($State.Path)': $Reason. Waiting up to $($State.WaitSec)s."
}

function Move-GroundingLockAway {
    # The rename-away step of a stale break: an atomic, NON-overwriting rename. A separate function so
    # tests can inject a fresh lock between rename-away and restore (TL condition 1); in production it
    # is exactly this one call.
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination)
    [System.IO.File]::Move($Path, $Destination, $false)
}

function Restore-GroundingLockFile {
    # Puts a wrongly broken lock back WITHOUT ever overwriting a lock created meanwhile (TL condition 1).
    # $false: a newer lock exists (or the move was refused), so the restored holder has lost its lock.
    # A breaking file that has vanished counts as restored-nothing ($true), as in the Python reference.
    param([Parameter(Mandatory)][string]$Breaking, [Parameter(Mandatory)][string]$Path)
    try {
        [System.IO.File]::Move($Breaking, $Path, $false)
        return $true
    }
    catch [System.IO.FileNotFoundException] { return $true }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] { return $false }
}

function Remove-GroundingLockBreakingFile {
    param([Parameter(Mandatory)][string]$Breaking)
    try { [System.IO.File]::Delete($Breaking) }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] {
        Write-Warning "Enter-GroundingLock: could not delete '$Breaking': $($_.Exception.GetBaseException().Message). It is not a lockfile (inert) and can be removed by hand."
    }
}

function Resolve-GroundingLockBreak {
    # After a successful rename-away: decide from the moved file's contents what we actually took.
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][string]$Breaking,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Seen, [double]$Age)
    try { $taken = Read-GroundingLockText -Path $Breaking }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] { $taken = $script:GroundingLockUnreadable }
    if ($null -eq $taken) {
        Write-Warning "Enter-GroundingLock: rename of '$($State.Path)' reported success but the moved file is missing (concurrent break); retrying acquire."
        return
    }
    if ($taken -ceq $Seen) {
        Write-Warning "Enter-GroundingLock: breaking stale lock '$($State.Path)' (mtime age $([int]$Age)s > $($State.StaleSec)s; holder presumed dead): renamed away with its identity confirmed. Fallback-path per docs/error-handling.md."
        Remove-GroundingLockBreakingFile -Breaking $Breaking
        return
    }
    # A fresh lock replaced the stale one between our read and our rename: put it back, never overwriting.
    if (-not (Restore-GroundingLockFile -Breaking $Breaking -Path $State.Path)) {
        Write-Warning "Enter-GroundingLock: could not restore a live lock at '$($State.Path)' (a newer lock exists); its holder will detect the loss and refuse to write."
        Remove-GroundingLockBreakingFile -Breaking $Breaking
    }
}

function Invoke-GroundingLockStaleBreak {
    # One identity-checked break attempt of a lock judged stale. 'Retry': loop to the create at once.
    # 'Busy': the break could not proceed; the caller takes a bounded wait step.
    param([Parameter(Mandatory)][hashtable]$State, [double]$Age)
    try { $seen = Read-GroundingLockText -Path $State.Path }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] {
        Set-GroundingLockBreakFailure -State $State -Reason "busy on read ($($_.Exception.GetBaseException().Message))"
        return 'Busy'
    }
    if ($null -eq $seen) { return 'Retry' }   # released meanwhile
    $breaking = '{0}.breaking.{1}.{2}' -f $State.Path, $PID, $State.Nonce
    try { Move-GroundingLockAway -Path $State.Path -Destination $breaking }
    catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return 'Retry' }   # another waiter won
    catch [System.IO.IOException], [System.UnauthorizedAccessException] {
        Set-GroundingLockBreakFailure -State $State -Reason "rename-away refused ($($_.Exception.GetBaseException().Message))"
        return 'Busy'
    }
    Resolve-GroundingLockBreak -State $State -Breaking $breaking -Seen $seen -Age $Age
    return 'Retry'
}

function Enter-GroundingLock {
    <#
    .SYNOPSIS
        Acquire the advisory write-lock (protocol v2, t/4193). Returns the lock object
        (AITriad.GroundingLockV2.LockHandle: Path, Nonce, Payload, Lost, heartbeat). Call
        Assert-GroundingLockHeld immediately before the final write, and Exit-GroundingLock in a finally.
    #>
    [CmdletBinding()]
    [OutputType('AITriad.GroundingLockV2.LockHandle')]
    param(
        [Parameter(Mandatory)][string]$LockPath,
        # What the lock guards and who else takes it, for error text only. The defaults are the
        # original entity_mentions wording; the policy registry lock (t/4028) passes its own.
        [string]$Purpose = 'the entity_mentions.json read-merge-write across grounding writers',
        [string]$OtherWriters = 'reconcile_grounding.py or another Update-EntityMentionIndex',
        [string]$Holder = 'AITriad',
        [double]$WaitSec = $script:GroundingLockWaitSec,
        [double]$StaleSec = $script:GroundingLockStaleSec,
        [double]$PollSec = $script:GroundingLockPollSec,
        [double]$MaxHoldSec = $script:GroundingLockMaxHoldSec
    )
    Set-StrictMode -Version Latest
    $type = Initialize-GroundingLockType

    $lockDir = Split-Path -Parent $LockPath
    if ($lockDir -and -not (Test-Path -LiteralPath $lockDir)) {
        throw (New-ActionableError -PassThru `
                -Goal     "Acquire the lock serializing $Purpose" `
                -Problem  "Lock directory does not exist: $lockDir" `
                -Location 'Enter-GroundingLock' `
                -NextSteps @('Ensure the directory of the guarded file exists before writing.'))
    }

    $nonce = [guid]::NewGuid().ToString('N')
    $state = @{
        Path = $LockPath; Nonce = $nonce; Payload = (New-GroundingLockPayload -Holder $Holder -Nonce $nonce)
        WaitSec = $WaitSec; StaleSec = $StaleSec; PollSec = $PollSec; Purpose = $Purpose; OtherWriters = $OtherWriters
        Clock = [System.Diagnostics.Stopwatch]::StartNew(); BreakFailure = $null
    }
    while (-not (Invoke-GroundingLockCreate -Path $LockPath -Payload $state.Payload)) {
        $age = Get-GroundingLockAgeSec -Path $LockPath
        if ($null -eq $age) { Wait-GroundingLockPoll -State $state -Age 0 -SleepMs 50; continue }   # released meanwhile
        if ($age -gt $StaleSec -and (Invoke-GroundingLockStaleBreak -State $state -Age $age) -eq 'Retry') { continue }
        Wait-GroundingLockPoll -State $state -Age $age
    }
    $lock = $type::new($LockPath, $nonce, $state.Payload, $Purpose, [Math]::Max($StaleSec / 4.0, 0.02), $MaxHoldSec)
    $lock.Start()
    return $lock
}

function Write-GroundingLockWarning {
    # Emits, on the caller's thread, the warnings the heartbeat thread queued.
    param([Parameter(Mandatory)][object]$Lock)
    foreach ($w in $Lock.DrainWarnings()) { Write-Warning "GroundingLock heartbeat: $w" }
}

function Assert-GroundingLockHeld {
    <#
    .SYNOPSIS
        TL condition 2 (t/4193#4): throws an ActionableError unless this holder still owns the lock
        (not marked Lost, and the file still carries its exact payload). Call it immediately before
        the final write; on a throw the caller must not write.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()][object]$Lock)
    if ($null -eq $Lock) {
        throw (New-ActionableError -PassThru -Goal 'Write under the advisory write-lock' `
                -Problem 'No lock object was passed, so this caller does not hold the lock.' `
                -Location 'Assert-GroundingLockHeld' -NextSteps @('Acquire the lock with Enter-GroundingLock and pass the object it returns.'))
    }
    if (-not $Lock.Lost) {
        try { $current = Read-GroundingLockText -Path $Lock.Path }
        catch [System.IO.IOException], [System.UnauthorizedAccessException] { $current = $Lock.Payload }   # momentary open; the heartbeat flags a takeover
        if ($current -cne $Lock.Payload) { $null = $Lock.MarkLost($(if ($null -eq $current) { 'lockfile missing' } else { 'lockfile replaced' })) }
    }
    Write-GroundingLockWarning -Lock $Lock
    if ($Lock.Lost) {
        throw (New-ActionableError -PassThru `
                -Goal     "Write $($Lock.Purpose) under the advisory write-lock" `
                -Problem  "The lock was lost while held ($($Lock.LostReason)); this run did not write." `
                -Location $Lock.Path `
                -NextSteps @(
                    'Another writer broke or replaced the lock and may be writing now; this run refused its write instead of racing it.',
                    'Re-run once the other writer finishes.',
                    "If it recurs with no other writer, check that the hold stays under MaxHoldSec ($($Lock.MaxHoldSec)s) and that host clocks agree."
                ))
    }
}

function Remove-GroundingLockIfOurs {
    # 'Done' when the file is gone, not ours, or deleted; 'Busy' on a sharing violation.
    param([Parameter(Mandatory)][object]$Lock)
    try {
        if ((Read-GroundingLockText -Path $Lock.Path) -cne $Lock.Payload) { return 'Done' }   # never delete another holder's lock
        [System.IO.File]::Delete($Lock.Path)
        return 'Done'
    }
    catch [System.IO.IOException], [System.UnauthorizedAccessException] { return 'Busy' }
}

function Exit-GroundingLock {
    <#
    .SYNOPSIS
        Release: stop the heartbeat, then delete the lockfile only if it still carries our payload.
        Retries a sharing violation for ~2s, then WARNs. Never throws into the caller.
        [IO.File] calls ignore an ambient $WhatIfPreference (t/4047): the lockfile is bookkeeping.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][Alias('Handle')][AllowNull()][object]$Lock,
        # Legacy (v1) parameter, ignored: the lock object carries its own path.
        [string]$LockPath
    )
    if ($null -eq $Lock) { return }
    try {
        $Lock.Stop()
        Write-GroundingLockWarning -Lock $Lock
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if ((Remove-GroundingLockIfOurs -Lock $Lock) -eq 'Done') { return }
            Start-Sleep -Milliseconds 50
        }
        Write-Warning "Exit-GroundingLock: could not remove '$($Lock.Path)' on release (busy after retries); it will be broken as stale once its mtime ages out."
    }
    catch {
        Write-Warning "Exit-GroundingLock: release of '$($Lock.Path)' failed: $($_.Exception.GetBaseException().Message). The lock goes stale and is broken normally."
    }
}
