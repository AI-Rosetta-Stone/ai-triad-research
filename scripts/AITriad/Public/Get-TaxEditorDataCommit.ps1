# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TaxEditorDataCommit {
    <#
    .SYNOPSIS
        Lists recent commits in the taxonomy data repository.
    .DESCRIPTION
        Queries the GitHub API for recent commits in AI-Rosetta-Stone/ai-triad-data.
        Returns typed DataCommit objects with SHA, message, author, and date.
        Requires GITHUB_TOKEN environment variable.
    .PARAMETER Last
        Number of commits to return (1-100). Default: 20.
    .PARAMETER Repo
        GitHub repo in owner/name format. Default: AI-Rosetta-Stone/ai-triad-data.
    .EXAMPLE
        Get-TaxEditorDataCommit -Last 5
    .EXAMPLE
        Get-TaxEditorDataCommit | Where-Object Message -like '*migration*'
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [ValidateRange(1, 100)]
        [int]$Last = 20,

        [Parameter()]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-data'
    )

    Set-StrictMode -Version Latest

    $Commits = Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/commits?per_page=$Last" `
        -CallerName 'Get-TaxEditorDataCommit'

    foreach ($C in $Commits) {
        $Obj = [DataCommit]::new()
        $Obj.Sha     = $C.sha
        $Obj.ShortSha = $C.sha.Substring(0, 7)
        $Obj.Message = ($C.commit.message -split "`n")[0]
        $Obj.Author  = $C.commit.author.name
        $Obj.Date    = $C.commit.author.date
        $Obj
    }
}
