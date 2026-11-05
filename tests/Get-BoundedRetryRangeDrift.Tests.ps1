# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Prevention follow-up to t/4842 (t/4850): rides the already-required `test-powershell`
    gate (same mechanism as TrivyIgnoreRevisitLint.Tests.ps1, t/3539#2 Option C) so a caller
    literal outside its target function's declared [ValidateRange(...)] fails CI instead of
    being caught live by a gate's own catch block, as happened in t/4842 (4 prod rollbacks
    over ~4.5h for a `-MaxAttempts 22` call against a [ValidateRange(1,20)] declaration).

.DESCRIPTION
    Arm B (the enforcement leg): every bounded-retry call site in the real
    `.github/workflows/*.yml` and `operations/devops/*.ps1` files has ZERO literals outside
    the declared range of the function/param it targets.

    Arm A + edges: the three pure functions, exercised against crafted fixtures so the gate
    is proven to FAIL on a real gap, not merely pass on clean input.
#>

Describe 'Get-BoundedRetryRangeDrift — ValidateRange/caller coupling (t/4850)' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Get-BoundedRetryRangeDrift.ps1"
        $script:DevopsDir    = "$PSScriptRoot/../operations/devops"
        $script:WorkflowsDir = "$PSScriptRoot/../.github/workflows"
    }

    Context 'Arm B — the real repo (the enforcement leg)' {
        It 'has ZERO caller literals outside their target function''s declared range' {
            $declared = [System.Collections.Generic.List[object]]::new()
            foreach ($f in Get-ChildItem -LiteralPath $script:DevopsDir -Filter '*.ps1') {
                $declared.AddRange(@(Get-DeclaredBoundedRetryRange -Path $f.FullName))
            }
            $declared = $declared.ToArray()
            $declared.Count | Should -BeGreaterThan 0 -Because 'Wait-MountReady/Wait-RevisionFqdn/Wait-RevisionActivation must still declare ValidateRange, or this test is checking nothing'

            $functionNames = @($declared | Select-Object -ExpandProperty Function -Unique)

            $callerFiles = @(Get-ChildItem -LiteralPath $script:DevopsDir -Filter '*.ps1') +
                           @(Get-ChildItem -LiteralPath $script:WorkflowsDir -Filter '*.yml')

            $allGaps = [System.Collections.Generic.List[object]]::new()
            foreach ($f in $callerFiles) {
                $literals = @(Get-CallerBoundedRetryLiteral -Path $f.FullName -FunctionName $functionNames)
                if ($literals.Count -eq 0) { continue }
                $gaps = @(Get-BoundedRetryRangeGap -Declared $declared -CallerLiteral $literals -SourcePath $f.Name)
                $allGaps.AddRange($gaps)
            }
            $allGaps = $allGaps.ToArray()
            $allGaps.Count | Should -Be 0 -Because (Format-BoundedRetryRangeGapMessage $allGaps)
        }
    }

    Context 'Get-DeclaredBoundedRetryRange — Arm A + edges' {
        It 'parses a declared [ValidateRange(min,max)] with its parameter name' {
            $fixture = @(
                'function Wait-Example {',
                '    param(',
                '        [ValidateRange(1, 30)][int] $MaxAttempts = 3,',
                '        [ValidateRange(0, 60)][int] $IntervalSeconds = 5',
                '    )',
                '}'
            )
            $declared = @(Get-DeclaredBoundedRetryRange -Line $fixture)
            $declared.Count | Should -Be 2
            ($declared | Where-Object Param -eq 'MaxAttempts').Min | Should -Be 1
            ($declared | Where-Object Param -eq 'MaxAttempts').Max | Should -Be 30
            ($declared | Where-Object Param -eq 'IntervalSeconds').Min | Should -Be 0
            ($declared | Where-Object Param -eq 'IntervalSeconds').Max | Should -Be 60
        }

        It 'treats [int]::MaxValue as an unbounded ceiling ($null Max)' {
            $fixture = @(
                'function Get-Example {',
                '    param([ValidateRange(1, [int]::MaxValue)][int] $Attempt)',
                '}'
            )
            $declared = @(Get-DeclaredBoundedRetryRange -Line $fixture)
            $declared.Count | Should -Be 1
            $declared[0].Min | Should -Be 1
            $declared[0].Max | Should -BeNullOrEmpty
        }

        It 'attributes each declaration to the correct enclosing function' {
            $fixture = @(
                'function Wait-First {',
                '    param([ValidateRange(1, 10)][int] $MaxAttempts)',
                '}',
                'function Wait-Second {',
                '    param([ValidateRange(1, 99)][int] $MaxAttempts)',
                '}'
            )
            $declared = @(Get-DeclaredBoundedRetryRange -Line $fixture)
            ($declared | Where-Object Function -eq 'Wait-First').Max | Should -Be 10
            ($declared | Where-Object Function -eq 'Wait-Second').Max | Should -Be 99
        }

        It 'ignores a parameter with no ValidateRange attribute' {
            $fixture = @(
                'function Invoke-Example {',
                '    param([int] $MaxAttempts = 3)',
                '}'
            )
            @(Get-DeclaredBoundedRetryRange -Line $fixture).Count | Should -Be 0
        }
    }

    Context 'Get-CallerBoundedRetryLiteral — Arm A + edges' {
        It 'finds a literal argument to a named parameter on a call line' {
            $fixture = @('$Verdict = Wait-MountReady -Probe $Probe -MaxAttempts 22 -IntervalSeconds 10')
            $found = @(Get-CallerBoundedRetryLiteral -Line $fixture -FunctionName @('Wait-MountReady'))
            $found.Count | Should -Be 2
            ($found | Where-Object Param -eq 'MaxAttempts').Value | Should -Be 22
            ($found | Where-Object Param -eq 'IntervalSeconds').Value | Should -Be 10
        }

        It 'ignores a call passing a variable rather than a literal (not statically checkable)' {
            $fixture = @('Wait-MountReady -Probe $Probe -MaxAttempts $N')
            $found = @(Get-CallerBoundedRetryLiteral -Line $fixture -FunctionName @('Wait-MountReady'))
            $found.Count | Should -Be 0
        }

        It 'ignores a function not in the given FunctionName list' {
            $fixture = @('Test-TaxEditorHealth -BaseUrl $AppUrl -MaxAttempts 3 -RetryIntervalSec 10')
            $found = @(Get-CallerBoundedRetryLiteral -Line $fixture -FunctionName @('Wait-MountReady'))
            $found.Count | Should -Be 0
        }

        It 'ignores a commented-out call' {
            $fixture = @('# Wait-MountReady -Probe $Probe -MaxAttempts 999')
            $found = @(Get-CallerBoundedRetryLiteral -Line $fixture -FunctionName @('Wait-MountReady'))
            $found.Count | Should -Be 0
        }

        It 'reports the correct 1-based line number' {
            $fixture = @('# header', 'Wait-MountReady -Probe $Probe -MaxAttempts 22')
            (Get-CallerBoundedRetryLiteral -Line $fixture -FunctionName @('Wait-MountReady'))[0].LineNumber | Should -Be 2
        }
    }

    Context 'Get-BoundedRetryRangeGap — Arm A + edges (the t/4842 shape)' {
        BeforeAll {
            $script:Declared = @(
                [pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Min = 1; Max = 30 }
            )
        }

        It 'FLAGS a literal above the declared ceiling (reproduces t/4842: 22 against a [1,20] declaration)' {
            $declared = @([pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Min = 1; Max = 20 })
            $callers  = @([pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Value = 22; LineNumber = 1 })
            $gaps = @(Get-BoundedRetryRangeGap -Declared $declared -CallerLiteral $callers)
            $gaps.Count | Should -Be 1
            $gaps[0].Value | Should -Be 22
        }

        It 'PASSES a literal inside the declared range' {
            $callers = @([pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Value = 22; LineNumber = 1 })
            @(Get-BoundedRetryRangeGap -Declared $script:Declared -CallerLiteral $callers).Count | Should -Be 0
        }

        It 'FLAGS a literal below the declared minimum' {
            $callers = @([pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Value = 0; LineNumber = 1 })
            @(Get-BoundedRetryRangeGap -Declared $script:Declared -CallerLiteral $callers).Count | Should -Be 1
        }

        It 'SKIPS a literal for a function/param with no declared range (fail-open: nothing to check)' {
            $callers = @([pscustomobject]@{ Function = 'Invoke-BlobContainerGateCheck'; Param = 'MaxAttempts'; Value = 999; LineNumber = 1 })
            @(Get-BoundedRetryRangeGap -Declared $script:Declared -CallerLiteral $callers).Count | Should -Be 0
        }

        It 'does not flag a literal when the declared Max is unbounded ($null)' {
            $declared = @([pscustomobject]@{ Function = 'Get-Example'; Param = 'Attempt'; Min = 1; Max = $null })
            $callers  = @([pscustomobject]@{ Function = 'Get-Example'; Param = 'Attempt'; Value = 999999; LineNumber = 1 })
            @(Get-BoundedRetryRangeGap -Declared $declared -CallerLiteral $callers).Count | Should -Be 0
        }
    }

    Context 'Format-BoundedRetryRangeGapMessage' {
        It 'names the offending literal and its declared bound' {
            $gap = @([pscustomobject]@{ Function = 'Wait-MountReady'; Param = 'MaxAttempts'; Value = 22; Min = 1; Max = 20; SourcePath = 'deploy-azure.yml'; LineNumber = 871 })
            $msg = Format-BoundedRetryRangeGapMessage -Gap $gap
            $msg | Should -Match 'Wait-MountReady'
            $msg | Should -Match '22'
            $msg | Should -Match '\[1,20\]'
            $msg | Should -Match 'deploy-azure\.yml:871'
        }

        It 'reports clean when there are no gaps' {
            Format-BoundedRetryRangeGapMessage -Gap @() | Should -Match 'declared ValidateRange'
        }
    }
}
