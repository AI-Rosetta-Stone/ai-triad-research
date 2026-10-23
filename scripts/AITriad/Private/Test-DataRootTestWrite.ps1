# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Test-run write check (t/4454, design t/4454#2, TL conditions t/4454#3). Incident t/4453: a Pester run
# wrote the REAL ai-triad-data through the guarded funnel, which only refused already-dirty files.
# Assert-DataWriteAllowed now calls Invoke-DataRootTestWriteCheck first: when Invoke-Pester is on the call
# stack and the target is under the PROTECTED root (the configured root, ignoring $env:AI_TRIAD_DATA_ROOT),
# it reports the write. Phase 1 (this code) WARNs with the fixed token DATA-ROOT-TEST-WRITE; Phase 2 (a T2)
# turns the warning into a refusal once the offender list is empty or ticketed.
# Paths are compared as RESOLVED real paths (TL condition 1): CI's ../ai-triad-data is a symlink and
# worktrees reach the data through junctions.
# Remaining vectors, accepted at t/4454#3: child processes a test spawns, -Parallel runspaces (no
# Invoke-Pester on their stack), raw sinks outside the funnel (static DataWriteSinkGuard).

$script:DataRootTestWriteToken = 'DATA-ROOT-TEST-WRITE'

function Resolve-DataRealPath {
    # The real path of $Path: every existing component's symlink/junction followed (recursively), the
    # non-existent tail appended as-is, normalized with GetFullPath. Bounded against link loops.
    # [IO.Path]::Combine, not Join-Path: Join-Path consults the PowerShell provider and throws for a drive that
    # does not exist (X:\...), which broke callers that pass a fake path (SurgicalWriteExemption ARM 1, Windows).
    param([Parameter(Mandatory)][string]$Path, [int]$Depth = 0)
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($Depth -gt 16) { return $full }
    $root = [System.IO.Path]::GetPathRoot($full)
    $parts = @($full.Substring($root.Length).Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries))
    $cur = $root
    for ($i = 0; $i -lt $parts.Count; $i++) {
        $next = [System.IO.Path]::Combine($cur, $parts[$i])
        $item = Get-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            # The rest does not exist yet (a file about to be written): append it unresolved.
            $tail = if ($i -lt $parts.Count) { $parts[$i..($parts.Count - 1)] -join [System.IO.Path]::DirectorySeparatorChar } else { '' }
            return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($cur, $tail))
        }
        if ($item.PSObject.Properties['LinkType'] -and $item.LinkType -and $item.PSObject.Properties['LinkTarget'] -and $item.LinkTarget) {
            $target = [string]$item.LinkTarget
            if (-not [System.IO.Path]::IsPathRooted($target)) { $target = [System.IO.Path]::Combine($cur, $target) }
            $next = Resolve-DataRealPath -Path $target -Depth ($Depth + 1)
        }
        $cur = $next
    }
    [System.IO.Path]::GetFullPath($cur)
}

function Get-MainCheckoutRoot {
    # The main checkout of a git worktree, read from the worktree's `.git` FILE ("gitdir: <main>/.git/worktrees/<n>")
    # without the git CLI, so it holds where `git` is absent. $null when $RepoRoot is not a linked worktree.
    param([string]$RepoRoot)
    $dotGit = Join-Path $RepoRoot '.git'
    if (-not (Test-Path -LiteralPath $dotGit -PathType Leaf)) { return $null }
    $line = @(Get-Content -LiteralPath $dotGit -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*gitdir:\s*(.+)$' }) | Select-Object -First 1
    if (-not $line) { return $null }
    $gitdir = ([regex]::Match($line, '^\s*gitdir:\s*(.+)$').Groups[1].Value).Trim()
    if (-not [System.IO.Path]::IsPathRooted($gitdir)) { $gitdir = Join-Path $RepoRoot $gitdir }
    $gitdir = [System.IO.Path]::GetFullPath($gitdir)
    # <main>/.git/worktrees/<n> -> <main>
    $wtDir = Split-Path $gitdir -Parent
    if ((Split-Path -Leaf $wtDir) -ne 'worktrees') { return $null }
    Split-Path (Split-Path $wtDir -Parent) -Parent
}

function Get-ConfiguredRootFrom {
    # A repo's .aitriad.json data_root resolved against that repo's directory (as found, no main-checkout anchor).
    param([string]$RepoRoot)
    $cfg = Join-Path $RepoRoot '.aitriad.json'
    if (-not (Test-Path -LiteralPath $cfg)) { return $null }
    try { $c = Get-Content -Raw -LiteralPath $cfg | ConvertFrom-Json } catch { return $null }
    if (-not $c.PSObject.Properties['data_root'] -or [string]::IsNullOrWhiteSpace([string]$c.data_root)) { return $null }
    $r = [string]$c.data_root
    if ([System.IO.Path]::IsPathRooted($r)) { return [System.IO.Path]::GetFullPath($r) }
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $r))
}

