# Tag: summary (t/2902)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Centralized data-write dirty-tree guard (t/2902 Part 2) — both arms + mode +
    data-root scoping, against a REAL temp git repo used as the data root.
.DESCRIPTION
    Assert-DataWriteAllowed is the sink chokepoint. It must:
      - Block mode + dirty data-target   -> throw (sweep blocked).
      - Warn  mode + dirty data-target   -> warn, no throw (warn-first promotion).
      - Off   mode                       -> no-op.
      - clean data-target (any mode)     -> no-op, silent.
      - target OUTSIDE the data root      -> no-op even in Block (per-file, data-scoped;
                                            NOT a whole-tree gate — the false-block trap).
      - -AllowDirty                       -> bypass even in Block (sequential-rewriter opt-out).
    Also proves Write-Utf8NoBom routes through the guard (Block + dirty -> throw).
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Capture pre-existing env so AfterEach can RESTORE (not clobber) it — the full
    # suite runs every test file in one process, and CI sets AI_TRIAD_DATA_ROOT.
    $script:OrigDataRoot  = [Environment]::GetEnvironmentVariable('AI_TRIAD_DATA_ROOT')
    $script:OrigGuardMode = [Environment]::GetEnvironmentVariable('AI_TRIAD_DATA_WRITE_GUARD')

    function New-DataRepo {
        param([string]$Root, [string]$RelPath = 'summaries/doc.json')
        New-Item -ItemType Directory -Path $Root -Force | Out-Null
        & git -C $Root init --quiet
        & git -C $Root config user.email 'fixture@example.com'
        & git -C $Root config user.name 'Fixture'
        & git -C $Root config commit.gpgsign false
        $file = Join-Path $Root $RelPath
        New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
        '{ "stance": "aligned" }' | Set-Content -Path $file -Encoding utf8NoBOM
        & git -C $Root add -A
        & git -C $Root commit --quiet -m 'seed'
        return $file
    }
}

Describe 'Assert-DataWriteAllowed — centralized data-write guard (t/2902)' -Tag 'summary' {

    AfterEach {
        # Restore the pre-existing values (do NOT blanket-remove — would clobber a
        # CI-set AI_TRIAD_DATA_ROOT for every later test file in the shared process).
        if ($null -eq $script:OrigDataRoot) { Remove-Item Env:\AI_TRIAD_DATA_ROOT -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_ROOT = $script:OrigDataRoot }
        if ($null -eq $script:OrigGuardMode) { Remove-Item Env:\AI_TRIAD_DATA_WRITE_GUARD -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_WRITE_GUARD = $script:OrigGuardMode }
    }

    It 'Block mode + dirty data-target throws' {
        $repo = Join-Path $TestDrive 'block-dirty'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM   # make it dirty
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F } | Should -Throw -ExpectedMessage '*uncommitted changes*'
        }
    }

    It 'Warn mode + dirty data-target warns but does not throw' {
        $repo = Join-Path $TestDrive 'warn-dirty'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Warn'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            $emitted = Assert-DataWriteAllowed -Path $F 3>&1
            @($emitted).Count | Should -BeGreaterThan 0
            "$emitted" | Should -BeLike '*uncommitted changes*'
        }
    }

    It 'Off mode is a no-op even on a dirty data-target' {
        $repo = Join-Path $TestDrive 'off-dirty'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Off'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            $emitted = Assert-DataWriteAllowed -Path $F 3>&1
            @($emitted).Count | Should -Be 0
        }
    }

    It 'clean data-target is a silent no-op (Block mode)' {
        $repo = Join-Path $TestDrive 'block-clean'
        $file = New-DataRepo -Root $repo
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            $emitted = Assert-DataWriteAllowed -Path $F 3>&1
            @($emitted).Count | Should -Be 0
        }
    }

    It 'target OUTSIDE the data root is not guarded even in Block mode' {
        $repo = Join-Path $TestDrive 'scope-repo'
        $null = New-DataRepo -Root $repo
        # A dirty tracked file in a DIFFERENT git repo, not under the data root.
        $other = Join-Path $TestDrive 'other'
        $outsideFile = New-DataRepo -Root $other   # its own repo
        'mutated' | Set-Content -Path $outsideFile -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo            # data root is the FIRST repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $outsideFile } {
            param($F)
            # Not under data root -> guard must not fire, even dirty + Block.
            { Assert-DataWriteAllowed -Path $F } | Should -Not -Throw
        }
    }

    It '-AllowDirty bypasses the guard even in Block mode' {
        $repo = Join-Path $TestDrive 'allowdirty'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F -AllowDirty } | Should -Not -Throw
        }
    }

    It 'Write-Utf8NoBom routes through the guard (Block + dirty data-target throws)' {
        $repo = Join-Path $TestDrive 'wired'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { 'new' | Write-Utf8NoBom -Path $F } | Should -Throw -ExpectedMessage '*uncommitted changes*'
        }
    }
}

