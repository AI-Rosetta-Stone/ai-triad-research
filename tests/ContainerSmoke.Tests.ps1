# Tag: devops (t/611)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
    t/611: operations/devops/Invoke-ContainerSmoke.ps1 runs the deploy smoke's phases against the CI-built
    container (ci.yml test-container). Pins: every Invoke-Smoke*Phase is run or skipped with a reason; the
    gate mirrors the deploy smoke's OverallPass; the verdicts fail closed; the ci.yml step is wired.
#>

BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    . (Join-Path $script:RepoRoot 'operations' 'devops' 'Invoke-ContainerSmoke.ps1') -BaseUrl 'http://unused'
    $script:PhasesFile = Join-Path $script:RepoRoot 'scripts' 'AITriad' 'Private' 'TaxEditorSmokeTestPhases.ps1'
    $script:Ci = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot '.github' 'workflows' 'ci.yml')
}

Describe 'Invoke-ContainerSmoke: nothing is skipped silently (t/611 step 4)' -Tag 'devops' {
    It 'every Invoke-Smoke*Phase function is in PHASES, and PHASES names only real phase functions' {
        $defined = @(Select-String -LiteralPath $script:PhasesFile -Pattern '^function Invoke-Smoke(\w+)Phase\b' |
                ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object)
        $defined.Count | Should -BeGreaterThan 5
        @($script:Phases.Name | Sort-Object) | Should -Be $defined -Because 'a new phase must be run in CI or skipped with a reason in Invoke-ContainerSmoke.ps1'
    }

    It 'every skipped phase carries a reason; only Azure and GitHub are skipped' {
        $skipped = @($script:Phases | Where-Object Kind -eq 'skip')
        foreach ($s in $skipped) { [string]$s.Reason | Should -Not -BeNullOrEmpty -Because "$($s.Name) needs a reason" }
        @($skipped.Name | Sort-Object) | Should -Be @('Azure', 'GitHub')
    }

    It 'the gate mirrors the deploy smoke: Health and every endpoint-style phase gate; the WARN-only phases stay WARN-only' {
        @($script:Phases | Where-Object Kind -eq 'gate' | ForEach-Object Name) |
            Should -Be @('Health', 'Endpoint', 'AnonEndpoint', 'Analytics', 'DataPresence', 'OpedFiles')
        @($script:Phases | Where-Object Kind -eq 'warn' | ForEach-Object Name) | Should -Be @('EmbeddingLatency', 'CachePresence', 'IdentityAllowlist')
        # The deploy smoke's own gate, so the two can't drift apart unnoticed.
        $smoke = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'scripts' 'AITriad' 'Public' 'Invoke-TaxEditorSmokeTest.ps1')
        $smoke | Should -Match ([regex]::Escape('$AllResults = @($Endpoints) + @($AnonEndpoints) + @($Analytics) + @($DataPresence) + @($OpedFiles.Result)'))
        $smoke | Should -Match ([regex]::Escape('$OverallPass = $Health.Healthy -and $Failed -eq 0 -and $Azure.Healthy'))
    }

    It 'the runner, the phase functions it runs, and the OverallPass it is pinned to are gate files (SO p/273#12)' {
        $gfc = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'operations' 'devops' 'gate-file-change.mjs')
        foreach ($rel in 'operations/devops/Invoke-ContainerSmoke.ps1', 'scripts/AITriad/Private/TaxEditorSmokeTestPhases.ps1', 'scripts/AITriad/Public/Invoke-TaxEditorSmokeTest.ps1',
            'scripts/AITriad/Private/Test-DataPresenceAssertion.ps1', 'scripts/AITriad/Public/Test-TaxEditorHealth.ps1', 'scripts/AITriad/Public/Test-TaxEditorEndpoints.ps1') {
            $gfc | Should -Match ([regex]::Escape("'$rel'")) -Because "a PR must not loosen $rel and lock a route in one change without a gate-change review"
        }
        # The recorded residual (SO p/273#14): the transport stays unprotected, on purpose, and says so.
        $gfc | Should -Not -Match ([regex]::Escape("'scripts/AITriad/Private/Invoke-RemoteCheck.ps1'"))
        $gfc | Should -Match 'RECORDED RESIDUAL[^\n]*Invoke-RemoteCheck\.ps1'
    }

    It 'every run phase has a verdict rule (an unknown phase fails closed)' {
        foreach ($p in @($script:Phases | Where-Object Kind -ne 'skip')) {
            (Get-ContainerSmokePhaseVerdict -Name $p.Name -Result $null).Detail | Should -Not -Match 'no verdict rule'
        }
        $v = Get-ContainerSmokePhaseVerdict -Name 'Brand-New' -Result ([pscustomobject]@{ Pass = $true })
        $v.Pass | Should -BeFalse
        $v.Detail | Should -Match 'no verdict rule'
    }
}

