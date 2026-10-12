# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Re-triggers CI on every open PR after a required-status-context swap.
.DESCRIPTION
    After changing which status contexts are required on main, every open PR that
    predates the swap lacks the new check — its armed auto-merge cannot fire.
    This script:
      1. Enumerates all open, non-draft PRs.
      2. Captures the current check-run state for each required context (before).
      3. Re-triggers all PR workflows via close-then-reopen on each PR. This
         synthesizes a fresh pull_request event, which causes every PR-triggered
         workflow (ci.yml, codeql.yml, etc.) to run against the same head SHA
         without any code change or empty commit on the branch.
      4. Waits for the new check runs to reach a terminal state (up to -TimeoutMinutes).
      5. Prints a per-PR x per-context before/after table.
    Exits 0 when every PR reports every required context as success; exits 1 otherwise.

    See deploy/azure/runbooks/context-swap.md for the full protocol.

    TRADE-OFF: close-reopen sends GitHub notifications and briefly de-arms auto-merge.
    For the rare context-swap operation this is acceptable; it is the only mechanism
    that reliably re-triggers all PR workflows without modifying workflow files or
    pushing empty commits.
.PARAMETER Repo
    GitHub repository slug (owner/name). Default: AI-Rosetta-Stone/ai-triad-research.
.PARAMETER RequiredContexts
    Status context names to verify. If omitted, fetched live from branch protection.
.PARAMETER TimeoutMinutes
    Max minutes to wait for checks to reach a terminal state. Default: 8.
.PARAMETER WhatIf
    Show what would be triggered without actually triggering anything.
.EXAMPLE
    ./operations/devops/Invoke-ContextSwapRetrigger.ps1
.EXAMPLE
    ./operations/devops/Invoke-ContextSwapRetrigger.ps1 -WhatIf
.EXAMPLE
    ./operations/devops/Invoke-ContextSwapRetrigger.ps1 -RequiredContexts 'ci-gate','CodeQL' -TimeoutMinutes 12
#>

#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]   $Repo             = 'AI-Rosetta-Stone/ai-triad-research',
    [string[]] $RequiredContexts,
    [int]      $TimeoutMinutes   = 8,
    [switch]   $WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TerminalStates = @('success', 'failure', 'cancelled', 'timed_out', 'action_required', 'skipped', 'neutral')

function Get-CheckMap {
    param([string]$Sha)
    $raw = gh api "repos/$Repo/commits/$Sha/check-runs" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return @{} }
    $map = @{}
    foreach ($r in ($raw | ConvertFrom-Json).check_runs) {
        $map[$r.name] = if ($r.conclusion) { $r.conclusion } else { $r.status }
    }
    return $map
}

function Format-Row {
    param([hashtable]$Before, [hashtable]$After, [object]$PR, [bool]$ShowAfter)
    $titleWidth = 32

    $title = if ($PR.title.Length -le $titleWidth - 2) {
        $PR.title
    } else {
        "$($PR.title.Substring(0, $titleWidth - 5))..."
    }

    $row = "#$($PR.number)".PadRight(5) + $title.PadRight($titleWidth)
    foreach ($ctx in $script:RequiredContexts) {
        $bef = if ($Before.ContainsKey($ctx)) { $Before[$ctx] } else { '—' }
        if ($ShowAfter) {
            $aft  = if ($After.ContainsKey($ctx)) { $After[$ctx] } else { '—' }
            $cell = "$bef → $aft"
        } else {
            $cell = $bef
        }
        $row += $cell.PadRight($script:CtxWidth)
    }
    return $row
}

# ── 1. Resolve required contexts ──────────────────────────────────────────────
if (-not $RequiredContexts) {
    $protection       = gh api "repos/$Repo/branches/main/protection/required_status_checks" | ConvertFrom-Json
    $RequiredContexts = [string[]]$protection.contexts
}

$script:RequiredContexts = $RequiredContexts
$script:CtxWidth         = [Math]::Max(16, ($RequiredContexts | Measure-Object -Property Length -Maximum).Maximum + 6)

