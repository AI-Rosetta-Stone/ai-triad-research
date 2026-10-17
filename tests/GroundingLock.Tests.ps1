# Tag: unit (t/3203)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/3203: the entity_mentions grounding write-lock (Enter/Exit-GroundingLock) — advisory,
    exclusive-create acquire, mtime-staleness break (>120s), bounded wait → ActionableError,
    and Update-EntityMentionIndex acquires/releases it around its read-merge-write. Mirrors the
    Python reconcile_grounding.py contract (t/3194).
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Enter/Exit-GroundingLock (t/3203)' -Tag 'unit' {

    It 'acquires an unheld lock (creates the file, returns a handle) and releases it' {
        InModuleScope AITriad {
            $lock = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')) 'entity_mentions.lock'
            New-Item -ItemType Directory -Path (Split-Path $lock) -Force | Out-Null

            $h = Enter-GroundingLock -LockPath $lock
            try {
                Test-Path -LiteralPath $lock | Should -BeTrue
                $h.GetType().FullName | Should -Be 'AITriad.GroundingLockV2.LockHandle'   # v2 lock object (t/4193)
            }
            finally {
                Exit-GroundingLock -Handle $h -LockPath $lock
            }
            # released — file gone
            Test-Path -LiteralPath $lock | Should -BeFalse
        }
    }

    It 'times out with an ActionableError when the lock is held (fresh) and not stale' {
        InModuleScope AITriad {
            $lock = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')) 'entity_mentions.lock'
            New-Item -ItemType Directory -Path (Split-Path $lock) -Force | Out-Null
            New-Item -ItemType File -Path $lock -Force | Out-Null   # held (mtime = now)

            # WaitSec 1, StaleSec 120 → not stale, so it waits ~1s then throws.
            { Enter-GroundingLock -LockPath $lock -WaitSec 1 -StaleSec 120 -PollSec 0.2 } |
                Should -Throw '*held by another writer*'
        }
    }

    It 'breaks a stale lock (mtime age > StaleSec), WARNs, and acquires' {
        InModuleScope AITriad {
            $lock = Join-Path $TestDrive ([guid]::NewGuid().ToString('N')) 'entity_mentions.lock'
            New-Item -ItemType Directory -Path (Split-Path $lock) -Force | Out-Null
            New-Item -ItemType File -Path $lock -Force | Out-Null
            # Age the holder past the staleness threshold.
            (Get-Item -LiteralPath $lock).LastWriteTime = (Get-Date).AddSeconds(-200)

            $warn = @()
            $h = Enter-GroundingLock -LockPath $lock -WaitSec 5 -StaleSec 120 -PollSec 0.2 -WarningVariable warn -WarningAction SilentlyContinue
            try {
                $h.GetType().FullName | Should -Be 'AITriad.GroundingLockV2.LockHandle'   # acquired after breaking the stale lock
                ($warn -join ' ') | Should -Match 'stale lock'
            }
            finally {
                Exit-GroundingLock -Handle $h -LockPath $lock
            }
        }
    }
}

