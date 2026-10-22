# Tag: data-mutation (t/4405)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the t/4405 mark builder (scripts/data-mutations/t4405/T4405MarkPlan.ps1).
.DESCRIPTION
    Pins the SO's e/348#2 guards as accepted by the TL (e/348#3, #10), including the regression cases
    the SO asked for (condition 6): the .DS_Store join (a junk file never makes a raw set), an empty
    substantive set, a null-title generic raw file, and (TL e/348#10) a 3+ blob reaching outside the
    group.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4405' 'T4405MarkPlan.ps1')
    # Build sharers from the raw map, as the freeze script does from the git tree.
    function script:Plan {
        param([object[]]$Groups, [hashtable]$Raw, [hashtable]$Title = @{}, [hashtable]$Weak = @{}, [hashtable]$Signal = @{},
              [hashtable]$Suspect = @{}, [hashtable]$Marked = @{}, [object[]]$R2 = @(), [hashtable]$Human = @{})
        $sh = @{}; foreach ($id in $Raw.Keys) { foreach ($b in @($Raw[$id])) { if (-not $sh.ContainsKey($b)) { $sh[$b] = [System.Collections.Generic.List[string]]::new() }; $sh[$b].Add($id) } }
        $tk = @{}; foreach ($id in $Raw.Keys) { $tk[$id] = if ($Title.ContainsKey($id)) { $Title[$id] } else { 'the same work' } }
        Get-T4405MarkPlan -Groups $Groups -Raw $Raw -Sharers $sh -TitleKey $tk -TitleWeak $Weak -SecondSignal $Signal -CanonicalSuspect $Suspect -Marked $Marked -R2 $R2 -Human $Human
    }
    function script:G([string]$c, [string[]]$m) { @{ canonical = $c; members = @($c) + $m } }
}