Describe 'Invoke-ContainerSmoke: verdicts' -Tag 'devops' {
    It 'an endpoint-style phase fails when any row fails, naming it with its status and error' {
        $rows = @([pscustomobject]@{ Endpoint = 'POST /api/analytics/event'; Status = 403; Pass = $false; Error = 'admin only' },
            [pscustomobject]@{ Endpoint = 'GET /api/x'; Status = 200; Pass = $true; Error = $null })
        $v = Get-ContainerSmokePhaseVerdict -Name 'Analytics' -Result $rows
        $v.Pass | Should -BeFalse
        $v.Detail | Should -Match '1/2 failed: POST /api/analytics/event -> 403 admin only'
    }

    It 'an endpoint-style phase that returns nothing fails closed' {
        (Get-ContainerSmokePhaseVerdict -Name 'Endpoint' -Result @()).Pass | Should -BeFalse
        (Get-ContainerSmokePhaseVerdict -Name 'DataPresence' -Result $null).Pass | Should -BeFalse
    }

    It 'only a real boolean $true passes (SO p/273#12): a string, $null or 1 never does' {
        foreach ($v in @('True', 'false', 'yes', 1, $null, @($true))) {
            Test-StrictTrue $v | Should -BeFalse -Because "$(if ($null -eq $v) { '$null' } else { "'$v' ($($v.GetType().Name))" }) is not a boolean true"
        }
        Test-StrictTrue $true | Should -BeTrue
        $row = [pscustomobject]@{ Endpoint = 'GET /api/x'; Status = 200; Pass = 'false'; Error = $null }
        (Get-ContainerSmokePhaseVerdict -Name 'Endpoint' -Result @($row)).Pass | Should -BeFalse -Because "[bool]'false' is `$true; the verdict must not cast"
        (Get-ContainerSmokePhaseVerdict -Name 'Health' -Result ([pscustomobject]@{ Healthy = 'true'; Checks = @() })).Pass | Should -BeFalse
        (Get-ContainerSmokePhaseVerdict -Name 'OpedFiles' -Result ([pscustomobject]@{ Pass = 1; Result = $null })).Pass | Should -BeFalse
    }

    It 'Health passes only when healthy, and names the failing checks' {
        (Get-ContainerSmokePhaseVerdict -Name 'Health' -Result ([pscustomobject]@{ Healthy = $true; Checks = @() })).Pass | Should -BeTrue
        $v = Get-ContainerSmokePhaseVerdict -Name 'Health' -Result ([pscustomobject]@{ Healthy = $false; Checks = @([pscustomobject]@{ Healthy = $false; Endpoint = '/healthz'; Detail = '503' }) })
        $v.Pass | Should -BeFalse
        $v.Detail | Should -Match '/healthz: 503'
    }

    It 'the summary table has a row per phase, with the skip reason, and escapes pipes' {
        $md = Format-ContainerSmokeSummary -Rows @(
            [pscustomobject]@{ Phase = 'Azure'; Ran = 'skipped'; Gates = '-'; Result = '-'; Detail = 'needs az' }
            [pscustomobject]@{ Phase = 'Analytics'; Ran = 'ran'; Gates = 'yes'; Result = 'FAIL'; Detail = "a|b`nc" })
        $md | Should -Match '\| Phase \| Ran / skipped \| Gates the job \| Result \| Detail / reason \|'
        $md | Should -Match '\| Azure \| skipped \| - \| - \| needs az \|'
        $md | Should -Match '\| Analytics \| ran \| yes \| FAIL \| a\\\|b c \|'
    }
}

Describe 'ci.yml test-container: the container smoke step (t/611)' -Tag 'devops' {
    It 'runs the runner against the built image, with the hosted auth profile from main.bicep' {
        $script:Ci | Should -Match 'operations/devops/Invoke-ContainerSmoke\.ps1'
        foreach ($env in 'NODE_ENV=production', 'AUTH_OPTIONAL=1', 'WEBSITE_AUTH_ENABLED=true', 'STORAGE_MODE=filesystem') {
            $script:Ci | Should -Match ([regex]::Escape("-e $env")) -Because "the container smoke must start with $env"
        }
        $script:Ci | Should -Match 'docker logs container-smoke'
    }

    It 'fronts the container with digest-pinned TLS (the hosted session cookie is Secure) and smokes https://localhost' {
        $script:Ci | Should -Match 'caddy:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}'
        $script:Ci | Should -Match 'update-ca-certificates'
        $script:Ci | Should -Match 'openssl x509 -noout -fingerprint -sha256'
        $script:Ci | Should -Match 'header_up X-Forwarded-Proto https'
        $script:Ci | Should -Match ([regex]::Escape('curl -fsS --max-time 5 -o /dev/null https://localhost/healthz'))
        # Lead p/233#174 condition 2: never a cert-skip anywhere in the workflow, nor (SO p/273#12) in the
        # PowerShell the step runs: the runner and the smoke's phase and orchestration files.
        $bypass = 'SkipCertificateCheck|NODE_TLS_REJECT_UNAUTHORIZED|curl[^\n]*\s-k\b|--insecure|ServerCertificateValidationCallback|ServerCertificateCustomValidationCallback'
        $script:Ci | Should -Not -Match $bypass
        foreach ($rel in 'operations/devops/Invoke-ContainerSmoke.ps1', 'scripts/AITriad/Private/TaxEditorSmokeTestPhases.ps1', 'scripts/AITriad/Public/Invoke-TaxEditorSmokeTest.ps1') {
            Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot $rel) | Should -Not -Match $bypass -Because "$rel must not bypass certificate checks"
        }
        $script:Ci | Should -Match ([regex]::Escape('Invoke-ContainerSmoke.ps1 -BaseUrl https://localhost'))
        # The reason TLS is needed: the app marks the anon session cookie Secure in production.
        $src = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'taxonomy-editor' 'src' 'server' 'routes' 'anonSessionCreated.ts')
        $src | Should -Match "NODE_ENV === 'production'.*'; Secure'"
    }
}
