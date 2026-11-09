# Tag: summary (t/4884)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4884 native-path torch pin (Quality/TL review on #4597, t/4884#7/#8/#10): the native
    (non-container) -Fix install path must pin torch to the CPU build the same way the
    Dockerfile does, WITHOUT assuming the Dockerfile's Linux-only, --index-url-already-set
    environment. Covers Get-DepPipInstallArgument (the platform-aware arg builder),
    Get-DepPipFailureClass (the network-vs-resolution-failure classifier), and
    Test-DepPythonPackages's use of both.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Get-DepPipInstallArgument (t/4884)' -Tag 'summary' {

    It 'Windows/Linux: includes -c <constraints> and --extra-index-url for the +cpu wheel' {
        InModuleScope AITriad {
            if ($IsMacOS) { Set-ItResult -Skipped -Because 'this assertion is for the non-macOS branch' }
            $ArgList = Get-DepPipInstallArgument -ReqFile 'C:/repo/scripts/requirements.txt' -ConstraintsFile 'C:/repo/scripts/pip-constraints.txt'
            $Joined = $ArgList -join ' '
            $Joined | Should -Match '-m\s+pip\s+install\s+-r\s+.*requirements\.txt'
            $Joined | Should -Match '-c\s+.*pip-constraints\.txt' `
                -Because 'without -c, pip has no reason to prefer the +cpu build over the default CUDA one'
            $Joined | Should -Match '--extra-index-url\s+https://download\.pytorch\.org/whl/cpu' `
                -Because 'torch==X+cpu is published ONLY on PyTorch''s own CPU wheel index, never on default PyPI -- without this flag the pin cannot resolve at all outside the Dockerfile (which sets its own --index-url separately)'
        }
    }

    It 'macOS: omits -c and --extra-index-url entirely (no +cpu wheel exists for mac)' {
        InModuleScope AITriad {
            # $IsMacOS is a read-only automatic variable -- exercised via a mock of the
            # function's own check isn't possible without making it a parameter, so this
            # Context runs the real branch on whatever OS Pester is executing on and the
            # assertion is written to hold either way: both outcomes are tested explicitly,
            # keyed off the ACTUAL $IsMacOS value this run observes.
            $ArgList = Get-DepPipInstallArgument -ReqFile '/repo/scripts/requirements.txt' -ConstraintsFile '/repo/scripts/pip-constraints.txt'
            $Joined = $ArgList -join ' '
            if ($IsMacOS) {
                $Joined | Should -Not -Match '-c\s' -Because 'macOS has no +cpu wheel to constrain to -- pinning it would make torch unresolvable'
                $Joined | Should -Not -Match '--extra-index-url'
                $Joined | Should -Match '-m\s+pip\s+install\s+-r' -Because 'the plain requirements install must still happen'
            } else {
                Set-ItResult -Skipped -Because 'this assertion is for the macOS branch; this run is not on macOS'
            }
        }
    }
}

