# Tag: data-mutation (t/4337)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the t/4337 option-A mark builder (scripts/data-mutations/t4337/T4337MarkPlan.ps1).
.DESCRIPTION
    The first builder only considered identity groups in which every member shared one hash, so 16
    byte-identical sets inside mixed groups were dropped from the frozen list (found by Server
    Storage's second-agent recount, t/4337#29). The rules pinned here are SO e/344#5, TL-accepted
    e/344#6: canonical by C6 over the whole group; mark only its byte-identical twins; everything
    else to review.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4337' 'T4337MarkPlan.ps1')
    function script:Plan([object[]]$Groups, [hashtable]$Hash, [hashtable]$Sum = @{}, [hashtable]$Refs = @{}) {
        $meta = @{}; foreach ($g in $Groups) { foreach ($id in $g) { $meta[$id] = $true } }
        Get-T4337MarkPlan -Groups $Groups -Hash $Hash -HasSummary $Sum -LiveRefs $Refs -HasMetadata $meta
    }
    function script:Targets($p) { $t = @{}; foreach ($m in $p.Marks) { $t[$m.id] = $m.duplicate_of }; $t }
}

Describe 'Get-T4337MarkPlan' -Tag 'data-mutation' {

    It 'marks every twin of an all-identical group to the C6 canonical' {
        $p = Plan @(, @('a-2026', 'a-2026-1', 'a-2026-2')) @{ 'a-2026' = 'h1'; 'a-2026-1' = 'h1'; 'a-2026-2' = 'h1' } @{ 'a-2026-1' = $true }
        $t = Targets $p
        $t.Keys.Count | Should -Be 2
        $t['a-2026'] | Should -BeExactly 'a-2026-1' -Because 'a member with a summary wins over the ordinal-smallest id'
        @($p.Review).Count | Should -Be 0
    }

    It 'REGRESSION (t/4337#29): a mixed group still marks the canonical''s identical twins; the odd member goes to review' {
        # The eight-ways shape: identical copies plus one conversion-noise copy in the same identity group.
        $ids = 'eight-2026', 'eight-2026-1', 'eight-2026-2', 'eight-atlantic-2026', 'eight-noise-2026'
        $hash = @{ 'eight-2026' = 'h1'; 'eight-2026-1' = 'h1'; 'eight-2026-2' = 'h1'; 'eight-atlantic-2026' = 'h1'; 'eight-noise-2026' = 'h2' }
        $p = Plan @(, $ids) $hash
        $t = Targets $p
        $t.Keys.Count | Should -Be 3 -Because 'the first builder skipped the whole group and marked nothing'
        @($t.Values | Sort-Object -Unique) | Should -Be @('eight-2026')
        @($p.Review).Count | Should -Be 1
        @($p.Review[0].members) | Should -Be @('eight-noise-2026')
    }

    It 'sends the whole group to review when the C6 canonical has no identical twin (SO e/344#5 point 2)' {
        $ids = 'odd-2026', 'twin-2026', 'twin-2026-1'
        $p = Plan @(, $ids) @{ 'odd-2026' = 'h9'; 'twin-2026' = 'h1'; 'twin-2026-1' = 'h1' } @{ 'odd-2026' = $true }
        @($p.Marks).Count | Should -Be 0 -Because 'marking twin-2026-1 -> twin-2026 would split canonicalDocId from resolve (C8)'
        $p.Review[0].reason | Should -Be 'canonical-has-no-identical-twin'
        @($p.Review[0].members) | Should -Be @('odd-2026', 'twin-2026', 'twin-2026-1')
    }

    It 'marks only the canonical''s subset when a group holds two identical subsets; the second goes to review' {
        $ids = 'cf-2026', 'cf-2026-1', 'cf-2026-2', 'arxiv-2026'
        $hash = @{ 'cf-2026' = 'hA'; 'cf-2026-2' = 'hA'; 'cf-2026-1' = 'hB'; 'arxiv-2026' = 'hB' }
        $p = Plan @(, $ids) $hash @{ 'cf-2026' = $true }
        (Targets $p)['cf-2026-2'] | Should -BeExactly 'cf-2026'
        @($p.Marks).Count | Should -Be 1
        @($p.Review[0].members | Sort-Object) | Should -Be @('arxiv-2026', 'cf-2026-1')
    }

    It 'breaks C6 ties by live references, then ordinal id' {
        $p = Plan @(, @('b-2026', 'b-2026-1', 'b-2026-2')) @{ 'b-2026' = 'h'; 'b-2026-1' = 'h'; 'b-2026-2' = 'h' } @{ 'b-2026-1' = $true; 'b-2026-2' = $true } @{ 'b-2026-2' = 3; 'b-2026-1' = 1 }
        @((Targets $p).Values | Sort-Object -Unique) | Should -Be @('b-2026-2')
        $p2 = Plan @(, @('c-2026-1', 'c-2026')) @{ 'c-2026' = 'h'; 'c-2026-1' = 'h' }
        (Targets $p2)['c-2026-1'] | Should -BeExactly 'c-2026'
    }

    It 'leaves a C9-deferred twin unmarked and lists it for review; the group''s other twins are still marked' {
        $ids = 'd-2026', 'd-2026-1', 'd-2026-2'
        $meta = @{}; foreach ($id in $ids) { $meta[$id] = $true }
        $p = Get-T4337MarkPlan -Groups @(, $ids) -Hash @{ 'd-2026' = 'h'; 'd-2026-1' = 'h'; 'd-2026-2' = 'h' } -HasSummary @{} -LiveRefs @{} -HasMetadata $meta -Defer @('d-2026-1')
        @($p.Marks | ForEach-Object id) | Should -Be @('d-2026-2')
        ($p.Review | Where-Object reason -like 'c9-*').members | Should -Be @('d-2026-1')
    }

    It 'never marks against a canonical with no content hash' {
        $p = Plan @(, @('n-2026', 'n-2026-1')) @{ 'n-2026' = $null; 'n-2026-1' = $null }
        @($p.Marks).Count | Should -Be 0
        $p.Review[0].reason | Should -Be 'canonical-has-no-identical-twin'
    }
}

