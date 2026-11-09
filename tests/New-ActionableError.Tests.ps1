# Tag: erroring (t/3307)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for New-ActionableError's -ErrorType and -AsErrorRecord options (t/3307).
.DESCRIPTION
    -ErrorType and -AsErrorRecord are optional/backward-compatible additions so a subprocess shim can
    serialize a structured failure ({ErrorType,Goal,Problem,NextSteps}) WITHOUT parsing the rendered
    human message. Verifies structured propagation via TargetObject, the rendered Type: line, and that
    pre-existing default/-PassThru/-Throw behavior is unchanged. New-ActionableError is private, so
    exercised via InModuleScope.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'New-ActionableError availability in deploy-staging.yml (t/4951)' -Tag 'erroring' {
    # t/4951: AITriad.psm1 never exports New-ActionableError -- its defining script's own header
    # says "do NOT export", it's an internal helper for the module's own public cmdlets. A `run:`
    # step that only does Import-Module AITriad.psm1 and then calls New-ActionableError directly
    # fails with "the term 'New-ActionableError' is not recognized", silently losing the Goal/
    # Problem/Next-Steps text. Both arms proven below: the bare import fails, the dot-sourced fix
    # resolves -- and the workflow file is asserted to actually contain that dot-source.

    It 'Import-Module alone does NOT resolve New-ActionableError as a public command (the bug this ticket fixes)' {
        $out = pwsh -NoProfile -Command "Import-Module '$ModulePath' -Force -WarningAction SilentlyContinue; Get-Command New-ActionableError -ErrorAction SilentlyContinue" 2>&1 | Out-String
        $out.Trim() | Should -BeNullOrEmpty
    }

    It 'dot-sourcing the Private script (the fix) resolves New-ActionableError' {
        $privateScript = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1'
        $out = pwsh -NoProfile -Command "Import-Module '$ModulePath' -Force -WarningAction SilentlyContinue; . '$privateScript'; (Get-Command New-ActionableError -ErrorAction SilentlyContinue).Name" 2>&1 | Out-String
        $out.Trim() | Should -Be 'New-ActionableError'
    }

    It 'deploy-staging.yml dot-sources New-ActionableError.ps1 inside the "Deploy new revision" step, before its first use' {
        $workflow = Get-Content (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-staging.yml') -Raw
        $stepStart = $workflow.IndexOf('- name: Deploy new revision to staging')
        $stepStart | Should -BeGreaterThan -1
        $nextStep = $workflow.IndexOf("`n      - name:", $stepStart + 1)
        if ($nextStep -lt 0) { $nextStep = $workflow.Length }
        $stepBody = $workflow.Substring($stepStart, $nextStep - $stepStart)

        $dotSourceIdx = $stepBody.IndexOf('. ./scripts/AITriad/Private/New-ActionableError.ps1')
        $firstUseIdx  = $stepBody.IndexOf('New-ActionableError -AsErrorRecord')

        $dotSourceIdx | Should -BeGreaterThan -1
        $firstUseIdx  | Should -BeGreaterThan -1
        $dotSourceIdx | Should -BeLessThan $firstUseIdx
    }
}

Describe 'New-ActionableError -AsErrorRecord / -ErrorType' -Tag 'erroring' {

    It '-AsErrorRecord returns an ErrorRecord whose TargetObject carries the structured fields' {
        $rec = InModuleScope AITriad {
            New-ActionableError -AsErrorRecord -ErrorType 'ContentPathMissing' `
                -Goal 'G' -Problem 'P' -Location 'L' -NextSteps @('one', 'two')
        }
        $rec        | Should -BeOfType [System.Management.Automation.ErrorRecord]
        $to = $rec.TargetObject
        $to.ErrorType | Should -Be 'ContentPathMissing'
        $to.Goal      | Should -Be 'G'
        $to.Problem   | Should -Be 'P'
        $to.Location  | Should -Be 'L'
        @($to.NextSteps).Count | Should -Be 2
        $rec.FullyQualifiedErrorId | Should -Match 'ContentPathMissing'
    }

    It '-ErrorType renders a Type: line in the -PassThru message' {
        $msg = InModuleScope AITriad {
            New-ActionableError -PassThru -ErrorType 'ConversionFailed' `
                -Goal 'G' -Problem 'P' -Location 'L' -NextSteps @('x')
        }
        $msg | Should -Match 'Type:\s+ConversionFailed'
    }

    It 'omits the Type: line when -ErrorType is not supplied (backward compatible)' {
        $msg = InModuleScope AITriad {
            New-ActionableError -PassThru -Goal 'G' -Problem 'P' -Location 'L' -NextSteps @('x')
        }
        $msg | Should -Not -Match 'Type:'
        # Rendered labels unchanged (t/2952): Goal/Error/Location/Resolve.
        $msg | Should -Match 'Goal:'
        $msg | Should -Match 'Error:'
        $msg | Should -Match 'Location:'
        $msg | Should -Match 'Resolve:'
    }

    It 'still throws the rendered string with -Throw (unchanged path)' {
        {
            InModuleScope AITriad {
                New-ActionableError -Throw -Goal 'G' -Problem 'boom' -Location 'L' -NextSteps @('x')
            }
        } | Should -Throw -ExpectedMessage '*boom*'
    }
}
