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
