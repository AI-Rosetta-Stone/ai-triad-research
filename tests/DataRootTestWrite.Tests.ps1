# Tag: unit (t/4454)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4454 Phase 1: a write to the protected (configured, real) data root from inside a Pester run WARNs with
# DATA-ROOT-TEST-WRITE (design t/4454#2, TL conditions t/4454#3). Every case uses a temp "real root" through
# a mocked Get-DataRoot -IgnoreEnvOverride; nothing here touches ../ai-triad-data.

#Requires -Module Pester

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    function script:Get-Warnings([scriptblock]$Block) {
        @(& $Block 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { "$_" })
    }
}

Describe 'Test-run write check (t/4454)' -Tag 'unit' {
    BeforeEach {
        $script:base = Join-Path ([IO.Path]::GetTempPath()) ("t4454-" + [guid]::NewGuid().ToString('N'))
        $script:real = Join-Path $script:base 'ai-triad-data'
        New-Item -ItemType Directory -Force (Join-Path $script:real 'taxonomy' 'Origin') | Out-Null
        $script:savedEnv = $env:AI_TRIAD_DATA_ROOT
        $env:AI_TRIAD_DATA_ROOT = $null
        # Saved and RESTORED, never left null: in CI this variable carries the job-summary log for the whole shard,
        # and these tests' own (temp-root) hits must not land in it (t/4454 positive-control finding).
        $script:savedLog = $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG
        $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG = $null
        $realRoot = $script:real
        Mock Get-DataRoot -ModuleName AITriad -ParameterFilter { $IgnoreEnvOverride } { $realRoot }.GetNewClosure()
    }
    AfterEach {
        $env:AI_TRIAD_DATA_ROOT = $script:savedEnv
        $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG = $script:savedLog
        Remove-Item -Recurse -Force $script:base -ErrorAction SilentlyContinue
    }

    It 'WARNs with the fixed token, the real target and the caller for a write under the protected root' {
        $target = Join-Path $real 'taxonomy' 'Origin' 'entities.json'
        $w = @(Get-Warnings { & (Get-Module AITriad) { param($p) Invoke-DataRootTestWriteCheck -ReportOnly -Path $p } $target })
        @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE target=*' }).Count | Should -Be 1
        $w[0] | Should -BeLike "*target=$([IO.Path]::GetFullPath($target))*"
        $w[0] | Should -BeLike '*caller=DataRootTestWrite.Tests.ps1:*'
    }

    It 'the funnel (Assert-DataWriteAllowed) REFUSES, before the -AllowDirty / -SurgicalWrite exemptions (Phase 2)' {
        $target = Join-Path $real 'taxonomy' 'Origin' 'entities.json'
        foreach ($sw in @(@{}, @{ AllowDirty = $true }, @{ SurgicalWrite = $true })) {
            { & (Get-Module AITriad) { param($p, $s) Assert-DataWriteAllowed -Path $p @s 3>$null } $target $sw } |
                Should -Throw -ExpectedMessage '*DATA-ROOT-TEST-WRITE target=*' -Because "switches: $($sw.Keys -join ',')"
        }
    }

    It 'a real funnel writer (Write-Utf8NoBom) is refused and the file never reaches disk (Phase 2)' {
        $target = Join-Path $real 'taxonomy' 'Origin' 'situations.json'
        { & (Get-Module AITriad) { param($p) Write-Utf8NoBom -Path $p -Value '{}' 3>$null } $target } | Should -Throw -ExpectedMessage '*Keep test runs from writing the real data repo*'
        Test-Path -LiteralPath $target | Should -BeFalse
        # The same writer to a temp root is untouched by the check.
        $tmp = Join-Path $base 'tmp-root'; New-Item -ItemType Directory -Force $tmp | Out-Null
        & (Get-Module AITriad) { param($p) Write-Utf8NoBom -Path $p -Value '{}' 3>$null } (Join-Path $tmp 'situations.json')
        Test-Path -LiteralPath (Join-Path $tmp 'situations.json') | Should -BeTrue
    }

    It 'is silent for a write outside the protected root, including a sibling that shares its prefix' {
        foreach ($p in @((Join-Path $base 'elsewhere' 'x.json'), (Join-Path $base 'ai-triad-data2' 'x.json'))) {
            $w = Get-Warnings { & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t } $p }
            @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 0 -Because $p
        }
    }

    It 'a temp AI_TRIAD_DATA_ROOT writes freely; pointing it AT the real root is still caught (condition 3)' {
        $tmp = Join-Path $base 'tmp-root'; New-Item -ItemType Directory -Force $tmp | Out-Null
        $env:AI_TRIAD_DATA_ROOT = $tmp
        $w = Get-Warnings { & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t } (Join-Path $tmp 'entities.json') }
        @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 0
        $env:AI_TRIAD_DATA_ROOT = $real
        $w = Get-Warnings { & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t } (Join-Path $real 'entities.json') }
        @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 1
    }

    It 'compares real paths: a write through a link to the root, and through the resolved path, both fire (condition 1)' {
        $link = Join-Path $base 'link-to-data'
        $type = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
        New-Item -ItemType $type -Path $link -Target $real | Out-Null
        foreach ($p in @((Join-Path $link 'taxonomy' 'Origin' 'entities.json'), (Join-Path $real 'taxonomy' 'Origin' 'entities.json'))) {
            $w = Get-Warnings { & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t } $p }
            @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 1 -Because $p
        }
        # And a protected root that is ITSELF reached through the link resolves to the same real root.
        $linkRoot = $link
        Mock Get-DataRoot -ModuleName AITriad -ParameterFilter { $IgnoreEnvOverride } { $linkRoot }.GetNewClosure()
        $w = Get-Warnings { & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t } (Join-Path $real 'entities.json') }
        @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 1
    }

    It 'an unresolvable configured root WARNs and protects the default ../ai-triad-data, never nothing (condition 2)' {
        Mock Get-DataRoot -ModuleName AITriad -ParameterFilter { $IgnoreEnvOverride } { throw 'no config' }
        $bare = Join-Path $base 'bare-repo'; New-Item -ItemType Directory -Force $bare | Out-Null   # no .aitriad.json, not a worktree
        $roots = @(& (Get-Module AITriad) { param($r) Get-ProtectedDataRoots -RepoRoot $r 3>$null } $bare)
        $roots.Count | Should -Be 1
        $roots[0] | Should -Be ([IO.Path]::GetFullPath((Join-Path $base 'ai-triad-data')))
        $w = @(Get-Warnings { & (Get-Module AITriad) { param($r) $null = Get-ProtectedDataRoots -RepoRoot $r } $bare })
        @($w | Where-Object { $_ -like '*could not be resolved*protecting the default*' }).Count | Should -Be 1
    }

    It 'a module loaded from a git WORKTREE protects the main checkout''s data root, read from the .git file (amended condition 2)' {
        # base/main            main checkout: .git/worktrees/w, .aitriad.json -> ../ai-triad-data (= base/ai-triad-data, the real one)
        # base/main/.worktrees/w  worktree: .git FILE, .aitriad.json -> ../ai-triad-data (= base/main/.worktrees/ai-triad-data: absent)
        $main = Join-Path $base 'main'; $wt = Join-Path $main '.worktrees' 'w'
        New-Item -ItemType Directory -Force (Join-Path $main '.git' 'worktrees' 'w'), $wt | Out-Null
        foreach ($d in $main, $wt) { Set-Content -LiteralPath (Join-Path $d '.aitriad.json') -Value '{ "data_root": "../ai-triad-data" }' }
        Set-Content -LiteralPath (Join-Path $wt '.git') -Value "gitdir: $((Join-Path $main '.git' 'worktrees' 'w') -replace '\\', '/')"
        $roots = @(& (Get-Module AITriad) { param($r) Get-ProtectedDataRoots -RepoRoot $r -SkipModuleRoot 3>$null } $wt)
        $roots | Should -Contain ([IO.Path]::GetFullPath($real)) -Because 'the worktree-relative root does not exist; only the main checkout''s root is the real data'
        $target = Resolve-Path (Join-Path $real 'taxonomy' 'Origin') | Join-Path -ChildPath 'entity_embeddings.json'
        $hit = & (Get-Module AITriad) { param($rs, $t) @($rs | Where-Object { Test-PathUnderRoot -RealPath (Resolve-DataRealPath -Path $t) -RealRoot $_ }).Count } $roots $target
        $hit | Should -Be 1
        # A relative gitdir resolves the same way.
        Set-Content -LiteralPath (Join-Path $wt '.git') -Value 'gitdir: ../../.git/worktrees/w'
        @(& (Get-Module AITriad) { param($r) Get-ProtectedDataRoots -RepoRoot $r -SkipModuleRoot 3>$null } $wt) | Should -Contain ([IO.Path]::GetFullPath($real))
    }

    It 'a path on a drive that does not exist resolves without throwing, and is not protected' {
        $p = 'X:\data\taxonomy\situations.json'
        $real = & (Get-Module AITriad) { param($x) Resolve-DataRealPath -Path $x } $p
        $real | Should -Be ([IO.Path]::GetFullPath($p))
        $w = @(Get-Warnings { & (Get-Module AITriad) { param($x) Invoke-DataRootTestWriteCheck -Path $x } $p })
        @($w | Where-Object { $_ -like 'DATA-ROOT-TEST-WRITE*' }).Count | Should -Be 0
    }

    It 'appends the line to AITRIAD_DATA_ROOT_TEST_WRITE_LOG when set (the CI job-summary contract)' {
        $log = Join-Path $base 'hits.log'
        $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG = $log
        $null = & (Get-Module AITriad) { param($t) Invoke-DataRootTestWriteCheck -ReportOnly -Path $t 3>$null } (Join-Path $real 'entities.json')
        (Get-Content -LiteralPath $log) | Should -BeLike 'DATA-ROOT-TEST-WRITE target=*'
    }

    It 'outside a Pester run (no Invoke-Pester on the stack) nothing fires' {
        $script = Join-Path $base 'outside.ps1'
        $mod = (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1')
        # Read-only: the check only computes paths; nothing is written. `under=True` proves the target IS under
        # the protected root, so only the absent Invoke-Pester frame keeps it silent (not a vacuous pass).
        Set-Content -LiteralPath $script -Value @"
`$ErrorActionPreference = 'Stop'
Import-Module '$mod' -Force -WarningAction SilentlyContinue
& (Get-Module AITriad) {
    `$t = Join-Path (Get-DataRoot -IgnoreEnvOverride) 'entities.json'
    `$under = Test-PathUnderRoot -RealPath (Resolve-DataRealPath -Path `$t) -RealRoot (Get-ProtectedDataRoot)
    `$r = @(Invoke-DataRootTestWriteCheck -ReportOnly -Path `$t 3>&1)
    "under=`$under fired=`$(@(`$r | Where-Object { `$_ -is [bool] -and `$_ }).Count) warns=`$(@(`$r | Where-Object { `$_ -is [System.Management.Automation.WarningRecord] }).Count)"
}
"@
        $out = @(pwsh -NoProfile -File $script 2>&1)
        $LASTEXITCODE | Should -Be 0 -Because ($out -join "`n")
        ($out | Select-Object -Last 1) | Should -Be 'under=True fired=0 warns=0'
    }
}

