# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4158: the deploy health check stops on a terminal revision and names the cause.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-RevisionActivationVerdict.ps1')
    # The real log lines from the 2026-10-12 attempt-2 revision (deploy-96cf630-20107).
    $script:MintLog = '{"level":40,"component":"auth","status":404,"msg":"Installation token mint failed"}'
    $script:CredLog = '{"level":40,"component":"server","err":{"message":"Goal: Validate data root via GitHub API  Error: GitHub App credentials are missing or not configured."}}'
}

Describe 'Get-RevisionActivationVerdict' {
    It 'RED ARM (the real incident): ActivationFailed plus the mint 404 fails, naming the installation ID' {
        $v = Get-RevisionActivationVerdict -RunningState 'ActivationFailed' -HealthState 'Unhealthy' -LogTail $script:MintLog
        $v.Verdict | Should -Be 'failed'
        $v.Cause   | Should -Be 'github-app-installation'
        $v.Message | Should -Match 'SYNC_GITHUB_APP_INSTALLATION_ID'
    }

    It 'fails on the mint 404 in the log even while Azure still says Activating (does not wait for the state flip)' {
        $v = Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $script:MintLog
        $v.Verdict | Should -Be 'failed'
        $v.Cause   | Should -Be 'github-app-installation'
    }

    It 'names missing App credentials' {
        $v = Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $script:CredLog
        $v.Cause | Should -Be 'github-app-credentials'
    }

    It 'a terminal state with no recognised log cause still fails, as a generic activation failure' {
        $v = Get-RevisionActivationVerdict -RunningState 'Failed' -HealthState 'Unhealthy' -LogTail 'nothing useful'
        $v.Verdict | Should -Be 'failed'
        $v.Cause   | Should -Be 'activation'
    }

    It 'an image-pull failure is named only once the revision is terminal' {
        $log = 'Failed to pull image "ghcr.io/x/y@sha256:abc": manifest unknown'
        (Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $log).Verdict | Should -Be 'waiting'
        $v = Get-RevisionActivationVerdict -RunningState 'ActivationFailed' -HealthState 'Unhealthy' -LogTail $log
        $v.Cause | Should -Be 'image-pull'
    }

    It 'GREEN ARM: a starting revision with a clean log keeps waiting' {
        (Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail '{"msg":"Taxonomy Editor running"}').Verdict |
            Should -Be 'waiting'
    }

    It 'Degraded keeps waiting (it can recover)' {
        (Get-RevisionActivationVerdict -RunningState 'Degraded' -HealthState 'Unhealthy' -LogTail '').Verdict | Should -Be 'waiting'
    }

    It 'a passing probe is healthy' {
        (Get-RevisionActivationVerdict -RunningState 'RunningAtMaxScale' -HealthState 'Healthy' -LogTail '' -ProbeHealthy $true).Verdict |
            Should -Be 'healthy'
    }

    It 'null inputs keep waiting rather than throwing' {
        (Get-RevisionActivationVerdict -RunningState $null -HealthState $null -LogTail $null).Verdict | Should -Be 'waiting'
    }
}
