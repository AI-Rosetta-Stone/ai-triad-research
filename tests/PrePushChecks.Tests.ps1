# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Unit arms for operations/devops/pre-push-checks.sh's planning (which checks a push runs).
.DESCRIPTION
    Exercises the script's --plan mode, which maps changed repo paths to checks without running
    them. Execution itself (eslint/tsc/vitest) is the same commands CI runs.
#>

Describe 'pre-push-checks.sh --plan' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Checks = Join-Path $PSScriptRoot '../operations/devops/pre-push-checks.sh'
        $script:Root = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
        function Get-Plan([string[]]$Path) { @(& $script:Sh $script:Checks --plan @Path | Where-Object { $_ }) }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
    }

    It 'a taxonomy-editor src .tsx change runs eslint, both tsc projects and vitest related' {
        $plan = Get-Plan @('taxonomy-editor/src/renderer/components/Foo.tsx')
        $plan | Should -Contain 'taxonomy-editor|eslint| src/renderer/components/Foo.tsx'
        $plan | Should -Contain 'taxonomy-editor|tsc|tsconfig.json'
        $plan | Should -Contain 'taxonomy-editor|tsc|tsconfig.main.json'
        $plan | Should -Contain "taxonomy-editor|vitest-related| $($script:Root)/taxonomy-editor/src/renderer/components/Foo.tsx"
    }

    It 'passes vitest related an ABSOLUTE path (relative paths match no tests under root src/renderer)' {
        $related = @(Get-Plan @('taxonomy-editor/src/main/x.ts') | Where-Object { $_ -like '*vitest-related*' })
        $related.Count | Should -Be 1
        ($related[0] -split '\|')[2].Trim() | Should -Match '^(/|[A-Za-z]:)'
    }

    It 'a lib .ts change runs lib eslint and type checks, and its tests via taxonomy-editor vitest' {
        $plan = Get-Plan @('lib/debate/engine.ts')
        $plan | Should -Contain 'lib|eslint| debate/engine.ts'
        $plan | Should -Contain 'lib|tsc|debate/tsconfig.json'
        $plan | Should -Contain 'lib|script|typecheck:brief-nodenext'
        @($plan | Where-Object { $_ -like 'taxonomy-editor|vitest-related|*lib/debate/engine.ts' }).Count | Should -Be 1
    }

    It 'a taxonomy-editor .ts file outside src only type-checks' {
        $plan = Get-Plan @('taxonomy-editor/vite.config.ts')
        $plan | Should -Be @('taxonomy-editor|tsc|tsconfig.json', 'taxonomy-editor|tsc|tsconfig.main.json')
    }

    It 'a src .css or .js change lints only what eslint covers and skips type checks' {
        $plan = Get-Plan @('taxonomy-editor/src/renderer/Foo.css', 'taxonomy-editor/src/renderer/legacy.js')
        $plan | Should -Be @('taxonomy-editor|eslint| src/renderer/legacy.js')
    }

    It 'docs, PowerShell and workflow changes plan no TypeScript checks' {
        Get-Plan @('docs/x.md', 'scripts/AITriad/Public/Get-Foo.ps1', '.github/workflows/ci.yml') | Should -BeNullOrEmpty
    }

    It 'groups several changed files into one invocation per check' {
        $plan = Get-Plan @('taxonomy-editor/src/a.ts', 'taxonomy-editor/src/b.tsx')
        @($plan | Where-Object { $_ -like 'taxonomy-editor|eslint|*' }) | Should -Be @('taxonomy-editor|eslint| src/a.ts src/b.tsx')
        @($plan | Where-Object { $_ -like '*|tsc|tsconfig.json' }).Count | Should -Be 1
    }
}

