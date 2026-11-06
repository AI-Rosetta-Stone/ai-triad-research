# Tag: summary (t/4884)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4884 follow-up (Docker, p/911#1): Test-DepPythonPackages's -Fix install path must pin
    torch to the CPU build via -c scripts/pip-constraints.txt, same as the Dockerfile's two
    pip installs -- without it, the native/non-container dev path can still pull a CUDA
    torch wheel, defeating the whole point of the constraints file.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Test-DepPythonPackages (t/4884 pip-constraints fix)' -Tag 'summary' {

    BeforeEach {
        $script:RepoRoot = Join-Path $TestDrive "repo-$(New-Guid)"
        New-Item -ItemType Directory -Path (Join-Path $script:RepoRoot 'scripts') -Force | Out-Null
        Set-Content -Path (Join-Path $script:RepoRoot 'scripts/requirements.txt') -Value 'sentence-transformers==5.0.0'
    }

    It 'passes -c pip-constraints.txt when installing missing requirements (-Fix)' {
        InModuleScope AITriad -Parameters @{ RepoRoot = $script:RepoRoot } {
            param($RepoRoot)
            function script:fakepython3 { }
            Mock fakepython3 {
                if ($args[0] -eq '-c') {
                    # the `import sentence_transformers` probe -- simulate "not installed"
                    $global:LASTEXITCODE = 1
                    return $null
                }
                # the pip install call
                $script:CapturedArgs = @($args)
                $global:LASTEXITCODE = 0
                return $null
            }

            $Ctx = @{ Passed = 0; Warned = 0; Failed = 0; Fixed = 0; Outdated = 0; Results = [System.Collections.Generic.List[PSObject]]::new() }
            Test-DepPythonPackages -Ctx $Ctx -RepoRoot $RepoRoot -PythonCmd 'fakepython3' -IsTestMode $false -IsInstallMode $true -Fix $true

            $Ctx.Fixed | Should -Be 1
            $script:CapturedArgs | Should -Not -BeNullOrEmpty
            $Joined = $script:CapturedArgs -join ' '
            $Joined | Should -Match '-m\s+pip\s+install' -Because 'the install call must still happen'
            $Joined | Should -Match '-c\s+.*pip-constraints\.txt' `
                -Because 't/4884: without -c pip-constraints.txt the native dev path can pull a CUDA torch wheel'
        }
    }

    It 'the skip-mode hint names BOTH files (-r requirements.txt AND -c pip-constraints.txt)' {
        InModuleScope AITriad -Parameters @{ RepoRoot = $script:RepoRoot } {
            param($RepoRoot)
            function script:fakepython3 { }
            Mock fakepython3 {
                $global:LASTEXITCODE = 1
                return $null
            }
            Mock Write-DepSkip { $script:SkipMessage = $Message } -ParameterFilter { $null -ne $Message }

            $Ctx = @{ Passed = 0; Warned = 0; Failed = 0; Fixed = 0; Outdated = 0; Results = [System.Collections.Generic.List[PSObject]]::new() }
            # -Fix:$false -> the skip-message path, not the install path.
            Test-DepPythonPackages -Ctx $Ctx -RepoRoot $RepoRoot -PythonCmd 'fakepython3' -IsTestMode $false -IsInstallMode $true -Fix $false

            $script:SkipMessage | Should -Match '-c\s+scripts/pip-constraints\.txt' `
                -Because 'the suggested manual command must include the constraints flag too, or a human runs the same unpinned install'
        }
    }
}
