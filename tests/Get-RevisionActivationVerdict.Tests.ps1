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

    Context 'SO C1: only a 404 or 401 token mint is fatal on sight' {
        It 'a 401 mint fails, naming the App credentials' {
            $log = '{"level":40,"component":"auth","status":401,"msg":"Installation token mint failed"}'
            $v = Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $log
            $v.Verdict | Should -Be 'failed'
            $v.Cause   | Should -Be 'github-app-credentials'
            $v.Message | Should -Match 'HTTP 401'
        }

        It 'a <Status> mint is transient: it keeps waiting and is named as the last refusal' -ForEach @(
            @{ Status = 403 }, @{ Status = 429 }, @{ Status = 500 }, @{ Status = 502 }, @{ Status = 503 }
        ) {
            $log = "{""level"":40,""component"":""auth"",""status"":$Status,""msg"":""Installation token mint failed""}"
            $v = Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $log
            $v.Verdict     | Should -Be 'waiting'
            $v.LastRefusal | Should -Be "GitHub App token mint refused (HTTP $Status)"
        }

        It 'a mint failure with no status logged is not fatal' {
            $log = '{"level":40,"component":"auth","msg":"Installation token mint failed"}'
            $v = Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $log
            $v.Verdict     | Should -Be 'waiting'
            $v.LastRefusal | Should -Match 'status not logged'
        }

        It 'a transient 503 followed by a 404 in the same tail still fails on the 404' {
            $log = @(
                '{"level":40,"component":"auth","status":503,"msg":"Installation token mint failed"}'
                '{"level":40,"component":"auth","status":404,"msg":"Installation token mint failed"}'
            ) -join "`n"
            (Get-RevisionActivationVerdict -RunningState 'Activating' -HealthState 'None' -LogTail $log).Cause |
                Should -Be 'github-app-installation'
        }
    }

    Context 'SO C2: the last GitHub refusal is reported, never fatal on its own' {
        It 'circuit open keeps waiting and is named' {
            $log = '{"level":50,"msg":"readiness: data-load failed: github-api circuit open"}'
            $v = Get-RevisionActivationVerdict -RunningState 'Running' -HealthState 'Unhealthy' -LogTail $log
            $v.Verdict     | Should -Be 'waiting'
            $v.LastRefusal | Should -Match 'circuit open'
        }

        It 'a non-ok GitHub API response keeps waiting and is named' {
            $log = '{"level":40,"cause":"api-non-ok","msg":"listDirectory returning [] — GitHub API non-ok response, may be false-empty (t/3300)"}'
            $v = Get-RevisionActivationVerdict -RunningState 'Running' -HealthState 'Unhealthy' -LogTail $log
            $v.Verdict     | Should -Be 'waiting'
            $v.LastRefusal | Should -Match 'non-ok response'
        }

        It 'a clean log has no last refusal' {
            (Get-RevisionActivationVerdict -RunningState 'Running' -HealthState 'Healthy' -LogTail '{"msg":"ok"}').LastRefusal |
                Should -BeNullOrEmpty
        }
    }
}
