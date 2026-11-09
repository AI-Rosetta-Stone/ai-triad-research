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
# `git merge-base --is-ancestor` call. These run the actual git binary.
#
# CI FAILURE (test-powershell shard 5, run on PR #4694; Docker p/916#21): the original version
# used THIS repo's own ambient checkout (HEAD/HEAD~1/HEAD~2) as the ancestor/descendant pair.
# That assumes a deep clone -- true in a local worktree, but ci.yml's `test-powershell` job's
# `actions/checkout` has no `fetch-depth` set, which defaults to a SHALLOW depth-1 clone.
# `git rev-parse HEAD~1` then fails outright ("fatal: ambiguous argument"), every downstream
# assertion saw $null instead of true/false, and the job failed -- a real bug in the test's
# environment assumption, not a flaky rerun, and not a reason to deepen CI's checkout (TL,
# p/916#22). Fixed by never depending on the ambient checkout's depth at all: `git init` a small,
# disposable repo in a temp directory with commits A -> B -> C on main, plus a branch D off A
# (diverged from both B and C), and point every real git call at it with `-C`, so the test is
# deterministic regardless of how this repo itself was checked out.
Describe 'Get-StagingCurrentDeployComparison: real git (t/4932 live incident)' {
    BeforeAll {
        $Script:RepoPath = Join-Path ([System.IO.Path]::GetTempPath()) "t4932-realgit-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $Script:RepoPath -Force | Out-Null
        git -C $Script:RepoPath init -q -b main
        git -C $Script:RepoPath config user.email 'test@example.com'
        git -C $Script:RepoPath config user.name 'Pester'

        Set-Content -Path (Join-Path $Script:RepoPath 'a.txt') -Value 'a'
        git -C $Script:RepoPath add a.txt
        git -C $Script:RepoPath commit -q -m 'A'
        $Script:A = (git -C $Script:RepoPath rev-parse HEAD).Trim()

        Set-Content -Path (Join-Path $Script:RepoPath 'b.txt') -Value 'b'
        git -C $Script:RepoPath add b.txt
        git -C $Script:RepoPath commit -q -m 'B'
        $Script:B = (git -C $Script:RepoPath rev-parse HEAD).Trim()  # A's direct child on main

        Set-Content -Path (Join-Path $Script:RepoPath 'c.txt') -Value 'c'
        git -C $Script:RepoPath add c.txt
        git -C $Script:RepoPath commit -q -m 'C'
        $Script:C = (git -C $Script:RepoPath rev-parse HEAD).Trim()  # B's direct child on main

        git -C $Script:RepoPath checkout -q -b side $Script:A
        Set-Content -Path (Join-Path $Script:RepoPath 'd.txt') -Value 'd'
        git -C $Script:RepoPath add d.txt
        git -C $Script:RepoPath commit -q -m 'D'
        $Script:D = (git -C $Script:RepoPath rev-parse HEAD).Trim()  # branched off A -- diverged from B and C

        $Script:RealGitCommitExistsFn = {
            param($Sha)
            git -C $Script:RepoPath cat-file -e "$Sha^{commit}" 2>$null
            $Exists = ($LASTEXITCODE -eq 0)
            $global:LASTEXITCODE = 0
            $Exists
        }
        $Script:RealGitMergeBaseFn = {
            param($Ancestor, $Descendant)
            git -C $Script:RepoPath merge-base --is-ancestor $Ancestor $Descendant
            $ExitCode = $LASTEXITCODE
            $global:LASTEXITCODE = 0
            $ExitCode
        }
    }

    AfterAll {
        if ($Script:RepoPath -and (Test-Path $Script:RepoPath)) {
            Remove-Item -Path $Script:RepoPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'PROCEED arm: (current=B, built=C) -- B is an ancestor of C, exit 0, $LASTEXITCODE reset afterward' {
        $global:LASTEXITCODE = 99  # poison it first, so a missing reset would be caught, not coincidental
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:C `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:B""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $true
        $r.BuiltMissing | Should -Be $false
        $r.CurrentMissing | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It 'BLOCK arm: (current=C, built=B) -- downgrade, C is NOT an ancestor of B, exit 1, reset afterward' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:B `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:C""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It 'BLOCK arm: (current=C, built=D) -- genuinely diverged branch, exit 1, reset afterward' {
        # D is branched off A, a common ancestor of C -- but D and C are siblings down two
        # different lines, so neither is an ancestor of the other. The real shape of a branch
        # build off an older base (the exact case the TL's flipped-direction fix, p/916#14,
        # exists to block, since "not an ancestor" alone can't tell this apart from a downgrade).
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:D `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:C""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        $r.CurrentIsAncestorOfBuilt | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }

    It '(current=C, built=C) -- same SHA: a real self-ancestor merge-base call still runs cleanly (the rebuild skip is the verdict function''s job, tested there)' {
        # Get-StagingCurrentDeployComparison reports facts only; the equal-SHA block decision is
        # Get-StagingDeployGateVerdict's job (tested there). Here, just confirm the real
        # GitCommitExistsFn/GitMergeBaseFn calls on an identical pair don't error or hang.
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:C `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:C""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $Script:RealGitMergeBaseFn
        # merge-base --is-ancestor X X is true (a commit is its own ancestor) -- exit 0 here.
        $r.CurrentIsAncestorOfBuilt | Should -Be $true
        $LASTEXITCODE | Should -Be 0
    }

    It 'BUILT missing (nonexistent SHA): BuiltMissing true, merge-base never invoked, no hang' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha '0000000000000000000000000000000000beef' `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:C""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn { throw 'must not be called when BuiltSha is missing' }
        $r.BuiltMissing | Should -Be $true
        $LASTEXITCODE | Should -Be 0
    }

    It 'CURRENT missing (nonexistent SHA, BuiltSha real): CurrentMissing true, proceed+warn territory, reset afterward' {
        $global:LASTEXITCODE = 99
        $r = Get-StagingCurrentDeployComparison -BuiltSha $Script:C `
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
            git -C $Script:RepoPath merge-base --is-ancestor $Ancestor $Descendant
            $LASTEXITCODE  # no reset -- this is the exact bug shape that broke production
        }
        $null = Get-StagingCurrentDeployComparison -BuiltSha $Script:B `
            -GetActiveRevisionFn { @([PSCustomObject]@{ Name = 'app--staging-current'; TrafficWeight = 100 }) } `
            -AzRevisionShowFn { param($RevisionName) @{ ExitCode = 0; Output = "[{""name"":""DEPLOY_SHA"",""value"":""$Script:C""}]" } } `
            -GitCommitExistsFn $Script:RealGitCommitExistsFn `
            -GitMergeBaseFn $unresetMergeBaseFn
        # (current=C, built=B) is the downgrade pair -- exits 1, exactly the leak this ticket fixes.
        $LASTEXITCODE | Should -Be 1
    }
}
