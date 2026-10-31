# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Gate-Verification arms for the GitHub App installation quota preflight predicate (t/4587 part b).
.DESCRIPTION
    Pure predicate -- no I/O, no network calls. Proves: a healthy quota stays quiet; a low
    quota warns; a failed query warns (never read as healthy); a missing remaining field warns;
    the boundary is strictly less-than.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'GitHubAppQuotaVerdict.ps1')
}

Describe 'GitHub App installation quota preflight verdict (t/4587 part b)' -Tag 'devops' {

    It 'QUIET: remaining well above the ceiling' {
        $v = Get-GitHubAppQuotaVerdict -Remaining 4982 -Ceiling 1000
        $v.ShouldWarn | Should -BeFalse
        $v.Kind | Should -Be 'healthy'
    }

    It 'QUIET: exactly at the ceiling does not warn (strictly less-than)' {
        $v = Get-GitHubAppQuotaVerdict -Remaining 1000 -Ceiling 1000
        $v.ShouldWarn | Should -BeFalse
    }

    It 'WARN: one below the ceiling' {
        $v = Get-GitHubAppQuotaVerdict -Remaining 999 -Ceiling 1000
        $v.ShouldWarn | Should -BeTrue
        $v.Kind | Should -Be 'quota-low'
    }

    It 'WARN: well under the ceiling' {
        $v = Get-GitHubAppQuotaVerdict -Remaining 42 -Ceiling 1000
        $v.ShouldWarn | Should -BeTrue
        $v.Kind | Should -Be 'quota-low'
    }

    It 'WARN: a query error is never read as healthy, even with no Remaining value' {
        $v = Get-GitHubAppQuotaVerdict -QueryError 'HTTP 401 Bad credentials' -Ceiling 1000
        $v.ShouldWarn | Should -BeTrue
        $v.Kind | Should -Be 'query-failed'
        $v.Reason | Should -Match 'Bad credentials'
    }

    It 'WARN: query error takes precedence even if a Remaining value is also present' {
        # Defensive: a caller should never pass both, but if it does, the error must win --
        # never let a stale/default Remaining mask a failed query.
        $v = Get-GitHubAppQuotaVerdict -Remaining 5000 -QueryError 'timeout' -Ceiling 1000
        $v.ShouldWarn | Should -BeTrue
        $v.Kind | Should -Be 'query-failed'
    }

    It 'WARN: Remaining absent (null) with no QueryError is its own distinct finding, not healthy' {
        $v = Get-GitHubAppQuotaVerdict -Ceiling 1000
        $v.ShouldWarn | Should -BeTrue
        $v.Kind | Should -Be 'field-missing'
    }

    It 'Default ceiling is 1000 per the ticket ask' {
        $v = Get-GitHubAppQuotaVerdict -Remaining 1001
        $v.ShouldWarn | Should -BeFalse
        $v2 = Get-GitHubAppQuotaVerdict -Remaining 999
        $v2.ShouldWarn | Should -BeTrue
    }
}
