# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# Characterization tests for Add-SummaryKeyPointCitations (t/5326, t/5324).
# Race-safe: dot-source ONLY this Private file plus the Get-SummaryField
# dependency; never Import-Module the batch worktree module.

BeforeAll {
    $script:PrivDir = Join-Path $PSScriptRoot '..\scripts\AITriad\Private'
    . (Join-Path $script:PrivDir 'FinalizeSummarySteps.ps1')  # defines Get-SummaryField
    . (Join-Path $script:PrivDir 'Add-SummaryKeyPointCitations.ps1')

    function New-NodeEntry {
        [pscustomobject]@{
            Citations = 0
            DocIds    = [System.Collections.Generic.List[string]]::new()
            Stances   = [System.Collections.Generic.List[string]]::new()
        }
    }

    function New-Summary {
        param([hashtable]$Povs)
        $pov = [pscustomobject]@{}
        foreach ($k in $Povs.Keys) {
            $pov | Add-Member -NotePropertyName $k -NotePropertyValue $Povs[$k]
        }
        [pscustomobject]@{ pov_summaries = $pov }
    }

    function New-KeyPoint {
        param([string]$NodeId, [string]$Stance)
        $kp = [pscustomobject]@{}
        if ($PSBoundParameters.ContainsKey('NodeId')) {
            $kp | Add-Member -NotePropertyName 'taxonomy_node_id' -NotePropertyValue $NodeId
        }
        if ($PSBoundParameters.ContainsKey('Stance')) {
            $kp | Add-Member -NotePropertyName 'stance' -NotePropertyValue $Stance
        }
        $kp
    }
}

Describe 'Add-SummaryKeyPointCitations' {
    It 'returns 0 and mutates nothing when pov_summaries is absent' {
        $idx = @{ 'acc-x-001' = New-NodeEntry }
        $r = Add-SummaryKeyPointCitations -Summary ([pscustomobject]@{}) -DocId 'd1' -NodeIndex $idx
        $r | Should -Be 0
        $idx['acc-x-001'].Citations | Should -Be 0
    }

    It 'returns 0 when pov_summaries is null' {
        $idx = @{ 'acc-x-001' = New-NodeEntry }
        $r = Add-SummaryKeyPointCitations -Summary ([pscustomobject]@{ pov_summaries = $null }) -DocId 'd1' -NodeIndex $idx
        $r | Should -Be 0
    }

    It 'counts every key point scanned across POVs regardless of mapping' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'acc-x-001'), (New-KeyPoint)) }
            safetyist       = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'missing')) }
        }
        $idx = @{ 'acc-x-001' = New-NodeEntry }
        $r = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        $r | Should -Be 3
    }

    It 'in normal mode increments Citations, adds DocId once, and records stance' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1' -Stance 'support')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $null = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        $idx['n1'].Citations | Should -Be 1
        $idx['n1'].DocIds | Should -Be @('d1')
        $idx['n1'].Stances | Should -Be @('support')
    }

    It 'in normal mode still increments Citations when DocId already present but does not duplicate DocId' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1' -Stance 'oppose')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $idx['n1'].DocIds.Add('d1')
        $idx['n1'].Citations = 5
        $null = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        $idx['n1'].Citations | Should -Be 6
        @($idx['n1'].DocIds).Count | Should -Be 1
        $idx['n1'].Stances | Should -Be @('oppose')
    }

    It 'in normal mode omits empty stance' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1' -Stance '')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $null = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        @($idx['n1'].Stances).Count | Should -Be 0
    }

    It 'in OncePerDoc mode adds a citation+DocId once when DocId absent and never a stance' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1' -Stance 'support')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $null = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx -OncePerDoc
        $idx['n1'].Citations | Should -Be 1
        $idx['n1'].DocIds | Should -Be @('d1')
        @($idx['n1'].Stances).Count | Should -Be 0
    }

    It 'in OncePerDoc mode leaves an already-counted node untouched' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1' -Stance 'support')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $idx['n1'].DocIds.Add('d1')
        $idx['n1'].Citations = 2
        $null = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx -OncePerDoc
        $idx['n1'].Citations | Should -Be 2
        @($idx['n1'].DocIds).Count | Should -Be 1
    }

    It 'ignores key points with no node id or an unmapped node id' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @((New-KeyPoint), (New-KeyPoint -NodeId 'nope')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $r = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        $r | Should -Be 2
        $idx['n1'].Citations | Should -Be 0
    }

    It 'skips POVs that are absent or have empty key_points' {
        $summary = New-Summary @{
            accelerationist = [pscustomobject]@{ key_points = @() }
            skeptic         = [pscustomobject]@{ key_points = @((New-KeyPoint -NodeId 'n1')) }
        }
        $idx = @{ 'n1' = New-NodeEntry }
        $r = Add-SummaryKeyPointCitations -Summary $summary -DocId 'd1' -NodeIndex $idx
        $r | Should -Be 1
        $idx['n1'].Citations | Should -Be 1
    }
}
