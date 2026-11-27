# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/674 item 3 (TL p/9#665): when deploy-azure.yml's t/4194 guard proceeds on the t/670 containment
# path (the requested commit is NOT a descendant of the running one, but contains its changes), it
# must say so with a ::warning::, so the relaxed path shows in the run summary and not only in the
# log. This pins the workflow's text; the verdict logic is tested in Get-DeployAgeVerdict.Tests.ps1.

BeforeAll {
    $script:WorkflowPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.github/workflows/deploy-azure.yml'
    $script:Workflow = (Get-Content -LiteralPath $script:WorkflowPath -Raw) -replace "`r`n", "`n"
    $script:ExpectedLine = 'Write-Host "::warning::t/670 guard: $Requested is not a descendant of running $RunningFull; proceeding because every change is contained (merge-base $($Containment.MergeBase))"'
    $script:Hint = "deploy-azure.yml's t/4194 guard step must contain this line inside its 'not-ancestor-but-changes-contained' branch: $($script:ExpectedLine) -- if you reworded the warning, update `$ExpectedLine in tests/DeployAzureContainmentWarning.Tests.ps1 to match."
}

Describe 'deploy-azure.yml: the containment path warns in the run summary (t/674 item 3)' {
    It 'the guard step emits the ::warning:: line' {
        $script:Workflow.Contains($script:ExpectedLine) | Should -BeTrue -Because $script:Hint
    }

    It 'the warning is emitted only for the not-ancestor-but-changes-contained verdict, before the proceed line' {
        $guard = "if (`$Verdict.Reason -eq 'not-ancestor-but-changes-contained') {"
        $at = $script:Workflow.IndexOf($guard)
        $at | Should -BeGreaterThan -1 -Because $script:Hint
        $warn = $script:Workflow.IndexOf($script:ExpectedLine, $at)
        $proceed = $script:Workflow.IndexOf('Write-Host "t/4194 guard: $($Verdict.Reason)', $at)
        $warn | Should -BeGreaterThan $at -Because $script:Hint
        $proceed | Should -BeGreaterThan $warn -Because 'the ordinary "proceeding" line still follows the warning'
        # Nothing but the warning sits between the condition and its closing brace.
        $between = $script:Workflow.Substring($at + $guard.Length, $warn - $at - $guard.Length)
        $between.Trim() | Should -BeNullOrEmpty -Because $script:Hint
    }

    It 'the refuse path is unchanged: it still exits 1' {
        $script:Workflow | Should -Match "(?s)'refuse' \{.*?::error::t/4194 guard: refusing to deploy.*?exit 1"
    }
}