Describe 'The committed frozen list covers the 16 sets the first builder dropped (t/4337#29)' -Tag 'data-mutation' {
    BeforeAll {
        $script:Fz = Get-Content (Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4337' 'frozen-t4337-marks.json') -Raw | ConvertFrom-Json
        $script:Placed = @{}
        foreach ($m in @($script:Fz.marks) + @($script:Fz.marks_without_metadata)) { $script:Placed[$m.id] = "mark->$($m.duplicate_of)"; $script:Placed[$m.duplicate_of] = 'canonical' }
        foreach ($r in @($script:Fz.review)) { foreach ($id in @($r.members) + @($r.canonical)) { if (-not $script:Placed.ContainsKey($id)) { $script:Placed[$id] = "review:$($r.reason)" } } }
    }
    It '<_> is marked or listed for review, never absent' -ForEach @(
        '170306856v3-2026', 'counterfactual-fairness-2026-1', '2026-antitrust-year-preview-ai-2026-1', '260305175v1-2026',
        'ai-democracy-dilemma-2026-1', 'ai-democracy-mapping-intersections-2026-2', 'counterfactual-fairness-2026-2',
        'eight-ways-ai-will-shape-geopolitics-2026-2026-1', 'extreme-power-concentration-2026-1', 'from-assistance-execution-how-enterprises-put-ai-work-2026-1',
        'governor-newsom-issues-executive-order-accelerate-2026-1', 'how-brussels-effect-hinders-innovation-global-south-2026-2',
        'how-brussels-effect-hinders-innovation-global-south-reports-2026', 'how-existing-liability-frameworks-can-handle-agentic-ai-2026-1',
        'outsmarting-smart-device-2026', 'regulatory-tide-goes-out-what-global-ai-governance-2026-2', 'rise-authoritarian-informationalism-escalating-surveillance-2026-2') {
        $script:Placed.ContainsKey($_) | Should -BeTrue -Because "the first builder left '$_' out of the frozen list entirely"
    }
}
