# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/75: main.bicep deploys the budget and the monitoring module only when budgetAlertEmail is
# non-empty. A deploy with vars.ALERT_EMAIL unset therefore goes green while applying no alert
# change. deploy-azure.yml must say so, before the what-if, without failing and without printing
# the address.

Describe 'deploy-azure.yml warns when vars.ALERT_EMAIL is empty (t/75)' {
    BeforeAll {
        $script:Workflow = Get-Content (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml') -Raw
        $script:Block = [regex]::Match(
            $script:Workflow,
            '(?s)if \[ "\$ALERT_EMAIL_SET" != "true" \]; then(.*?)\n          fi\n').Groups[1].Value
    }

    It 'derives a boolean from the variable, and never puts the address in a step env var' {
        $script:Workflow | Should -Match "ALERT_EMAIL_SET: \$\{\{ vars\.ALERT_EMAIL != '' \}\}"
        $script:Workflow | Should -Not -Match '(?m)^\s+[A-Z_]+:\s*\$\{\{ vars\.ALERT_EMAIL \}\}\s*$'
    }

    It 'still passes the address to Bicep at both call sites (what-if and apply), and nowhere else' {
        ([regex]::Matches($script:Workflow, 'budgetAlertEmail=\$\{\{ vars\.ALERT_EMAIL \}\}')).Count | Should -Be 2
        ([regex]::Matches($script:Workflow, '\$\{\{ vars\.ALERT_EMAIL \}\}')).Count | Should -Be 2
    }

    It 'emits a WARN that names what is skipped and what to do' {
        $script:Block | Should -Not -BeNullOrEmpty
        $script:Block | Should -Match '::warning::WARN t/75: vars\.ALERT_EMAIL is empty'
        $script:Block | Should -Match 'SKIPS the budget and the monitoring module'
        $script:Block | Should -Match 'a new environment gets no alerts at all'
        $script:Block | Should -Match 'Set the repository variable ALERT_EMAIL'
    }

    It 'is a warning only: the empty-email arm never fails the deploy' {
        $script:Block | Should -Not -Match 'exit\s+\d'
        $script:Block | Should -Not -Match '::error::'
    }

    It 'runs in the what-if step, before the preview and before the Bicep apply' {
        $warn = $script:Workflow.IndexOf('::warning::WARN t/75')
        $warn | Should -BeGreaterThan $script:Workflow.IndexOf('- name: Preview Bicep changes (what-if)')
        $warn | Should -BeLessThan $script:Workflow.IndexOf('echo "Previewing infrastructure changes..."')
        $warn | Should -BeLessThan $script:Workflow.IndexOf('- name: Deploy Bicep template')
    }
}