Describe 'Get-T4405MarkPlan' -Tag 'data-mutation' {
    It 'marks R1 same-raw members to the group canonical' {
        $p = Plan @(G 'a' @('a-1', 'a-2')) @{ 'a' = @('b1'); 'a-1' = @('b1'); 'a-2' = @('b1') }
        @($p.Marks | ForEach-Object { "$($_.id)>$($_.duplicate_of):$($_.basis)" }) | Should -Be @('a-1>a:r1-same-raw', 'a-2>a:r1-same-raw')
        @($p.Review).Count | Should -Be 0
        $p.Blobs[0].accepted | Should -BeTrue
        @($p.Blobs[0].docs) | Should -Be @('a', 'a-1', 'a-2')
    }

    It 'never marks on an empty substantive set (the .DS_Store join: junk files are not in the raw set)' {
        # Two unrelated papers whose only shared file was .DS_Store: the freeze script drops it, so both sets are empty.
        $p = Plan @(G 'paper-x' @('paper-y')) @{ 'paper-x' = @(); 'paper-y' = @() }
        @($p.Marks).Count | Should -Be 0
        $p.Review[0].reason | Should -BeExactly 'empty-substantive-raw-set'
    }

    It 'treats a missing raw entry as empty, not as a one-element set' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1') }
        @($p.Marks).Count | Should -Be 0
        $p.Review[0].reason | Should -BeExactly 'empty-substantive-raw-set'
    }

    It 'sends a genuine title disagreement to review, not rejection' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1'); 'a-1' = @('b1') } -Title @{ 'a' = 'california lawyer chatgpt'; 'a-1' = 'historic fine' }
        @($p.Marks).Count | Should -Be 0
        $p.Review[0].reason | Should -BeExactly 'title-disagreement'
    }

    It 'needs a second signal when title agreement is weak (a null-title generic raw file)' {
        $raw = @{ 'a' = @('generic'); 'a-1' = @('generic') }
        $p = Plan @(G 'a' @('a-1')) $raw -Title @{ 'a' = 'a report'; 'a-1' = '' }
        $p.Review[0].reason | Should -BeExactly 'weak-title-no-second-signal'
        $p2 = Plan @(G 'a' @('a-1')) $raw -Title @{ 'a' = 'a report'; 'a-1' = '' } -Signal @{ 'a|a-1' = $true }
        @($p2.Marks | ForEach-Object id) | Should -Be @('a-1')
    }

    It 'treats an arXiv-id title as weak' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1'); 'a-1' = @('b1') } -Title @{ 'a' = 'concrete problems'; 'a-1' = '1606 06565v2' } -Weak @{ 'a-1' = $true }
        $p.Review[0].reason | Should -BeExactly 'weak-title-no-second-signal'
    }

    It 'sends a 3+ blob reaching OUTSIDE the group to review, and records it (TL e/348#10)' {
        $raw = @{ 'a' = @('shared'); 'a-1' = @('shared'); 'unrelated-doc' = @('shared') }
        $p = Plan @(G 'a' @('a-1')) $raw
        @($p.Marks).Count | Should -Be 0
        $p.Review[0].reason | Should -BeExactly 'blob-shared-outside-group'
        $p.Blobs[0].accepted | Should -BeFalse
        @($p.Blobs[0].docs) | Should -Be @('a', 'a-1', 'unrelated-doc')
    }

    It 'accepts a 3+ blob inside one group whose titles agree (6 copies of one work)' {
        $raw = @{}; foreach ($id in 'x', 'x-1', 'x-2', 'x-3', 'x-4', 'x-5') { $raw[$id] = @('one') }
        $p = Plan @(G 'x' @('x-1', 'x-2', 'x-3', 'x-4', 'x-5')) $raw
        @($p.Marks).Count | Should -Be 5
    }

    It 'sends a 3+ blob whose sharers'' titles disagree to review' {
        $raw = @{ 'a' = @('s'); 'a-1' = @('s'); 'a-2' = @('s') }
        $p = Plan @(G 'a' @('a-1', 'a-2')) $raw -Title @{ 'a' = 'one work'; 'a-1' = 'one work'; 'a-2' = 'another work entirely' }
        @($p.Review | ForEach-Object reason | Sort-Object -Unique) | Should -Contain 'title-disagreement'
        @($p.Marks).Count | Should -Be 0 -Because 'the shared blob''s sharers disagree, so even the agreeing pair is held'
    }

    It 'lets a human-reviewed doc join a group through a shared blob (text-2026 into the WEO group, t/4402)' {
        $raw = @{ 'weo' = @('w'); 'weo-1' = @('w'); 'text' = @('w'); 'text-1' = @('w') }
        $p = Plan @((G 'weo' @('weo-1')), (G 'text' @('text-1'))) $raw -Title @{ 'weo' = 'world economic outlook'; 'weo-1' = 'world economic outlook'; 'text' = 'text'; 'text-1' = 'text' } -Human @{ 'text' = 'weo'; 'text-1' = 'weo' }
        @($p.Marks | ForEach-Object { "$($_.id)>$($_.duplicate_of):$($_.basis)" }) | Should -Be @('text>weo:human-reviewed-t4402', 'text-1>weo:human-reviewed-t4402', 'weo-1>weo:r1-same-raw')
        @($p.Review).Count | Should -Be 0
    }

    It 'never re-points an applied mark' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1'); 'a-1' = @('b1') } -Marked @{ 'a-1' = 'elsewhere' }
        $p.Review[0].reason | Should -BeExactly 'applied-mark-would-be-repointed'
        $p2 = Plan @() @{} -R2 @(@{ member = 'r'; canonical = 'c' }) -Marked @{ 'c' = 'z' }
        $p2.Review[0].reason | Should -BeExactly 'applied-mark-would-be-repointed'
    }

    It 'holds a group whose canonical needs an override (damaged or materially shorter)' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1'); 'a-1' = @('b1') } -Suspect @{ 'a' = 'cp437-damaged' }
        $p.Review[0].reason | Should -BeExactly 'canonical-override-needs-decision: cp437-damaged'
    }

    It 'leaves a different-raw pair to R2, and marks a PI-approved R2 pair' {
        $p = Plan @(G 'a' @('a-1')) @{ 'a' = @('b1'); 'a-1' = @('b2') } -R2 @(@{ member = 'a-1'; canonical = 'a' })
        @($p.Marks | ForEach-Object { "$($_.id):$($_.basis)" }) | Should -Be @('a-1:r2-pi-approved')
        @($p.Review).Count | Should -Be 0
    }

    It 'refuses a chain (a target that is itself marked by the plan)' {
        $p = Plan @() @{} -R2 @(@{ member = 'b'; canonical = 'a' }, @{ member = 'c'; canonical = 'b' })
        @($p.Marks | ForEach-Object id) | Should -Be @('b')
        $p.Review[0].reason | Should -BeExactly 'chain-target-is-marked'
    }
}
