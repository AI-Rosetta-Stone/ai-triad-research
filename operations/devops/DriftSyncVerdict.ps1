# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate: is an ff-sync of the shared checkout BLOCKED by real WIP that the incoming
    commits would actually overwrite? (t/3745 drift-check hold-predicate fix; TL p/331#1666-1674.)
.DESCRIPTION
    The bug this fixes: the drift check held (escalated owner-claim, blocked the sync) whenever ANY
    real WIP existed — `HasRealDiff` — regardless of whether that WIP intersects what's landing. But
    `git merge --ff-only` only refuses when the fast-forward would OVERWRITE a locally-modified file;
    a dirty file the incoming commits don't touch is carried through untouched. So "9 behind, one
    open editor on an unrelated file" blocked every sync for hours — the PROTOCOL, not git, was
    blocking (a real occurrence: LessonsLearned.md dirty, 9 incoming commits, none touching it).

    Correct hold predicate: **hold iff a real-WIP file is in the incoming change-set.**

        clean-behind (ahead=0, behind>0):  SyncBlocked = (RealWipFiles ∩ IncomingFiles) non-empty
        diverged     (ahead>0, behind>0):  SyncBlocked = (RealWipFiles.Count > 0)
                                           — the diverged path uses `reset --hard`, which overwrites
                                             EVERY local mod regardless of intersection, so the
                                             intersection carve-out is FF-ONLY; hold on any real WIP.
        current      (behind=0):           SyncBlocked = $false (nothing to sync).

    RealWipFiles already means "differs from origin/main modulo CRLF" (Get-DriftPhantomVerdict, exit
    0=phantom / 1|other=REAL), so a dirty file byte-identical to origin is already NOT real WIP and
    never blocks — no separate unique-vs-origin check is needed here.

    FAIL-CLOSED ARMS — three comparisons feed this, and each must refuse to read "empty ⇒ safe"
    (the recurring "infer safe from silence" trap):
      1. INCOMING set empty while behind>0 is IMPOSSIBLE (behind means there ARE incoming commits
         with changes). Treat an empty/failed incoming set with behind>0 as BROKEN → SyncBlocked,
         never as "no intersection ⇒ safe." (`$IncomingKnown = $false` signals the caller's git
         diff failed or returned nothing.)
      2. WIP set — RealWipFiles comes from Get-DriftPhantomVerdict, which already fails a failed
         git-diff toward REAL. A $null list here is treated conservatively as "unknown ⇒ blocked".
      3. unique-vs-origin — already inside RealWipFiles' classification (see above); its own
         failed-diff→REAL arm lives in Get-DriftPhantomVerdict.

    Untracked files are deliberately OUT of RealWipFiles (they are junk/suspicious buckets, not WIP)
    so an untracked file colliding with an incoming ADDED path is not held here — but `git merge
    --ff-only` refuses with "untracked working tree file would be overwritten", so git is the
    backstop: the cost is a failed sync attempt, not data loss (TL p/331#1674).
    This decision is PRESERVED — SyncBlocked stays tracked-WIP-only. t/4789 adds a SEPARATE advisory
    finding (Get-DriftUntrackedCollisionVerdict, surfaced by check-shared-drift.ps1 as UntrackedCollisions)
    so the collision is no longer a silent "safe-to-ff" (r/11#1619), WITHOUT reclassifying it as a hold.

    PURE half: takes already-computed sets + counts, returns the verdict — both arms unit-testable
    without a git fixture. The impure git calls (behind/ahead counts, the incoming name-set) live in
    check-shared-drift.ps1. Mirrors DriftPhantomVerdict.ps1 / BranchStrandVerdict.ps1.
.PARAMETER RealWipFiles
    Dirty TRACKED files classified REAL (differ from origin/main) — from Get-DriftPhantomVerdict.
.PARAMETER IncomingFiles
    Paths the incoming commits change: `git diff --name-only HEAD..origin/main`. Meaningful only
    when $IncomingKnown is $true.
.PARAMETER Behind
    Commits the shared checkout is behind origin/main (HEAD..origin/main).
.PARAMETER Ahead
    Commits the shared checkout is ahead of origin/main (origin/main..HEAD). >0 with Behind>0 = diverged.
.PARAMETER IncomingKnown
    $false when the caller could not compute the incoming set (git error). Forces fail-closed.
.OUTPUTS
    PSCustomObject { SyncBlocked = [bool]; Conflicts = [string[]]; Reason = [string] }
#>

function Get-DriftSyncVerdict {
    [CmdletBinding()]
    param(
        [string[]]$RealWipFiles = @(),
        [string[]]$IncomingFiles = @(),
        [Parameter(Mandatory)] [int]$Behind,
        [int]$Ahead = 0,
        [bool]$IncomingKnown = $true
    )

    $wip = @($RealWipFiles | Where-Object { $_ })

    # current — nothing incoming to fast-forward, so nothing to block.
    if ($Behind -le 0) {
        return [PSCustomObject]@{ SyncBlocked = $false; Conflicts = @(); Reason = 'current — behind=0, nothing to sync' }
    }

    # diverged (ahead>0, behind>0) — resolution is `reset --hard`, which overwrites EVERY local mod
    # regardless of intersection. The intersection carve-out is FF-only; hold on ANY real WIP here.
    if ($Ahead -gt 0) {
        return [PSCustomObject]@{
            SyncBlocked = ($wip.Count -gt 0)
            Conflicts   = @($wip)
            Reason      = if ($wip.Count -gt 0) {
                "DIVERGED (ahead=$Ahead, behind=$Behind) with $($wip.Count) real-WIP file(s) — reset --hard overwrites all; hold + owner-claim (FF intersection carve-out does not apply to reset)"
            } else {
                "DIVERGED (ahead=$Ahead, behind=$Behind), no real WIP — DevOps reset-sync path (no owner-claim)"
            }
        }
    }

    # FAIL-CLOSED (arm 1): behind>0 but the incoming set is unknown/empty is impossible for a real
    # behind — the diff computation failed. Never read empty-incoming as "no conflict ⇒ safe".
    $incoming = @($IncomingFiles | Where-Object { $_ })
    if (-not $IncomingKnown -or $incoming.Count -eq 0) {
        return [PSCustomObject]@{
            SyncBlocked = $true
            Conflicts   = @($wip)
            Reason      = "BROKEN: behind=$Behind but incoming change-set is empty/uncomputable (IncomingKnown=$IncomingKnown) — cannot verify intersection, failing closed (do NOT sync)"
        }
    }

    # clean-behind — hold iff a real-WIP file is in the incoming change-set (git would refuse the ff
    # only for those). A real-WIP file the incoming doesn't touch is carried through untouched.
    $incomingSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$incoming, [System.StringComparer]::Ordinal)
    $conflicts = @($wip | Where-Object { $incomingSet.Contains($_) })

    return [PSCustomObject]@{
        SyncBlocked = ($conflicts.Count -gt 0)
        Conflicts   = @($conflicts)
        Reason      = if ($conflicts.Count -gt 0) {
            "clean-behind (behind=$Behind): $($conflicts.Count) real-WIP file(s) intersect the incoming change-set — ff would overwrite them; hold + owner-claim: $([string]::Join(', ', $conflicts))"
        } else {
            "clean-behind (behind=$Behind): real WIP ($($wip.Count) file(s)) does NOT intersect the incoming change-set — ff-sync is safe, WIP carried through untouched"
        }
    }
}
