# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Both-arms tests for pre-push-checks.sh's blocking decisions (t/289).
.DESCRIPTION
    Each test builds a throwaway git repo holding copies of the script, its PowerShell parse
    helper and the hook, commits a change, and runs the real script on base..head. pnpm is a
    stub on PATH (exit 0), so these tests prove the precondition and verdict wiring, not
    eslint/tsc themselves. One fault per decision site in pre-push-checks.sh:
      - pnpm missing while TypeScript checks are due        -> BLOCK      (TS preconditions)
      - a TS package without node_modules                    -> BLOCK      (TS preconditions)
      - PowerShell file that fails to parse                  -> BLOCK      (parse step)
      - Python file that fails to compile                    -> BLOCK      (py_compile step)
      - pwsh missing                                         -> WARN, pass (parse step)
      - AITRIAD_PREPUSH=skip                                 -> WARN, pass (.githooks/pre-push)
#>

Describe 'pre-push-checks.sh blocking (t/289)' -Tag 'devops' {

    BeforeAll {
        # Tools resolve as real executables only (-CommandType Application). Other suites in the
        # same Pester run leave global function shims behind (e.g. `function global:python3` in
        # Find-SituationCandidates.Characterization.Tests.ps1); a plain Get-Command returned that
        # function, whose empty .Source crashed this BeforeAll in merge-group shard 3 (t/289).
        function Get-AppPath([string]$Name) {
            Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path
        }
        $script:Sh = Get-AppPath 'sh'
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        if (-not $script:Sh) { Write-Warning 'PrePushBlocking: no POSIX sh found; every test in this suite will be skipped.' }
        $script:Src = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
        $script:Python = $null
        foreach ($name in 'python3', 'python') {
            $p = Get-AppPath $name
            # The Windows Store "python" stub is an Application that cannot run code, so probe it.
            if ($p) { try { & $p -c 'import sys' 2>$null; if ($LASTEXITCODE -eq 0) { $script:Python = $p; break } } catch { } }
        }
        if (-not $script:Python) { Write-Warning 'PrePushBlocking: no runnable python found; the Python compile tests will be skipped.' }
        $script:Repos = [System.Collections.Generic.List[string]]::new()
        $script:Sep = [IO.Path]::PathSeparator

        # A stub pnpm that always succeeds, so a test isolates the precondition it is about.
        $script:StubDir = Join-Path ([IO.Path]::GetTempPath()) "t289-stub-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path $script:StubDir | Out-Null
        [IO.File]::WriteAllText((Join-Path $script:StubDir 'pnpm'), "#!/bin/sh`nexit 0`n")
        if (-not $IsWindows) { chmod +x (Join-Path $script:StubDir 'pnpm') }

        # PATH with every directory holding the named command removed. If that would also remove
        # git (both in one directory, as pwsh and git are in /usr/bin on Linux), the test can't
        # isolate the condition, so it is skipped rather than failing on "cannot find repo root".
        function Get-PathWithout([string]$Command) {
            $kept = @($env:PATH -split [regex]::Escape($script:Sep) | Where-Object {
                $_ -and -not (Get-ChildItem -LiteralPath $_ -Filter "$Command*" -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.BaseName -eq $Command })
            })
            $hasGit = $kept | Where-Object {
                Get-ChildItem -LiteralPath $_ -Filter 'git*' -File -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -eq 'git' }
            }
            if (-not $hasGit) { Set-ItResult -Skipped -Because "removing $Command from PATH would also remove git" }
            $kept -join $script:Sep
        }

        function New-ScratchRepo {
            $r = Join-Path ([IO.Path]::GetTempPath()) "t289-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
            New-Item -ItemType Directory -Path $r | Out-Null
            $script:Repos.Add($r)
            & git -C $r init -q -b main
            & git -C $r config core.autocrlf false
            foreach ($rel in 'operations/devops/pre-push-checks.sh', 'operations/devops/Test-PowerShellSyntax.ps1', '.githooks/pre-push') {
                $dest = Join-Path $r $rel
                New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
                Copy-Item (Join-Path $script:Src $rel) $dest
            }
            Set-Content -Path (Join-Path $r 'README.md') -Value 'scratch'
            & git -C $r add -A
            & git -C $r -c user.email=t@example.invalid -c user.name=t commit -q -m base
            $r
        }

        function Add-Commit([string]$Repo, [hashtable]$Files) {
            foreach ($k in $Files.Keys) {
                $p = Join-Path $Repo $k
                New-Item -ItemType Directory -Path (Split-Path $p) -Force | Out-Null
                [IO.File]::WriteAllText($p, $Files[$k])
                & git -C $Repo add -- $k
            }
            & git -C $Repo -c user.email=t@example.invalid -c user.name=t commit -q -m change
            (& git -C $Repo rev-parse HEAD).Trim()
        }

        function Invoke-Checks([string]$Repo, [string]$Path = "$($script:StubDir)$($script:Sep)$env:PATH") {
            $base = (& git -C $Repo rev-parse HEAD~1).Trim(); $head = (& git -C $Repo rev-parse HEAD).Trim()
            $oldPath = $env:PATH
            Push-Location $Repo
            try {
                $env:PATH = $Path
                $out = & $script:Sh (Join-Path $Repo 'operations/devops/pre-push-checks.sh') $base $head 2>&1
                $code = $LASTEXITCODE
            } finally { $env:PATH = $oldPath; Pop-Location }
            [pscustomobject]@{ Code = $code; Out = ($out -join "`n") }
        }

        $script:BadPs = "function f {`n    'x'`n}}`n"
        $script:GoodPs = "function f {`n    'x'`n}`n"
    }

    AfterAll {
        # Null-safe: if BeforeAll failed part-way, cleanup must not add a second, misleading error.
        foreach ($r in @($script:Repos)) { if ($r) { Remove-Item -LiteralPath $r -Recurse -Force -ErrorAction SilentlyContinue } }
        if ($script:StubDir) { Remove-Item -LiteralPath $script:StubDir -Recurse -Force -ErrorAction SilentlyContinue }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
    }

    Context 'TypeScript preconditions' {
        It 'BLOCKS a TS change when the package has no node_modules, naming the fix and the override' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'taxonomy-editor/src/a.ts' = "export const a = 1;`n" } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'BLOCKED taxonomy-editor has no node_modules'
            $res.Out | Should -Match 'pnpm install --frozen-lockfile'
            $res.Out | Should -Match 'AITRIAD_PREPUSH=skip git push'
        }

        It 'reports every package missing node_modules in one run' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'taxonomy-editor/src/a.ts' = "export const a = 1;`n"; 'lib/b.ts' = "export const b = 1;`n" } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'BLOCKED taxonomy-editor has no node_modules'
            $res.Out | Should -Match 'BLOCKED lib has no node_modules'
        }

        It 'passes the same change once node_modules exists' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'taxonomy-editor/src/a.ts' = "export const a = 1;`n" } | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $r 'taxonomy-editor/node_modules') | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 0
            $res.Out | Should -Not -Match 'BLOCKED'
        }

        It 'BLOCKS a TS change when pnpm is not on PATH' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'taxonomy-editor/src/a.ts' = "export const a = 1;`n" } | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $r 'taxonomy-editor/node_modules') | Out-Null
            $res = Invoke-Checks $r -Path (Get-PathWithout 'pnpm')
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'BLOCKED pnpm not found'
            $res.Out | Should -Match 'pnpm install --frozen-lockfile'
        }

        It 'does not require pnpm or node_modules for a push with no TypeScript' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/ok.ps1' = $script:GoodPs } | Out-Null
            $res = Invoke-Checks $r -Path (Get-PathWithout 'pnpm')
            $res.Code | Should -Be 0
            $res.Out | Should -Not -Match 'node_modules|pnpm not found'
        }
    }

    Context 'PowerShell parse' {
        It 'BLOCKS a .ps1 that fails to parse and prints file:line' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'scripts/bad\.ps1:3:\d+: Unexpected token'
            $res.Out | Should -Match 'FAIL  PowerShell parse'
        }

        It 'passes a .psm1 that parses' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/good.psm1' = $script:GoodPs } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 0
            $res.Out | Should -Match 'ok    PowerShell parse \(1 file'
        }

        It 'judges the PUSHED blob: an uncommitted fix in the working tree does not hide the error' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs } | Out-Null
            [IO.File]::WriteAllText((Join-Path $r 'scripts/bad.ps1'), $script:GoodPs)
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'scripts/bad\.ps1:3'
        }

        It 'still BLOCKS a parse error when uncommitted TypeScript makes TS failures warn-only' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs; 'taxonomy-editor/src/a.ts' = "export const a = 1;`n" } | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $r 'taxonomy-editor/node_modules') | Out-Null
            [IO.File]::WriteAllText((Join-Path $r 'taxonomy-editor/src/dirty.ts'), "export const d = 1;`n")
            $res = Invoke-Checks $r
            $res.Out | Should -Match 'uncommitted code'
            $res.Code | Should -Be 1
        }

        It 'the AITRIAD_PREPUSH_PWSH seam cannot fake a pass: the check still runs the real pwsh' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs } | Out-Null
            $env:AITRIAD_PREPUSH_PWSH = 'true'
            try { $res = Invoke-Checks $r } finally { Remove-Item Env:\AITRIAD_PREPUSH_PWSH -ErrorAction SilentlyContinue }
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'scripts/bad\.ps1:3'
        }

        It 'WARNS and passes when pwsh is not found' {
            # Via the script's AITRIAD_PREPUSH_PWSH seam, not by stripping PATH: on Linux runners
            # pwsh lives in /usr/bin beside git, so stripping it made the script lose git itself.
            $r = New-ScratchRepo
            Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs } | Out-Null
            $env:AITRIAD_PREPUSH_PWSH = 'pwsh-not-installed-t289'
            try { $res = Invoke-Checks $r } finally { Remove-Item Env:\AITRIAD_PREPUSH_PWSH -ErrorAction SilentlyContinue }
            $res.Code | Should -Be 0
            $res.Out | Should -Match 'WARN pwsh not found'
        }
    }

    Context 'Python compile' {
        BeforeEach {
            if (-not $script:Python) { Set-ItResult -Skipped -Because 'no python available' }
        }

        It 'BLOCKS a .py that fails to compile' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'tools/bad.py' = "def f(:`n    pass`n" } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'bad\.py'
            $res.Out | Should -Match 'FAIL  Python py_compile'
        }

        It 'a pushed top-level py_compile.py cannot shadow the stdlib module and fake a pass' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'py_compile.py' = "raise SystemExit(0)`n"; 'tools/bad.py' = "def f(:`n    pass`n" } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 1
            $res.Out | Should -Match 'FAIL  Python py_compile'
        }

        It 'passes a .py that compiles and leaves no __pycache__ in the tree' {
            $r = New-ScratchRepo
            Add-Commit $r @{ 'tools/good.py' = "def f():`n    return 1`n" } | Out-Null
            $res = Invoke-Checks $r
            $res.Code | Should -Be 0
            $res.Out | Should -Match 'ok    Python py_compile'
            Test-Path (Join-Path $r 'tools/__pycache__') | Should -BeFalse
        }
    }

    Context '.githooks/pre-push override' {
        It 'AITRIAD_PREPUSH=skip skips the checks with a WARN; without it the same push blocks' {
            $r = New-ScratchRepo
            $base = (& git -C $r rev-parse HEAD).Trim()
            $head = Add-Commit $r @{ 'scripts/bad.ps1' = $script:BadPs }
            & git -C $r update-ref refs/remotes/origin/main $base
            $stdin = "refs/heads/feat $head refs/heads/feat $('0' * 40)"
            $hook = Join-Path $r '.githooks/pre-push'
            $oldPath = $env:PATH
            Push-Location $r
            try {
                $env:PATH = "$($script:StubDir)$($script:Sep)$env:PATH"
                $env:AITRIAD_PREPUSH = 'skip'
                $skipped = ($stdin | & $script:Sh $hook 2>&1) -join "`n"; $skippedCode = $LASTEXITCODE
                Remove-Item Env:\AITRIAD_PREPUSH
                $blocked = ($stdin | & $script:Sh $hook 2>&1) -join "`n"; $blockedCode = $LASTEXITCODE
            } finally {
                Remove-Item Env:\AITRIAD_PREPUSH -ErrorAction SilentlyContinue
                $env:PATH = $oldPath; Pop-Location
            }
            $skippedCode | Should -Be 0
            $skipped | Should -Match 'skipped by AITRIAD_PREPUSH=skip'
            $blockedCode | Should -Be 1
            $blocked | Should -Match 'scripts/bad\.ps1:3'
        }
    }
}