Describe 'Update-EntityMentionIndex honors the grounding lock (t/3203)' -Tag 'unit' {

    It 'acquires + releases the lock around the write (no leftover entity_mentions.lock)' {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $entPath = Join-Path $root 'entities.json'
        $outPath = Join-Path $root 'entity_mentions.json'
        ([ordered]@{ _schema_version = '1.0.0'; _doc = 't'; entity_count = 1; last_modified = '2026-09-01'
                entities = @([ordered]@{ id = 'ent-001'; name = 'Apollo Project'; aliases = @(); entity_type = 'event'; status = 'approved' }) } |
            ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $entPath -Encoding utf8NoBOM
        ([ordered]@{ 'acc-desires-001' = @{ facts = @(@{ claim = 'The Apollo Project reshaped ambition.' }) } } |
            ConvertTo-Json -Depth 8) | Set-Content -LiteralPath (Join-Path $root 'sei.json') -Encoding utf8NoBOM

        $r = Update-EntityMentionIndex -EntitiesPath $entPath `
            -SourceEvidenceIndexPath (Join-Path $root 'sei.json') -SummariesPath @() -OutputPath $outPath
        $r.Written | Should -BeTrue
        # The write happened AND the lock was released (no leftover lockfile beside the output).
        Test-Path -LiteralPath (Join-Path $root 'entity_mentions.lock') | Should -BeFalse
    }

    It 'refuses the final write with an ActionableError when the lock is lost before it (t/4193 condition 2)' {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $entPath = Join-Path $root 'entities.json'
        $outPath = Join-Path $root 'entity_mentions.json'
        $lockPath = Join-Path $root 'entity_mentions.lock'
        ([ordered]@{ _schema_version = '1.0.0'; _doc = 't'; entity_count = 1; last_modified = '2026-09-01'
                entities = @([ordered]@{ id = 'ent-001'; name = 'Apollo Project'; aliases = @(); entity_type = 'event'; status = 'approved' }) } |
            ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $entPath -Encoding utf8NoBOM
        ([ordered]@{ 'acc-desires-001' = @{ facts = @(@{ claim = 'The Apollo Project reshaped ambition.' }) } } |
            ConvertTo-Json -Depth 8) | Set-Content -LiteralPath (Join-Path $root 'sei.json') -Encoding utf8NoBOM

        $err = $null
        try {
            # LockFile, not a name the cmdlet uses itself: the mock body resolves variables dynamically.
            InModuleScope AITriad -Parameters @{ Root = $root; Ent = $entPath; Out = $outPath; LockFile = $lockPath } {
                param($Root, $Ent, $Out, $LockFile)
                # The step just before the final write: another writer takes the lock over here.
                Mock Assert-DataWriteAllowed { [System.IO.File]::WriteAllText($LockFile, '{"holder":"reconciler","nonce":"other"}') }
                Mock Set-Content { } -ParameterFilter { $LiteralPath -like '*.tmp' }   # the write sink
                try {
                    Update-EntityMentionIndex -EntitiesPath $Ent -SourceEvidenceIndexPath (Join-Path $Root 'sei.json') `
                        -SummariesPath @() -OutputPath $Out 3> $null
                }
                finally { Should -Invoke Set-Content -Times 0 -Exactly -ParameterFilter { $LiteralPath -like '*.tmp' } }
            }
        }
        catch { $err = $_ }
        $err | Should -Not -BeNullOrEmpty
        $err.Exception.Message | Should -Match 'Goal:'
        $err.Exception.Message | Should -Match 'lost while held \(lockfile replaced\)'
        Test-Path -LiteralPath $outPath | Should -BeFalse                                        # nothing written
        Get-Content -LiteralPath $lockPath -Raw | Should -Be '{"holder":"reconciler","nonce":"other"}'   # the new holder's lock is untouched
    }
}

