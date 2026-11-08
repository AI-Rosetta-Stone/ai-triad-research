#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Phase 0: Worktree Audit Script
    
.DESCRIPTION
    Audits all active worktrees, categorizes by refactor-sensitivity,
    and generates recommendations for landing/pausing/deleting.
    
.USAGE
    cd operations/devops
    .\phase0-audit.ps1
    .\phase0-audit.ps1 -OutputFile "worktree-audit.csv"
    
.OUTPUT
    Generates:
    - Console output with summary
    - CSV file with detailed inventory
    - Recommendations for each branch
#>

[OutputType([PSCustomObject[]])]
param(
    [string]$OutputFile = "PHASE_0_WORKTREE_INVENTORY.csv"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Invoke-GitCommand {
    [CmdletBinding()]
    param(
        [string]$Path,
        [string[]]$Arguments
    )
    
    try {
        $output = & git -C $Path @Arguments 2>$null
        return $output
    } catch {
        Write-Warning "Git command failed in $Path : $_"
        return $null
    }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Phase 0: Worktree Audit" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Refactor-sensitive paths
$refactorZones = @(
    "lib/debate/",
    "lib/ai-client/",
    "lib/shared-types/",
    "lib/taxonomy/",
    "scripts/AITriad/",
    "operations/devops/",
    "docs/PHASE_0",
    "docs/UNIFIED_EXECUTION_PLAN"
)

# Get all worktrees
Write-Host "[1/4] Listing all worktrees..." -ForegroundColor Yellow
$wtRaw = @(git worktree list --porcelain)
$worktrees = @()

# Parse --porcelain format:
# worktree <path>
# HEAD <hash>
# branch <ref>
# [blank line]
$i = 0
while ($i -lt @($wtRaw).Count) {
    $line = $wtRaw[$i]
    
    if ($line -match '^worktree\s+(.+)$') {
        $fullPath = $matches[1]
        
        # Skip the shared checkout (.)
        if ($fullPath -ne '.') {
            # Extract worktree name from path
            $wtName = Split-Path -Leaf $fullPath
            
            # Next line should be HEAD
            if ($i + 1 -lt @($wtRaw).Count -and $wtRaw[$i + 1] -match '^HEAD\s+(\S+)$') {
                $headHash = $matches[1]
                
                # Next line should be branch
                $branchRef = ""
                if ($i + 2 -lt @($wtRaw).Count -and $wtRaw[$i + 2] -match '^branch\s+(.+)$') {
                    $branchRef = $matches[1] -replace 'refs/heads/', ''
                }
                
                $worktrees += [PSCustomObject]@{
                    Path       = $fullPath
                    Name       = $wtName
                    Branch     = $branchRef
                    HeadHash   = $headHash
                }
            }
        }
    }
    $i++
}

$inventory = @()
$categoryCounts = @{
    LAND = 0
    PAUSE = 0
    CONTINUE = 0
    STALE = 0
    DELETE = 0
}

Write-Host "  Found $($worktrees.Count) worktrees" -ForegroundColor Green
Write-Host ""

# Analyze each worktree
Write-Host "[2/4] Analyzing each worktree..." -ForegroundColor Yellow
$count = 0
foreach ($wt in $worktrees) {
    $count++
    $percent = [math]::Round($count / $worktrees.Count * 100)
    Write-Progress -Activity "Analyzing worktrees" -Status "$percent% ($count/$($worktrees.Count))" -PercentComplete $percent
    
    $path = $wt.Path
    $branch = $wt.Branch
    $worktreeName = $wt.Name
    
    # Get last commit info
    $lastCommit = git -C $path log -1 --format="%h %s" 2>$null
    $lastCommitDate = git -C $path log -1 --format="%ai" 2>$null
    
    $daysIdle = 999
    if ($null -ne $lastCommitDate -and $lastCommitDate -ne '') {
        try {
            $daysIdle = [math]::Round(((Get-Date) - [DateTime]$lastCommitDate).TotalDays)
        } catch {
            Write-Warning "Failed to parse date for $worktreeName : $_"
            $daysIdle = 999
        }
    }
    
    # Check for uncommitted changes
    $status = git -C $path status --porcelain 2>$null
    $hasChanges = @($status).Count -gt 0
    
    # Check what files this branch touches vs main
    $mergeBase = git -C $path merge-base HEAD main 2>$null
    $touchedFiles = @(git -C $path diff --name-only $mergeBase...HEAD 2>$null)
    
    # Determine if refactor-sensitive
    $isRefactorSensitive = $false
    if (@($touchedFiles).Count -gt 0) {
        foreach ($zone in $refactorZones) {
            foreach ($file in $touchedFiles) {
                if ($file -like "$zone*") {
                    $isRefactorSensitive = $true
                    break
                }
            }
            if ($isRefactorSensitive) { break }
        }
    }
    
    # Categorize
    $category = "CONTINUE"
    if ($daysIdle -gt 14) {
        $category = "DELETE"
    } elseif ($daysIdle -gt 7) {
        $category = "STALE"
    } elseif ($isRefactorSensitive) {
        if ($hasChanges) {
            $category = "PAUSE"
        } else {
            $category = "LAND"
        }
    }
    
    $categoryCounts[$category]++
    
    $inventory += [PSCustomObject]@{
        Worktree = $worktreeName
        Path = $path
        Branch = $branch
        Category = $category
        RefactorSensitive = $isRefactorSensitive
        DaysIdle = $daysIdle
        HasChanges = $hasChanges
        FilesTouched = @($touchedFiles).Count
        LastCommit = if ($null -ne $lastCommit) { $lastCommit } else { "ERROR" }
    }
}

Write-Progress -Activity "Analyzing worktrees" -Completed

Write-Host ""
Write-Host "[3/4] Generating inventory..." -ForegroundColor Yellow

# Export to CSV
$inventory | Export-Csv -Path $OutputFile -NoTypeInformation
Write-Host "  ✅ Exported to: $OutputFile" -ForegroundColor Green

# Summary
Write-Host ""
Write-Host "[4/4] Summary" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Total worktrees:" @($inventory).Count -ForegroundColor Cyan
Write-Host "  ├─ LAND immediately:" $categoryCounts["LAND"] "🚀" -ForegroundColor Green
Write-Host "  ├─ PAUSE (stash):" $categoryCounts["PAUSE"] "⏸️ " -ForegroundColor Yellow
Write-Host "  ├─ CONTINUE (safe):" $categoryCounts["CONTINUE"] "✓" -ForegroundColor Blue
Write-Host "  ├─ STALE (7+ days):" $categoryCounts["STALE"] "⚠️ " -ForegroundColor Yellow
Write-Host "  └─ DELETE (14+ days):" $categoryCounts["DELETE"] "🗑️ " -ForegroundColor Red
Write-Host ""

# Show LAND candidates
$landBranches = @($inventory | Where-Object { $_.Category -eq "LAND" })
if (@($landBranches).Count -gt 0) {
    Write-Host "LAND Candidates:" -ForegroundColor Green
    $landBranches | ForEach-Object {
        Write-Host "  ✅ $($_.Worktree) ($($_.Branch)) — $($_.FilesTouched) files" -ForegroundColor Green
    }
    Write-Host ""
}

# Show PAUSE candidates
$pauseBranches = @($inventory | Where-Object { $_.Category -eq "PAUSE" })
if (@($pauseBranches).Count -gt 0) {
    Write-Host "PAUSE Candidates:" -ForegroundColor Yellow
    $pauseBranches | ForEach-Object {
        Write-Host "  ⏸️  $($_.Worktree) ($($_.Branch)) — $($_.FilesTouched) files, $($_.DaysIdle)d old" -ForegroundColor Yellow
    }
    Write-Host ""
}

# Show DELETE candidates
$deleteBranches = @($inventory | Where-Object { $_.Category -eq "DELETE" })
if (@($deleteBranches).Count -gt 0) {
    Write-Host "DELETE Candidates ($(@($deleteBranches).Count)):" -ForegroundColor Red
    $deleteBranches | Select-Object -First 10 | ForEach-Object {
        Write-Host "  🗑️  $($_.Worktree) — $($_.DaysIdle)d old" -ForegroundColor Red
    }
    if (@($deleteBranches).Count -gt 10) {
        Write-Host "  ... and $(@($deleteBranches).Count - 10) more" -ForegroundColor Red
    }
    Write-Host ""
}

# Reduction estimate
$currentCount = $inventory.Count + 1  # +1 for shared checkout
$afterLanding = $currentCount - $categoryCounts["LAND"] - $categoryCounts["DELETE"]
$reduction = $currentCount - $afterLanding

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Phase 0 Reduction Estimate" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Current worktrees: $currentCount" -ForegroundColor Cyan
Write-Host "  After landing + cleanup: $afterLanding" -ForegroundColor Cyan
Write-Host "  Reduction: $reduction worktrees" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Goal: <15 worktrees" -ForegroundColor Cyan
if ($afterLanding -lt 15) {
    Write-Host "  Status: ✅ ACHIEVABLE" -ForegroundColor Green
} else {
    Write-Host "  Status: ⚠️  Need more cleanup" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Review $OutputFile" -ForegroundColor Cyan
Write-Host "  2. For each LAND branch: verify tests pass, merge to main" -ForegroundColor Cyan
Write-Host "  3. For each PAUSE branch: stash changes (git stash)" -ForegroundColor Cyan
Write-Host "  4. For each DELETE branch: confirm, then delete" -ForegroundColor Cyan
Write-Host ""