Describe 'pre-push-checks.sh --check-link (t/4816)' -Tag 'devops' {
    <#
    .DESCRIPTION
        check_node_modules_link refuses a node_modules that resolves (symlink/junction) outside
        the repo root -- the t/4815 shape, where a worktree's node_modules linked to the shared
        checkout's and a pnpm invocation there rewrote the shared links.
    #>

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Checks = Join-Path $PSScriptRoot '../operations/devops/pre-push-checks.sh'
        $script:Root = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
        $script:Scratch = Join-Path $script:Root 'scratch_t4816_nm_test'
        # $env:TEMP is Windows-only and empty on Linux CI (the test-powershell matrix runs
        # there too), which threw ParameterBindingValidationException out of this BeforeAll
        # and, as a cascade, left the next block's cleanup call looking "not recognized"
        # (t/4816 CI failure). [System.IO.Path]::GetTempPath() works on both.
        $script:Outside = Join-Path ([System.IO.Path]::GetTempPath()) 't4816_outside_nm'
        function Test-Link([string]$RelPath) {
            Push-Location $script:Root
            try { & $script:Sh $script:Checks --check-link $RelPath 2>&1 | Out-Null; return $LASTEXITCODE }
            finally { Pop-Location }
        }
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
        # Inlined, not a shared helper function: a function declared in BeforeAll and called
        # from a sibling BeforeEach/AfterAll (rather than from an It block) was intermittently
        # "not recognized" under Pester v6's block-scoping (t/4816 CI failure) -- It blocks in
        # this same file call BeforeAll-defined functions (Test-Link, Get-Plan) without issue,
        # so the failure mode is specific to BeforeEach/AfterAll, not functions in general.
        # A junction whose target was already removed can make Remove-Item throw a
        # PSArgumentException that -ErrorAction SilentlyContinue does not suppress; this
        # cleanup is best-effort, so swallow it rather than fail the test run over it.
        try { Remove-Item -Recurse -Force $script:Scratch -ErrorAction Stop } catch {}
        try { Remove-Item -Recurse -Force $script:Outside -ErrorAction Stop } catch {}
    }

    AfterAll {
        try { Remove-Item -Recurse -Force $script:Scratch -ErrorAction Stop } catch {}
        try { Remove-Item -Recurse -Force $script:Outside -ErrorAction Stop } catch {}
    }

    It 'passes (exit 0) when node_modules is absent' {
        Test-Link 'scratch_t4816_nm_test/node_modules' | Should -Be 0
    }

    It 'passes (exit 0) when node_modules is a real directory inside the root' {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:Scratch 'node_modules') | Out-Null
        Test-Link 'scratch_t4816_nm_test/node_modules' | Should -Be 0
    }

    It 'refuses (exit 1) when node_modules is a symlink/junction resolving outside the root' {
        New-Item -ItemType Directory -Force -Path $script:Scratch | Out-Null
        New-Item -ItemType Directory -Force -Path $script:Outside | Out-Null
        $linkPath = Join-Path $script:Scratch 'node_modules'
        if ($IsWindows) {
            # New-Item -ItemType SymbolicLink needs admin/Developer Mode on Windows and fails
            # silently through Out-Null without it (observed on this machine and plausibly on
            # CI runners); a junction needs no elevation and is the real-world t/4815 shape.
            cmd /c "mklink /J `"$linkPath`" `"$script:Outside`"" | Out-Null
        } else {
            New-Item -ItemType SymbolicLink -Path $linkPath -Target $script:Outside | Out-Null
        }
        Test-Link 'scratch_t4816_nm_test/node_modules' | Should -Be 1
    }
}

Describe '.githooks/pre-push ref handling' -Tag 'devops' {

    BeforeAll {
        $script:Sh = (Get-Command sh -ErrorAction SilentlyContinue).Source
        if (-not $script:Sh -and (Test-Path 'C:\Program Files\Git\bin\sh.exe')) { $script:Sh = 'C:\Program Files\Git\bin\sh.exe' }
        $script:Hook = Join-Path $PSScriptRoot '../.githooks/pre-push'
        $script:Zero = '0' * 40
        $script:NotHead = (& git -C $PSScriptRoot rev-parse 'HEAD~1').Trim()
    }

    BeforeEach {
        if (-not $script:Sh) { Set-ItResult -Skipped -Because 'no POSIX sh available' }
    }

    It 'skips, with a WARN, a pushed ref that is not the checked-out commit (checks read the working tree)' {
        $out = "refs/heads/x $($script:NotHead) refs/heads/x $($script:Zero)" | & $script:Sh $script:Hook 2>&1
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Match 'not the checked-out commit'
    }

    It 'ignores a branch deletion' {
        $out = "(delete) $($script:Zero) refs/heads/y $($script:NotHead)" | & $script:Sh $script:Hook 2>&1
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Not -Match 'running'
    }
}
