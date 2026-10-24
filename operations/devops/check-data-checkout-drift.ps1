# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Scheduled drift check for the fleet's shared DATA checkouts (t/4005): ai-triad-data and
    ai-triad-sources. check-shared-drift.ps1 (r/11) covers only the CODE checkout; this is the
    data-side equivalent, surfaced by the t/4001 surviving vector (63 uncommitted ingested
    sources sat ~3 weeks, found only by chance, p/210#70).
.DESCRIPTION
    DETECTION ONLY. Never commits, deletes, stashes, or syncs anything in either checkout.

    Per checkout:
      - `git fetch` (best-effort; a failed fetch degrades that checkout to Alarm=$true,
        QueryError set — never silently skipped as if clean);
      - `git status --porcelain -z` (NUL-separated, rename-aware) to split tracked-modified
        vs untracked paths;
      - the OLDEST mtime among those paths, read via the `\\?\` long-path prefix (t/4005: one
        ingested filename in ai-triad-sources exceeds 260 characters — a plain
        [System.IO.File]::GetLastWriteTimeUtc without the prefix throws PathTooLongException
        on that file, which would otherwise look exactly like "no uncommitted work" if the
        exception were swallowed the wrong way);
      - ahead/behind counts, and (when behind) the incoming path set;
      - the pure verdict, Get-DataCheckoutDriftVerdict (DataCheckoutDriftVerdict.ps1).

    Fail-safe: an unreadable repo path, or a `git`/fetch failure for a checkout, sets
    Alarm=$true and QueryError on that checkout's result — "could not check" is never read as
    "clean." Each checkout's work is in its own try/catch so one checkout's failure can never
    suppress or skip the other's result.

    Exit code is always 0 (the agent reads the returned object, same contract as
    check-shared-drift.ps1); this script itself takes no action beyond reporting.
.PARAMETER Checkouts
    Hashtable of Name -> absolute repo path. Defaults to the two fleet-standard data checkouts.
.PARAMETER AgeThresholdHours
    Passed through to Get-DataCheckoutDriftVerdict. Default 24.
.PARAMETER Now
    Wall-clock reference for age computation, in UTC. Defaults to the real UTC now; override in
    tests. MUST be UTC: the mtime side (GetLastWriteTimeUtc above) is already UTC, and comparing
    a local-time $Now against it produces a timezone-offset-sized error in AgeHours -- e.g. EDT
    (UTC-4) read AgeHours as -3.49 on a file modified moments ago, because local-time "now" is
    ~4h behind UTC "now" while the mtime it's diffed against is already in UTC (t/4060, p/648#98).
.PARAMETER ProtectedPaths
    Passed through to Get-DataCheckoutDriftVerdict (t/4056). Hashtable of repo-relative-path
    -> owner name, data rather than code so more entries can be added without touching either
    script. Default: the one entry known today, `taxonomy/Origin/pov-tag-proposals.json` ->
    'Computational Linguist' (t/4052 reviews land as an uncommitted edit until CL's step-4
    run, t/3962#15, SO e/270#2). A hit forces Alarm=$true and sync-blocked regardless of the
    ordinary intersection/staleness/divergence result -- the sync procedure
    (docs/shared-tree-divergence.md) must refuse to sync/restore/reset while any
    ProtectedWip entry is present, even when that path's diff against origin/main is empty.
#>

param(
    [hashtable]$Checkouts = [ordered]@{
        'ai-triad-data'    = 'C:\Users\jsnov\repos\ai-triad-data'
        'ai-triad-sources' = 'C:\Users\jsnov\repos\ai-triad-sources'
    },
    [double]$AgeThresholdHours = 24,
    [datetime]$Now = (Get-Date).ToUniversalTime(),
    [hashtable]$ProtectedPaths = @{ 'taxonomy/Origin/pov-tag-proposals.json' = 'Computational Linguist' }
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$verdictScript = Join-Path $PSScriptRoot 'DataCheckoutDriftVerdict.ps1'
if (Test-Path $verdictScript) { . $verdictScript }

function Invoke-GitBounded {
    # Mirrors check-shared-drift.ps1's Invoke-Git (Start-Job + timeout), with a longer default
    # timeout: these two checkouts are 3.6-15 GB, materially larger than the code checkout.
    # Fine for ordinary line-based git output (rev-list counts, diff --name-only); NOT used for
    # `status -z`, whose NUL separators PowerShell's text pipeline does not preserve — see
    # Invoke-GitRawBytes below.
    param([string[]]$GitArgs, [int]$TimeoutMs = 20000)
    try {
        $job = Start-Job { & git @using:GitArgs 2>$null }
        $completed = Wait-Job $job -Timeout ([int]($TimeoutMs / 1000))
        if (-not $completed) { Remove-Job $job -Force; return $null }
        $out = Receive-Job $job
        Remove-Job $job
        return $out
    } catch { return $null }
}

function Invoke-GitRawBytes {
    # t/4005 live-fire finding: capturing a native command's stdout through PowerShell's normal
    # pipeline (`& git ...`, Start-Job + Receive-Job) runs it through the console's TEXT
    # encoding layer, which does not preserve embedded NUL bytes — confirmed empirically: a
    # `status --porcelain -z` entry's NUL separators came back as mangled multi-byte garbage,
    # splicing two filenames together. `-z` exists specifically to make filenames with spaces or
    # special characters unambiguous (same reasoning as check-shared-drift.ps1's t/3634 fix); a
    # capture layer that corrupts the separator defeats the entire point of asking for it.
    # Fix: run git via System.Diagnostics.Process directly and copy RAW BYTES off
    # StandardOutput.BaseStream, bypassing PowerShell's string conversion entirely until this
    # function's own caller explicitly UTF8-decodes the bytes.
    #
    # Returns a WRAPPER object { Bytes; TimedOut; Error }, never a raw byte[] — a SECOND
    # live-fire bug (t/4005): a clean checkout (zero uncommitted files) makes git print ZERO
    # bytes, and `return $ms.ToArray()` on an EMPTY array COLLAPSES TO $null across the
    # function-return boundary (the same "empty array -> $null" gotcha documented in
    # DriftDedupVerdict.ps1), making the caller's `$null -eq $result` check indistinguishable
    # from a REAL failure — "nothing uncommitted" was reading as "the query failed." Matches
    # check-shared-drift.ps1's Invoke-Gh, which wraps for the identical reason.
    param([string[]]$GitArgs, [int]$TimeoutMs = 20000)
    $proc = $null
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = 'git'
        foreach ($a in $GitArgs) { $psi.ArgumentList.Add($a) }
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $ms = [System.IO.MemoryStream]::new()
        $copyTask = $proc.StandardOutput.BaseStream.CopyToAsync($ms)
        $exited = $proc.WaitForExit($TimeoutMs)
        if (-not $exited) {
            try { $proc.Kill() } catch { }
            return [PSCustomObject]@{ Bytes = $null; TimedOut = $true; Error = $null }
        }
        # PowerShell gotcha guard (found live-fire, t/4005): Task.Wait(int) RETURNS A BOOL
        # (did it complete within the timeout) — an unassigned/unsuppressed expression
        # statement emits its result to the function's OUTPUT stream, which then gets
        # flattened together with the byte[] from `return $ms.ToArray()` into one combined
        # collection: the caller's "byte array" silently gained a leading literal "True"
        # element, corrupting every downstream offset. Must assign-away, not just call.
        $null = $copyTask.Wait([int]$TimeoutMs)
        return [PSCustomObject]@{ Bytes = [byte[]]$ms.ToArray(); TimedOut = $false; Error = $null }
    } catch {
        return [PSCustomObject]@{ Bytes = $null; TimedOut = $false; Error = $_.Exception.Message }
    } finally {
        if ($proc) { try { $proc.Dispose() } catch { } }
    }
}

function ConvertFrom-PorcelainZ {
    # `git status --porcelain -z` entries: "XY PATH\0", except rename/copy (X or Y = R or C),
    # which is "XY ORIG_PATH\0PATH\0" — the destination path is a SEPARATE following token, not
    # part of the same one. Walk tokens by index so a rename consumes two tokens, never one.
    # Takes the RAW BYTES from Invoke-GitRawBytes (never a PowerShell-captured string — see that
    # function's comment for why) and decodes as UTF8 here, once, in one place.
    param([byte[]]$RawBytes)
    if ($null -eq $RawBytes -or $RawBytes.Length -eq 0) { return @() }
    $text = [System.Text.Encoding]::UTF8.GetString($RawBytes)
    $tokens = @(($text -split "`0") | Where-Object { $_ -ne '' })
    $entries = [System.Collections.Generic.List[object]]::new()
    $i = 0
    while ($i -lt $tokens.Count) {
        $tok = $tokens[$i]
        if ($tok.Length -lt 3) { $i++; continue }
        $xy = $tok.Substring(0, 2)
        $isRenameOrCopy = ($xy[0] -eq 'R' -or $xy[0] -eq 'C' -or $xy[1] -eq 'R' -or $xy[1] -eq 'C')
        if ($isRenameOrCopy -and ($i + 1) -lt $tokens.Count) {
            $destPath = $tokens[$i + 1]
            $entries.Add([PSCustomObject]@{ Status = $xy; Path = $destPath })
            $i += 2
            continue
        }
        $path = $tok.Substring(3)
        $entries.Add([PSCustomObject]@{ Status = $xy; Path = $path })
        $i++
    }
    return @($entries)
}

