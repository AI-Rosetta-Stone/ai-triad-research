# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate: should the hourly drift check alarm on a shared DATA checkout
    (ai-triad-data / ai-triad-sources)? Detection only — never commits, deletes, or syncs
    anything. (t/4005, the surviving vector from t/4001: 63 uncommitted ingested sources
    sat for ~3 weeks, backed up nowhere, found only by chance.)
.DESCRIPTION
    check-shared-drift.ps1 (r/11) covers only the CODE checkout; nothing watched either data
    checkout. This predicate is the data-side equivalent, scoped to what matters for data:
    uncommitted work going stale, and uncommitted work that a future sync would conflict with.

    Alarm iff ANY of:
      (0) PROTECTED WIP (t/4056, SO e/270#2) — a path in ProtectedPaths (tracked-modified OR
          untracked) is reviewer work-in-progress that a sync/restore must never discard (e.g.
          `taxonomy/Origin/pov-tag-proposals.json`, owned by the Computational Linguist: t/4052
          reviews land as an uncommitted edit until CL's step-4 run). This is CHECKED AND
          REPORTED FIRST, unconditionally — Alarm=$true regardless of what (a)-(d) below would
          otherwise say, so a protected path is never masked by, or deduplicated into, an
          ordinary staleness/intersection finding. SyncReason names the owner to route to; the
          caller (check-data-checkout-drift.ps1) and the sync procedure must refuse to
          sync/restore/reset while any ProtectedWip entry is present, even if that path's diff
          against origin/main is empty (an empty diff is not evidence the review decision is
          already captured upstream — see docs/shared-tree-divergence.md).
      (a) uncommitted work (tracked-modified OR untracked) is older than AgeThresholdHours;
      (b) a tracked-modified path intersects IncomingPaths — origin/main will touch a file
          this checkout has modified but not committed;
      (c) an untracked path intersects IncomingPaths — origin/main is about to ADD a file at
          a path this checkout already has an untracked (uncommitted, unbacked-up) copy of.
          (Structural note: a path in IncomingPaths that is also UNTRACKED locally cannot be
          a local modify-conflict — if the path were already tracked at HEAD, the local copy
          would be tracked too, not untracked. So any Untracked∩IncomingPaths hit is
          necessarily an incoming ADD colliding with local uncommitted work — no separate
          `git diff --name-status` pass is needed to tell add from modify.)
      (d) diverged (Ahead > 0 AND Behind > 0) — ahead+behind at once means local commits exist
          that origin/main doesn't have AND origin/main has commits this checkout doesn't;
          either direction's resolution risks the other's uncommitted work.

    Behind-only (Behind > 0, Ahead = 0, no intersection) is explicitly NOT an alarm — only an
    info line in Reasons. A data checkout trailing origin/main with no conflicting local edits
    is normal and does not need an owner-claim.

    FAIL-SAFE on missing age data: if there IS uncommitted work (tracked-modified or untracked
    non-empty) but $OldestUncommittedMtime is $null (the caller could not stat it — e.g. a
    long-path read failure), age is treated as INFINITE (always over threshold), never as "no
    age, so no alarm." A file whose age cannot be determined must never read as fresh.

    PURE: takes already-computed sets/counts/timestamp, returns the verdict. The impure git
    calls, file mtime reads (long-path `\\?\`-prefixed, t/4005), and per-checkout error
    handling live in check-data-checkout-drift.ps1. Mirrors DriftSyncVerdict.ps1 /
    DriftPhantomVerdict.ps1 — unverified errors (unreadable repo, git/fetch failure) are the
    CALLER's job to turn into Alarm=$true + QueryError, bypassing this function entirely for
    that checkout; this function is never called with an error to represent.
.PARAMETER Name
    Checkout label (e.g. 'ai-triad-data'), carried through to the result for reporting.
.PARAMETER TrackedModified
    Paths with uncommitted modifications to TRACKED files (`git status --porcelain`, the
    modified/added/deleted/renamed entries — not untracked).
.PARAMETER Untracked
    Paths git does not track at all (`git status --porcelain`, `??` entries).
.PARAMETER OldestUncommittedMtime
    [Nullable[datetime]] last-write-time of the OLDEST file among TrackedModified+Untracked, in
    UTC (the caller reads it via GetLastWriteTimeUtc). $null when the caller could not determine
    it (fail-safe: treated as infinitely old below).
.PARAMETER OldestUncommittedPath
    The specific path that OldestUncommittedMtime belongs to (t/4005 real-incident fix, p/210#152:
    the old Reasons message applied this ONE file's age to the entire dirty-file list, reading as
    if every listed file shared it -- e.g. a 96.7h-old cache file's age got attached to taxonomy
    files that were really ~3h old, costing a round-trip with the file's actual owner to sort out).
    $null (the default) falls back to the pre-fix wording for callers that don't pass it.
.PARAMETER Ahead
    Commits this checkout has that origin does not (`origin..HEAD`).
.PARAMETER Behind
    Commits origin has that this checkout does not (`HEAD..origin`).
.PARAMETER IncomingPaths
    Paths the behind-commits touch (`git diff --name-only HEAD origin/main`). Only meaningful
    when Behind > 0; an empty list when Behind = 0 is expected, not a failure.
.PARAMETER Now
    Wall-clock time to compute age against, in UTC (same clock as OldestUncommittedMtime --
    mixing local and UTC here produces a timezone-offset-sized error in AgeHours, t/4060).
    Mandatory — this function is pure, so "now" is supplied by the caller, never read
    internally (Get-Date would make this impure and untestable-by-fixed-clock).
.PARAMETER AgeThresholdHours
    Hours after which uncommitted work is considered stale enough to alarm. Default 24 (t/4005
    spec: "say 24h").
.PARAMETER ProtectedPaths
    Hashtable of repo-relative-path -> owner name. Data, not code, so more entries can be
    added without touching this function (t/4056). Default: the one entry known today --
    `taxonomy/Origin/pov-tag-proposals.json` -> 'Computational Linguist' (t/4052 reviews land
    as an uncommitted edit until CL's step-4 run, t/3962#15).
.OUTPUTS
    PSCustomObject { Name; Alarm; Reasons=[string[]]; AgeHours=[double]; Intersects=[bool];
    Diverged=[bool]; ProtectedWip=[PSCustomObject[]] ({Path;Owner}); SyncReason=[string] or
    $null }
#>

function Get-DataCheckoutDriftVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Name,
        [string[]]$TrackedModified = @(),
        [string[]]$Untracked = @(),
        [Nullable[datetime]]$OldestUncommittedMtime = $null,
        [string]$OldestUncommittedPath = $null,
        [int]$Ahead = 0,
        [int]$Behind = 0,
        [string[]]$IncomingPaths = @(),
        [Parameter(Mandatory)] [datetime]$Now,
        [double]$AgeThresholdHours = 24,
        [hashtable]$ProtectedPaths = @{ 'taxonomy/Origin/pov-tag-proposals.json' = 'Computational Linguist' }
    )

    $tracked = @($TrackedModified | Where-Object { $_ })
    $untracked = @($Untracked | Where-Object { $_ })
    $incoming = @($IncomingPaths | Where-Object { $_ })
    $hasUncommitted = (($tracked.Count + $untracked.Count) -gt 0)

    # (0) PROTECTED WIP — checked and reported FIRST, unconditionally: a path here is
    # reviewer work-in-progress a sync/restore must never discard, regardless of what (a)-(d)
    # below would otherwise conclude (t/4056, SO e/270#2).
    $protectedWip = [System.Collections.Generic.List[object]]::new()
    foreach ($p in @($tracked + $untracked)) {
        if ($ProtectedPaths.ContainsKey($p)) {
            $protectedWip.Add([PSCustomObject]@{ Path = $p; Owner = $ProtectedPaths[$p] })
        }
    }
    $hasProtectedWip = $protectedWip.Count -gt 0
    $syncReason = $null
    if ($hasProtectedWip) {
        $owners = @($protectedWip | ForEach-Object { $_.Owner } | Select-Object -Unique)
        $ownerList = [string]::Join(', ', $owners)
        $syncReason = "protected WIP (pov-tag review in progress) — route to $ownerList, do not sync/restore"
    }

    # (a) age — fail-safe on a missing mtime: infinite age, never "no age so fresh".
    $ageHours = 0.0
    if ($hasUncommitted) {
        if ($null -eq $OldestUncommittedMtime) {
            $ageHours = [double]::PositiveInfinity
        } else {
            $ageHours = ($Now - $OldestUncommittedMtime).TotalHours
        }
    }
    $staleAlarm = $hasUncommitted -and ($ageHours -gt $AgeThresholdHours)

    # (b)/(c) intersection — tracked-modified or untracked colliding with an incoming path.
    $incomingSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$incoming, [System.StringComparer]::Ordinal)
    $trackedHits = @($tracked | Where-Object { $incomingSet.Contains($_) })
    $untrackedHits = @($untracked | Where-Object { $incomingSet.Contains($_) })
    $intersects = (($trackedHits.Count + $untrackedHits.Count) -gt 0)

    # (d) diverged.
    $diverged = ($Ahead -gt 0 -and $Behind -gt 0)

    $alarm = $staleAlarm -or $intersects -or $diverged -or $hasProtectedWip

    $reasons = [System.Collections.Generic.List[string]]::new()
    if ($hasProtectedWip) {
        $reasons.Add($syncReason)
    }
    if ($staleAlarm) {
        $oldest = @(@($tracked + $untracked) | Select-Object -First 20)
        # t/4493 follow-up: $oldest is capped at 20 for display, but the "total uncommitted" count
        # must be the REAL total (tracked.Count + untracked.Count), not the capped list's length --
        # otherwise any checkout with >20 dirty files silently under-reports its own total (found
        # live: ai-triad-sources had 56 dirty files, reported as "20 total").
        $totalUncommitted = $tracked.Count + $untracked.Count
        $ageDesc = if ([double]::IsPositiveInfinity($ageHours)) { 'unknown (mtime unreadable — treated as stale)' } else { "$([Math]::Round($ageHours, 1))h" }
        if ($OldestUncommittedPath) {
            # t/4005 real-incident fix: name the ONE file this age actually belongs to, separately
            # from the rest of the dirty-file list -- each of those may be a very different age.
            # The old wording attached one file's age to the whole list, reading as if every listed
            # file shared it (p/210#152: a 96.7h-old cache file's age got misread onto taxonomy files
            # that were really ~3h old).
            $reasons.Add("uncommitted work older than ${AgeThresholdHours}h -- oldest: $OldestUncommittedPath ($ageDesc); $totalUncommitted total uncommitted file(s), ages vary: $([string]::Join(', ', $oldest))")
        } else {
            $reasons.Add("uncommitted work older than ${AgeThresholdHours}h (oldest age: $ageDesc): $([string]::Join(', ', $oldest))")
        }
    }
    if ($trackedHits.Count -gt 0) {
        $listed = @($trackedHits | Select-Object -First 20)
        $reasons.Add("tracked-modified intersects incoming origin/main change(s): $([string]::Join(', ', $listed))")
    }
    if ($untrackedHits.Count -gt 0) {
        $listed = @($untrackedHits | Select-Object -First 20)
        $reasons.Add("untracked file(s) collide with an incoming add: $([string]::Join(', ', $listed))")
    }
    if ($diverged) {
        $reasons.Add("DIVERGED (ahead=$Ahead, behind=$Behind)")
    }
    if (-not $alarm -and $Behind -gt 0) {
        $reasons.Add("(info) behind origin by $Behind commit(s), no intersection with local uncommitted work — not an alarm")
    }

    return [PSCustomObject]@{
        Name         = $Name
        Alarm        = $alarm
        Reasons      = @($reasons)
        AgeHours     = $ageHours
        Intersects   = $intersects
        Diverged     = $diverged
        ProtectedWip = @($protectedWip)
        SyncReason   = $syncReason
    }
}