Describe 'Assert-DataWriteAllowed — data-write observability log (t/4455)' -Tag 'summary' {

    BeforeAll {
        function Get-LoggedRecords([string]$Repo) {
            $logPath = Join-Path $Repo 'data-writes.jsonl'
            if (-not (Test-Path -LiteralPath $logPath)) { return @() }
            @(Get-Content -LiteralPath $logPath | ForEach-Object { $_ | ConvertFrom-Json })
        }
    }

    AfterEach {
        if ($null -eq $script:OrigDataRoot) { Remove-Item Env:\AI_TRIAD_DATA_ROOT -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_ROOT = $script:OrigDataRoot }
        if ($null -eq $script:OrigGuardMode) { Remove-Item Env:\AI_TRIAD_DATA_WRITE_GUARD -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_WRITE_GUARD = $script:OrigGuardMode }
    }

    It 'an allowed write (clean target, Block mode) logs a record naming the caller and path' {
        $repo = Join-Path $TestDrive 'obs-allowed'
        $file = New-DataRepo -Root $repo
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            function Invoke-TestCaller { Assert-DataWriteAllowed -Path $F }
            Invoke-TestCaller 3>$null
        }
        $records = Get-LoggedRecords -Repo $repo
        $records.Count | Should -Be 1
        $records[0].allowed | Should -Be $true
        $records[0].path | Should -Be $file
        $records[0].caller | Should -Be 'Invoke-TestCaller'
        $records[0].reason | Should -Be 'block-clean'
    }

    It 'a refused write (Block mode, dirty) still throws AND logs allowed=false' {
        $repo = Join-Path $TestDrive 'obs-refused'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F } | Should -Throw
        }
        $records = Get-LoggedRecords -Repo $repo
        $records.Count | Should -Be 1
        $records[0].allowed | Should -Be $false
        $records[0].reason | Should -Be 'block-dirty-refused'
    }

    It '-AllowDirty bypass logs allowed=true with reason allow-dirty-override' {
        $repo = Join-Path $TestDrive 'obs-allowdirty'
        $file = New-DataRepo -Root $repo
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            Assert-DataWriteAllowed -Path $F -AllowDirty
        }
        $records = Get-LoggedRecords -Repo $repo
        $records.Count | Should -Be 1
        $records[0].allowed | Should -Be $true
        $records[0].reason | Should -Be 'allow-dirty-override'
    }

    It 'a target outside the data root is not logged at all' {
        $repo = Join-Path $TestDrive 'obs-scope-repo'
        $null = New-DataRepo -Root $repo
        $other = Join-Path $TestDrive 'obs-other'
        $outsideFile = New-DataRepo -Root $other
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $outsideFile } {
            param($F)
            Assert-DataWriteAllowed -Path $F
        }
        (Get-LoggedRecords -Repo $repo).Count | Should -Be 0
    }
}

