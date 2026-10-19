BeforeAll {
    . "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" -DeploySourceValues @{} -ErrorAction SilentlyContinue 2>$null
    # The dot-source above only loads the param block's defaults for IntelliSense parity in CI
    # logs; the function under test is re-invoked per test via the real script file below, with
    # `az` shadowed by a Pester-scoped function (PowerShell resolves a function before an
    # external command of the same name in the same session).
}

Describe 'Test-SignInSecretDrift' {
    Context 'Matching secret' {
        It 'reports match and exits 0 when the live value equals the deploy-source value' {
            function az {
                if ($args -contains 'secret' -and $args -contains 'show') {
                    $global:LASTEXITCODE = 0
                    return 'same-value-123'
                }
            }
            $global:LASTEXITCODE = 0
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -DeploySourceValues @{ 'aad-client-secret' = 'same-value-123' } *>&1 | Out-String
            $LASTEXITCODE | Should -Be 0
            $output | Should -Match 'aad-client-secret: match'
            $output | Should -Not -Match 'MISMATCH'
        }
    }

    Context 'Mismatched secret (t/4288 — the actual incident shape)' {
        It 'warns MISMATCH, never prints either value, and still exits 0 (warn-only)' {
            function az {
                if ($args -contains 'secret' -and $args -contains 'show') {
                    $global:LASTEXITCODE = 0
                    return 'live-value-old-WG'
                }
            }
            $global:LASTEXITCODE = 0
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -DeploySourceValues @{ 'aad-client-secret' = 'deploy-value-new-10-15' } *>&1 | Out-String
            $LASTEXITCODE | Should -Be 0
            $output | Should -Match 'aad-client-secret: MISMATCH'
            # The live value IS registered for masking (`::add-mask::`) — that directive line
            # necessarily carries the plaintext once, which is exactly how GitHub Actions'
            # platform-level log redaction is told what to hide; it scans the full rendered
            # log for registered values (including that same line) and replaces them with
            # `***` in the UI. That redaction is a GHA-runner behavior this local Pester run
            # has no engine for, so asserting its absence here would test the platform, not
            # this script. What THIS script fully controls is never emitting the deploy-source
            # value at all — only its hash — so that one is checked for real absence.
            $output | Should -Match '::add-mask::live-value-old-WG'
            $output | Should -Not -Match 'deploy-value-new-10-15'
        }
    }

    Context 'Missing deploy-source value' {
        It 'skips a secret with no configured deploy-source value, without calling az' {
            function az { throw 'az should not be called when there is no deploy-source value to compare against' }
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -DeploySourceValues @{ 'google-client-secret' = '' } *>&1 | Out-String
            $output | Should -Match 'skipped'
        }
    }

    Context 'Live secret unreadable' {
        It 'warns and continues (never treats an unreadable live value as a match)' {
            function az {
                if ($args -contains 'secret' -and $args -contains 'show') {
                    $global:LASTEXITCODE = 1
                    return $null
                }
            }
            $global:LASTEXITCODE = 0
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -DeploySourceValues @{ 'github-client-secret' = 'some-value' } *>&1 | Out-String
            $output | Should -Match 'could not read the live value'
            $output | Should -Not -Match 'match$'
        }
    }
}
