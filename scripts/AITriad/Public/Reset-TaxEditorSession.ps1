# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Reset-TaxEditorSession {
    <#
    .SYNOPSIS
        Resets a user's taxonomy editor session branch to main.
    .DESCRIPTION
        Force-pushes the current main branch SHA to the user's
        api-session/{userId} branch, discarding all uncommitted edits.
        This is a destructive operation requiring confirmation.
        Requires GITHUB_TOKEN environment variable.
    .PARAMETER UserId
        The user ID whose session branch to reset.
    .PARAMETER Repo
        GitHub repo in owner/name format. Default: AI-Rosetta-Stone/ai-triad-data.
    .EXAMPLE
        Reset-TaxEditorSession -UserId 'jpsnover'
    .EXAMPLE
        Reset-TaxEditorSession -UserId 'jpsnover' -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$UserId,

        [Parameter()]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-data'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Reset-TaxEditorSession'
    $BranchRef = "heads/api-session/$UserId"

    # ── Verify session branch exists ─────────────────────────────────────
    try {
        $BranchInfo = Invoke-GitHubApi `
            -Endpoint "/repos/$Repo/git/ref/$BranchRef" `
            -CallerName $CallerName
    }
    catch {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Reset session for user '$UserId'" `
            -Problem "Session branch 'api-session/$UserId' does not exist" `
            -Location $CallerName `
            -NextSteps @('Verify the user ID is correct',
                         'The user may not have an active editing session'))
    }

    $SessionSha = $BranchInfo.object.sha

    # ── Get current main SHA ─────────────────────────────────────────────
    $MainRef = Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/git/ref/heads/main" `
        -CallerName $CallerName
    $MainSha = $MainRef.object.sha

    if ($SessionSha -eq $MainSha) {
        Write-Verbose "Session branch already at main ($($MainSha.Substring(0, 7))) — nothing to reset."
        [PSCustomObject]@{
            Action      = 'SessionReset'
            UserId      = $UserId
            Branch      = "api-session/$UserId"
            PreviousSha = $SessionSha.Substring(0, 7)
            NewSha      = $MainSha.Substring(0, 7)
            Changed     = $false
            Repo        = $Repo
            Timestamp   = (Get-Date).ToString('o')
        }
        return
    }

    # ── WhatIf / Confirm gate ────────────────────────────────────────────
    $ActionDesc = "Force-reset api-session/$UserId from $($SessionSha.Substring(0, 7)) to main ($($MainSha.Substring(0, 7))) — discards all uncommitted edits"
    if (-not $PSCmdlet.ShouldProcess($Repo, $ActionDesc)) {
        return
    }

    # ── Force-update session branch to main ──────────────────────────────
    Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/git/refs/$BranchRef" `
        -Method PATCH `
        -Body @{ sha = $MainSha; force = $true } `
        -CallerName $CallerName | Out-Null

    [PSCustomObject]@{
        Action      = 'SessionReset'
        UserId      = $UserId
        Branch      = "api-session/$UserId"
        PreviousSha = $SessionSha.Substring(0, 7)
        NewSha      = $MainSha.Substring(0, 7)
        Changed     = $true
        Repo        = $Repo
        Timestamp   = (Get-Date).ToString('o')
    }
}