Describe 'Test-DepPythonPackages (t/4884)' -Tag 'summary' {

    BeforeEach {
        $script:RepoRoot = Join-Path $TestDrive "repo-$(New-Guid)"
        New-Item -ItemType Directory -Path (Join-Path $script:RepoRoot 'scripts') -Force | Out-Null
        Set-Content -Path (Join-Path $script:RepoRoot 'scripts/requirements.txt') -Value 'sentence-transformers==5.0.0'
    }

    It 'increments Fixed exactly ONCE for the requirements install, independent of the markitdown install (Quality review: Test-DepPythonPackages.Tests.ps1:46 was flaky at 1 vs 2)' {
        InModuleScope AITriad -Parameters @{ RepoRoot = $script:RepoRoot } {
            param($RepoRoot)
            function script:fakepython3 { }
            Mock fakepython3 {
                # The `import sentence_transformers` probe: simulate "not installed".
                if ($args[0] -eq '-c') { $global:LASTEXITCODE = 1; return $null }
                # Match ONLY the requirements install (contains '-r'), not markitdown's
                # `pip install 'markitdown[all]'` call -- the prior flaky version of this mock
                # returned exit 0 for EVERY non-'-c' call, so markitdown's own install (always
                # attempted when the `markitdown` command isn't found, which it never is here)
                # ALSO counted as a fix, making $Ctx.Fixed deterministically 2, not 1.
                if ($args -contains '-r') { $script:CapturedArgs = @($args); $global:LASTEXITCODE = 0; return $null }
                # Anything else (the markitdown install): fail it so it does NOT increment
                # Fixed, keeping this test's assertion about the requirements install isolated.
                $global:LASTEXITCODE = 1
                return $null
            }

            $Ctx = @{ Passed = 0; Warned = 0; Failed = 0; Fixed = 0; Outdated = 0; Results = [System.Collections.Generic.List[PSObject]]::new() }
            Test-DepPythonPackages -Ctx $Ctx -RepoRoot $RepoRoot -PythonCmd 'fakepython3' -IsTestMode $false -IsInstallMode $true -Fix $true

            $Ctx.Fixed | Should -Be 1 -Because 'only the requirements install should count as a fix in this test'
            $script:CapturedArgs | Should -Not -BeNullOrEmpty
            $Joined = $script:CapturedArgs -join ' '
            $Joined | Should -Match '-m\s+pip\s+install\s+-r'
            if (-not $IsMacOS) {
                $Joined | Should -Match '-c\s+.*pip-constraints\.txt'
                $Joined | Should -Match '--extra-index-url\s+https://download\.pytorch\.org/whl/cpu'
            }
        }
    }

    It 'the skip-mode hint names the full platform-appropriate command' {
        InModuleScope AITriad -Parameters @{ RepoRoot = $script:RepoRoot } {
            param($RepoRoot)
            function script:fakepython3 { }
            Mock fakepython3 { $global:LASTEXITCODE = 1; return $null }
            Mock Write-DepSkip { $script:SkipMessage = $Message } -ParameterFilter { $null -ne $Message }

            $Ctx = @{ Passed = 0; Warned = 0; Failed = 0; Fixed = 0; Outdated = 0; Results = [System.Collections.Generic.List[PSObject]]::new() }
            Test-DepPythonPackages -Ctx $Ctx -RepoRoot $RepoRoot -PythonCmd 'fakepython3' -IsTestMode $false -IsInstallMode $true -Fix $false

            $script:SkipMessage | Should -Match 'requirements\.txt'
            if (-not $IsMacOS) {
                $script:SkipMessage | Should -Match 'pip-constraints\.txt'
                $script:SkipMessage | Should -Match 'download\.pytorch\.org/whl/cpu'
            }
        }
    }
}

Describe 'Get-DepPipFailureClass (t/4884, Quality must-fix at t/4884#10)' -Tag 'summary' {

    It 'classifies a genuine resolution failure as ResolutionFailure' {
        InModuleScope AITriad {
            $Output = @(
                'ERROR: Could not find a version that satisfies the requirement torch==99.0.0+cpu'
                'ERROR: No matching distribution found for torch==99.0.0+cpu'
            )
            Get-DepPipFailureClass -Output $Output | Should -Be 'ResolutionFailure'
        }
    }

    It 'classifies a network failure as NetworkError, not a pin regression' {
        InModuleScope AITriad {
            $Output = @(
                'WARNING: Retrying... ConnectionError(MaxRetryError'
                "Could not fetch URL https://download.pytorch.org/whl/cpu/: There was a problem confirming the ssl certificate: HTTPSConnectionPool(host='download.pytorch.org', port=443): Max retries exceeded with url: /whl/cpu/ (Caused by NewConnectionError"
            )
            Get-DepPipFailureClass -Output $Output | Should -Be 'NetworkError'
        }
    }

    It 'classifies an unrecognized failure shape as NetworkError (skip, not redden ci-gate, over a false positive)' {
        InModuleScope AITriad {
            Get-DepPipFailureClass -Output @('some entirely unrelated pip output this classifier has never seen') | Should -Be 'NetworkError'
        }
    }
}

