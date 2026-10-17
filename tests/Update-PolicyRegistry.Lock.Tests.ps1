# Tag: taxonomy (t/4028)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# t/4028: Update-PolicyRegistry -Fix holds an advisory lock (policy_actions.lock), refuses BEFORE any
# node write when the registry write would be refused, and the registration-failure WARN names the
# node-scoped remedy.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1')

    function New-LockFixture {
        $Dir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-lock-$(Get-Random)"
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        [ordered]@{ _schema_version = '1.0.0'; nodes = @(
                [ordered]@{ id = 'skp-target'; graph_attributes = [ordered]@{ policy_actions = @([ordered]@{ action = 'fresh'; framing = 'f' }) } }
            ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $Dir 'skeptic.json')
        [ordered]@{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 1; policies = @(
                [ordered]@{ id = 'pol-001'; action = 'kept'; source_povs = @('skeptic'); member_count = 0; status = 'active' }) } |
            ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $Dir 'policy_actions.json')
        Add-PolicyPovFillers -Dir $Dir
        return $Dir
    }
}

Describe 'Update-PolicyRegistry advisory lock and preflight (t/4028)' -Tag 'taxonomy' {

    BeforeEach { $script:Dir = New-LockFixture; $script:Lock = Join-Path $script:Dir 'policy_actions.lock' }
    AfterEach { Remove-Item $script:Dir -Recurse -Force -ErrorAction SilentlyContinue }

    It '-Fix takes the lock and releases it (no lockfile left behind)' {
        InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
            param($Dir)
            Mock Get-TaxonomyDir { $Dir }
            Mock Enter-PolicyRegistryLock { Enter-GroundingLock -LockPath $LockPath } -Verifiable
            Update-PolicyRegistry -Fix -NodeId 'skp-target' *> $null
            Should -Invoke Enter-PolicyRegistryLock -Times 1 -Exactly
        }
        Test-Path $script:Lock | Should -BeFalse
    }

    It 'releases the lock when the run throws (corrupt registry)' {
        Set-Content -Path (Join-Path $script:Dir 'policy_actions.json') -Value '{ not json'
        $threw = $false
        try {
            InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
                param($Dir)
                Mock Get-TaxonomyDir { $Dir }
                Update-PolicyRegistry -Fix -NodeId 'skp-target' *> $null
            }
        } catch { $threw = $true }
        $threw | Should -BeTrue
        Test-Path $script:Lock | Should -BeFalse
    }

    It 'a report-only run takes no lock, so it is not blocked by a held one' {
        New-Item -ItemType File -Path $script:Lock | Out-Null   # fresh = held by "another writer"
        $r = InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
            param($Dir)
            Mock Get-TaxonomyDir { $Dir }
            Update-PolicyRegistry -NodeId 'skp-target' -PassThru 6> $null
        }
        $r.Unregistered | Should -Be 1
        Test-Path $script:Lock | Should -BeTrue   # not ours; untouched
    }

    It 'breaks a stale lock (holder presumed dead) with a WARN and proceeds' {
        New-Item -ItemType File -Path $script:Lock | Out-Null
        (Get-Item $script:Lock).LastWriteTime = (Get-Date).AddMinutes(-10)
        $warnings = InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
            param($Dir)
            Mock Get-TaxonomyDir { $Dir }
            Update-PolicyRegistry -Fix -NodeId 'skp-target' 6> $null 3>&1
        }
        (@($warnings) -join "`n") | Should -Match 'breaking stale lock'
        (Get-Content -Raw (Join-Path $script:Dir 'skeptic.json') | ConvertFrom-Json).nodes[0].graph_attributes.policy_actions[0].policy_id | Should -Be 'pol-002'
        Test-Path $script:Lock | Should -BeFalse
    }

    It 't/4193 condition 2: a lock lost before the node write refuses every write with an ActionableError' {
        $before = (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash
        $regBefore = (Get-FileHash (Join-Path $script:Dir 'policy_actions.json')).Hash
        $err = $null
        try {
            # Named LockFile, not Lock: the mock body resolves variables dynamically, and the body it runs
            # inside has its own -Lock parameter (the lock object).
            InModuleScope AITriad -Parameters @{ Dir = $script:Dir; LockFile = $script:Lock } {
                param($Dir, $LockFile)
                Mock Get-TaxonomyDir { $Dir }
                # The registry preflight runs just before the node write: another writer takes the lock over here.
                Mock Assert-DataWriteAllowed { [System.IO.File]::WriteAllText($LockFile, 'other-holder') }
                Update-PolicyRegistry -Fix -NodeId 'skp-target' *> $null
            }
        } catch { $err = $_ }
        $err.Exception.Message | Should -Match 'Goal:'
        $err.Exception.Message | Should -Match 'lost while held'
        (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash | Should -Be $before
        (Get-FileHash (Join-Path $script:Dir 'policy_actions.json')).Hash | Should -Be $regBefore
        Get-Content -Raw $script:Lock | Should -Be 'other-holder'   # the new holder's lock is not released by us
    }

    It 'PREFLIGHT: when the registry write would be refused, no node file is written' {
        # Simulates policy_actions.json dirty with an earlier run's uncommitted change (BLOCK-tier).
        $before = (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash
        $err = $null
        try {
            InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
                param($Dir)
                Mock Get-TaxonomyDir { $Dir }
                Mock Assert-DataWriteAllowed { }   # node files (WARN tier) are allowed
                Mock Assert-DataWriteAllowed { throw 'BLOCK: policy_actions.json has uncommitted changes' } -ParameterFilter { $Path -like '*policy_actions.json' }
                Update-PolicyRegistry -Fix -NodeId 'skp-target' *> $null
            }
        } catch { $err = $_ }
        $err.Exception.Message | Should -Match 'uncommitted changes'
        (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash | Should -Be $before
        Test-Path $script:Lock | Should -BeFalse
    }
}

Describe 'Invoke-NodePolicyRegistration remedy (t/4028)' -Tag 'taxonomy' {

    It 'names the node-scoped command and the commit-first step, not a corpus-wide -Fix' {
        $warnings = InModuleScope AITriad {
            Mock Update-PolicyRegistry { throw 'refused' }
            Invoke-NodePolicyRegistration -NodeId 'skp-a', 'skp-b' -Caller 'Test' 3>&1
        }
        $msg = @($warnings) -join "`n"
        $msg | Should -Match ([regex]::Escape("Update-PolicyRegistry -Fix -NodeId 'skp-a','skp-b'"))
        $msg | Should -Match 'commit policy_actions.json'
    }
}

Describe 'Lockfile release under -WhatIf (t/4047)' -Tag 'taxonomy' {

    BeforeEach { $script:Dir = New-LockFixture; $script:Lock = Join-Path $script:Dir 'policy_actions.lock' }
    AfterEach { Remove-Item $script:Dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'Update-PolicyRegistry -Fix -WhatIf leaves no policy_actions.lock behind' {
        $before = (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash
        InModuleScope AITriad -Parameters @{ Dir = $script:Dir } {
            param($Dir)
            Mock Get-TaxonomyDir { $Dir }
            Update-PolicyRegistry -Fix -NodeId 'skp-target' -WhatIf *> $null
        }
        Test-Path $script:Lock | Should -BeFalse
        (Get-FileHash (Join-Path $script:Dir 'skeptic.json')).Hash | Should -Be $before   # -WhatIf still writes nothing
    }

    It 'Exit-GroundingLock deletes the lockfile even with an ambient $WhatIfPreference' {
        InModuleScope AITriad -Parameters @{ Lock = $script:Lock } {
            param($Lock)
            $h = Enter-GroundingLock -LockPath $Lock
            $WhatIfPreference = $true
            Exit-GroundingLock -Handle $h -LockPath $Lock 6> $null
            $WhatIfPreference = $false
        }
        Test-Path $script:Lock | Should -BeFalse
    }

    It 'the stale-lock break also deletes under an ambient $WhatIfPreference' {
        New-Item -ItemType File -Path $script:Lock | Out-Null
        (Get-Item $script:Lock).LastWriteTime = (Get-Date).AddMinutes(-10)
        InModuleScope AITriad -Parameters @{ Lock = $script:Lock } {
            param($Lock)
            $WhatIfPreference = $true
            $h = Enter-GroundingLock -LockPath $Lock -WaitSec 2 3> $null 6> $null
            $WhatIfPreference = $false
            Exit-GroundingLock -Handle $h -LockPath $Lock
        }
        Test-Path $script:Lock | Should -BeFalse
    }
}

Describe 'Stale-lock break that cannot delete the lockfile (t/4049)' -Tag 'taxonomy' {

    BeforeEach { $script:Dir = New-LockFixture; $script:Lock = Join-Path $script:Dir 'policy_actions.lock' }
    AfterEach { Remove-Item $script:Dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'terminates within WaitSec with an ActionableError instead of spinning forever' {
        New-Item -ItemType File -Path $script:Lock | Out-Null
        (Get-Item $script:Lock).LastWriteTime = (Get-Date).AddMinutes(-10)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $err = $null
        try {
            InModuleScope AITriad -Parameters @{ Lock = $script:Lock } {
                param($Lock)
                # v2 (t/4193) breaks by rename-away: refuse it, as permissions, an open handle or AV would.
                Mock Move-GroundingLockAway { throw [System.UnauthorizedAccessException]::new('Access to the path is denied (test).') }
                Enter-GroundingLock -LockPath $Lock -WaitSec 2 -PollSec 0.1 3> $null
            }
        } catch { $err = $_ }
        $sw.Stop()
        $err | Should -Not -BeNullOrEmpty
        $err.Exception.Message | Should -Match 'could not be deleted'
        $err.Exception.Message | Should -Match 'Error:'
        $sw.Elapsed.TotalSeconds | Should -BeLessThan 15
        Test-Path $script:Lock | Should -BeTrue   # the lock it could not delete is still there
    }

    It 'warns once about the failed delete, not on every poll' {
        New-Item -ItemType File -Path $script:Lock | Out-Null
        (Get-Item $script:Lock).LastWriteTime = (Get-Date).AddMinutes(-10)
        $warnings = InModuleScope AITriad -Parameters @{ Lock = $script:Lock } {
            param($Lock)
            Mock Move-GroundingLockAway { throw [System.UnauthorizedAccessException]::new('Access to the path is denied (test).') }
            try { Enter-GroundingLock -LockPath $Lock -WaitSec 1 -PollSec 0.05 3>&1 } catch { }
        }
        @(@($warnings) | Where-Object { "$_" -match 'could not delete stale lock' }).Count | Should -Be 1
        # v2 (t/4193) WARNs 'breaking stale lock' only once a break is confirmed; this one never is.
        @(@($warnings) | Where-Object { "$_" -match 'breaking stale lock' }).Count | Should -Be 0
    }
}