Describe 'Test-run write check is LIVE in this environment (t/4454 positive control)' -Tag 'unit' {
    # No mocks. Proves that here (CI's data clone, or a local checkout) Pester detection fires and the real protected
    # root resolves, so a run that reports 0 DATA-ROOT-TEST-WRITE hits means "no offenders", not "the check is dead".
    # Writes nothing: the target is a file that does not exist, the warning is captured, and the CI log variable is
    # pointed at a scratch file for the call, then restored, so this control never appears in the offender list.
    It 'fires for a path under the real protected root, with Invoke-Pester on the stack' {
        $roots = @(& (Get-Module AITriad) { Get-ProtectedDataRoots 3>$null })
        $roots.Count | Should -BeGreaterThan 0
        $live = @($roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
        if ($live.Count -eq 0) { Set-ItResult -Inconclusive -Because "no protected data root exists here ($($roots -join ', '))"; return }
        & (Get-Module AITriad) { Test-IsPesterRun } | Should -BeTrue
        $probe = Join-Path $live[0] ("t4454-positive-control-" + [guid]::NewGuid().ToString('N') + '.json')
        $saved = $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ("t4454-pc-" + [guid]::NewGuid().ToString('N') + '.log')
        try {
            $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG = $scratch
            $out = @(& (Get-Module AITriad) { param($p) Invoke-DataRootTestWriteCheck -ReportOnly -Path $p } $probe 3>&1)
        } finally {
            $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG = $saved
            Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
        }
        @($out | Where-Object { $_ -is [bool] -and $_ }).Count | Should -Be 1 -Because "the check must fire for $probe"
        @($out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] -and "$_" -like 'DATA-ROOT-TEST-WRITE target=*' }).Count | Should -Be 1
        Test-Path -LiteralPath $probe | Should -BeFalse -Because 'the control must write nothing'
    }
}
