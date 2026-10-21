# Tag: ci (t/2882)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Get-CIFailureSummary (t/2882) and its pure parser ConvertFrom-CILog.
    The parser is exercised with synthetic gh-log text — no network / no gh call.
#>

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force -WarningAction SilentlyContinue

    # Realistic gh `run view --log` shape: "job<TAB>step<TAB>ISO-timestamp <content>".
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

Describe 'Get-CIFailureSummary (t/2882)' -Tag 'ci' {

    It 'is exported from the AITriad module' {
        Get-Command -Module AITriad -Name 'Get-CIFailureSummary' | Should -Not -BeNullOrEmpty
    }

    Context 'ConvertFrom-CILog parser' {

        It 'extracts the failing Pester test name (from the [-] line, timestamp/prefix stripped)' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                $r.FailingTests | Should -Contain 'GET /api/reveal with spoofed Host header returns 403'
                @($r.FailingTests).Count | Should -Be 1
            }
        }

        It 'captures the assertion detail into PesterFailureLines (clean, no gh prefix)' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                ($r.PesterFailureLines -join "`n") | Should -Match 'Expected 403, but got 404\.'
                # The prefix/timestamp must be stripped.
                ($r.PesterFailureLines -join "`n") | Should -Not -Match 'test-powershell'
            }
        }

        It 'classifies a real infra error as infra, not a test failure' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                ($r.InfraErrorLines -join "`n") | Should -Match "Could not load module 'Foo'"
                # The [-] test failure must NOT be in the infra bucket.
                ($r.InfraErrorLines -join "`n") | Should -Not -Match 'spoofed Host'
            }
        }

        It 'ignores the generic "Process completed with exit code" step-wrapper noise' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                ($r.InfraErrorLines -join "`n") | Should -Not -Match 'Process completed with exit code'
            }
        }

        It 'extracts the Pester failed count' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                $r.FailedCount | Should -Be 1
            }
        }

        It 'returns empty structures (no throw) for an empty log' {
            InModuleScope AITriad {
                $r = ConvertFrom-CILog -LogText ''
                @($r.FailingTests).Count    | Should -Be 0
                @($r.InfraErrorLines).Count | Should -Be 0
                @($r.VitestFailures).Count  | Should -Be 0
            }
        }

        It 'leaves a Pester-only log unchanged: no vitest entries, same count (t/4271)' {
            InModuleScope AITriad -Parameters @{ Log = $script:SampleLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                @($r.VitestFailures).Count | Should -Be 0
                @($r.FailingTests) | Should -Be @('GET /api/reveal with spoofed Host header returns 403')
                @($r.InfraErrorLines) | Should -Be @("Import-Module: Could not load module 'Foo'")
            }
        }
    }

    Context 'ConvertFrom-CILog vitest failures (t/4271)' {

        BeforeAll {
            # A slice of the real `gh run view 39125849906 --log-failed` capture (test-electron, 2
            # vitest failures). gh renders the colour codes as the literal text "^[".
            $script:VitestLog = Get-Content -Raw -LiteralPath "$PSScriptRoot/fixtures/ci-log/vitest-failed-39125849906.log"
            $script:Esc = [string][char]27
            $script:Loc = [string][char]0x276F
        }

        It 'extracts file, test name, error and location for each failure in the real run log' {
            InModuleScope AITriad -Parameters @{ Log = $script:VitestLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                $v = @($r.VitestFailures)
                $v.Count | Should -Be 2
                $v[0].Runner   | Should -Be 'vitest'
                $v[0].File     | Should -Be '../../../lib/debate/taxonomyRelevance.wellTestedMode.test.ts'
                $v[0].TestName | Should -Be 'excludes well_tested nodes even when no greatest-hits list is passed'
                $v[0].Suite    | Should -Match '^selectRelevantTaxonomy .+ exclude-well-tested mode \(app/server path\)$'
                $v[0].Error    | Should -Match "^AssertionError: expected \[ 'acc-beliefs-001', .+ to not include 'acc-beliefs-001'$"
                $v[0].Location | Should -Be '../../../lib/debate/taxonomyRelevance.wellTestedMode.test.ts:151:52'
                $v[1].TestName | Should -Be 'unions the curated greatest-hits list with the tier exclusion'
                $v[1].Error    | Should -Be "AssertionError: expected [ Array(2) ] to deeply equal [ 'acc-desires-001' ]"
                $v[1].Location | Should -Be '../../../lib/debate/taxonomyRelevance.wellTestedMode.test.ts:158:48'
            }
        }

        It 'counts them as failing tests and fills FailedCount from the vitest summary' {
            InModuleScope AITriad -Parameters @{ Log = $script:VitestLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                @($r.FailingTests).Count | Should -Be 2
                $r.FailingTests[0] | Should -Match '\.test\.ts > .+ > excludes well_tested nodes'
                $r.FailedCount | Should -Be 2
            }
        }

        It 'keeps the trailing ##[error] copies of the test errors out of InfraErrorLines' {
            InModuleScope AITriad -Parameters @{ Log = $script:VitestLog } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                ($r.InfraErrorLines -join "`n") | Should -Not -Match 'AssertionError'
            }
        }

        It 'strips real ESC colour codes too, and gives grouped failures the shared error' {
            $e = $script:Esc
            $log = @(
                "job`tstep`t2026-10-18T12:00:00.0Z $e[31m Failed Tests 2 $e[39m",
                "job`tstep`t2026-10-18T12:00:00.1Z $e[41m$e[1m FAIL $e[22m$e[49m src/a.test.ts$e[2m > $e[22mSuite A$e[2m > $e[22mfirst",
                "job`tstep`t2026-10-18T12:00:00.2Z $e[41m$e[1m FAIL $e[22m$e[49m src/a.test.ts$e[2m > $e[22mSuite A$e[2m > $e[22msecond",
                "job`tstep`t2026-10-18T12:00:00.3Z $e[31mTypeError$e[22m: x is not a function$e[39m",
                "job`tstep`t2026-10-18T12:00:00.4Z $e[36m $($script:Loc) src/a.test.ts:$e[2m12:3$e[22m$e[39m",
                "job`tstep`t2026-10-18T12:00:00.5Z $e[2m      Tests $e[22m $e[31m2 failed$e[39m | 10 passed"
            ) -join "`n"
            InModuleScope AITriad -Parameters @{ Log = $log } {
                param($Log)
                $v = @((ConvertFrom-CILog -LogText $Log).VitestFailures)
                $v.Count | Should -Be 2
                @($v.TestName) | Should -Be @('first', 'second')
                @($v | Where-Object { $_.Error -eq 'TypeError: x is not a function' }).Count | Should -Be 2
                @($v | Where-Object { $_.Location -eq 'src/a.test.ts:12:3' }).Count | Should -Be 2
            }
        }

        It 'records a suite-level failure with no test name' {
            $log = @(
                ' Failed Suites 1 ',
                ' FAIL  src/broken.test.ts [ src/broken.test.ts ]',
                "Error: Cannot find module './missing'",
                ' Test Files  1 failed | 3 passed (4)'
            ) -join "`n"
            InModuleScope AITriad -Parameters @{ Log = $log } {
                param($Log)
                $v = @((ConvertFrom-CILog -LogText $Log).VitestFailures)
                $v.Count | Should -Be 1
                $v[0].File     | Should -Be 'src/broken.test.ts'
                $v[0].TestName | Should -BeNullOrEmpty
                $v[0].Error    | Should -Be "Error: Cannot find module './missing'"
            }
        }

        It 'adds the vitest count to the Pester count when one log holds both' {
            InModuleScope AITriad -Parameters @{ Log = ($script:SampleLog + "`n" + $script:VitestLog) } {
                param($Log)
                $r = ConvertFrom-CILog -LogText $Log
                $r.FailedCount | Should -Be 3
                @($r.FailingTests).Count | Should -Be 3
                ($r.InfraErrorLines -join "`n") | Should -Match "Could not load module 'Foo'"
            }
        }
    }
}