function Get-FileMtimeLongPath {
    # t/4005: always use the \\?\ prefix ON WINDOWS, not just when a path happens to look long
    # -- the one known offender (an ingested filename > 260 chars in ai-triad-sources) is
    # exactly the file that would otherwise throw, and prefixing unconditionally removes any
    # length-guessing bug as a class rather than special-casing "long enough to worry about."
    # t/4060: that prefix is WINDOWS-ONLY long-path syntax. On Linux CI (ubuntu-latest,
    # test-powershell), prepending it to a real path makes GetLastWriteTimeUtc silently return
    # the Win32 FILETIME epoch (1601-01-01, ~425 years before "now") instead of throwing --
    # .NET documents that behavior for a path it can't resolve, so the try/catch below never
    # fires and the bogus epoch value flows straight through as a real mtime. Caught by the
    # t/4060 Pester case, the first test to run this function (not just the pure predicate) on
    # Linux CI. Only Windows needs or understands the \\?\ prefix.
    param([string]$FullPath)
    try {
        $p = $FullPath
        if ($IsWindows -or -not (Test-Path variable:IsWindows)) {
            $p = $p -replace '/', '\'
            if (-not $p.StartsWith('\\?\')) { $p = "\\?\$p" }
        }
        return [System.IO.File]::GetLastWriteTimeUtc($p)
    } catch {
        return $null
    }
}

$results = [System.Collections.Generic.List[object]]::new()
$overallAlarm = $false

foreach ($name in $Checkouts.Keys) {
    $root = $Checkouts[$name]
    $checkoutResult = [PSCustomObject]@{
        Name            = $name
        Path            = $root
        Alarm           = $false
        Reasons         = @()
        AgeHours        = 0.0
        Intersects      = $false
        Diverged        = $false
        Ahead           = 0
        Behind          = 0
        TrackedModified = @()
        Untracked       = @()
        QueryError      = $null
        ProtectedWip    = @()
        SyncReason      = $null
    }
    try {
        if (-not (Test-Path -LiteralPath $root)) {
            $checkoutResult.Alarm = $true
            $checkoutResult.QueryError = "repo path not found: $root"
            $results.Add($checkoutResult); $overallAlarm = $true
            continue
        }

        # Best-effort fetch — a FAILED fetch does not skip the rest of the check (status/ahead/
        # behind can still be computed against the last-known origin ref), but it DOES mean the
        # behind/ahead/incoming numbers may be stale, so fold it into QueryError as a visible
        # degradation rather than a silent "fetch skipped, continuing as if current."
        Invoke-GitBounded -GitArgs @('-C', $root, 'fetch', '--quiet', 'origin', 'main') -TimeoutMs 60000 | Out-Null
        # Fetch failure is NOT detected from its own exit code (Start-Job does not propagate
        # $LASTEXITCODE to this scope) — it is detected structurally below: if origin/main is
        # unresolvable, the ahead/behind rev-list calls return non-numeric output and that arm
        # fails the checkout closed (QueryError), which also covers "fetch never ran at all."

        # -c core.quotePath=false (t/3634 lesson, reused): a filename containing a shell
        # metacharacter or control byte comes back LITERAL, not octal-quoted, so it round-trips
        # correctly through the NUL-split below instead of silently mismatching every path
        # comparison against git's quoted form. -z itself needs the raw-bytes capture
        # (Invoke-GitRawBytes), never Invoke-GitBounded — see that function's comment.
        $statusResult = Invoke-GitRawBytes -GitArgs @('-C', $root, '-c', 'core.quotePath=false', 'status', '--porcelain', '-z', '--untracked-files=all') -TimeoutMs 60000
        if ($statusResult.TimedOut -or $null -ne $statusResult.Error) {
            $checkoutResult.Alarm = $true
            $checkoutResult.QueryError = if ($statusResult.TimedOut) { 'git status query timed out' } else { "git status query failed: $($statusResult.Error)" }
            $results.Add($checkoutResult); $overallAlarm = $true
            continue
        }
        # $statusResult.Bytes is a REAL (possibly zero-length) byte[] here, never collapsed to
        # $null — ConvertFrom-PorcelainZ already treats a zero-length/$null array as "no
        # entries" correctly; the ambiguity this guards against is one level up, at the
        # function-return boundary, not here.
        $entries = ConvertFrom-PorcelainZ -RawBytes $statusResult.Bytes
        $tracked = @($entries | Where-Object { $_.Status -ne '??' } | ForEach-Object { $_.Path })
        $untracked = @($entries | Where-Object { $_.Status -eq '??' } | ForEach-Object { $_.Path })
        $checkoutResult.TrackedModified = $tracked
        $checkoutResult.Untracked = $untracked

        # Oldest mtime among every uncommitted path (long-path-safe read). A single unreadable
        # file (deleted mid-scan, permission issue, the >260-char name if the prefix somehow
        # still fails) is EXCLUDED from the oldest-of comparison rather than aborting the whole
        # check — but if EVERY uncommitted path is unreadable, that is indistinguishable from
        # "no mtime data at all," which Get-DataCheckoutDriftVerdict already treats as fail-safe
        # old (see $oldestMtime staying $null below).
        $oldestMtime = $null
        $oldestPath = $null
        foreach ($relPath in @($tracked + $untracked)) {
            $full = Join-Path $root $relPath
            $mt = Get-FileMtimeLongPath -FullPath $full
            if ($null -ne $mt -and ($null -eq $oldestMtime -or $mt -lt $oldestMtime)) { $oldestMtime = $mt; $oldestPath = $relPath }
        }

        $aheadRaw = Invoke-GitBounded -GitArgs @('-C', $root, 'rev-list', '--count', 'origin/main..HEAD')
        $behindRaw = Invoke-GitBounded -GitArgs @('-C', $root, 'rev-list', '--count', 'HEAD..origin/main')
        $aheadKnown = ($aheadRaw -match '^\d+$')
        $behindKnown = ($behindRaw -match '^\d+$')
        if (-not $aheadKnown -or -not $behindKnown) {
            # origin/main unresolvable (fetch truly failed and there was never a prior origin/main,
            # or the remote ref is gone) — fail closed rather than silently treating as 0/0 (current).
            $checkoutResult.Alarm = $true
            $checkoutResult.QueryError = "could not resolve ahead/behind against origin/main (fetch may have failed) — ahead raw='$aheadRaw' behind raw='$behindRaw'"
            $results.Add($checkoutResult); $overallAlarm = $true
            continue
        }
        $ahead = [int]$aheadRaw
        $behind = [int]$behindRaw
        $checkoutResult.Ahead = $ahead
        $checkoutResult.Behind = $behind

        $incomingPaths = @()
        if ($behind -gt 0) {
            $incomingRaw = Invoke-GitBounded -GitArgs @('-C', $root, 'diff', '--name-only', 'HEAD', 'origin/main')
            $incomingPaths = @($incomingRaw | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\', '/').Trim() })
        }

        if (Get-Command Get-DataCheckoutDriftVerdict -ErrorAction SilentlyContinue) {
            $v = Get-DataCheckoutDriftVerdict -Name $name -TrackedModified $tracked -Untracked $untracked `
                -OldestUncommittedMtime $oldestMtime -OldestUncommittedPath $oldestPath -Ahead $ahead -Behind $behind -IncomingPaths $incomingPaths `
                -Now $Now -AgeThresholdHours $AgeThresholdHours -ProtectedPaths $ProtectedPaths
            $checkoutResult.Alarm = $v.Alarm
            $checkoutResult.Reasons = $v.Reasons
            $checkoutResult.AgeHours = $v.AgeHours
            $checkoutResult.Intersects = $v.Intersects
            $checkoutResult.Diverged = $v.Diverged
            $checkoutResult.ProtectedWip = $v.ProtectedWip
            $checkoutResult.SyncReason = $v.SyncReason
        } else {
            # Fail-safe if the verdict file is missing: alarm whenever there's any uncommitted
            # work or any ahead/behind at all (conservative fallback, never silently clean).
            # t/4056: protected-WIP still checked even on this fallback path -- a missing
            # verdict file must never silently drop the one check that exists to prevent data
            # loss, so this path alone replicates it rather than skipping it.
            $protectedHits = [System.Collections.Generic.List[object]]::new()
            foreach ($p in @($tracked + $untracked)) {
                if ($ProtectedPaths.ContainsKey($p)) {
                    $protectedHits.Add([PSCustomObject]@{ Path = $p; Owner = $ProtectedPaths[$p] })
                }
            }
            if ($protectedHits.Count -gt 0) {
                $owners = @($protectedHits | ForEach-Object { $_.Owner } | Select-Object -Unique)
                $checkoutResult.ProtectedWip = @($protectedHits)
                $checkoutResult.SyncReason = "protected WIP (pov-tag review in progress) — route to $([string]::Join(', ', $owners)), do not sync/restore"
            }
            $hasWork = (($tracked.Count + $untracked.Count) -gt 0)
            $checkoutResult.Alarm = $hasWork -or $ahead -gt 0 -or $behind -gt 0
            $checkoutResult.Reasons = @('DataCheckoutDriftVerdict.ps1 missing — conservative fallback')
        }
    } catch {
        $checkoutResult.Alarm = $true
        $checkoutResult.QueryError = "unhandled error checking ${name}: $($_.Exception.Message)"
    }
    $results.Add($checkoutResult)
    if ($checkoutResult.Alarm) { $overallAlarm = $true }
}

[PSCustomObject]@{
    Alarm     = $overallAlarm
    Checkouts = @($results)
}
exit 0
