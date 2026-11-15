# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/266 option (b): both arms of Get-PreviousRevisionRetireVerdict. Retire only when every input
    positively says safe; every failure, unknown or missing input keeps the rollback target.
#>

Describe 'Get-PreviousRevisionRetireVerdict (t/266 b)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Get-PreviousRevisionRetireVerdict.ps1"
        $script:Safe = @{
            Ac2Failed = 'false'; EarlierRollbackFired = 'false'; SoakPassed = 'true'
            PreviousRevision = 'taxonomy-editor--deploy-aaa-1'; NewRevision = 'taxonomy-editor--deploy-bbb-2'
            NewRevisionWeight = 100; PreviousRevisionWeight = 0
        }
    }

    It 'RETIRE arm: AC2 passed, no earlier rollback, soak green, new at 100, previous at 0' {
        $v = Get-PreviousRevisionRetireVerdict @script:Safe
        $v.Action | Should -Be 'retire'
    }

    It 'KEEP arm: <Case>' -ForEach @(
        @{ Case = 'AC2 failed';                         Over = @{ Ac2Failed = 'true' } }
        @{ Case = 'AC2 never ran (empty)';              Over = @{ Ac2Failed = '' } }
        @{ Case = 'earlier gate rollback fired';        Over = @{ EarlierRollbackFired = 'true' } }
        @{ Case = 'earlier rollback unknown (empty)';   Over = @{ EarlierRollbackFired = '' } }
        @{ Case = 'soak failed';                        Over = @{ SoakPassed = 'false' } }
        @{ Case = 'soak never ran (empty)';             Over = @{ SoakPassed = '' } }
        @{ Case = 'no previous revision';               Over = @{ PreviousRevision = '' } }
        @{ Case = 'new revision unknown';               Over = @{ NewRevision = '' } }
        @{ Case = 'previous equals new';                Over = @{ PreviousRevision = 'taxonomy-editor--deploy-bbb-2' } }
        @{ Case = 'new weight unreadable';              Over = @{ NewRevisionWeight = $null } }
        @{ Case = 'new not at 100';                     Over = @{ NewRevisionWeight = 0 } }
        @{ Case = 'previous weight unreadable';         Over = @{ PreviousRevisionWeight = $null } }
        @{ Case = 'previous still has traffic';         Over = @{ PreviousRevisionWeight = 100 } }
    ) {
        $p = $script:Safe.Clone()
        foreach ($k in $Over.Keys) { $p[$k] = $Over[$k] }
        $v = Get-PreviousRevisionRetireVerdict @p
        $v.Action | Should -Be 'keep'
        $v.Reason | Should -Not -BeNullOrEmpty
    }
}