Describe 'Write-Utf8NoBom Build-Module contract (t/2902 regression)' -Tag 'summary' {
    # Build-Module.ps1 dot-sources Private/Write-Utf8NoBom.ps1 STANDALONE (without the
    # guard chain) to write .aitriad.json. The centralized guard must therefore be
    # best-effort: a standalone dot-source must still write, not fail on a missing
    # Assert-DataWriteAllowed. Verified in a FRESH pwsh process (real isolation — the
    # in-process module would otherwise make the guard resolvable and mask the break).
    It 'a standalone dot-source writes without requiring the guard chain' {
        $writer = (Resolve-Path (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Write-Utf8NoBom.ps1')).Path
        $out    = Join-Path $TestDrive 'standalone-build.json'
        $mini   = Join-Path $TestDrive 'mini-build.ps1'
        # Write the harness to a file (avoids -Command quoting hazards, Shell Quoting Rule).
        Set-Content -Path $mini -Encoding utf8NoBOM -Value @(
            ". `"$writer`""
            "'hello-build' | Write-Utf8NoBom -Path `"$out`""
        )
        $p = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-File', $mini -Wait -PassThru -NoNewWindow
        $p.ExitCode | Should -Be 0
        (Get-Content -Raw -Path $out).Trim() | Should -Be 'hello-build'
    }
}

Describe 'Assert-DataWriteAllowed — tiered mode (t/2909)' -Tag 'summary' {
    # Default (no env override): BLOCK-tier basenames throw on a dirty target; WARN-tier
    # basenames only warn. The global env override still wins over the tier.
    AfterEach {
        if ($null -eq $script:OrigDataRoot) { Remove-Item Env:\AI_TRIAD_DATA_ROOT -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_ROOT = $script:OrigDataRoot }
        if ($null -eq $script:OrigGuardMode) { Remove-Item Env:\AI_TRIAD_DATA_WRITE_GUARD -ErrorAction SilentlyContinue }
        else { $env:AI_TRIAD_DATA_WRITE_GUARD = $script:OrigGuardMode }
    }

    It 'BLOCK tier (situations.json) + dirty + NO env → throws' {
        $repo = Join-Path $TestDrive 'tier-block'
        $file = New-DataRepo -Root $repo -RelPath 'taxonomy/Origin/situations.json'
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        Remove-Item Env:\AI_TRIAD_DATA_WRITE_GUARD -ErrorAction SilentlyContinue   # tier decides
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F } | Should -Throw -ExpectedMessage '*uncommitted changes*'
        }
    }

    It 'WARN tier (accelerationist.json — high-traffic) + dirty + NO env → warns, does NOT throw' {
        $repo = Join-Path $TestDrive 'tier-warn'
        $file = New-DataRepo -Root $repo -RelPath 'taxonomy/Origin/accelerationist.json'
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        Remove-Item Env:\AI_TRIAD_DATA_WRITE_GUARD -ErrorAction SilentlyContinue
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            $emitted = Assert-DataWriteAllowed -Path $F 3>&1
            @($emitted).Count | Should -BeGreaterThan 0
            "$emitted" | Should -BeLike '*uncommitted changes*'
        }
    }

    It 'env override wins over tier: WARN-tier file + env=Block → throws' {
        $repo = Join-Path $TestDrive 'tier-override-block'
        $file = New-DataRepo -Root $repo -RelPath 'taxonomy/Origin/accelerationist.json'
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Block'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F } | Should -Throw -ExpectedMessage '*uncommitted changes*'
        }
    }

    It 'env override wins over tier: BLOCK-tier file + env=Warn → warns, does NOT throw' {
        $repo = Join-Path $TestDrive 'tier-override-warn'
        $file = New-DataRepo -Root $repo -RelPath 'taxonomy/Origin/situations.json'
        'mutated' | Set-Content -Path $file -Encoding utf8NoBOM
        $env:AI_TRIAD_DATA_ROOT = $repo
        $env:AI_TRIAD_DATA_WRITE_GUARD = 'Warn'
        InModuleScope AITriad -Parameters @{ F = $file } {
            param($F)
            { Assert-DataWriteAllowed -Path $F } | Should -Not -Throw
        }
    }
}