Describe 'Grounding lock protocol v2 (t/4193)' -Tag 'unit' {

    BeforeEach {
        $script:LockDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:LockDir -Force | Out-Null
        $script:LockPath = Join-Path $script:LockDir 'entity_mentions.lock'
    }

    It 'acquire writes the JSON payload and closes the handle (readable and renamable while held)' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P -Holder 'pester' }
        try {
            $raw = [System.IO.File]::ReadAllText($script:LockPath)   # would throw with the v1 FileShare.None handle
            $raw | Should -BeExactly $l.Payload
            $j = $raw | ConvertFrom-Json
            $j.holder | Should -Be 'pester'
            $j.pid | Should -Be $PID
            $j.nonce | Should -Be $l.Nonce
            @($j.PSObject.Properties.Name) | Should -Be @('holder', 'pid', 'host', 'nonce', 'acquired_at')
            $moved = "$($script:LockPath).probe"
            [System.IO.File]::Move($script:LockPath, $moved)       # a breaker can rename it
            [System.IO.File]::Move($moved, $script:LockPath)
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L } }
        Test-Path -LiteralPath $script:LockPath | Should -BeFalse
    }

    It 'rename-break: a stale lock with a foreign payload is renamed away and deleted, the waiter acquires, and it WARNs' {
        [System.IO.File]::WriteAllText($script:LockPath, '{"holder":"dead","nonce":"old"}')
        [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddSeconds(-600))
        $warn = @()
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } {
            param($P) Enter-GroundingLock -LockPath $P -WaitSec 5 -PollSec 0.05 -WarningVariable w -WarningAction SilentlyContinue
            $script:GlTestWarn = $w
        }
        try {
            $warn = InModuleScope AITriad { $script:GlTestWarn }
            [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly $l.Payload
            ($warn -join ' ') | Should -Match 'breaking stale lock'
            ($warn -join ' ') | Should -Match 'identity confirmed'
            @(Get-ChildItem -LiteralPath $script:LockDir -Filter '*.breaking.*').Count | Should -Be 0
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L } }
    }

    It 'rename-break: when the moved file differs from what was judged stale, it is restored (no break)' {
        [System.IO.File]::WriteAllText($script:LockPath, 'stale-A')
        [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddSeconds(-600))
        $err = $null
        try {
            InModuleScope AITriad -Parameters @{ P = $script:LockPath } {
                param($P)
                # Between our read (A) and our rename, A's holder lost it to a fresh holder B.
                Mock Move-GroundingLockAway {
                    [System.IO.File]::WriteAllText($Path, 'fresh-B')
                    [System.IO.File]::Move($Path, $Destination, $false)
                }
                Enter-GroundingLock -LockPath $P -WaitSec 1 -PollSec 0.05 3> $null
            }
        }
        catch { $err = $_ }
        $err.Exception.Message | Should -Match 'held by another writer'
        [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly 'fresh-B'   # restored, never deleted
        @(Get-ChildItem -LiteralPath $script:LockDir -Filter '*.breaking.*').Count | Should -Be 0
    }

    It 'TL condition 1: a fresh lock injected between rename-away and restore survives (restore never overwrites)' {
        [System.IO.File]::WriteAllText($script:LockPath, 'stale-A')
        [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddSeconds(-600))
        InModuleScope AITriad -Parameters @{ P = $script:LockPath } {
            param($P)
            Mock Move-GroundingLockAway {
                [System.IO.File]::WriteAllText($Path, 'fresh-B')                 # before our rename: B replaced A
                [System.IO.File]::Move($Path, $Destination, $false)              # we rename B away
                [System.IO.File]::WriteAllText($Path, 'fresh-C')                 # a third waiter O_EXCL-creates C
            }
            $script:GlTestWarn = [System.Collections.Generic.List[string]]::new()
            $script:GlTestErr = $null
            try { Enter-GroundingLock -LockPath $P -WaitSec 1 -PollSec 0.05 3>&1 | ForEach-Object { $script:GlTestWarn.Add("$_") } }
            catch { $script:GlTestErr = $_ }
        }
        $err = InModuleScope AITriad { $script:GlTestErr }
        $warn = InModuleScope AITriad { $script:GlTestWarn }
        $err.Exception.Message | Should -Match 'held by another writer'
        [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly 'fresh-C'   # C survives: no overwrite
        @(Get-ChildItem -LiteralPath $script:LockDir -Filter '*.breaking.*').Count | Should -Be 0   # B's breaking file deleted
        (@($warn) -join ' ') | Should -Match 'could not restore a live lock'
    }

    It 'rename-break: a rename that reports success but leaves no moved file (NTFS concurrent-rename quirk) WARNs and retries' {
        [System.IO.File]::WriteAllText($script:LockPath, 'stale-A')
        [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddSeconds(-600))
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } {
            param($P)
            Mock Move-GroundingLockAway { [System.IO.File]::Move($Path, $Destination, $false); [System.IO.File]::Delete($Destination) }
            Enter-GroundingLock -LockPath $P -WaitSec 5 -PollSec 0.05 -WarningVariable w -WarningAction SilentlyContinue
            $script:GlTestWarn = $w
        }
        try {
            $warn = InModuleScope AITriad { $script:GlTestWarn }
            ($warn -join ' ') | Should -Match 'reported success but the moved file is missing'
            [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly $l.Payload
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L } }
    }

    It 'TL condition 2: a lock REPLACED under the holder makes Assert-GroundingLockHeld throw an ActionableError' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P }
        try {
            [System.IO.File]::WriteAllText($script:LockPath, '{"holder":"reconciler","nonce":"other"}')
            $err = $null
            try { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Assert-GroundingLockHeld -Lock $L 3> $null } } catch { $err = $_ }
            $err | Should -Not -BeNullOrEmpty
            $err.Exception.Message | Should -Match 'Goal:'
            $err.Exception.Message | Should -Match 'lost while held \(lockfile replaced\)'
            $l.Lost | Should -BeTrue
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L 3> $null } }
        [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly '{"holder":"reconciler","nonce":"other"}'   # release left it alone
    }

    It 'TL condition 2: a lock DELETED under the holder makes Assert-GroundingLockHeld throw an ActionableError' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P }
        try {
            [System.IO.File]::Delete($script:LockPath)
            $err = $null
            try { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Assert-GroundingLockHeld -Lock $L 3> $null } } catch { $err = $_ }
            $err.Exception.Message | Should -Match 'lost while held \(lockfile missing\)'
            $l.Lost | Should -BeTrue
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L 3> $null } }
    }

    It 'Assert-GroundingLockHeld passes while the lock is ours, and refuses a $null lock' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P }
        try {
            { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Assert-GroundingLockHeld -Lock $L } } | Should -Not -Throw
            { InModuleScope AITriad { Assert-GroundingLockHeld -Lock $null } } | Should -Throw '*does not hold the lock*'
        }
        finally { InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L } }
    }

    It 'TL condition 3: the heartbeat advances mtime without changing the JSON bytes, and marks Lost when the file is replaced' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P -StaleSec 0.4 }   # beat every 0.1s
        try {
            $before = [System.IO.File]::ReadAllBytes($script:LockPath)
            [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddHours(-1))
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ([System.IO.File]::GetLastWriteTimeUtc($script:LockPath) -lt [DateTime]::UtcNow.AddMinutes(-1) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
            ([DateTime]::UtcNow - [System.IO.File]::GetLastWriteTimeUtc($script:LockPath)).TotalSeconds | Should -BeLessThan 30
            $l.BeatCount | Should -BeGreaterThan 0
            [System.IO.File]::ReadAllBytes($script:LockPath) | Should -Be $before   # mtime only, never a JSON rewrite
            $l.Lost | Should -BeFalse

            [System.IO.File]::WriteAllText($script:LockPath, 'someone-else')
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while (-not $l.Lost -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
            $l.Lost | Should -BeTrue
            $l.LostReason | Should -Be 'lockfile replaced'
            $l.HeartbeatStopped | Should -BeTrue
        }
        finally {
            InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L -WarningVariable w -WarningAction SilentlyContinue; $script:GlTestWarn = $w }
        }
        (@(InModuleScope AITriad { $script:GlTestWarn }) -join ' ') | Should -Match 'lost while held'   # queued on the timer thread, emitted here
        [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly 'someone-else'
    }

    It 'TL condition 4: after MaxHoldSec the heartbeat stops with a WARN, so the lock can go stale' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P -StaleSec 0.4 -MaxHoldSec 0.3 }
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while (-not $l.HeartbeatStopped -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
            $l.HeartbeatStopped | Should -BeTrue
            $l.HeartbeatStopReason | Should -Be 'max_hold'
            $l.Lost | Should -BeFalse
            [System.IO.File]::SetLastWriteTimeUtc($script:LockPath, [DateTime]::UtcNow.AddHours(-1))
            Start-Sleep -Milliseconds 400                                                # 4 beat intervals
            [System.IO.File]::GetLastWriteTimeUtc($script:LockPath) | Should -BeLessThan ([DateTime]::UtcNow.AddMinutes(-30))   # no more touches
        }
        finally {
            InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L -WarningVariable w -WarningAction SilentlyContinue; $script:GlTestWarn = $w }
        }
        (@(InModuleScope AITriad { $script:GlTestWarn }) -join ' ') | Should -Match 'MaxHoldSec'
        Test-Path -LiteralPath $script:LockPath | Should -BeFalse   # still ours, so release deletes it
    }

    It 'release leaves a lock carrying a foreign payload in place' {
        $l = InModuleScope AITriad -Parameters @{ P = $script:LockPath } { param($P) Enter-GroundingLock -LockPath $P }
        [System.IO.File]::WriteAllText($script:LockPath, 'foreign')
        InModuleScope AITriad -Parameters @{ L = $l } { param($L) Exit-GroundingLock -Lock $L 3> $null }
        [System.IO.File]::ReadAllText($script:LockPath) | Should -BeExactly 'foreign'
        $l.HeartbeatStopped | Should -BeTrue
    }
}
