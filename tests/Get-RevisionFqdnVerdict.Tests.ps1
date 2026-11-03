# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

BeforeAll {
    . "$PSScriptRoot/../operations/devops/Get-RevisionFqdnVerdict.ps1"
}

Describe 'Get-RevisionFqdnVerdict' {
    It 'returns resolved when a non-empty FQDN is probed, regardless of attempt number' {
        (Get-RevisionFqdnVerdict -Fqdn 'rev.example.com' -Attempt 1 -MaxAttempts 3).Verdict | Should -Be 'resolved'
        (Get-RevisionFqdnVerdict -Fqdn 'rev.example.com' -Attempt 3 -MaxAttempts 3).Verdict | Should -Be 'resolved'
    }
    It 'returns retry when the FQDN is null/empty/whitespace and attempts remain' {
        (Get-RevisionFqdnVerdict -Fqdn $null -Attempt 1 -MaxAttempts 3).Verdict | Should -Be 'retry'
        (Get-RevisionFqdnVerdict -Fqdn '' -Attempt 1 -MaxAttempts 3).Verdict | Should -Be 'retry'
        (Get-RevisionFqdnVerdict -Fqdn '   ' -Attempt 2 -MaxAttempts 3).Verdict | Should -Be 'retry'
    }
    It 'returns unresolved when the FQDN is still empty on the last allowed attempt' {
        (Get-RevisionFqdnVerdict -Fqdn $null -Attempt 3 -MaxAttempts 3).Verdict | Should -Be 'unresolved'
    }
    It 'returns unresolved when the attempt count somehow exceeds MaxAttempts (fail-safe, never retry past the bound)' {
        (Get-RevisionFqdnVerdict -Fqdn $null -Attempt 4 -MaxAttempts 3).Verdict | Should -Be 'unresolved'
    }
}

Describe 'Wait-RevisionFqdn' {
    It 'returns resolved on the first attempt when the probe returns an FQDN immediately' {
        $script:calls = 0
        $result = Wait-RevisionFqdn -Probe { $script:calls++; 'rev.example.com' } -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'resolved'
        $result.Fqdn | Should -Be 'rev.example.com'
        $result.Attempts | Should -Be 1
        $script:calls | Should -Be 1
    }

    It 'retries a transient empty FQDN and recovers within the bound (the t/4822 shape: ARM propagation)' {
        $script:attemptsSeen = 0
        $probe = {
            $script:attemptsSeen++
            if ($script:attemptsSeen -ge 2) { return 'rev.example.com' }
            return $null
        }
        $result = Wait-RevisionFqdn -Probe $probe -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'resolved'
        $result.Attempts | Should -Be 2
    }

    It 'recovers on the second-to-last attempt (boundary: exercise the final usable retry, not just an early-attempt recovery)' {
        $MaxAttempts = 6
        $script:boundaryAttempts = 0
        $probe = {
            $script:boundaryAttempts++
            if ($script:boundaryAttempts -eq ($MaxAttempts - 1)) { return 'rev.example.com' }
            return $null
        }
        $result = Wait-RevisionFqdn -Probe $probe -MaxAttempts $MaxAttempts -IntervalSeconds 0
        $result.Verdict | Should -Be 'resolved'
        $result.Attempts | Should -Be ($MaxAttempts - 1)
    }

    It 'falls through unresolved when the FQDN never resolves within MaxAttempts (a real provisioning failure, not a transient race)' {
        $script:calls = 0
        $result = Wait-RevisionFqdn -Probe { $script:calls++; $null } -MaxAttempts 3 -IntervalSeconds 0
        $result.Verdict | Should -Be 'unresolved'
        $result.Attempts | Should -Be 3
        $script:calls | Should -Be 3
    }

    It 'never calls the probe more than MaxAttempts times' {
        $script:calls = 0
        $null = Wait-RevisionFqdn -Probe { $script:calls++; $null } -MaxAttempts 5 -IntervalSeconds 0
        $script:calls | Should -Be 5
    }

    It 'propagates a probe exception rather than silently retrying it as "not yet assigned"' {
        $calls = 0
        $probe = {
            $calls++
            if ($calls -lt 2) { throw 'simulated transient probe error' }
            return 'rev.example.com'
        }
        { Wait-RevisionFqdn -Probe $probe -MaxAttempts 3 -IntervalSeconds 0 } | Should -Throw
    }
}
