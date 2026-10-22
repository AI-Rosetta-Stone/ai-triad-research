BeforeAll {
    . "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" -DeploySourceValues @{} -ErrorAction SilentlyContinue 2>$null
    # The dot-source above only loads the param block's defaults for IntelliSense parity in CI
    # logs; the function under test is re-invoked per test via the real script file below, with
    # `az` shadowed by a Pester-scoped function (PowerShell resolves a function before an
    # external command of the same name in the same session).
}

Describe 'Test-SignInSecretDrift' {
    Context 'Matching secret (SO C1 — checks prod AND staging by default)' {
        It 'reports match for both apps and exits 0 when the live value equals the deploy-source value' {
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
            $output | Should -Match 'taxonomy-editor/aad-client-secret: match'
            $output | Should -Match 'taxonomy-editor-staging/aad-client-secret: match'
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
                -ContainerAppNames @('taxonomy-editor') `
                -DeploySourceValues @{ 'aad-client-secret' = 'deploy-value-new-10-15' } *>&1 | Out-String
            $LASTEXITCODE | Should -Be 0
            $output | Should -Match 'taxonomy-editor/aad-client-secret: MISMATCH'
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

    Context 'Whitespace-only mismatch (SO C2 — e/319#4 gh secret set CRLF risk)' {
        It 'reports match-after-trim, never prints the deploy value, and still exits 0' {
            function az {
                if ($args -contains 'secret' -and $args -contains 'show') {
                    $global:LASTEXITCODE = 0
                    return 'same-secret-value'
                }
            }
            $global:LASTEXITCODE = 0
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -ContainerAppNames @('taxonomy-editor') `
                -DeploySourceValues @{ 'aad-client-secret' = "same-secret-value`r`n" } *>&1 | Out-String
            $LASTEXITCODE | Should -Be 0
            $output | Should -Match 'taxonomy-editor/aad-client-secret: match-after-trim'
            # Same masking caveat as the mismatch test above: `::add-mask::` necessarily carries
            # the live value once, which GitHub's platform-level redaction (not this script, and
            # not this local Pester run) hides. What this script fully controls is the
            # deploy-source value, which it never emits at all.
            $output | Should -Match '::add-mask::same-secret-value'
            $output | Should -Not -Match 'MISMATCH — this deploy would change'
        }
    }

    Context 'Missing deploy-source value' {
        It 'skips a secret with no configured deploy-source value, without calling az' {
            function az { throw 'az should not be called when there is no deploy-source value to compare against' }
            $output = & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                -DeploySourceValues @{ 'google-client-secret' = '' } *>&1 | Out-String
            $output | Should -Match 'skipped'
            # t/4418: the skip must be a visible warning annotation, not a plain line. GitHub only
            # renders `::warning::` as an annotation when it STARTS the line, so anchor it (multiline)
            # and keep the match on that one line — an unanchored match would pass a mid-line prefix.
            $output | Should -Match '(?m)^::warning::[^\r\n]*google-client-secret: skipped'
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

    Context 'GITHUB_STEP_SUMMARY (SO C3)' {
        It 'appends non-match results to the step summary file, without a value or hash' {
            function az {
                if ($args -contains 'secret' -and $args -contains 'show') {
                    $global:LASTEXITCODE = 0
                    return 'live-value-old-WG'
                }
            }
            $summaryFile = Join-Path ([System.IO.Path]::GetTempPath()) "t4288-summary-$([guid]::NewGuid()).md"
            try {
                $env:GITHUB_STEP_SUMMARY = $summaryFile
                $global:LASTEXITCODE = 0
                & "$PSScriptRoot/../operations/devops/Test-SignInSecretDrift.ps1" `
                    -ContainerAppNames @('taxonomy-editor') `
                    -DeploySourceValues @{ 'aad-client-secret' = 'deploy-value-new-10-15' } *>&1 | Out-Null
                Test-Path $summaryFile | Should -BeTrue
                $summaryContent = Get-Content $summaryFile -Raw
                $summaryContent | Should -Match 'taxonomy-editor/aad-client-secret: MISMATCH'
                $summaryContent | Should -Not -Match 'live-value-old-WG'
                $summaryContent | Should -Not -Match 'deploy-value-new-10-15'
            } finally {
                Remove-Item Env:\GITHUB_STEP_SUMMARY -ErrorAction SilentlyContinue
                Remove-Item $summaryFile -ErrorAction SilentlyContinue
            }
        }
    }
}
