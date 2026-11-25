# Tag: ci (t/2882, refactor characterization)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Race-safe characterization tests for the pure parser ConvertFrom-CILog.
    Dot-sources ONLY the Private file (no Import-Module of the batch worktree
    module) so it is isolated from concurrent edits to sibling files.
    Pins current behavior across the Pester and vitest branches.
#>

BeforeAll {
    . "$PSScriptRoot/../scripts/AITriad/Private/ConvertFrom-CILog.ps1"

    $script:Esc = [string][char]27
    $script:Loc = [string][char]0x276F

    $script:SampleLog = @(
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z Describing Register-AIBackend auth hardening",
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z   [+] GET / without token returns 401 26ms",
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z ##[error][-] GET /api/reveal with spoofed Host header returns 403 17ms",
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z ##[group]Message",
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z Expected 403, but got 404.",
        "test-powershell`tRun tests`t2026-08-12T15:57:47.4Z at `$status | Should -Be 403, Register-AIBackend.Auth.Tests.ps1:144",
        "test-powershell`tRun tests`t2026-08-12T15:57:50.0Z Tests Passed: 42, Failed: 1, Skipped: 0",
        "test-powershell`tRun tests`t2026-08-12T15:57:50.1Z ##[error]Import-Module: Could not load module 'Foo'",
        "build`tCompile`t2026-08-12T15:58:00.0Z ##[error]Process completed with exit code 1"
    ) -join "`n"
}

Describe 'ConvertFrom-CILog (characterization)' -Tag 'ci' {

    Context 'Pester log' {
        It 'extracts the failing Pester test name, prefix stripped' {
            $r = ConvertFrom-CILog -LogText $script:SampleLog
            $r.FailingTests | Should -Contain 'GET /api/reveal with spoofed Host header returns 403'
            @($r.FailingTests).Count | Should -Be 1
        }

        It 'captures the assertion detail into PesterFailureLines, clean' {
            $r = ConvertFrom-CILog -LogText $script:SampleLog
            ($r.PesterFailureLines -join "`n") | Should -Match 'Expected 403, but got 404\.'
            ($r.PesterFailureLines -join "`n") | Should -Not -Match 'test-powershell'
        }

        It 'classifies infra error vs test failure, ignoring step-wrapper noise' {
            $r = ConvertFrom-CILog -LogText $script:SampleLog
            @($r.InfraErrorLines) | Should -Be @("Import-Module: Could not load module 'Foo'")
            ($r.InfraErrorLines -join "`n") | Should -Not -Match 'spoofed Host'
            ($r.InfraErrorLines -join "`n") | Should -Not -Match 'Process completed with exit code'
        }

        It 'extracts the Pester failed count' {
            (ConvertFrom-CILog -LogText $script:SampleLog).FailedCount | Should -Be 1
        }

        It 'returns empty structures for an empty log' {
            $r = ConvertFrom-CILog -LogText ''
            @($r.FailingTests).Count    | Should -Be 0
            @($r.InfraErrorLines).Count | Should -Be 0
            @($r.VitestFailures).Count  | Should -Be 0
            $r.FailedCount | Should -BeNullOrEmpty
        }

        It 'echoes FailedJobs through unchanged' {
            $r = ConvertFrom-CILog -LogText '' -FailedJobs @('job-a', 'job-b')
            @($r.FailedJobs) | Should -Be @('job-a', 'job-b')
        }
    }

    Context 'vitest log' {
        It 'strips ESC colour codes and gives grouped failures the shared error/location' {
            $e = $script:Esc
            $log = @(
                "job`tstep`t2026-10-18T12:00:00.0Z $e[31m Failed Tests 2 $e[39m",
                "job`tstep`t2026-10-18T12:00:00.1Z $e[41m$e[1m FAIL $e[22m$e[49m src/a.test.ts$e[2m > $e[22mSuite A$e[2m > $e[22mfirst",
                "job`tstep`t2026-10-18T12:00:00.2Z $e[41m$e[1m FAIL $e[22m$e[49m src/a.test.ts$e[2m > $e[22mSuite A$e[2m > $e[22msecond",
                "job`tstep`t2026-10-18T12:00:00.3Z $e[31mTypeError$e[22m: x is not a function$e[39m",
                "job`tstep`t2026-10-18T12:00:00.4Z $e[36m $($script:Loc) src/a.test.ts:$e[2m12:3$e[22m$e[39m",
                "job`tstep`t2026-10-18T12:00:00.5Z $e[2m      Tests $e[22m $e[31m2 failed$e[39m | 10 passed"
            ) -join "`n"
            $r = ConvertFrom-CILog -LogText $log
            $v = @($r.VitestFailures)
            $v.Count | Should -Be 2
            @($v.TestName) | Should -Be @('first', 'second')
            @($v.Suite) | Should -Be @('Suite A', 'Suite A')
            @($v.File) | Should -Be @('src/a.test.ts', 'src/a.test.ts')
            @($v | Where-Object { $_.Error -eq 'TypeError: x is not a function' }).Count | Should -Be 2
            @($v | Where-Object { $_.Location -eq 'src/a.test.ts:12:3' }).Count | Should -Be 2
            $r.FailedCount | Should -Be 2
            @($r.FailingTests).Count | Should -Be 2
        }

        It 'records a suite-level failure with no test name' {
            $log = @(
                ' Failed Suites 1 ',
                ' FAIL  src/broken.test.ts [ src/broken.test.ts ]',
                "Error: Cannot find module './missing'",
                ' Test Files  1 failed | 3 passed (4)'
            ) -join "`n"
            $v = @((ConvertFrom-CILog -LogText $log).VitestFailures)
            $v.Count | Should -Be 1
            $v[0].File     | Should -Be 'src/broken.test.ts'
            $v[0].TestName | Should -BeNullOrEmpty
            $v[0].Suite    | Should -BeNullOrEmpty
            $v[0].Error    | Should -Be "Error: Cannot find module './missing'"
        }

        It 'keeps vitest test errors out of InfraErrorLines and sums counts with Pester' {
            $e = $script:Esc
            $vlog = @(
                " Failed Tests 1 ",
                " FAIL  src/b.test.ts > Suite B > only",
                "AssertionError: boom",
                "$($script:Loc) src/b.test.ts:3:4",
                "##[error]AssertionError: boom",
                " Tests 1 failed | 5 passed"
            ) -join "`n"
            $r = ConvertFrom-CILog -LogText ($script:SampleLog + "`n" + $vlog)
            ($r.InfraErrorLines -join "`n") | Should -Not -Match 'AssertionError'
            ($r.InfraErrorLines -join "`n") | Should -Match "Could not load module 'Foo'"
            $r.FailedCount | Should -Be 2
            @($r.FailingTests).Count | Should -Be 2
        }

        It 'carries the typed PSTypeName on vitest entries' {
            $log = @(
                ' Failed Tests 1 ',
                ' FAIL  src/c.test.ts > S > t',
                'Err: nope',
                ' Tests 1 failed | 0 passed'
            ) -join "`n"
            $v = @((ConvertFrom-CILog -LogText $log).VitestFailures)
            $v[0].PSObject.TypeNames | Should -Contain 'AITriad.CITestFailure'
            $v[0].Runner | Should -Be 'vitest'
            $v[0].FullName | Should -Be 'src/c.test.ts > S > t'
        }
    }
}
