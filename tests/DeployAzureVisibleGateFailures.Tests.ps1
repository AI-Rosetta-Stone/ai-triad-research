# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4844 WP6: deploy-azure.yml's health check, mount readiness and full smoke gates always exit 0
# and carry their verdict in outputs (t/4252), so only "Rollback on failure" ever went red. Each gate
# now has a "Gate failed" step that turns its 'false' verdict into a red step. Structural (text)
# assertions on the real workflow file, same approach as DeployAzureHealthCheckExitWiring.Tests.ps1:
# the behavior is GitHub Actions' if-condition wiring, which Pester cannot execute.

BeforeAll {
    $script:WorkflowPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml'
    $script:WorkflowText = Get-Content -Raw $script:WorkflowPath

    function Get-StepText([string]$Name) {
        $m = [regex]::Match($script:WorkflowText, "(?s)- name: $([regex]::Escape($Name))\r?\n.*?(?=\r?\n      - name:|\r?\n  [a-z][a-z0-9_-]*:\r?\n)")
        if ($m.Success) { $m.Value } else { $null }
    }
    function Get-StepIndex([string]$Name) {
        [regex]::Match($script:WorkflowText, "- name: $([regex]::Escape($Name))\r?\n").Index
    }
    function Get-StepIf([string]$Name) {
        ([regex]::Match((Get-StepText $Name), '(?m)^\s+if:\s*(.+)$')).Groups[1].Value.Trim()
    }

    $script:Gates = @(
        @{ Step = 'Gate failed — health check';     Output = "steps.health_check.outputs.healthy == 'false'" }
        @{ Step = 'Gate failed — mount readiness';  Output = "steps.mount_probe.outputs.ready == 'false'" }
        @{ Step = 'Gate failed — full smoke';       Output = "steps.acceptance.outputs.accepted == 'false'" }
    )
}

Describe 'deploy-azure.yml visible gate failures (t/4844 WP6)' {
    It '<Step> exists, fires only on its gate''s explicit false verdict under always(), and exits 1' -ForEach @(
        @{ Step = 'Gate failed — health check';     Output = "steps.health_check.outputs.healthy == 'false'" }
        @{ Step = 'Gate failed — mount readiness';  Output = "steps.mount_probe.outputs.ready == 'false'" }
        @{ Step = 'Gate failed — full smoke';       Output = "steps.acceptance.outputs.accepted == 'false'" }
    ) {
        $text = Get-StepText $Step
        $text | Should -Not -BeNullOrEmpty -Because "the '$Step' step must exist under this exact name"
        Get-StepIf $Step | Should -Be "always() && $Output"
        $text | Should -Match '::error::Deploy gate FAILED'
        $text | Should -Match '(?m)^\s+exit 1\s*$'
    }

    It 'the gate-failed steps sit after "Collect failure diagnostics" and before rollback' {
        $diag     = Get-StepIndex 'Collect failure diagnostics'
        $reauth   = Get-StepIndex 'Re-authenticate before rollback'
        $rollback = Get-StepIndex 'Rollback on failure'
        $diag | Should -BeGreaterThan 0
        foreach ($g in $script:Gates) {
            $i = Get-StepIndex $g.Step
            $i | Should -BeGreaterThan $diag -Because "a red step before diagnostics would skip it (no always(), t/4252)"
            $i | Should -BeLessThan $reauth
            $i | Should -BeLessThan $rollback
        }
    }

    It 'diagnostics still has no always(), so the gates themselves must keep exiting 0 (contract unchanged)' {
        Get-StepIf 'Collect failure diagnostics' | Should -Not -Match 'always\(\)'
        (Get-StepText 'Mount readiness probe (t/4513)') | Should -Match '(?m)^\s+exit 0\s*$'
        (Get-StepText 'Acceptance tests — full smoke (pre-traffic shift)') | Should -Not -Match '(?m)^\s+exit 1\s*$'
    }

    It 'every step after the gate-failed steps that must still run keeps always()' {
        foreach ($name in 'Re-authenticate before rollback', 'Rollback on failure', 'Fail if unhealthy (no previous revision to rollback to)', 'Earlier-rollback signal (t/4309 C1)') {
            Get-StepIf $name | Should -Match '^always\(\)' -Because "'$name' runs after a possibly-red gate-failed step"
        }
    }

    It '"Fail if unhealthy" keeps its old reach: it runs only when the health check ran' {
        Get-StepIf 'Fail if unhealthy (no previous revision to rollback to)' | Should -Match "steps\.health_check\.outcome == 'success'"
    }
}

Describe 'deploy-azure.yml deploy-job checkout (t/4844 WP6)' {
    It 'keeps full history for the t/4194 guard and drops blobs' {
        $deployJob = [regex]::Match($script:WorkflowText, '(?s)\n  deploy:\r?\n.*?(?=\r?\n  [a-z][a-z0-9_-]*:\r?\n)').Value
        $checkout = [regex]::Match($deployJob, '(?s)- uses: actions/checkout@.*?(?=\r?\n      - name:)').Value
        $checkout | Should -Match '(?m)^\s+fetch-depth:\s*0\b'
        $checkout | Should -Match '(?m)^\s+filter:\s*blob:none\b'
    }
}
