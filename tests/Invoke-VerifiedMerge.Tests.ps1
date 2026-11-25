# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Invoke-VerifiedMerge (t/558): deprecated, merges nothing, names enqueue-pr.mjs.

.NOTES
    The cmdlet used to run `gh pr merge` (t/3225). That is a merge path outside the merge
    queue, so it now refuses every call. These tests fail on the old cmdlet: it called gh and
    git, and it did not name enqueue-pr.mjs.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-VerifiedMerge: export and parameters' -Tag 'devops', 'ci' {

    It 'Is still exported from the module, so an old call fails with the message, not CommandNotFound' {
        Get-Command Invoke-VerifiedMerge -Module AITriad | Should -Not -BeNullOrEmpty
    }

    It 'Requires -PrNumber' {
        (Get-Command Invoke-VerifiedMerge).Parameters['PrNumber'].Attributes.Where({ $_ -is [Parameter] }).Mandatory | Should -BeTrue
    }

    It 'Rejects PrNumber 0 and a negative PrNumber' {
        { Invoke-VerifiedMerge -PrNumber 0 } | Should -Throw
        { Invoke-VerifiedMerge -PrNumber -1 } | Should -Throw
    }

    It 'Still binds -MergeArgs and -WhatIf' {
        $P = (Get-Command Invoke-VerifiedMerge).Parameters
        $P.ContainsKey('MergeArgs') | Should -BeTrue
        $P.ContainsKey('WhatIf') | Should -BeTrue
    }
}

Describe 'Invoke-VerifiedMerge: refuses and merges nothing' -Tag 'devops', 'ci' {

    BeforeAll {
        # Any call to gh or git from the cmdlet is a failure of this change.
        Mock -ModuleName AITriad gh { throw 'gh must not be called' }
        Mock -ModuleName AITriad git { throw 'git must not be called' }
    }

    It 'Throws an actionable error that names enqueue-pr.mjs with the PR number' {
        $Err = $null
        try { Invoke-VerifiedMerge -PrNumber 1820 3>$null } catch { $Err = $_ }
        $Err | Should -Not -BeNullOrEmpty
        $Text = "$Err"
        $Text | Should -Match 'node operations/devops/enqueue-pr\.mjs <owner>/<repo> 1820'
        $Text | Should -Match 'Goal'
        $Text | Should -Match 'Resolve:'
        $Text | Should -Not -Match 'gh must not be called'
    }

    It 'Calls neither gh nor git' {
        try { Invoke-VerifiedMerge -PrNumber 1820 3>$null } catch { $null = $_ }
        Should -Invoke -ModuleName AITriad gh -Times 0 -Exactly
        Should -Invoke -ModuleName AITriad git -Times 0 -Exactly
    }

    It 'Refuses with the old merge arguments too' {
        { Invoke-VerifiedMerge -PrNumber 1820 -MergeArgs '--squash', '--delete-branch' 3>$null } | Should -Throw '*enqueue-pr.mjs*'
        Should -Invoke -ModuleName AITriad gh -Times 0 -Exactly
    }

    It 'Refuses under -WhatIf: there is no merge left to preview' {
        { Invoke-VerifiedMerge -PrNumber 1820 -WhatIf 3>$null } | Should -Throw '*enqueue-pr.mjs*'
    }

    It 'Warns that it is deprecated' {
        $Warnings = @()
        try { Invoke-VerifiedMerge -PrNumber 7 -WarningVariable Warnings 3>$null } catch { $null = $_ }
        ($Warnings -join ' ') | Should -Match 'deprecated'
        ($Warnings -join ' ') | Should -Match 'enqueue-pr\.mjs <owner>/<repo> 7'
    }

    It 'Its help no longer tells anyone to use it to merge' {
        $Help = Get-Help Invoke-VerifiedMerge -Full | Out-String
        $Help | Should -Match 'DEPRECATED'
        $Help | Should -Match 'enqueue-pr\.mjs'
        $Help | Should -Not -Match 'Use this instead of bare'
    }
}
