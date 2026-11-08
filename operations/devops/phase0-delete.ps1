#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Phase 0: Delete old worktrees (14+ days)
    
.DESCRIPTION
    Deletes worktrees marked for deletion (14+ days old with no recent commits).
    Requires confirmation before proceeding.
    
.USAGE
    cd operations/devops
    .\phase0-delete.ps1
    .\phase0-delete.ps1 -SkipConfirmation
#>

[CmdletBinding()]
param(
    [switch]$SkipConfirmation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Phase 0: Delete Old Worktrees" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Parse the inventory CSV to find DELETE candidates
$inventoryFile = "PHASE_0_WORKTREE_INVENTORY.csv"
if (-not (Test-Path $inventoryFile)) {
    Write-Error "Inventory file not found: $inventoryFile`nRun phase0-audit.ps1 first."
    exit 1
}

$inventory = @(Import-Csv -Path $inventoryFile)
$deleteCandidates = @($inventory | Where-Object { $_.Category -eq "DELETE" })

Write-Host "Found $(@($deleteCandidates).Count) DELETE candidates:" -ForegroundColor Red
Write-Host ""

$deleteCandidates | ForEach-Object {
    Write-Host "  🗑️  $($_.Worktree) — $($_.DaysIdle)d old" -ForegroundColor Red
}
Write-Host ""

# Confirmation
if (-not $SkipConfirmation) {
    $confirm = Read-Host "Delete these $(@($deleteCandidates).Count) worktrees? (yes/no)"
    if ($confirm -ne "yes") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host ""
Write-Host "[1/2] Deleting worktrees..." -ForegroundColor Yellow

$deleted = 0
$failed = @()

foreach ($wt in $deleteCandidates) {
    $wtName = $wt.Worktree
    $wtPath = $wt.Path  # Use actual path from git, not assumed .worktrees/
    
    try {
        Write-Host "  Deleting: $wtName" -ForegroundColor Yellow
        git worktree remove $wtPath --force 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    ✅ Deleted" -ForegroundColor Green
            $deleted++
        } else {
            Write-Host "    ❌ Failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
            $failed += $wtName
        }
    } catch {
        Write-Host "    ❌ Error: $_" -ForegroundColor Red
        $failed += $wtName
    }
}

Write-Host ""
Write-Host "[2/2] Summary" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ✅ Deleted: $deleted" -ForegroundColor Green
Write-Host "  ❌ Failed: $(@($failed).Count)" -ForegroundColor Red

if (@($failed).Count -gt 0) {
    Write-Host ""
    Write-Host "  Failed worktrees:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "    - $_" }
    exit 1
}

Write-Host ""
Write-Host "  Worktrees reduced by: $deleted" -ForegroundColor Green
Write-Host "  Remaining: ~$($inventory.Count - $deleted)" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: Review STALE worktrees (7-14 days old)" -ForegroundColor Cyan
