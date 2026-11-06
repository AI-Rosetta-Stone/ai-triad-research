# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Pure-predicate proof for the untracked-vs-incoming-ADD collision detector (t/4789).
# An untracked local file colliding with an incoming ADD blocks `git merge --ff-only` even though
# SyncBlocked (tracked-WIP-only, TL p/331#1674) does not see it. This verdict surfaces that as an
# ADVISORY finding and deliberately does NOT flip SyncBlocked.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'DriftUntrackedCollisionVerdict.ps1')
}

Describe 'Get-DriftUntrackedCollisionVerdict' {

    Context 'clean-behind — the core intersection' {
        It 'detects a collision when an untracked path IS in the incoming-ADD set' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('a.ts', 'b.ts') -IncomingAddedFiles @('b.ts', 'c.ts') -Behind 3
            $v.HasCollision | Should -BeTrue
            $v.Collisions | Should -Be @('b.ts')
            $v.Degraded | Should -BeFalse
        }

        It 'reports NO collision when the untracked files are not among the incoming ADDs' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('a.ts') -IncomingAddedFiles @('b.ts') -Behind 2
            $v.HasCollision | Should -BeFalse
            $v.Collisions | Should -BeNullOrEmpty
            $v.Reason | Should -Match 'no untracked path'
        }

        It 'reports every colliding path, not just the first' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('x', 'y', 'z') -IncomingAddedFiles @('y', 'z', 'w') -Behind 1
            $v.HasCollision | Should -BeTrue
            $v.Collisions | Should -Be @('y', 'z')
        }

        It 'normalizes separators so a backslash untracked path matches a forward-slash incoming ADD' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('src\server\a.ts') -IncomingAddedFiles @('src/server/a.ts') -Behind 1
            $v.HasCollision | Should -BeTrue
            $v.Collisions | Should -Be @('src/server/a.ts')
        }
    }

    Context 'the live regression fixture (r/11#1619)' {
        It 'communityContainer.ts untracked + incoming ADD of the same path → collision' {
            $p = 'taxonomy-editor/src/server/storage/communityContainer.ts'
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @($p) -IncomingAddedFiles @($p) -Behind 1
            $v.HasCollision | Should -BeTrue
            $v.Collisions | Should -Be @($p)
        }
    }

    Context 'current (behind=0) — no fast-forward pending' {
        It 'never reports a collision when behind=0, even on an exact path match' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('a.ts') -IncomingAddedFiles @('a.ts') -Behind 0
            $v.HasCollision | Should -BeFalse
            $v.Reason | Should -Match 'behind=0'
        }
    }

    Context 'DEGRADED — incoming-ADD set uncomputable must never read as clean OR as a false alarm' {
        It 'behind>0 + IncomingAddedKnown=$false → no collision, Degraded=$true' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('a.ts') -IncomingAddedFiles @() -Behind 2 -IncomingAddedKnown $false
            $v.HasCollision | Should -BeFalse
            $v.Degraded | Should -BeTrue
            $v.Reason | Should -Match 'DEGRADED'
        }

        It 'a genuinely empty-but-KNOWN incoming-ADD set is clean, not degraded' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('a.ts') -IncomingAddedFiles @() -Behind 2 -IncomingAddedKnown $true
            $v.HasCollision | Should -BeFalse
            $v.Degraded | Should -BeFalse
        }
    }

    Context 'empty / no-op inputs' {
        It 'no untracked files at all → no collision' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @() -IncomingAddedFiles @('a.ts') -Behind 2
            $v.HasCollision | Should -BeFalse
        }

        It 'ignores blank/empty entries in both inputs' {
            $v = Get-DriftUntrackedCollisionVerdict -UntrackedFiles @('', 'a.ts', $null) -IncomingAddedFiles @('a.ts', '') -Behind 1
            $v.HasCollision | Should -BeTrue
            $v.Collisions | Should -Be @('a.ts')
        }
    }
}
