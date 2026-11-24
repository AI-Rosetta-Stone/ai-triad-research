# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-VerifiedMerge {
    <#
    .SYNOPSIS
        DEPRECATED. Does not merge: refuses and names the one supported way to land a PR.
    .DESCRIPTION
        This cmdlet used to run `gh pr merge` after checking the PR's head against the remote
        branch (t/3225). That is a merge path outside the merge queue: it skips the approval
        check and the gate-file check that `operations/devops/enqueue-pr.mjs` makes (t/537,
        t/558). The rule is never `gh pr merge` in any form.

        It now makes no `gh` or `git` call and merges nothing. Every call fails with an error
        that names the command to run instead, from a checkout at origin/main:

            node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>

        `enqueue-pr.mjs` pins the PR's head when it enqueues, which is the stale-head
        protection this cmdlet existed for. The name and parameters are kept so an old call
        fails with this message, not with a binding error.
    .PARAMETER PrNumber
        GitHub PR number. Used only in the error message.
    .PARAMETER MergeArgs
        Ignored. Kept so existing calls still bind.
    .EXAMPLE
        Invoke-VerifiedMerge -PrNumber 1820
        Fails, and names: node operations/devops/enqueue-pr.mjs <owner>/<repo> 1820
    .LINK
        Show-AITriadHelp
    .LINK
        Test-GitHubHealth
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([void])]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$PrNumber,

        [Parameter()]
        [string[]]$MergeArgs = @()
    )

    Set-StrictMode -Version Latest

    $Command = "node operations/devops/enqueue-pr.mjs <owner>/<repo> $PrNumber"
    Write-Warning "Invoke-VerifiedMerge is deprecated and merges nothing (t/558). Use: $Command"
    # Refuses under -WhatIf as well: there is no merge left to preview.
    throw (New-ActionableError -AsErrorRecord `
        -Goal "Land PR #$PrNumber" `
        -Problem ('Invoke-VerifiedMerge no longer merges. It ran gh pr merge, which lands a PR outside ' +
                  'the merge queue and skips the approval and gate-file checks.') `
        -Location 'Invoke-VerifiedMerge' `
        -NextSteps @(
            "From a checkout at origin/main, run: $Command",
            'If it refuses, stop and escalate; do not fall back to gh pr merge (docs/pr-landing.md).'
        ))
}
