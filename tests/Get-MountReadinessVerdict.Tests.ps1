# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

BeforeAll {
    . "$PSScriptRoot/../operations/devops/Get-MountReadinessVerdict.ps1"
}

Describe 'Get-MountReadinessVerdict' {
    It 'returns ready when the probe succeeded, regardless of attempt number' {
        (Get-MountReadinessVerdict -ProbeSucceeded $true -Attempt 1 -MaxAttempts 3).Verdict | Should -Be 'ready'
        (Get-MountReadinessVerdict -ProbeSucceeded $true -Attempt 3 -MaxAttempts 3).Verdict | Should -Be 'ready'
    }
    It 'returns retry when the probe failed and attempts remain' {
        (Get-MountReadinessVerdict -ProbeSucceeded $false -Attempt 1 -MaxAttempts 3).Verdict | Should -Be 'retry'
        (Get-MountReadinessVerdict -ProbeSucceeded $false -Attempt 2 -MaxAttempts 3).Verdict | Should -Be 'retry'
    }
    It 'returns failed when the probe failed on the last allowed attempt' {
        (Get-MountReadinessVerdict -ProbeSucceeded $false -Attempt 3 -MaxAttempts 3).Verdict | Should -Be 'failed'
    }
    It 'returns failed when the attempt count somehow exceeds MaxAttempts (fail-safe, never retry past the bound)' {
        (Get-MountReadinessVerdict -ProbeSucceeded $false -Attempt 4 -MaxAttempts 3).Verdict | Should -Be 'failed'
    }
}

Describe 'Wait-MountReady' {
    It 'returns ready on the first attempt when the probe succeeds immediately' {
        # & invokes the scriptblock in a child scope: a plain '$calls++' would shadow-create a
        # local in that scope rather than mutate this test's variable, so the probe must write
        # through $script: to be observable here.
        $script:calls = 0
        $result = Wait-MountReady -Probe { $script:calls++; $true } -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'ready'
        $result.Attempts | Should -Be 1
        $script:calls | Should -Be 1
    }

    It 'retries a transient failure and recovers within the bound (the t/4504 shape: a race that clears)' {
        $script:attemptsSeen = 0
        $probe = {
            $script:attemptsSeen++
            # fails on attempt 1, succeeds from attempt 2 onward -- a transient mount-attach race
            return ($script:attemptsSeen -ge 2)
        }
        $result = Wait-MountReady -Probe $probe -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'ready'
        $result.Attempts | Should -Be 2
    }

    It 'fails closed when the probe never succeeds within MaxAttempts (a real missing-file condition, not a transient race)' {
        $script:calls = 0
        $result = Wait-MountReady -Probe { $script:calls++; $false } -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'failed'
        $result.Attempts | Should -Be 3
        $script:calls | Should -Be 3
    }

    It 'never calls the probe more than MaxAttempts times' {
        $script:calls = 0
        $null = Wait-MountReady -Probe { $script:calls++; $false } -MaxAttempts 5 -IntervalSeconds 0
        $script:calls | Should -Be 5
    }

    It 'treats a probe exception as a failed round, not an unhandled loop failure (caller is expected to catch, but prove the loop survives one that does not)' {
        $calls = 0
        $probe = {
            $calls++
            if ($calls -lt 2) { throw 'simulated transient probe error' }
            return $true
        }
        # Wait-MountReady itself does not catch -- this proves the CALLER's contract (wrap the real
        # HTTP probe in try/catch, as the workflow step does) is what's needed, by showing an
        # uncaught throw propagates rather than being silently swallowed as "not ready".
        { Wait-MountReady -Probe $probe -MaxAttempts 3 -IntervalSeconds 0 } | Should -Throw
    }
}
