# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4194, SO condition C3 (p/682#16): a git ERROR exit code (128+) must never be read as "not an
# ancestor" (exit 1) — those are different things and conflating them refuses a deploy on a git
# hiccup, not a real older-commit case.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-DeployAgeVerdict.ps1')
}

Describe 'Get-DeployAgeVerdict' {
    It 'no active prod revision (first deploy) -> proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName '' -MergeBaseExitCode $null
        $v.Action | Should -Be 'proceed'
        $v.Reason | Should -Be 'no-active-prod-revision'
    }

    It 'exit 0 (is-ancestor) -> proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 0
        $v.Action | Should -Be 'proceed'
        $v.Reason | Should -Be 'is-ancestor'
    }

    It 'FIRE ARM: exit 1 (confirmed NOT an ancestor) -> refuse' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 1
        $v.Action | Should -Be 'refuse'
        $v.Reason | Should -Be 'not-ancestor-older-deploy'
        $v.RunningShort | Should -Be '7eb71fb'
    }

    It 'SO C3 FIX: exit 128 (a real git ERROR, e.g. a bad ref) -> warn-proceed, NOT refuse' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 128
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'git-error-exit-128'
    }

    It 'an unparseable revision name -> warn-proceed (fail open), regardless of exit code' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'some-hand-created-revision' -MergeBaseExitCode 1
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'unparseable-revision-name'
    }

    It 'a parseable name but an unresolvable SHA (merge-base never ran) -> warn-proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode $null
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'unresolvable-sha'
    }
}

