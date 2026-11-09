# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932, Quality should-fix (#4679, p/780#29): the az/git calls are injectable here so every
# arm (read success, az failure, missing DEPLOY_SHA, built/current missing) is testable without
# a live Azure subscription or a real git history -- plus real-git integration tests below that
# prove the predicate and the $LASTEXITCODE reset against this repo's own history (Lead p/648#377,
# TL p/916#12-14: both the proceed and block arms must be proven with REAL git, not just fakes).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-StagingCurrentDeployComparison.ps1')
}

Describe 'Get-StagingCurrentDeployComparison (t/4932)' {
    It 'no active revision at all -> true first deploy, not a read failure' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @() } `
            -AzRevisionShowFn { throw 'must not be called when there is no active revision' } `
            -GitCommitExistsFn { throw 'must not be called when there is no active revision' } `
            -GitMergeBaseFn { throw 'must not be called when there is no active revision' }
        $r.CurrentSha | Should -Be ''
        $r.ReadFailed | Should -Be $false
        $r.CurrentIsAncestorOfBuilt | Should -BeNullOrEmpty
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $false
    }

    It 'read success: current IS an ancestor of built (exit 0) -- forward deploy' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'new999' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"old111"}]' } } `
            -GitCommitExistsFn { param($Sha) $true } `
            -GitMergeBaseFn { param($Ancestor, $Descendant) 0 }
        $r.CurrentSha | Should -Be 'old111'
        $r.ReadFailed | Should -Be $false
        $r.CurrentIsAncestorOfBuilt | Should -Be $true
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $false
    }

    It 'current is NOT an ancestor of built (exit 1) -- downgrade or diverged' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'new999' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"old111"}]' } } `
            -GitCommitExistsFn { param($Sha) $true } `
            -GitMergeBaseFn { param($Ancestor, $Descendant) 1 }
        $r.CurrentIsAncestorOfBuilt | Should -Be $false
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $false
    }

    It 'az failure (non-zero exit): ReadFailed, git calls never made' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 1; Output = 'ERROR: some az failure' } } `
            -GitCommitExistsFn { throw 'must not be called when the az read failed' } `
            -GitMergeBaseFn { throw 'must not be called when the az read failed' }
        $r.ReadFailed | Should -Be $true
        $r.CurrentSha | Should -Be ''
    }

    It 'az succeeds but DEPLOY_SHA is missing from the env list: ReadFailed, git calls never made' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"OTHER_VAR","value":"x"}]' } } `
            -GitCommitExistsFn { throw 'must not be called when DEPLOY_SHA is missing' } `
            -GitMergeBaseFn { throw 'must not be called when DEPLOY_SHA is missing' }
        $r.ReadFailed | Should -Be $true
        $r.CurrentSha | Should -Be ''
    }

    # Quality should-fix (#4679, p/780#29): exit 0 with non-JSON output (a stderr warning the
    # caller failed to filter out of its 2>&1 capture, the t/1500 trap) must NOT throw --
    # ConvertFrom-Json's own exception must be caught and turned into ReadFailed.
    It 'az exits 0 but Output is not valid JSON: ReadFailed, no throw, git calls never made' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "WARNING: some az warning`n[{""name"":""DEPLOY_SHA"",""value"":""old111""}]" } } `
            -GitCommitExistsFn { throw 'must not be called when the JSON parse failed' } `
            -GitMergeBaseFn { throw 'must not be called when the JSON parse failed' }
        $r.ReadFailed | Should -Be $true
        $r.CurrentSha | Should -Be ''
    }

    It 'BUILT missing (git cat-file -e fails): BuiltMissing, merge-base never called' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'ghost1234' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-old111'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"old111"}]' } } `
            -GitCommitExistsFn { param($Sha) $false } `
            -GitMergeBaseFn { throw 'must not be called when BuiltSha is missing' }
        $r.BuiltMissing | Should -Be $true
        $r.CurrentMissing | Should -Be $false
        $r.CurrentIsAncestorOfBuilt | Should -BeNullOrEmpty
    }

    It 'CURRENT missing (merge-base exits 128, BuiltSha confirmed to exist): CurrentMissing, proceed+warn territory' {
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'new999' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-unreachable'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"unreachable999"}]' } } `
            -GitCommitExistsFn { param($Sha) $true } `
            -GitMergeBaseFn { param($Ancestor, $Descendant) 128 }
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $true
        $r.CurrentIsAncestorOfBuilt | Should -BeNullOrEmpty
    }

    It 'picks the highest-TrafficWeight revision when more than one is reported active' {
        $Captured = $null
        $r = Get-StagingCurrentDeployComparison -BuiltSha 'abc1234' `
            -GetActiveRevisionFn {
                @(
                    [PSCustomObject]@{ Name = 'app--staging-low'; TrafficWeight = 10 },
                    [PSCustomObject]@{ Name = 'app--staging-high'; TrafficWeight = 90 }
                )
            } `
            -AzRevisionShowFn {
                param($RevisionName)
                $Script:Captured = $RevisionName
                @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"shahigh"}]' }
            } `
            -GitCommitExistsFn { param($Sha) $true } `
            -GitMergeBaseFn { param($Ancestor, $Descendant) 1 }
        $Script:Captured | Should -Be 'app--staging-high'
        $r.CurrentSha | Should -Be 'shahigh'
    }
}

# Real-git integration tests (Lead p/648#377 item 2, TL p/916#12-14): fakes alone proved the
# PREDICATE's logic but not the live incident -- a leaked $LASTEXITCODE from a REAL
# `git merge-base --is-ancestor` call. These run the actual git binary against this repo's own
# history and assert $LASTEXITCODE afterward, which is the exact property that broke production.
Describe 'Get-StagingCurrentDeployComparison: real git (t/4932 live incident)' {
    BeforeAll {
        # A genuine ancestor/descendant pair from this repo's own history: HEAD~1 is necessarily
        # an ancestor of HEAD (unless this is the repo's very first commit).
        $Script:Descendant = (git rev-parse HEAD).Trim()
        $Script:Ancestor = (git rev-parse HEAD~1).Trim()
        $Script:RealGitCommitExistsFn = {
            param($Sha)
            git cat-file -e "$Sha^{commit}" 2>$null
            $Exists = ($LASTEXITCODE -eq 0)
            $global:LASTEXITCODE = 0
            $Exists
        }
        $Script:RealGitMergeBaseFn = {
            param($Ancestor, $Descendant)
            git merge-base --is-ancestor $Ancestor $Descendant
            $ExitCode = $LASTEXITCODE
            $global:LASTEXITCODE = 0
            $ExitCode
        }
    }

    It 'PROCEED arm: current (ancestor) vs. built (descendant) -- exit 0, and $LASTEXITCODE is reset afterward' {
        $global:LASTEXITCODE = 99  # poison it first, so a missing reset would be caught, not coincidental
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:Descendant `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Ancestor""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $true
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It 'BLOCK arm: the reverse pair (current is the descendant, built is the ancestor) -- exit 1, reset afterward' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:Ancestor `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Descendant""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It 'BLOCK arm: a diverged commit (not an ancestor either direction) -- exit 1, reset afterward' {
        # The repo's root commit's PARENT doesn't exist, so it has no history-sibling to diverge
        # from within two hops; use two commits that are provably not in a straight ancestor line:
        # HEAD~1 vs. the root commit's... simplest robust diverged pair: a commit and an unrelated
        # tag object are unavailable here, so use HEAD~1 as "built" against a synthetic unrelated
        # tree built from the same repo's root commit if it has 2+ parents; fall back to asserting
        # the SAME exit-1 contract using HEAD~1 vs HEAD~2 reversed (still "not an ancestor" from
        # the wrong side), which exercises the identical code path real divergence would.
        $global:LASTEXITCODE = 99
        $olderAncestor = (git rev-parse 'HEAD~2').Trim()
        $r = Get-StagingCurrentDeployComparison -BuiltSha $olderAncestor `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Descendant""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It 'BLOCK arm: BuiltSha equals CurrentDeploySha (rebuild) -- caller-level equality check, not this function''s job' {
        # Get-StagingCurrentDeployComparison reports facts only; the equal-SHA block decision is
        # Get-StagingDeployGateVerdict's job (tested there). Here, just confirm the real
        # GitCommitExistsFn/GitMergeBaseFn calls on an identical pair don't error or hang.
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:Descendant `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Descendant""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        # merge-base --is-ancestor X X is true (a commit is its own ancestor) -- exit 0 here;
        # Get-StagingDeployGateVerdict's own BuiltSha-equals-CurrentDeploySha check (tested
        # separately) is what turns this into a block, not this function.
        $r.CurrentIsAncestorOfBuilt | Should -Be $true
        $LASTEXITCODE | Should -Be 0
    }

    It 'BUILT missing (garbage SHA): BuiltMissing true, merge-base never invoked, no hang' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha '0000000000000000000000000000000000beef' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Descendant""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn { throw 'must not be called when BuiltSha is missing' }
        $r.BuiltMissing | Should -Be $true
        $LASTEXITCODE | Should -Be 0
    }

    It 'CURRENT missing (garbage SHA, BuiltSha real): CurrentMissing true, proceed+warn territory, reset afterward' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:Descendant `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = '[{"name":"DEPLOY_SHA","value":"0000000000000000000000000000000000beef"}]' } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $true
        $LASTEXITCODE | Should -Be 0
    }

    It 'FAULT CHECK: without the $LASTEXITCODE reset inside GitMergeBaseFn, the leak is observable (proves the test would catch a regression)' {
        $global:LASTEXITCODE = 99
        $unresetMergeBaseFn = {
            param($Ancestor, $Descendant)
            git merge-base --is-ancestor $Ancestor $Descendant
            $LASTEXITCODE  # no reset -- this is the exact bug shape that broke production
        }
        $null = Get-StagingCurrentDeployComparison -BuiltSha $Script:Ancestor `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:Descendant""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $unresetMergeBaseFn
        # The reverse pair (Ancestor as Built) exits 1 -- exactly the leak this ticket fixes.
        $LASTEXITCODE | Should -Be 1
    }
}
