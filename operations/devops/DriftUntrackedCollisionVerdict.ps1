# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate: does an UNTRACKED local file collide with an incoming ADD, so that a pending
    fast-forward would be refused by git? (t/4789 drift-check blind-spot — advisory finding.)
.DESCRIPTION
    The gap this surfaces (found live, r/11#1619): the drift check reported `SyncBlocked=false`
    (safe-to-ff), but `git merge --ff-only origin/main` was refused with "untracked working tree
    files would be overwritten" — an untracked local file (`communityContainer.ts`) colliding with
    an incoming ADD of the same path. `SyncBlocked`'s predicate is tracked-WIP-only, BY DESIGN
    (TL p/331#1674, see DriftSyncVerdict.ps1): untracked files are deliberately out of RealWipFiles,
    and git is treated as the ff-only backstop. That design is intentionally PRESERVED here — this
    verdict does NOT flip SyncBlocked. Two reasons flipping it would be wrong:
      1. it reverses the recorded TL decision; and
      2. SyncBlocked=true routes the reminder into real-WIP owner-claim / snapshot-first semantics,
         which is the WRONG remedy — an untracked collision is fixed by compare-and-remove-if-identical
         (exactly what was done manually in r/11#1619), not an owner-claim.
    So this is a SEPARATE advisory finding: detect the collision and let the caller surface it as its
    own hint (and qualify the misleading "ff-sync is SAFE" message), while SyncBlocked stays as-is.

    A collision is precisely (untracked local paths) ∩ (paths the incoming commits ADD). git refuses
    the ff regardless of content — even a byte-identical untracked copy blocks it — so path-match is
    the correct test; the caller's remediation hint tells the agent to compare content and remove the
    untracked copy only if identical (else preserve it first).

    DEGRADED, not fail-closed: unlike SyncBlocked (the authoritative block decision, which fails
    CLOSED on an uncomputable incoming set), this is an ADVISORY detector that merely supplements an
    already-alarming behind>0 state. Fabricating a collision when the incoming-ADD set could not be
    computed would be a false alarm, so on $IncomingAddedKnown=$false it reports NO collision but sets
    Degraded=$true + a Reason the caller can surface as "detection unavailable" (never as "clean").

    PURE half: takes already-computed sets + the behind count, returns the verdict — unit-testable
    without a git fixture. The impure git calls (behind count, `git diff --name-status`, the untracked
    enumeration) live in check-shared-drift.ps1. Mirrors DriftSyncVerdict.ps1 / DriftPhantomVerdict.ps1.
.PARAMETER UntrackedFiles
    Untracked working-tree paths (`git ls-files --others --exclude-standard`), repo-relative,
    forward-slash normalized. Paths under .worktrees/ should be excluded by the caller (not shared-tree).
.PARAMETER IncomingAddedFiles
    Paths the incoming commits ADD (`git diff --name-status HEAD..origin/main`: status 'A', plus the
    destination of 'R'/'C' rename/copy entries), repo-relative, forward-slash normalized.
.PARAMETER Behind
    Commits the shared checkout is behind origin/main. A collision can only block a pending ff, so
    behind<=0 => no collision (nothing to fast-forward).
.PARAMETER IncomingAddedKnown
    $false when the caller could not compute the incoming-ADD set (git error). Forces DEGRADED
    (no collision reported, Degraded=$true) rather than a false clean/false alarm.
.OUTPUTS
    PSCustomObject { HasCollision = [bool]; Collisions = [string[]]; Degraded = [bool]; Reason = [string] }
#>

function Get-DriftUntrackedCollisionVerdict {
    [CmdletBinding()]
    param(
        [string[]]$UntrackedFiles = @(),
        [string[]]$IncomingAddedFiles = @(),
        [Parameter(Mandatory)] [int]$Behind,
        [bool]$IncomingAddedKnown = $true
    )

    # Normalize both sets to forward-slash, trimmed, non-empty. @() keeps them real arrays even when
    # empty (an empty input must stay @(), never collapse to $null — the HashSet build below and the
    # "empty-but-known is clean, not degraded" contract both depend on it).
    $untracked = @($UntrackedFiles | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\', '/').Trim() } | Where-Object { $_ })
    $added     = @($IncomingAddedFiles | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\', '/').Trim() } | Where-Object { $_ })

    # No pending fast-forward => nothing a collision could block.
    if ($Behind -le 0) {
        return [PSCustomObject]@{ HasCollision = $false; Collisions = @(); Degraded = $false; Reason = 'current — behind=0, no fast-forward pending' }
    }

    # DEGRADED: the incoming-ADD set is uncomputable. Advisory detector => do NOT fabricate a collision
    # (false alarm) and do NOT read empty as clean. Report no collision + Degraded so the caller surfaces
    # "collision detection unavailable", not "clean".
    if (-not $IncomingAddedKnown) {
        return [PSCustomObject]@{
            HasCollision = $false
            Collisions   = @()
            Degraded     = $true
            Reason       = "DEGRADED (behind=$Behind): incoming-ADD set uncomputable (IncomingAddedKnown=`$false) — untracked-collision detection skipped; treat ff as unverified for this class"
        }
    }

    # Build the lookup with an explicit foreach rather than the collection-constructor: the ctor throws
    # ArgumentNullException on an empty/null collection, and an empty incoming-ADD set is a valid, common
    # case (behind with no adds). foreach over @() / $null iterates zero times — safe.
    $addedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($a in $added) { [void]$addedSet.Add($a) }
    $collisions = @($untracked | Where-Object { $addedSet.Contains($_) })

    return [PSCustomObject]@{
        HasCollision = ($collisions.Count -gt 0)
        Collisions   = @($collisions)
        Degraded     = $false
        Reason       = if ($collisions.Count -gt 0) {
            "behind=${Behind}: $($collisions.Count) untracked local file(s) collide with an incoming ADD — git merge --ff-only will refuse to overwrite them (even if byte-identical): $([string]::Join(', ', $collisions))"
        } else {
            "behind=${Behind}: no untracked path collides with an incoming ADD — ff not blocked by this class"
        }
    }
}
