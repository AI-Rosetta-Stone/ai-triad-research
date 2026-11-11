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
        # Stops at the next step, or at any line indented 2 or fewer (a job boundary or a top-level comment).
        [regex]::Match($JobText, "(?s)- name: $([regex]::Escape($Name))\r?\n.*?(?=\r?\n      - name:|\r?\n      - uses:|\r?\n {0,2}\S|\z)").Value
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
        $s | Should -Match 'Invoke-GatedRollback\.ps1 -AppName \$APP -ResourceGroup \$RG -RevisionName \$PREV_REV'
        # SO condition 1: no ungated activate+shift advice in the summary.
        $s | Should -Not -Match 'ingress traffic set'
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

    It 'SO round 2: has an explicit job-scoped token with id-token (OIDC) and issues (soak alert) write' {
        $head = ($script:Retire -split "\n    steps:")[0]
        $perm = [regex]::Match($head, '(?s)\n    permissions:\r?\n((?:      [a-z-]+: [a-z]+[^\r\n]*\r?\n)+)').Groups[1].Value
        $perm | Should -Match '(?m)^      id-token: write'
        $perm | Should -Match '(?m)^      issues: write'
        $perm | Should -Match '(?m)^      contents: read'
        $perm | Should -Not -Match 'packages: write'
    }

    It 'SO round 2: the drill''s -DeactivateAfterMeasure is gated by the double-sourced traffic guard' {
        $cli = Get-Content -Raw (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Invoke-GatedRollback.ps1')
        $block = [regex]::Match($cli, '(?s)if \(\$r\.Action -eq ''measured'' -and \$DeactivateAfterMeasure\) \{.*?\n\}').Value
        $block | Should -Match 'Get-RevisionDeactivationVerdict'
        $block | Should -Match 'Get-IngressTrafficWeightForRevision'
        $gate = $block.IndexOf('if ($guard.Action -eq ''deactivate'')')
        $gate | Should -BeGreaterThan -1 -Because 'the deactivate must sit inside the guard''s deactivate verdict'
        $gate | Should -BeLessThan $block.IndexOf('az containerapp revision deactivate')
        $block.IndexOf('Get-RevisionDeactivationVerdict') | Should -BeLessThan $block.IndexOf('az containerapp revision deactivate')
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
        # DevOps Lead condition 3: one retry within a round for the az read and the smoke.
        $s | Should -Match 'if \(-not \(Test-Serving \$Info\)\) \{ Start-Sleep -Seconds 20; \$Info = Get-ServingInfo \}'
        ([regex]::Matches($s, 'Test-TaxEditorEndpoints -BaseUrl \$env:APP_URL -UserType Anonymous')).Count | Should -Be 2
    }

    It 'exposes soak_passed, and tag-known-good tags only when the soak passed or the retire job was skipped (DevOps Lead condition 1)' {
        $script:Retire | Should -Match 'soak_passed: \$\{\{ steps\.soak\.outputs\.passed \}\}'
        $tkg = Get-Job 'tag-known-good'
        $tkg | Should -Match 'needs: \[preflight, deploy, retire-previous-revision\]'
        $if = Get-If ($tkg -split "\n    steps:")[0]
        $if | Should -Match "needs\.retire-previous-revision\.result == 'skipped' \|\| needs\.retire-previous-revision\.outputs\.soak_passed == 'true'"
        $if | Should -Match '!cancelled\(\)'   # status function, so a skipped retire job doesn't skip tag-known-good
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

    It 'a failed soak warns + opens an ops-alert issue, keeps the rollback target, and does NOT turn the run red (DevOps Lead condition 2)' {
        $f = Get-StepText $script:Retire 'Ops-alert — soak did not pass, rollback target kept (t/266 b)'
        $f | Should -Not -BeNullOrEmpty
        Get-If $f | Should -Be "always() && steps.soak.outputs.passed != 'true'"
        $f | Should -Match '::warning::'
        $f | Should -Match 'gh issue create --title "\$TITLE" --label "prod-soak-alert,alert-escalated" --body "\$BODY" && exit 0'
        $f | Should -Match 'gh issue comment "\$EXISTING" --body "\$BODY" && exit 0'
        # SO round 2: a post failure is never swallowed: it falls through to ::error:: + exit 1.
        $f | Should -Not -Match 'gh issue (create|comment)[^\r\n]*\|\|'
        $f.IndexOf('::error::t/266: the soak FAILED and the prod-soak-alert issue could not be posted') | Should -BeGreaterThan $f.LastIndexOf('&& exit 0')
        ($f -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim() | Should -Be 'exit 1'
        # Only the alert step can exit 1 (double failure: soak failed AND alert unpostable).
        ([regex]::Matches($script:Retire, '(?m)^\s+exit 1\s*$')).Count | Should -Be 1
        $sum = Get-StepText $script:Retire 'Summary — rollback target status (t/266 b)'
        Get-If $sum | Should -Be 'always()'
        $sum | Should -Match 'Invoke-GatedRollback\.ps1'
    }
}
