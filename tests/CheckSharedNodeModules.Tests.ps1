# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms gate for operations/devops/check-shared-node-modules.sh (t/4817).
.DESCRIPTION
    Detects a shared checkout's node_modules link resolving into a worktree, or dangling
    (the t/4815 corruption shape). Exercises the script's --check-link test-only entry point
    against scratch fixtures -- mirrors tests/PrePushChecks.Tests.ps1's t/4816 pattern.
#>

Describe 'check-shared-node-modules.sh --check-link (t/4817)' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Checker = Join-Path $PSScriptRoot '../operations/devops/check-shared-node-modules.sh'
        $script:Root = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
        $script:Scratch = Join-Path $script:Root 'scratch_t4817_nm_test'
        $script:FakeWorktree = Join-Path $script:Root '.worktrees/scratch_t4817_fake_wt'
        function Test-Link([string]$RelPath) {
            Push-Location $script:Root
            try { & $script:Sh $script:Checker --check-link $RelPath 2>&1 | Out-Null; return $LASTEXITCODE }
            finally { Pop-Location }
        }
        function Remove-ScratchPaths {
            try { Remove-Item -Recurse -Force $script:Scratch -ErrorAction Stop } catch {}
            try { Remove-Item -Recurse -Force $script:FakeWorktree -ErrorAction Stop } catch {}
        }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
        Remove-ScratchPaths
    }

    AfterAll {
        Remove-ScratchPaths
    }

    It 'passes (exit 0) when node_modules is absent' {
        Test-Link 'scratch_t4817_nm_test/node_modules' | Should -Be 0
    }

    It 'passes (exit 0) when node_modules is a real directory' {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:Scratch 'node_modules') | Out-Null
        Test-Link 'scratch_t4817_nm_test/node_modules' | Should -Be 0
    }

    It 'refuses (exit 1) when node_modules is a symlink/junction resolving into .worktrees/ (t/4815 shape)' {
        New-Item -ItemType Directory -Force -Path $script:Scratch | Out-Null
        New-Item -ItemType Directory -Force -Path $script:FakeWorktree | Out-Null
        $linkPath = Join-Path $script:Scratch 'node_modules'
        if ($IsWindows) {
            cmd /c "mklink /J `"$linkPath`" `"$script:FakeWorktree`"" | Out-Null
        } else {
            New-Item -ItemType SymbolicLink -Path $linkPath -Target $script:FakeWorktree | Out-Null
        }
        Test-Link 'scratch_t4817_nm_test/node_modules' | Should -Be 1
    }

    It 'refuses (exit 1) when node_modules is a dangling symlink/junction' {
        New-Item -ItemType Directory -Force -Path $script:Scratch | Out-Null
        New-Item -ItemType Directory -Force -Path $script:FakeWorktree | Out-Null
        $linkPath = Join-Path $script:Scratch 'node_modules'
        if ($IsWindows) {
            cmd /c "mklink /J `"$linkPath`" `"$script:FakeWorktree`"" | Out-Null
        } else {
            New-Item -ItemType SymbolicLink -Path $linkPath -Target $script:FakeWorktree | Out-Null
        }
        Remove-Item -Recurse -Force $script:FakeWorktree
        Test-Link 'scratch_t4817_nm_test/node_modules' | Should -Be 1
    }
}

Describe 'check-shared-node-modules.sh full scan' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Checker = Join-Path $PSScriptRoot '../operations/devops/check-shared-node-modules.sh'
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
    }

    It 'the real repo scan exits 0 when run against a real clean fixture root' {
        # Informational: scans a throwaway, genuinely clean fixture root (no node_modules at
        # all), proving the "nothing found" happy path end-to-end through the full-scan code
        # path (not just --check-link). The real repo's own node_modules state is not
        # asserted here -- that depends on whether pnpm install has run locally.
        $fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "t4817-clean-root-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
        try {
            $null = & $script:Sh $script:Checker $fixtureRoot 2>&1
            $LASTEXITCODE | Should -Be 0
        } finally {
            Remove-Item -Recurse -Force $fixtureRoot -ErrorAction SilentlyContinue
        }
    }
}