# t/670 (t/579; TL p/9#660, DeployAzure p/227#27): a hotfix built off a side branch whose changes
# reached main as separately SQUASHED PRs is never an ancestor of main. When the requested SHA is
# not a descendant, the deploy proceeds only if `git diff <merge-base> <running>` reverse-applies
# onto the requested tree. Every other case refuses, naming the files.
Describe 'Get-DeployAgeVerdict: containment when not a descendant (t/670)' {
    It 'exit 1 + contained -> proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7e6241b-1' -MergeBaseExitCode 1 -Containment ([pscustomobject]@{ Contained = $true; Error = $null; Files = @('a') })
        $v.Action | Should -Be 'proceed'
        $v.Reason | Should -Be 'not-ancestor-but-changes-contained'
    }
    It 'exit 1 + not contained, + an unverifiable check, + no check at all -> refuse (fail closed)' {
        foreach ($c in @([pscustomobject]@{ Contained = $false; Error = $null; Files = @('x.ts') }, [pscustomobject]@{ Contained = $false; Error = 'no merge-base'; Files = @() }, $null)) {
            $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7e6241b-1' -MergeBaseExitCode 1 -Containment $c
            $v.Action | Should -Be 'refuse'
            $v.Reason | Should -Be 'not-ancestor-older-deploy'
        }
    }
    It 'containment is never consulted for exit 0 or a git error' {
        $c = [pscustomobject]@{ Contained = $false; Error = 'x'; Files = @() }
        (Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7e6241b-1' -MergeBaseExitCode 0 -Containment $c).Action | Should -Be 'proceed'
        (Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7e6241b-1' -MergeBaseExitCode 128 -Containment $c).Action | Should -Be 'warn-proceed'
    }
}

Describe 'Test-DeployChangesContained against a real scratch repo (t/670)' {
    BeforeAll {
        $script:repo = Join-Path ([System.IO.Path]::GetTempPath()) ("t670-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $script:repo | Out-Null
        function script:G { & git -C $script:repo @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" } }
        function script:Head { (& git -C $script:repo rev-parse HEAD).Trim() }
        function script:Put([string]$path, [string]$text) { Set-Content -LiteralPath (Join-Path $script:repo $path) -Value $text -NoNewline }
        G init -q -b main
        G config user.email 't@t'; G config user.name 't'; G config core.autocrlf false
        Put 'a.txt' "a1`na2`na3`na4`na5`na6`na7`na8`n"; Put 'b.txt' "b1`nb2`nb3`n"; Put 'c.txt' "c1`nc2`n"
        G add -A; G commit -q -m base
        $script:base = Head
        # The hotfix side branch: two commits, changing a.txt and b.txt.
        G checkout -q -b hotfix
        Put 'a.txt' "a1`nA2`na3`na4`na5`na6`na7`na8`n"; G commit -q -am 'hotfix 1'
        Put 'b.txt' "b1`nB2`nb3`n"; G commit -q -am 'hotfix 2'
        $script:running = Head
        # main: an unrelated change, then BOTH hotfix changes as ONE squashed commit, then later work.
        G checkout -q main
        Put 'c.txt' "c1`nC2`n"; G commit -q -am 'unrelated'
        $script:mainWithout = Head
        Put 'a.txt' "a1`nA2`na3`na4`na5`na6`na7`na8`n"; Put 'b.txt' "b1`nB2`nb3`n"; G commit -q -am 'squash of hotfix 1+2'
        Put 'c.txt' "c1`nC2`nc3`n"; G commit -q -am 'later, unrelated'
        $script:mainContained = Head
        # One hunk of the hotfix reverted on top of the contained main.
        G checkout -q -b reverted
        Put 'b.txt' "b1`nb2`nb3`n"; G commit -q -am 'revert the b.txt hunk'
        $script:reverted = Head
        # A later change to the SAME lines the hotfix touched (overlapping), on top of the contained main.
        G checkout -q main; G checkout -q -b overlap
        Put 'a.txt' "a1`nA2-edited`na3`na4`na5`na6`na7`na8`n"; G commit -q -am 'later edit to the hotfix line'
        $script:overlap = Head
        # A plain descendant of the running commit.
        G checkout -q hotfix; G checkout -q -b descendant
        Put 'c.txt' "c1`nc2`nc3`n"; G commit -q -am 'on top of the hotfix'
        $script:descendant = Head
    }
    AfterAll { Remove-Item -LiteralPath $script:repo -Recurse -Force -ErrorAction SilentlyContinue }

    It "today's real shape: the hotfix squashed into main, plus later work -> contained" {
        $r = Test-DeployChangesContained -Running $script:running -Requested $script:mainContained -RepoPath $script:repo
        $r.Contained | Should -BeTrue
        $r.Error | Should -BeNullOrEmpty
        $r.MergeBase | Should -Be $script:base
        @($r.UniqueCommits).Count | Should -Be 2
    }
    It 'an older main without the squash -> not contained, naming the files' {
        $r = Test-DeployChangesContained -Running $script:running -Requested $script:mainWithout -RepoPath $script:repo
        $r.Contained | Should -BeFalse
        $r.Files | Should -Contain 'a.txt'
        $r.Files | Should -Contain 'b.txt'
    }
    It 'one hunk of the hotfix reverted -> not contained, naming that file' {
        $r = Test-DeployChangesContained -Running $script:running -Requested $script:reverted -RepoPath $script:repo
        $r.Contained | Should -BeFalse
        $r.Files | Should -Contain 'b.txt'
        $r.Files | Should -Not -Contain 'a.txt'
    }
    It 'a later change to the same lines the hotfix touched -> not contained (fail closed, a human decides)' {
        $r = Test-DeployChangesContained -Running $script:running -Requested $script:overlap -RepoPath $script:repo
        $r.Contained | Should -BeFalse
        $r.Files | Should -Contain 'a.txt'
    }
    It 'a plain descendant -> contained (the workflow also accepts it on ancestry alone)' {
        $r = Test-DeployChangesContained -Running $script:running -Requested $script:descendant -RepoPath $script:repo
        $r.Contained | Should -BeTrue
    }
    It 'an unresolvable commit -> not contained, with an error (never throws)' {
        $r = Test-DeployChangesContained -Running $script:running -Requested ('f' * 40) -RepoPath $script:repo
        $r.Contained | Should -BeFalse
        $r.Error | Should -Match 'no merge-base'
    }
    It 't/674 item 1: a RUNNING commit that is not in the clone -> "not fetchable", not "no merge-base"' {
        $gone = 'e' * 40
        $r = Test-DeployChangesContained -Running $gone -Requested $script:mainContained -RepoPath $script:repo
        $r.Contained | Should -BeFalse
        $r.Error | Should -Be "running commit $gone not fetchable (its branch may have been deleted while prod still runs it)"
        $r.Error | Should -Not -Match 'no merge-base'
        # The verdict reads 'unverifiable', and refuses.
        $v = Get-DeployAgeVerdict -ProdRevisionName 'app--deploy-eeeeeee-1' -MergeBaseExitCode 1 -Containment $r
        $v.Action | Should -Be 'refuse'
        $v.Detail | Should -Match '^containment unverifiable: running commit e+ not fetchable'
    }
}

Describe 'Get-DeployApplyFailure: reading a failed git apply (t/674 item 2)' {
    It 'a fatal: line -> Error set, so the refusal reads unverifiable, not changes missing' {
        $out = @(
            'error: unable to read sha1 file of a.txt (1234abcd)',
            "fatal: unable to fetch blob 1234abcd from promisor remote 'origin'"
        )
        $f = Get-DeployApplyFailure -Output $out
        $f.Error | Should -Be "git apply could not run the check (fatal: unable to fetch blob 1234abcd from promisor remote 'origin')"
        @($f.Files).Count | Should -Be 0
        $c = [pscustomobject]@{ Contained = $false; MergeBase = 'm'; UniqueCommits = @(); Files = @('a.txt'); Error = $f.Error }
        $v = Get-DeployAgeVerdict -ProdRevisionName 'app--deploy-abc1234-1' -MergeBaseExitCode 1 -Containment $c
        $v.Action | Should -Be 'refuse'
        $v.Detail | Should -Match '^containment unverifiable: git apply could not run the check'
    }
    It 'ordinary patch failures -> no Error, the files named once each' {
        $out = @(
            'error: patch failed: a.txt:1',
            'error: a.txt: patch does not apply',
            'error: while searching for: b.txt',
            'error: b.txt: patch does not apply'
        )
        $f = Get-DeployApplyFailure -Output $out
        $f.Error | Should -BeNullOrEmpty
        @($f.Files) | Should -Be @('a.txt', 'b.txt')
    }
    It 'ErrorRecord objects from 2>&1 and an empty output are both read without throwing' {
        $rec = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('fatal: bad object deadbeef'), 'NativeCommandError', 'NotSpecified', $null)
        (Get-DeployApplyFailure -Output @($rec)).Error | Should -Match 'fatal: bad object deadbeef'
        $empty = Get-DeployApplyFailure -Output $null
        $empty.Error | Should -BeNullOrEmpty
        @($empty.Files).Count | Should -Be 0
    }
}
