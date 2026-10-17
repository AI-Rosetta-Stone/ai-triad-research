# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4252, SO review (p/682#40, C1/C2): deploy-azure.yml's "Health check new revision" step is
# DESIGNED to always report step-success and carry the real signal only through
# steps.health_check.outputs.healthy — "Collect failure diagnostics" has no always(), so if that
# step itself reports failure, GitHub's implicit success() check skips diagnostics on exactly the
# runs that need them. These are structural (text) assertions on the real workflow file, because
# the behavior being proven is GitHub Actions' own if-condition wiring, which Pester cannot execute
# directly — this is the closest thing to a live-fire proof available for that wiring.

BeforeAll {
    $script:WorkflowPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml'
    $script:WorkflowText = Get-Content -Raw $script:WorkflowPath
}

Describe 'deploy-azure.yml health-check exit wiring (t/4252)' {
    It 'the "Health check new revision" step always exits 0, never from $Verdict' {
        $stepMatch = [regex]::Match($script:WorkflowText, '(?s)- name: Health check new revision.*?(?=\r?\n      - name:)')
        $stepMatch.Success | Should -BeTrue -Because 'the step must still exist under this exact name'
        $stepText = $stepMatch.Value

        # FIRE ARM: the step must never exit based on the verdict — that is exactly the regression
        # SO C1 caught (exit 1 on a non-healthy verdict skips the no-always() diagnostics step below).
        $stepText | Should -Not -Match 'exit\s*\(\s*Get-HealthCheckExitCode'
        $stepText | Should -Not -Match 'exit\s+1\s*$'

        # The step's actual last executable line must be an unconditional exit 0.
        $lastLine = ($stepText -split '\r?\n' | Where-Object { $_.Trim() -and $_.Trim() -ne '' } | Select-Object -Last 1).Trim()
        $lastLine | Should -Be 'exit 0'
    }

    It 'FIRE ARM (SO C2 — prove the unhealthy arm through the step wiring): "Collect failure diagnostics" has no always(), so it depends on health_check reporting success regardless of verdict' {
        $stepMatch = [regex]::Match($script:WorkflowText, '(?s)- name: Collect failure diagnostics.*?(?=\r?\n      - name:)')
        $stepMatch.Success | Should -BeTrue
        $ifLine = ([regex]::Match($stepMatch.Value, 'if:\s*(.+)')).Groups[1].Value.Trim()

        # This step's condition references steps.health_check.outputs.healthy with NO always() —
        # which only works if health_check's own step status is always 'success'. If this
        # assertion ever starts failing because always() was added, the exit-0-always requirement
        # above may no longer be load-bearing — revisit both together.
        $ifLine | Should -Match "steps\.health_check\.outputs\.healthy != 'true'"
        $ifLine | Should -Not -Match 'always\(\)'
    }

    It 'the "Rollback on failure" and "Fail if unhealthy" steps DO use always() / an unconditional check, so they are NOT affected by health_check''s own step status' {
        $rollback = [regex]::Match($script:WorkflowText, '(?s)- name: Rollback on failure.*?(?=\r?\n      - name:)').Value
        ([regex]::Match($rollback, 'if:\s*(.+)')).Groups[1].Value | Should -Match 'always\(\)'

        # "Fail if unhealthy" runs only when there is no prior revision to roll back to; it has no
        # always() either, but it is gated the same way as diagnostics and relies on the same
        # exit-0-always contract proven above.
        $failIfUnhealthy = [regex]::Match($script:WorkflowText, '(?s)- name: Fail if unhealthy.*?(?=\r?\n      - name:)').Value
        $failIfUnhealthy | Should -Match "steps\.health_check\.outputs\.healthy != 'true'"
    }
}
