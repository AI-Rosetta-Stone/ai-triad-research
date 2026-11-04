#Requires -Modules Pester

<#
.SYNOPSIS
    Tests for Test-StagingContainerEnvIsolation.ps1 (t/4797, prevention follow-up for t/4794).
.DESCRIPTION
    Both arms per docs/CodeReview/gate-signal-integrity.md rule 1: the clean case passes, and
    one injected fault per decision site this predicate touches --
      - each of the 4 known container vars, individually mis-valued (not staging-prefixed);
      - each of the 4 known container vars, individually MISSING from the env array entirely
        (TL condition 1, p/404#165);
      - zero pattern matches at all -- the vacuous-pass guard (TL condition 1);
      - a SYNTHETIC 5th var (AZURE_FOO_CONTAINER, not in the known-names list) mis-valued,
        proving the regex enumerates by PATTERN, not the hardcoded RequiredNames list -- the
        actual gap this ticket closes (a future container var nobody added to a fixed list).
#>

Describe 'Test-StagingContainerEnvIsolation (t/4797)' {
    BeforeAll {
        $scriptRoot = Split-Path $PSScriptRoot -Parent
        . (Join-Path $scriptRoot 'operations/devops/azure/Test-StagingContainerEnvIsolation.ps1')

        function script:CleanEnv {
            @(
                [PSCustomObject]@{ name = 'AZURE_USER_CONTENT_CONTAINER'; value = 'staging-user-content' }
                [PSCustomObject]@{ name = 'AZURE_COMMUNITY_CONTAINER'; value = 'staging-community' }
                [PSCustomObject]@{ name = 'AZURE_BRIEF_EXPORTS_CONTAINER'; value = 'staging-brief-exports' }
                [PSCustomObject]@{ name = 'AZURE_ANALYTICS_CONTAINER'; value = 'staging-analytics' }
                [PSCustomObject]@{ name = 'NODE_ENV'; value = 'production' }
            )
        }
    }

    Context 'Under Set-StrictMode -Version Latest, as deploy-staging.yml runs it' {
        # Regression: the clean arm threw "The property 'Count' cannot be found" in the real
        # workflow (run 41713953738) because the other tests here run without strict mode.
        It 'Assert- does not throw on the clean env under strict mode' {
            { Set-StrictMode -Version Latest; Assert-StagingContainerEnvIsolation -EnvVars (script:CleanEnv) } | Should -Not -Throw
        }
        It 'Assert- still throws, naming the var, on a missing var under strict mode' {
            $bad = @(script:CleanEnv | Where-Object { $_.name -ne 'AZURE_ANALYTICS_CONTAINER' })
            { Set-StrictMode -Version Latest; Assert-StagingContainerEnvIsolation -EnvVars $bad } | Should -Throw '*AZURE_ANALYTICS_CONTAINER*'
        }
    }

    Context 'Clean arm' {
        It 'returns no violations when every known var is present and staging-prefixed' {
            $violations = Test-StagingContainerEnvIsolation -EnvVars (script:CleanEnv)
            $violations.Count | Should -Be 0
        }

        It 'Assert- does not throw on the clean env' {
            { Assert-StagingContainerEnvIsolation -EnvVars (script:CleanEnv) } | Should -Not -Throw
        }
    }

    Context 'Mis-valued arm: one fault per known var (not staging-prefixed)' {
        # Pester -ForEach (not a plain `foreach` loop around `It`): a plain loop's `It` scriptblock
        # closes over the LOOP VARIABLE BY REFERENCE, which has already advanced to its final value
        # by the time Pester actually RUNS the deferred block -- every iteration would silently test
        # the same (last) var. -ForEach binds a fresh, per-iteration value instead.
        It "flags '<_>' when its value is a prod (non-staging-) name" -ForEach @(
            'AZURE_USER_CONTENT_CONTAINER', 'AZURE_COMMUNITY_CONTAINER', 'AZURE_BRIEF_EXPORTS_CONTAINER', 'AZURE_ANALYTICS_CONTAINER'
        ) {
            $var = $_
            $env = @(script:CleanEnv | ForEach-Object {
                if ($_.name -eq $var) { [PSCustomObject]@{ name = $_.name; value = ($_.name -replace '^AZURE_|_CONTAINER$', '').ToLower() } }
                else { $_ }
            })
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Name | Should -Contain $var
            ($violations | Where-Object { $_.Name -eq $var }).Reason | Should -Be 'not-staging-prefixed'
        }

        It "Assert- throws naming '<_>' when its value is a prod name" -ForEach @(
            'AZURE_USER_CONTENT_CONTAINER', 'AZURE_COMMUNITY_CONTAINER', 'AZURE_BRIEF_EXPORTS_CONTAINER', 'AZURE_ANALYTICS_CONTAINER'
        ) {
            $var = $_
            $env = @(script:CleanEnv | ForEach-Object {
                if ($_.name -eq $var) { [PSCustomObject]@{ name = $_.name; value = 'user-content' } }
                else { $_ }
            })
            { Assert-StagingContainerEnvIsolation -EnvVars $env } | Should -Throw "*$var*"
        }
    }

    Context 'Missing arm: one fault per known var (TL condition 1 — dropped from the revision entirely)' {
        It "flags '<_>' as missing when it is absent from the env array" -ForEach @(
            'AZURE_USER_CONTENT_CONTAINER', 'AZURE_COMMUNITY_CONTAINER', 'AZURE_BRIEF_EXPORTS_CONTAINER', 'AZURE_ANALYTICS_CONTAINER'
        ) {
            $var = $_
            $env = @(script:CleanEnv | Where-Object { $_.name -ne $var })
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Name | Should -Contain $var
            ($violations | Where-Object { $_.Name -eq $var }).Reason | Should -Be 'missing'
        }
    }

    Context 'Vacuous-pass guard (TL condition 1 — zero pattern matches must fail, not pass clean)' {
        It 'fails when the env array has no AZURE_*_CONTAINER vars at all' {
            $env = @([PSCustomObject]@{ name = 'NODE_ENV'; value = 'production' })
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Reason | Should -Contain 'no-azure-container-vars-matched'
        }

        It 'fails when the env array is entirely empty' {
            $violations = Test-StagingContainerEnvIsolation -EnvVars @()
            $violations.Reason | Should -Contain 'no-azure-container-vars-matched'
            # Also every known var is reported missing — an empty array must not look "clean".
            $violations.Count | Should -BeGreaterThan 1
        }

        It 'Assert- throws on an entirely empty env array (never a silent pass)' {
            { Assert-StagingContainerEnvIsolation -EnvVars @() } | Should -Throw
        }
    }

    Context 'Pattern enumeration (not a fixed list) — the actual gap this ticket closes' {
        It 'flags a SYNTHETIC, never-before-seen container var that is not staging-prefixed' {
            $env = @(script:CleanEnv) + [PSCustomObject]@{ name = 'AZURE_FOO_CONTAINER'; value = 'foo' }
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Name | Should -Contain 'AZURE_FOO_CONTAINER'
            ($violations | Where-Object { $_.Name -eq 'AZURE_FOO_CONTAINER' }).Reason | Should -Be 'not-staging-prefixed'
        }

        It 'does NOT flag a correctly staging-prefixed synthetic var (clean pattern match, not a hardcoded allowlist)' {
            $env = @(script:CleanEnv) + [PSCustomObject]@{ name = 'AZURE_FOO_CONTAINER'; value = 'staging-foo' }
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Count | Should -Be 0
        }

        It 'ignores a var matching AZURE_* that is not a *_CONTAINER var' {
            $env = @(script:CleanEnv) + [PSCustomObject]@{ name = 'AZURE_STORAGE_ACCOUNT_URL'; value = 'https://prod.blob.core.windows.net' }
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            $violations.Count | Should -Be 0
        }
    }

    Context 'secretRef-backed entry (no value property) is a violation, not a silent skip' {
        It 'flags a known container var expressed via secretRef instead of a literal value' {
            $env = @(script:CleanEnv | Where-Object { $_.name -ne 'AZURE_USER_CONTENT_CONTAINER' }) +
                [PSCustomObject]@{ name = 'AZURE_USER_CONTENT_CONTAINER'; secretRef = 'some-secret' }
            $violations = Test-StagingContainerEnvIsolation -EnvVars $env
            ($violations | Where-Object { $_.Name -eq 'AZURE_USER_CONTENT_CONTAINER' }).Reason | Should -Be 'not-staging-prefixed'
        }
    }
}
