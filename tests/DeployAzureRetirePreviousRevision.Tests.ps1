# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/266 option (b): deploy-azure.yml retires the previous revision only after AC2 passed and a
# 15-minute green soak, and never on any failure. Structural (text) assertions on the real workflow,
# the same approach as DeployAzureVisibleGateFailures.Tests.ps1: the behavior is GitHub Actions'
# job/step wiring, which Pester cannot execute. The decision itself is unit-tested in
# Get-PreviousRevisionRetireVerdict.Tests.ps1 (both arms).

BeforeAll {
    $script:Workflow = Get-Content -Raw (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml')
    function Get-Job([string]$Name) {
        [regex]::Match($script:Workflow, "(?s)\n  $([regex]::Escape($Name)):\r?\n.*?(?=\r?\n  [a-z][a-z0-9_-]*:\r?\n|\z)").Value
    }
    function Get-StepText([string]$JobText, [string]$Name) {
        [regex]::Match($JobText, "(?s)- name: $([regex]::Escape($Name))\r?\n.*?(?=\r?\n      - name:|\r?\n      - uses:|\z)").Value
    }
    function Get-If([string]$Text) { ([regex]::Match($Text, '(?m)^\s+if:\s*(.+)$')).Groups[1].Value.Trim() }

    $script:Deploy = Get-Job 'deploy'
    $script:Retire = Get-Job 'retire-previous-revision'
}

Describe 'deploy job exposes what the retire job needs (t/266 b)' {
    It 'outputs previous/new revision, app url, AC2 result and the earlier-rollback signal from their owning steps' {
        $script:Deploy | Should -Match 'previous_revision: \$\{\{ steps\.current_revision\.outputs\.revision \}\}'
        $script:Deploy | Should -Match 'new_revision: \$\{\{ steps\.new_revision\.outputs\.revision \}\}'
        $script:Deploy | Should -Match 'app_url: \$\{\{ steps\.deploy\.outputs\.appUrl \}\}'
        $script:Deploy | Should -Match 'ac2_failed: \$\{\{ steps\.ac2\.outputs\.failed \}\}'
        $script:Deploy | Should -Match 'earlier_rollback: \$\{\{ steps\.earlier_rollback\.outputs\.fired \}\}'
    }

    It 'prints the rollback target + one-command rollback in the job summary on every deploy with a previous revision' {
        $s = Get-StepText $script:Deploy 'Record the rollback target in the job summary (t/266 b)'
        $s | Should -Not -BeNullOrEmpty
        Get-If $s | Should -Be "always() && steps.current_revision.outputs.revision != ''"
        $s | Should -Match 'GITHUB_STEP_SUMMARY'
        $s | Should -Match 'az containerapp revision activate'
        $s | Should -Match 'az containerapp ingress traffic set'
    }

    It 'the deploy job itself never deactivates the previous (rollback-target) revision' {
        # Only "Cleanup stale revisions" (protects current_revision) and the rollback steps (new revision) disable anything.
        $script:Deploy | Should -Not -Match 'Disable-ContainerAppRevision -RevisionName \$env:PREV_REV'
    }
}

Describe 'retire-previous-revision job (t/266 b)' {
    It 'exists, runs after deploy, in the deploy environment' {
        $script:Retire | Should -Not -BeNullOrEmpty
        $script:Retire | Should -Match 'needs: \[deploy\]'
        $script:Retire | Should -Match 'environment: \$\{\{ inputs\.environment \}\}'
    }

    It 'FAILURE ARM (job level): never runs unless deploy succeeded, AC2 passed and no earlier gate rollback fired' {
        $if = Get-If ($script:Retire -split "\n    steps:")[0]
        $if | Should -Match "needs\.deploy\.result == 'success'"
        $if | Should -Match "needs\.deploy\.outputs\.ac2_failed == 'false'"
        $if | Should -Match "needs\.deploy\.outputs\.earlier_rollback == 'false'"
        $if | Should -Match "needs\.deploy\.outputs\.previous_revision != ''"
        $if | Should -Match '!cancelled\(\)'
        $if | Should -Not -Match 'always\(\)'
    }

    It 'soaks ~15 minutes: 5 rounds x 180s of active@100 + /health + read-only smoke, always exits 0 with a passed output' {
        $s = Get-StepText $script:Retire 'Soak — 15 minutes of health + full smoke on the serving revision'
        $s | Should -Not -BeNullOrEmpty
        $s | Should -Match '\$Rounds = 5; \$IntervalSec = 180'
        $s | Should -Match 'Test-TaxEditorHealth'
        $s | Should -Match 'Test-TaxEditorEndpoints -BaseUrl \$env:APP_URL -UserType Anonymous'
        $s | Should -Not -Match 'Invoke-TaxEditorSmokeTest -BaseUrl'   # writes analytics / spends GitHub quota
        $s | Should -Match "passed=false"
        $s | Should -Match "passed=true"
        ($s -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim() | Should -Be 'exit 0'
    }

    It 'FAILURE ARM (step level): the deactivate step runs ONLY on a retire verdict, and the verdict is fed the soak result' {
        $v = Get-StepText $script:Retire 'Retire verdict (fresh traffic reads)'
        $v | Should -Match 'Get-PreviousRevisionRetireVerdict'
        $v | Should -Match 'SOAK_PASSED: \$\{\{ steps\.soak\.outputs\.passed \}\}'
        $v | Should -Match 'AC2_FAILED: \$\{\{ needs\.deploy\.outputs\.ac2_failed \}\}'
        $v | Should -Match 'unknown is never read as 0'
        $d = Get-StepText $script:Retire 'Deactivate the previous revision (t/266 b)'
        Get-If $d | Should -Be "steps.verdict.outputs.action == 'retire'"
        $d | Should -Match 'Get-RevisionDeactivationVerdict'
        $d | Should -Match "-ProtectedNames @\(\`$env:NEW_REV\)"
        $d | Should -Match 'Disable-ContainerAppRevision -RevisionName \$env:PREV_REV'
    }

    It 'a failed soak goes red visibly and keeps the rollback target (no deactivate)' {
        $f = Get-StepText $script:Retire 'Fail if the soak failed (t/266 b)'
        Get-If $f | Should -Be "always() && steps.soak.outputs.passed != 'true'"
        $f | Should -Match 'exit 1'
        $sum = Get-StepText $script:Retire 'Summary — rollback target status (t/266 b)'
        Get-If $sum | Should -Be 'always()'
        $sum | Should -Match 'az containerapp revision activate'
    }
}