function Get-ProtectedDataRoots {
    <#
    .SYNOPSIS
        The real data roots a test run must not write (TL conditions 2 and amended 2, t/4454#3 and #5), as real paths.
    .DESCRIPTION
        The UNION of:
          - Get-DataRoot -IgnoreEnvOverride: the configured root as the module resolves it (anchored on the main
            checkout through git, t/3869);
          - $RepoRoot's own .aitriad.json root, resolved as found;
          - when $RepoRoot is a linked worktree: the MAIN checkout's .aitriad.json root, the main checkout read from
            the worktree's .git file (no git CLI). Worktrees have no ../ai-triad-data junction and reach the real
            data only through the user-level AI_TRIAD_DATA_ROOT (Shared Lib live-fire, t/4454#4), so without this
            a module loaded from a worktree, where git can't anchor it, would leave the real data unguarded.
        None resolvable -> WARN and protect the default ../ai-triad-data beside the main checkout (or the repo);
        never "nothing is protected".
    #>
    param([string]$RepoRoot = $script:RepoRoot, [switch]$SkipModuleRoot)
    $roots = [System.Collections.Generic.List[string]]::new()
    if (-not $SkipModuleRoot) { try { $m = Get-DataRoot -IgnoreEnvOverride; if ($m) { $roots.Add($m) } } catch { } }
    if ($RepoRoot) {
        $own = Get-ConfiguredRootFrom -RepoRoot $RepoRoot; if ($own) { $roots.Add($own) }
        $main = Get-MainCheckoutRoot -RepoRoot $RepoRoot
        if ($main) {
            $mr = Get-ConfiguredRootFrom -RepoRoot $main
            if (-not $mr) { $mr = Join-Path (Split-Path $main -Parent) 'ai-triad-data' }
            $roots.Add($mr)
        }
    }
    if ($roots.Count -eq 0) {
        $anchor = if ($RepoRoot) { $RepoRoot } else { (Get-Location).Path }
        $mainAnchor = Get-MainCheckoutRoot -RepoRoot $anchor
        if ($mainAnchor) { $anchor = $mainAnchor }
        $default = Join-Path (Split-Path $anchor -Parent) 'ai-triad-data'
        Write-Warning "$($script:DataRootTestWriteToken): the configured data root could not be resolved; protecting the default '$default' (t/4454)."
        $roots.Add($default)
    }
    $real = [System.Collections.Generic.List[string]]::new()
    foreach ($r in $roots) {
        $rp = Resolve-DataRealPath -Path $r
        if (-not @($real | Where-Object { $_ -ieq $rp }).Count) { $real.Add($rp) }
    }
    # Emit the roots one by one (callers collect with @()); a comma-wrapped return would nest the array.
    $real.ToArray()
}

function Get-ProtectedDataRoot {
    # Back-compat single-root view: the first protected root.
    @(Get-ProtectedDataRoots)[0]
}

function Test-IsPesterRun {
    # True when Invoke-Pester is on this runspace's call stack (not merely "Pester is loaded", which an
    # interactive session would also be).
    @(Get-PSCallStack | Where-Object { $_.Command -eq 'Invoke-Pester' }).Count -gt 0
}

function Test-PathUnderRoot {
    # Real-path containment, bounded on a separator (ai-triad-data2 is not under ai-triad-data);
    # case-insensitive on Windows only.
    param([string]$RealPath, [string]$RealRoot)
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $r = $RealRoot.TrimEnd('\', '/') + $sep
    $cmp = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    ($RealPath + $sep).StartsWith($r, $cmp)
}

function Get-DataRootTestWriteCaller {
    # "<test file>:<line> via <writer>": the nearest *.Tests.ps1 frame and the first frame above the guard.
    $stack = @(Get-PSCallStack)
    $test = $stack | Where-Object { $_.ScriptName -and $_.ScriptName -match '\.Tests\.ps1$' } | Select-Object -First 1
    $writer = $stack | Where-Object { $_.Command -and $_.Command -notmatch '^(Get-DataRootTestWriteCaller|Invoke-DataRootTestWriteCheck|Assert-DataWriteAllowed|<ScriptBlock>)$' } | Select-Object -First 1
    $t = if ($test) { "$(Split-Path -Leaf $test.ScriptName):$($test.ScriptLineNumber)" } else { '(no test frame)' }
    $w = if ($writer) { $writer.Command } else { '(unknown)' }
    "$t via $w"
}

function Invoke-DataRootTestWriteCheck {
    <#
    .SYNOPSIS
        Phase 1 (warn-only): report a write to the protected data root from inside a Pester run.
    .DESCRIPTION
        WARN line: "DATA-ROOT-TEST-WRITE target=<real path> caller=<test file>:<line> via <writer>". When
        $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG is set (CI), the same line is appended there for the job
        summary. Returns $true when it fired.
    #>
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-IsPesterRun)) { return $false }
    $real = Resolve-DataRealPath -Path $Path
    $hit = @(Get-ProtectedDataRoots) | Where-Object { Test-PathUnderRoot -RealPath $real -RealRoot $_ } | Select-Object -First 1
    if (-not $hit) { return $false }
    $line = "$($script:DataRootTestWriteToken) target=$real caller=$(Get-DataRootTestWriteCaller)"
    Write-Warning $line
    $log = $env:AITRIAD_DATA_ROOT_TEST_WRITE_LOG
    if (-not [string]::IsNullOrWhiteSpace($log)) {
        try { [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine) } catch { Write-Warning "$($script:DataRootTestWriteToken): could not append to '$log': $($_.Exception.Message)" }
    }
    $true
}
