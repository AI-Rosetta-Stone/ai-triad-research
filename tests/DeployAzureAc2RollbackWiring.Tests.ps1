# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4309, SO review (e/360#2): structural (text) assertions on the real workflow file, same
# rationale as DeployAzureHealthCheckExitWiring.Tests.ps1 -- the behavior being proven is GitHub
# Actions' own if-condition/exit wiring, which Pester cannot execute directly.

BeforeAll {
    $script:WorkflowPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml'
    $script:WorkflowText = Get-Content -Raw $script:WorkflowPath

    function script:Get-Step([string]$Name) {
        $escaped = [regex]::Escape($Name)
        $m = [regex]::Match($script:WorkflowText, "(?s)- name: $escaped.*?(?=\r?\n      - name:)")
        $m.Success | Should -BeTrue -Because "the step '$Name' must still exist under this exact name"
        return $m.Value
    }
}

Describe 'deploy-azure.yml AC2 rollback wiring (t/4309)' {
    It 'C4 — the rollback-succeeded alert path still ends in exit 1 (so tag-known-good stays gated off a run that rolled back)' {
        $step = Get-Step 'Ops-alert — AC2 rollback succeeded (t/4309, informational)'
        $lastLine = ($step -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
        $lastLine | Should -Be 'exit 1'
    }

    It 'C4 — the sev-1 alert path also ends in exit 1' {
        $step = Get-Step 'Sev-1 alert — AC2 failure could not be resolved by rollback (t/4309)'
        $lastLine = ($step -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
        $lastLine | Should -Be 'exit 1'
    }

    It 'the sev-1 step also fires when the ROLLBACK STEP ITSELF fails (az error/timeout the script could not even catch, e.g. the script invocation itself), not just when it ran clean and found a problem (SO review, e/360#5 -- the "silent red" gap)' {
        $step = Get-Step 'Sev-1 alert — AC2 failure could not be resolved by rollback (t/4309)'
        # Anchored to the START of a line (after whitespace), not just the substring "if:" --
        # this step's own explanatory comment mentions another step's `if:` condition in prose,
        # which a bare substring match would grab instead of the real YAML key (caught running
        # this test: it initially matched into the comment, not the actual condition).
        $ifLine = ([regex]::Match($step, '(?m)^\s*if:\s*(.+)$')).Groups[1].Value
        $ifLine | Should -Match "steps\.ac2_rollback\.outcome == 'failure'"
    }

    It 'C4 — tag-known-good''s gate is unchanged and still requires deploy to succeed' {
        $tagJobMatch = [regex]::Match($script:WorkflowText, '(?s)tag-known-good:.*?if:\s*(.+)')
        $tagJobMatch.Success | Should -BeTrue
        $tagJobMatch.Groups[1].Value | Should -Match "needs\.deploy\.result == 'success'"
    }

    It 'C1 — the earlier-rollback signal step uses the EXACT same gating expression as "Rollback on failure", not a separate guess' {
        $rollbackIf = ([regex]::Match((Get-Step 'Rollback on failure'), 'if:\s*(.+)')).Groups[1].Value.Trim()
        $earlierStep = Get-Step 'Earlier-rollback signal (t/4309 C1)'
        # The four sub-conditions from the original rollback step's `if:` must all appear in the
        # new step's computed expression -- proves it is DERIVED from, not re-typed independently.
        'health_check.outputs.healthy', 'acceptance.outputs.accepted', 'persona.outputs.accepted', 'warm_gate.outputs.warm' | ForEach-Object {
            $rollbackIf | Should -Match ([regex]::Escape($_))
            $earlierStep | Should -Match ([regex]::Escape($_))
        }
    }

    It 'C2 — the AC2 rollback step passes steps.current_revision as -TargetRevision, never a different revision source' {
        $step = Get-Step 'Rollback for AC2 failure (t/4309 C2, C3a)'
        $step | Should -Match "-TargetRevision\s+'\$\{\{\s*steps\.current_revision\.outputs\.revision\s*\}\}'"
    }

    It 'C3a — the rollback step calls Invoke-Ac2Rollback.ps1 (the real Azure calls live in a testable script, not inline in the workflow)' {
        $step = Get-Step 'Rollback for AC2 failure (t/4309 C2, C3a)'
        $step | Should -Match 'Invoke-Ac2Rollback\.ps1'
    }

    It 'Invoke-Ac2Rollback.ps1 exists and declares -DryRun (SO C3b -- the live read-only proof needs this switch)' {
        $scriptPath = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Invoke-Ac2Rollback.ps1'
        Test-Path $scriptPath | Should -BeTrue
        (Get-Content -Raw $scriptPath) | Should -Match '\[switch\]\s*\$DryRun'
    }

    It 'C5 — the rollback step writes its outputs via Write-Ac2RollbackOutput, not the bare .ToString() inline logic the SO flagged' {
        $step = Get-Step 'Rollback for AC2 failure (t/4309 C2, C3a)'
        $step | Should -Match 'Write-Ac2RollbackOutput\.ps1'
        $step | Should -Match 'Write-Ac2RollbackOutput\s+-Result\s+\$result\s+-OutputPath\s+\$env:GITHUB_OUTPUT'
        $step | Should -Not -Match '\.RecheckFailed\.ToString\(\)'
    }
}
