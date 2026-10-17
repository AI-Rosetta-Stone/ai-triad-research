# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-VerifiedMerge {
    <#
    .SYNOPSIS
        Merge a GitHub PR only after verifying headRefOid matches the actual remote tip.
    .DESCRIPTION
        Guards against GitHub's PR headRefOid cache lag (failure class: stale-head-merge,
        recurrences #701, #830, #1805). Compares `gh pr view --json headRefOid` with
        `git ls-remote origin <branch>`. If they differ, refuses to merge and prints both
        SHAs. If they match, invokes `gh pr merge` with any extra arguments supplied.

        Use this instead of bare `gh pr merge` for every self-merge to prevent stranded
        commits. When the guard fires, re-push the branch or wait 30-60 s for GitHub's
        PR cache to sync, then retry.
    .PARAMETER PrNumber
        GitHub PR number to merge.
    .PARAMETER MergeArgs
        Extra arguments passed through to gh pr merge (e.g. '--squash', '--delete-branch').
    .EXAMPLE
        Invoke-VerifiedMerge -PrNumber 1820
    .EXAMPLE
        Invoke-VerifiedMerge -PrNumber 1820 -MergeArgs '--squash','--delete-branch'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-GitHubHealth
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$PrNumber,

        [Parameter()]
        [string[]]$MergeArgs = @()
    )

    Set-StrictMode -Version Latest

    # ── Fetch PR metadata ────────────────────────────────────────────────────
    Write-Verbose "Fetching PR #$PrNumber metadata from GitHub..."
    $PrJson = gh pr view $PrNumber --json headRefOid,headRefName 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Verify PR #$PrNumber before merging" `
            -Problem "gh pr view failed: $PrJson" `
            -Location 'Invoke-VerifiedMerge' `
            -NextSteps 'Ensure gh is authenticated and the PR number is correct.')
    }
    $Pr = $PrJson | ConvertFrom-Json
    $CachedOid = $Pr.headRefOid
    $Branch = $Pr.headRefName

    # ── Fetch actual remote tip ──────────────────────────────────────────────
    Write-Verbose "Resolving remote tip for origin/$Branch via git ls-remote..."
    $LsOutput = git ls-remote origin "refs/heads/$Branch" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Verify PR #$PrNumber before merging" `
            -Problem "git ls-remote failed: $LsOutput" `
            -Location 'Invoke-VerifiedMerge' `
            -NextSteps 'Ensure the git remote is reachable and you are authenticated.')
    }

    # ls-remote output: "<sha>\trefs/heads/<branch>", or empty if branch is gone
    $RemoteOid = if ($LsOutput) { ($LsOutput -split '\s+')[0].Trim() } else { '' }

    if (-not $RemoteOid) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Verify PR #$PrNumber before merging" `
            -Problem "Branch '$Branch' not found on origin (ls-remote returned empty)." `
            -Location 'Invoke-VerifiedMerge' `
            -NextSteps 'Confirm the branch has been pushed to origin before merging.')
    }

    # ── Guard: refuse when SHAs differ (stale-head-merge prevention) ─────────
    if ($CachedOid -ne $RemoteOid) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Merge PR #$PrNumber without stranding commits" `
            -Problem ("PR headRefOid cache lag detected — cached and actual tips differ.`n" +
                      "  PR cached (gh):    $CachedOid`n" +
                      "  Remote actual:     $RemoteOid") `
            -Location 'Invoke-VerifiedMerge' `
            -NextSteps ("Re-push the branch or wait 30-60 s for GitHub's PR cache to sync, " +
                        'then retry Invoke-VerifiedMerge.'))
    }

    Write-Verbose "SHAs match ($CachedOid) — safe to merge."

    # ── Merge ────────────────────────────────────────────────────────────────
    if ($PSCmdlet.ShouldProcess("PR #$PrNumber ($Branch @ $CachedOid)", 'gh pr merge')) {
        $MergeOutput = gh pr merge $PrNumber @MergeArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Merge PR #$PrNumber" `
                -Problem "gh pr merge exited ${LASTEXITCODE}: $MergeOutput" `
                -Location 'Invoke-VerifiedMerge' `
                -NextSteps 'Check PR status: required reviews, conflicts, branch protection rules.')
        }
        Write-Verbose 'Merge complete.'
    }

    [PSCustomObject]@{
        PrNumber  = $PrNumber
        Branch    = $Branch
        MergedOid = $CachedOid
        Verified  = $true
    }
}
