# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms + fail-safe matrix for the t/3638 workflow-mode switch: the shared parse
    helper (.githooks/read-workflow-mode.sh) and the two githooks reading it.
.DESCRIPTION
    The load-bearing requirement (TL, t/3632#3 / t/3638): anything other than an exact,
    well-formed `direct` on line 1 — missing, empty, garbage, `Direct`, extra tokens,
    a broken/absent helper — MUST resolve to `worktree` (strict). A deleted or corrupt
    file must TIGHTEN, never loosen. These tests assert every failure path stays strict,
    and that the detached-HEAD-in-worktree refusal (t/2009) fires in BOTH modes.

    Uses `sh` (Git-for-Windows bundled) to run the POSIX hooks; skips if unavailable.
#>

Describe 'workflow-mode switch — fail-safe parse + hooks (t/3638)' -Tag 'devops' {

    BeforeAll {
        $script:HooksDir = (Resolve-Path "$PSScriptRoot/../.githooks").Path
        $script:Helper   = "$script:HooksDir/read-workflow-mode.sh"
        # Prefer Git for Windows' sh. $env:ProgramFiles can be unset in a scrubbed session, so fall back to
        # the standard install path. A PATH 'sh' is used only if nothing else exists.
        $script:Sh = @(
            $env:ProgramFiles ? "$env:ProgramFiles/Git/usr/bin/sh.exe" : $null
            'C:/Program Files/Git/usr/bin/sh.exe'
            (Get-Command sh -ErrorAction SilentlyContinue)?.Source
        ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
        # The helper calls sed and git; a PowerShell-started sh.exe has no usr/bin on PATH, so sed is
        # missing ('sed: command not found' -> worktree). Put the sh directory first on PATH.
        $script:OriginalPath = $env:PATH
        if ($script:Sh) { $env:PATH = "$(Split-Path $script:Sh);$env:PATH" }

        # Build a throwaway git repo with the real .githooks installed + a given mode-file body.
        # $ModeBody $null => omit the file entirely (the "missing" case).
        function script:New-ModeRepo([string]$ModeBody, [switch]$OmitFile) {
            $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("wfmode-" + [guid]::NewGuid().ToString('N').Substring(0,8))
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Push-Location $dir
            try {
                git init -q 2>$null; git symbolic-ref HEAD refs/heads/main 2>$null
                git config user.email t@t 2>$null; git config user.name t 2>$null
                git config commit.gpgsign false 2>$null
                Copy-Item -Recurse $script:HooksDir (Join-Path $dir '.githooks')
                # Remove the AGENTS.md tracking audit from the temp copy — it fires on every
                # commit and would block regardless of mode (it needs the real overlay), which
                # would confound the mode tests. We're testing the workflow-mode logic here.
                Remove-Item -LiteralPath (Join-Path $dir '.githooks/agent-file-owner.sh') -Force -EA SilentlyContinue
                # ABSOLUTE hooksPath so linked worktrees (which don't have the untracked
                # .githooks in their checkout) use the same hooks — else worktree commits run
                # no hook and the detached-HEAD test gets a false pass.
                git config core.hooksPath (Join-Path $dir '.githooks') 2>$null
                New-Item -ItemType Directory -Path (Join-Path $dir '.orca') -Force | Out-Null
                if (-not $OmitFile) {
                    # write bytes exactly (no PS-added trailing newline surprises)
                    [System.IO.File]::WriteAllText((Join-Path $dir '.orca/workflow-mode'), $ModeBody)
                }
                'seed' | Out-File -FilePath (Join-Path $dir 'seed.txt') -Encoding ascii
                git add seed.txt 2>$null; git commit -qm seed --no-verify 2>$null
            } finally { Pop-Location }
            return $dir
        }

        # Resolve mode via the real helper, run from $repo.
        function script:Get-Mode([string]$repo) {
            Push-Location $repo
            try { return (& $script:Sh "$repo/.githooks/read-workflow-mode.sh" 2>$null) } finally { Pop-Location }
        }

        # Try a real commit on main; return $true if the pre-commit hook PERMITTED it.
        function script:Test-CommitPermitted([string]$repo) {
            Push-Location $repo
            try {
                "change $(Get-Random)" | Out-File -FilePath (Join-Path $repo 'seed.txt') -Encoding ascii
                git add seed.txt 2>$null
                git commit -qm probe 2>$null
                return ($LASTEXITCODE -eq 0)
            } finally { Pop-Location }
        }

        # Detached-HEAD commit inside a linked worktree; $true if PERMITTED (must be refused
        # in BOTH modes — t/2009, not governed by the switch).
        function script:Test-DetachedWorktreeCommitPermitted([string]$repo) {
            Push-Location $repo
            try {
                $wt = Join-Path $repo '.worktrees/wt1'
                git worktree add --detach $wt HEAD 2>$null | Out-Null
                Push-Location $wt
                try {
                    "x $(Get-Random)" | Out-File -FilePath (Join-Path $wt 'seed.txt') -Encoding ascii
                    git add seed.txt 2>$null; git commit -qm detached 2>$null
                    return ($LASTEXITCODE -eq 0)
                } finally { Pop-Location }
            } finally { Pop-Location }
        }
    }

    Context 'the parse helper — the fail-safe core' {
        BeforeAll { if (-not $script:Sh) { Set-ItResult -Skipped -Because 'sh not available' } }

        It 'reads exactly "direct"' {
            $r = script:New-ModeRepo "direct`n# set-by: test"
            try { (script:Get-Mode $r) | Should -Be 'direct' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It '"worktree" -> worktree' {
            $r = script:New-ModeRepo "worktree`n"; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'MISSING file -> worktree (strict)' {
            $r = script:New-ModeRepo -OmitFile; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'EMPTY file -> worktree' {
            $r = script:New-ModeRepo ""; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'GARBAGE ("banana") -> worktree' {
            $r = script:New-ModeRepo "banana`n"; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It '"Direct" (wrong case) -> worktree' {
            $r = script:New-ModeRepo "Direct`n"; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It '"direct foo" (extra token, NOT first-token) -> worktree' {
            $r = script:New-ModeRepo "direct foo`n"; try { (script:Get-Mode $r) | Should -Be 'worktree' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It '"  direct  " (leading/trailing whitespace) -> direct (trimmed)' {
            $r = script:New-ModeRepo "   direct   `n"; try { (script:Get-Mode $r) | Should -Be 'direct' } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'helper DELETED -> caller must treat as worktree (helper prints nothing)' {
            $r = script:New-ModeRepo "direct`n"
            try {
                Remove-Item -LiteralPath (Join-Path $r '.githooks/read-workflow-mode.sh') -Force
                (script:Get-Mode $r) | Should -Not -Be 'direct'   # empty/nothing — the hook forces worktree
            } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
    }

    Context 'pre-commit — main-branch refusal honours the mode' {
        BeforeAll { if (-not $script:Sh) { Set-ItResult -Skipped -Because 'sh not available' } }

        It 'worktree mode REFUSES a commit on shared main' {
            $r = script:New-ModeRepo "worktree`n"; try { (script:Test-CommitPermitted $r) | Should -BeFalse } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'direct mode PERMITS a commit on shared main' {
            $r = script:New-ModeRepo "direct`n"; try { (script:Test-CommitPermitted $r) | Should -BeTrue } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'MISSING file REFUSES (fail-safe)' {
            $r = script:New-ModeRepo -OmitFile; try { (script:Test-CommitPermitted $r) | Should -BeFalse } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'GARBAGE REFUSES (fail-safe)' {
            $r = script:New-ModeRepo "banana`n"; try { (script:Test-CommitPermitted $r) | Should -BeFalse } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
    }

    Context 'detached-HEAD-in-worktree refusal fires in BOTH modes (t/2009 — not governed by the switch)' {
        BeforeAll { if (-not $script:Sh) { Set-ItResult -Skipped -Because 'sh not available' } }

        It 'REFUSED in worktree mode' {
            $r = script:New-ModeRepo "worktree`n"; try { (script:Test-DetachedWorktreeCommitPermitted $r) | Should -BeFalse } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
        It 'REFUSED in direct mode too (the switch does not govern this)' {
            $r = script:New-ModeRepo "direct`n"; try { (script:Test-DetachedWorktreeCommitPermitted $r) | Should -BeFalse } finally { Remove-Item -LiteralPath $r -Recurse -Force -EA SilentlyContinue }
        }
    }

    # Restore PATH: BeforeAll prepends the Git sh directory, which must not leak to later test files.
    AfterAll {
        if ($script:OriginalPath) { $env:PATH = $script:OriginalPath }
    }
}