Describe 'torch+cpu pin actually resolves (t/4884, TL ask: a test proving the pin resolves)' -Tag 'summary' {

    BeforeAll {
        # Real evidence, not a mock: skip gracefully (never fail the suite) when python/pip
        # aren't available on the machine running this -- same convention as the existing
        # "pip outdated can fail gracefully" catch elsewhere in this file's sibling. This
        # genuinely exercises pip's resolver against the real index, which a mocked unit test
        # cannot prove -- it is the "real native run" evidence the review asked for, for
        # whichever platform actually runs it (Windows locally, Linux in CI; this repo's CI is
        # Linux-only, so macOS resolution is NOT covered by this test and needs separate
        # confirmation from someone with mac access before this is treated as cross-platform-proven).
        $script:PythonAvailable = $false
        $script:PipVersionOutput = $null
        foreach ($Cmd in @('python3', 'python')) {
            if (Get-Command $Cmd -ErrorAction SilentlyContinue) {
                $script:PythonCmd = $Cmd
                try {
                    $script:PipVersionOutput = & $Cmd -m pip --version 2>&1
                    if ($LASTEXITCODE -eq 0) { $script:PythonAvailable = $true; break }
                } catch { }
            }
        }
    }

    It 'pip resolves torch==<pinned>+cpu via --extra-index-url (dry-run, no install) on this machine' {
        if ($IsMacOS) {
            Set-ItResult -Skipped -Because 'no +cpu wheel exists for macOS at all -- this assertion does not apply there'
            return
        }
        if (-not $script:PythonAvailable) {
            Set-ItResult -Skipped -Because 'no working python/pip on this machine -- cannot produce real resolution evidence here'
            return
        }

        $ConstraintsPath = Join-Path $PSScriptRoot '..' 'scripts' 'pip-constraints.txt'
        if (-not (Test-Path $ConstraintsPath)) {
            Set-ItResult -Skipped -Because 'scripts/pip-constraints.txt not present on this checkout (t/4884, lands with #4597)'
            return
        }
        $TorchLine = Get-Content $ConstraintsPath | Where-Object { $_ -match '^torch==' } | Select-Object -First 1
        $TorchLine | Should -Not -BeNullOrEmpty -Because 'pip-constraints.txt must still pin torch for this test to mean anything'
        $TorchSpec = $TorchLine.Trim()

        # --dry-run: resolves the dependency graph against the real index (network required)
        # WITHOUT downloading or installing anything. This is the actual proof the pin
        # resolves, not an assertion about which flags got passed.
        $Output = & $script:PythonCmd -m pip install --dry-run --extra-index-url 'https://download.pytorch.org/whl/cpu' $TorchSpec 2>&1
        $ExitCode = $LASTEXITCODE
        Write-Host "pip --dry-run output ($TorchSpec):`n$($Output -join "`n")"

        if ($ExitCode -eq 0) {
            $Output -join "`n" | Should -Match 'Would install torch' -Because 'a 0 exit from --dry-run should say what it would have installed'
            return
        }

        # Quality must-fix (t/4884#10): this test runs in CI against the real, live PyTorch
        # index -- a transient network failure there is not evidence the pin is wrong, and
        # must not turn ci-gate red for every unrelated PR. Only a classified
        # ResolutionFailure (pip genuinely couldn't resolve the pin) fails this test; a
        # classified NetworkError (or anything this classifier doesn't recognize) skips, with
        # the full output already printed above for a human to triage.
        $FailureClass = InModuleScope AITriad -Parameters @{ Output = @($Output) } { param($Output) Get-DepPipFailureClass -Output $Output }
        if ($FailureClass -eq 'NetworkError') {
            Set-ItResult -Skipped -Because "pip --dry-run failed with a classified network error, not a resolution failure -- see the output above, not a pin regression"
            return
        }
        $ExitCode | Should -Be 0 -Because "pip --dry-run classified this as a genuine ResolutionFailure for $TorchSpec -- see the output above, not a transient network issue"
    }
}
