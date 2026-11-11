# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/353: after any gate rollback, "Rollback on failure" exits 1, so AC2 (implicit success()) never runs
# and nothing verified the RESTORED revision. Two always()-gated steps now do. Structural (text)
# assertions on the real workflow, the same approach as DeployAzureVisibleGateFailures.Tests.ps1; the
# decision itself is unit-tested in Get-RestoredRevisionVerdict.Tests.ps1 (both arms).

BeforeAll {
    $script:Workflow = Get-Content -Raw (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml')
    function Get-StepText([string]$Name) {
        [regex]::Match($script:Workflow, "(?s)- name: $([regex]::Escape($Name))\r?\n.*?(?=\r?\n      - name:|\r?\n {0,2}\S|\z)").Value
    }
    function Get-StepIf([string]$Name) { ([regex]::Match((Get-StepText $Name), '(?m)^\s+if:\s*(.+)$')).Groups[1].Value.Trim() }
    function Get-StepIndex([string]$Name) { [regex]::Match($script:Workflow, "- name: $([regex]::Escape($Name))\r?\n").Index }
    $script:Check = 'Verify the restored revision after a gate rollback (t/353)'
    $script:Alert = 'Sev-1 alert — restored revision not serving after a gate rollback (t/353)'
}

Describe 'deploy-azure.yml verifies the restored revision after a gate rollback (t/353)' {
    It 'the premise holds: "Rollback on failure" still ends in exit 1 and AC2 still has no always()' {
        (Get-StepText 'Rollback on failure') | Should -Match '(?m)^\s+exit 1\s*$'
        Get-StepIf 'Post-deploy verification — serving revision active + /health 200 (t/4242 AC2)' | Should -Not -Match 'always\(\)'
    }

    It 'FIRE ARM: the check runs only after a gate rollback, under always() (a prior red step cannot skip it)' {
        Get-StepIf $script:Check | Should -Be "always() && steps.earlier_rollback.outputs.fired == 'true'"
    }

    It 'the check sits after the rollback and the earlier-rollback signal, before AC2' {
        $check = Get-StepIndex $script:Check
        $check | Should -BeGreaterThan (Get-StepIndex 'Rollback on failure')
        $check | Should -BeGreaterThan (Get-StepIndex 'Earlier-rollback signal (t/4309 C1)')
        $check | Should -BeLessThan (Get-StepIndex 'Post-deploy verification — serving revision active + /health 200 (t/4242 AC2)')
        (Get-StepIndex $script:Alert) | Should -BeGreaterThan $check
    }

    It 'the check reads the RESTORED revision fresh, uses the pure verdict, and always exits 0 with a healthy output' {
        $s = Get-StepText $script:Check
        $s | Should -Match 'RESTORED: \$\{\{ steps\.current_revision\.outputs\.revision \}\}'
        $s | Should -Match 'az containerapp revision show'
        $s | Should -Match 'Test-TaxEditorHealth'
        $s | Should -Match 'Get-RestoredRevisionVerdict'
        $s | Should -Match 'healthy='
        ($s -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim() | Should -Be 'exit 0'
    }

    It 'SILENT-FAIL ARM: the sev-1 alert fires when the check is not healthy OR did not complete (!= ''true''), and goes red' {
        Get-StepIf $script:Alert | Should -Be "always() && steps.earlier_rollback.outputs.fired == 'true' && steps.restored_check.outputs.healthy != 'true'"
        $a = Get-StepText $script:Alert
        $a | Should -Match 'gh issue create --title "\$TITLE" --label "prod-ac2-sev1,alert-escalated"'
        ($a -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim() | Should -Be 'exit 1'
    }

    It 'NO-ROLLBACK ARM: neither step can run on a deploy whose gates passed (fired != ''true'')' {
        foreach ($n in $script:Check, $script:Alert) {
            Get-StepIf $n | Should -Match "steps\.earlier_rollback\.outputs\.fired == 'true'"
        }
    }
}
