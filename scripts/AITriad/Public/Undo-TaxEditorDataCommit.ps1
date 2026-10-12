# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Undo-TaxEditorDataCommit {
    <#
    .SYNOPSIS
        Reverts a specific commit in the taxonomy data repository.
    .DESCRIPTION
        Creates a new revert commit via the GitHub API that undoes the changes
        from a specific commit. Never force-pushes. Detects conflicts when the
        same files have been modified in later commits.
        Requires GITHUB_TOKEN environment variable.
    .PARAMETER Sha
        The full or short SHA of the commit to revert.
    .PARAMETER Repo
        GitHub repo in owner/name format. Default: AI-Rosetta-Stone/ai-triad-data.
    .EXAMPLE
        Undo-TaxEditorDataCommit -Sha 'abc1234'
    .EXAMPLE
        Undo-TaxEditorDataCommit -Sha 'abc1234' -WhatIf
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
        [string]$Sha,

        [Parameter()]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-data'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Undo-TaxEditorDataCommit'

    # ── Get the commit to revert ─────────────────────────────────────────
    $Commit = Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/commits/$Sha" `
        -CallerName $CallerName

    $Parents = @($Commit.parents)
    if ($Parents.Count -ne 1) {
        throw (New-ActionableError `
            -Goal "Revert commit '$Sha'" `
            -Problem "Cannot revert merge commits ($($Parents.Count) parents)" `
            -Location $CallerName `
            -NextSteps @('Revert each parent commit individually',
                         'Or revert via git CLI: git revert -m 1 <sha>'))
    }

    $ParentSha = $Parents[0].sha
    $CommitMsg = ($Commit.commit.message -split "`n")[0]
    $ChangedFiles = @($Commit.files)

    if ($ChangedFiles.Count -eq 0) {
        throw (New-ActionableError `
            -Goal "Revert commit '$Sha'" `
            -Problem 'Commit has no file changes to revert' `
            -Location $CallerName `
            -NextSteps @('Verify the SHA is correct: Get-TaxEditorDataCommit'))
    }

    # ── Detect conflicts with subsequent commits ─────────────────────────
    $HeadRef = Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/git/ref/heads/main" `
        -CallerName $CallerName
    $HeadSha = $HeadRef.object.sha

    if ($HeadSha -ne $Commit.sha) {
        $Comparison = Invoke-GitHubApi `
            -Endpoint "/repos/$Repo/compare/$($Commit.sha)...$HeadSha" `
            -CallerName $CallerName

        $SubsequentFiles = @($Comparison.files | ForEach-Object { $_.filename })
        $RevertFiles = @($ChangedFiles | ForEach-Object { $_.filename })
        $Conflicts = @($RevertFiles | Where-Object { $_ -in $SubsequentFiles })

        if (@($Conflicts).Count -gt 0) {
            throw (New-ActionableError `
                -Goal "Revert commit '$Sha'" `
                -Problem "Conflict: files modified in both the target and later commits: $($Conflicts -join ', ')" `
                -Location $CallerName `
                -NextSteps @('Revert manually: git revert <sha>',
                             'Or revert newer commits first'))
        }
    }

    # ── WhatIf / Confirm gate ────────────────────────────────────────────
    $ShortSha = $Commit.sha.Substring(0, 7)
    if (-not $PSCmdlet.ShouldProcess($Repo,
        "Revert commit $ShortSha`: '$CommitMsg' ($($ChangedFiles.Count) file(s))")) {
        return
    }

    # ── Build revert tree ────────────────────────────────────────────────
    $HeadCommit = Invoke-GitHubApi `
        -Endpoint "/repos/$Repo/git/commits/$HeadSha" `
        -CallerName $CallerName
    $BaseTreeSha = $HeadCommit.tree.sha

    $TreeEntries = [System.Collections.Generic.List[hashtable]]::new()
    $NeedFullTree = $false

    foreach ($File in $ChangedFiles) {
        switch ($File.status) {
            'added' {
                $NeedFullTree = $true
            }
            { $_ -in 'removed', 'modified' } {
                $ParentContents = Invoke-GitHubApi `
                    -Endpoint "/repos/$Repo/contents/$($File.filename)?ref=$ParentSha" `
                    -CallerName $CallerName
                $TreeEntries.Add(@{
                    path = $File.filename
                    mode = '100644'
                    type = 'blob'
                    sha  = $ParentContents.sha
                })
            }
            'renamed' {
                $NeedFullTree = $true
            }
        }
    }

    if ($NeedFullTree) {
        $FullTree = Invoke-GitHubApi `
            -Endpoint "/repos/$Repo/git/trees/${BaseTreeSha}?recursive=1" `
            -CallerName $CallerName

        $AddedFiles = @($ChangedFiles | Where-Object { $_.status -eq 'added' } |
            ForEach-Object { $_.filename })
        $RenamedNew = @($ChangedFiles | Where-Object { $_.status -eq 'renamed' } |
            ForEach-Object { $_.filename })
        $SkipPaths = $AddedFiles + $RenamedNew

        $AllEntries = [System.Collections.Generic.List[hashtable]]::new()

        foreach ($Entry in $FullTree.tree) {
            if ($Entry.type -ne 'blob') { continue }
            if ($Entry.path -in $SkipPaths) { continue }

            $Override = $null
            foreach ($Te in $TreeEntries) {
                if ($Te.path -eq $Entry.path) { $Override = $Te; break }
            }

            if ($Override) {
                $AllEntries.Add($Override)
            }
            else {
                $AllEntries.Add(@{
                    path = $Entry.path
                    mode = $Entry.mode
                    type = 'blob'
                    sha  = $Entry.sha
                })
            }
        }

        # Restore files that were removed or renamed away in the original commit
        foreach ($File in $ChangedFiles) {
            $RestorePath = $null
            if ($File.status -eq 'removed') { $RestorePath = $File.filename }
            if ($File.status -eq 'renamed' -and $File.PSObject.Properties['previous_filename']) {
                $RestorePath = $File.previous_filename
            }
            if ($RestorePath) {
                $Already = $false
                foreach ($E in $AllEntries) {
                    if ($E.path -eq $RestorePath) { $Already = $true; break }
                }
                if (-not $Already) {
                    $ParentContents = Invoke-GitHubApi `
                        -Endpoint "/repos/$Repo/contents/${RestorePath}?ref=$ParentSha" `
                        -CallerName $CallerName
                    $AllEntries.Add(@{
                        path = $RestorePath
                        mode = '100644'
                        type = 'blob'
                        sha  = $ParentContents.sha
                    })
                }
            }
        }

        $NewTree = Invoke-GitHubApi -Endpoint "/repos/$Repo/git/trees" `
            -Method POST -Body @{ tree = @($AllEntries) } `
            -CallerName $CallerName
    }
    else {
        $NewTree = Invoke-GitHubApi -Endpoint "/repos/$Repo/git/trees" `
            -Method POST -Body @{ base_tree = $BaseTreeSha; tree = @($TreeEntries) } `
            -CallerName $CallerName
    }

    # ── Create revert commit ─────────────────────────────────────────────
    $NewCommit = Invoke-GitHubApi -Endpoint "/repos/$Repo/git/commits" `
        -Method POST -Body @{
            message = "Revert: $CommitMsg`n`nReverts commit $($Commit.sha)."
            tree    = $NewTree.sha
            parents = @($HeadSha)
        } `
        -CallerName $CallerName

    # ── Fast-forward main ref ────────────────────────────────────────────
    Invoke-GitHubApi -Endpoint "/repos/$Repo/git/refs/heads/main" `
        -Method PATCH -Body @{ sha = $NewCommit.sha; force = $false } `
        -CallerName $CallerName | Out-Null

    [PSCustomObject]@{
        Action      = 'DataRevert'
        RevertedSha = $Commit.sha
        RevertedMsg = $CommitMsg
        NewSha      = $NewCommit.sha
        Repo        = $Repo
        Timestamp   = (Get-Date).ToString('o')
    }
}