Write-Host "Repo:              $Repo"
Write-Host "Required contexts: $($RequiredContexts -join ', ')"
Write-Host "Mechanism:         close-reopen (synthesizes pull_request event)"

# ── 2. Get open non-draft PRs ─────────────────────────────────────────────────
$allPRs = gh pr list --repo $Repo --state open --json number,title,headRefName,headRefOid,isDraft | ConvertFrom-Json
$prs    = @($allPRs | Where-Object { -not $_.isDraft })

if ($prs.Count -eq 0) {
    Write-Host "`nNo open non-draft PRs. Nothing to do."
    exit 0
}
Write-Host "`n$($prs.Count) open PR(s) found."

# ── 3. Capture before state ───────────────────────────────────────────────────
Write-Host "`nCapturing check state before trigger..."
$beforeMap = @{}
foreach ($pr in $prs) {
    $beforeMap[$pr.number] = Get-CheckMap -Sha $pr.headRefOid
}

# ── 4. Print before table ─────────────────────────────────────────────────────
$titleWidth = 32
$header     = 'PR'.PadRight(5) + 'Title'.PadRight($titleWidth) + (($RequiredContexts | ForEach-Object { $_.PadRight($script:CtxWidth) }) -join '')
$sep        = '-' * $header.Length

Write-Host "`nBEFORE"
Write-Host $header
Write-Host $sep
foreach ($pr in $prs) {
    Write-Host (Format-Row -Before $beforeMap[$pr.number] -After @{} -PR $pr -ShowAfter $false)
}

# ── 5. Close-reopen each PR ───────────────────────────────────────────────────
Write-Host ''
if ($WhatIf) {
    Write-Host '[WhatIf] Would close-reopen:'
} else {
    Write-Host 'Triggering via close-reopen...'
}

foreach ($pr in $prs) {
    $msg = "  PR #$($pr.number)  $($pr.title)"
    Write-Host $msg
    if (-not $WhatIf) {
        gh pr close $pr.number --repo $Repo 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "  Failed to close PR #$($pr.number)" }
        Start-Sleep -Milliseconds 500
        gh pr reopen $pr.number --repo $Repo 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning "  Failed to reopen PR #$($pr.number)" }
    }
}

if ($WhatIf) {
    Write-Host "`n[WhatIf] No PRs were modified. Run without -WhatIf to apply."
    exit 0
}

# ── 6. Poll until terminal or timeout ─────────────────────────────────────────
Write-Host "`nPolling for check results (timeout: $TimeoutMinutes min)..."
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$afterMap = @{}
foreach ($pr in $prs) { $afterMap[$pr.number] = @{} }

do {
    Start-Sleep -Seconds 20
    $allTerminal = $true
    foreach ($pr in $prs) {
        $runs = Get-CheckMap -Sha $pr.headRefOid
        $afterMap[$pr.number] = $runs
        foreach ($ctx in $RequiredContexts) {
            $state = if ($runs.ContainsKey($ctx)) { $runs[$ctx] } else { '' }
            if (-not $state -or $state -notin $TerminalStates) { $allTerminal = $false }
        }
    }
} while (-not $allTerminal -and (Get-Date) -lt $deadline)

if (-not $allTerminal) {
    Write-Warning "Timed out before all checks reached a terminal state. Re-run to check again."
}

# ── 7. Print after table ──────────────────────────────────────────────────────
Write-Host "`nAFTER  (before → after)"
Write-Host $header
Write-Host $sep

$allGreen = $true
foreach ($pr in $prs) {
    Write-Host (Format-Row -Before $beforeMap[$pr.number] -After $afterMap[$pr.number] -PR $pr -ShowAfter $true)
    foreach ($ctx in $RequiredContexts) {
        $aft = if ($afterMap[$pr.number].ContainsKey($ctx)) { $afterMap[$pr.number][$ctx] } else { '' }
        if ($aft -ne 'success') { $allGreen = $false }
    }
}

Write-Host ''
if ($allGreen) {
    Write-Host 'All PRs report all required contexts as success. Safe to proceed.'
    exit 0
} else {
    Write-Warning 'Some PRs are missing required contexts or report non-success. Check the table above.'
    exit 1
}
