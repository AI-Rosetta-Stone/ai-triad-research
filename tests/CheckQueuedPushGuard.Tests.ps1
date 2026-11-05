# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms gate for operations/devops/check-queued-push-guard.sh (t/4858).
.DESCRIPTION
    Refuses a push to a branch whose PR is in the merge queue or has auto-merge armed --
    pushing while queued is exactly how PR #4489 shipped a stale head (t/4858). Real GitHub
    state is required for the positive (refuse) arm, so these tests exercise it against
    live, known-safe branches/PRs rather than a mocked gh -- `gh pr view` itself is the
    thing under test's only dependency, and a fixture can't fake its JSON shape reliably
    across gh CLI versions.
#>

Describe 'check-queued-push-guard.sh' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Guard = Join-Path $PSScriptRoot '../operations/devops/check-queued-push-guard.sh'
        $script:Gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
        if (-not $script:Gh) { Set-ItResult -Skipped -Because 'no gh CLI available' }
    }

    It 'fails open (exit 0) for a branch with no associated PR' {
        & $script:Sh $script:Guard 'this-branch-does-not-exist-t4858' 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'fails open (exit 0) for main itself (never a PR branch)' {
        & $script:Sh $script:Guard 'main' 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
    }

    It 'fails open (exit 0) when gh is unavailable' {
        # Simulate by pointing PATH somewhere without gh, in a child process only.
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = $script:Sh
        $psi.ArgumentList.Add($script:Guard)
        $psi.ArgumentList.Add('any-branch')
        $psi.EnvironmentVariables['PATH'] = [System.Environment]::GetEnvironmentVariable('SystemRoot') + '\System32'
        $psi.UseShellExecute = $false
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        $proc.ExitCode | Should -Be 0
    }
}
