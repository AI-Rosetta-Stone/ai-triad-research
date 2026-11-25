# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# Characterization tests for Get-NodeSourceIndexLink (private AITriad function).
# Race-safe: dot-sources ONLY this one Private file, never Import-Module the batch worktree module.

BeforeAll {
    . "$PSScriptRoot\..\scripts\AITriad\Private\Get-NodeSourceIndexLink.ps1"

    function New-Live { param([string[]]$Ids) $h = [System.Collections.Generic.HashSet[string]]::new(); $Ids | ForEach-Object { [void]$h.Add($_) }; $h }

    function New-Summary {
        param($PovSummaries, $FactualClaims)
        $o = [pscustomobject]@{}
        if ($null -ne $PovSummaries) { $o | Add-Member -NotePropertyName pov_summaries -NotePropertyValue $PovSummaries }
        if ($null -ne $FactualClaims) { $o | Add-Member -NotePropertyName factual_claims -NotePropertyValue $FactualClaims }
        $o
    }
}

Describe 'Get-NodeSourceIndexLink' {
    It 'emits a key_point link with verbatim as quote and payload quote' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'acc-x-001'; verbatim = 'VERB'; point = 'PT'; extraction_confidence = 0.9 }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $povs = [pscustomobject]@{ acc = $block }
        $summary = New-Summary -PovSummaries $povs -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'acc-x-001'))
        $r.Count | Should -Be 1
        $r[0].node | Should -Be 'acc-x-001'
        $r[0].field | Should -Be 'key_point'
        $r[0].quote | Should -Be 'VERB'
        $r[0].payload.source_id | Should -Be 'src1'
        $r[0].payload.link_source | Should -Be 'key_point'
        $r[0].payload.quote | Should -Be 'VERB'
        $r[0].payload.doc_position | Should -Be $null
        $r[0].payload.evidence_level | Should -Be $null
        $r[0].payload.extraction_confidence | Should -Be 0.9
    }

    It 'uses point as comparison quote when verbatim is whitespace, payload quote keeps the verbatim' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'acc-x-002'; verbatim = '   '; point = 'POINT' }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'acc-x-002'))
        $r[0].quote | Should -Be 'POINT'
        $r[0].payload.quote | Should -Be '   '
    }

    It 'uses empty quote when verbatim is missing and point is not a string' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'acc-x-003' }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'acc-x-003'))
        $r[0].quote | Should -Be ''
        $r[0].payload.quote | Should -Be ''
    }

    It 'skips key points whose node is not live' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'dead-001'; verbatim = 'V' }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'other'))
        $r.Count | Should -Be 0
    }

    It 'resolves a superseded key-point node to its survivor via ResolveMap' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'old-001'; verbatim = 'V' }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims $null
        $map = [System.Collections.Generic.Dictionary[string, string]]::new()
        $map['old-001'] = 'new-001'
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'new-001') -ResolveMap $map)
        $r.Count | Should -Be 1
        $r[0].node | Should -Be 'new-001'
    }

    It 'skips a pov block without key_points' {
        $block = [pscustomobject]@{ other = 1 }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src1' -Live (New-Live 'acc-x-001'))
        $r.Count | Should -Be 0
    }

    It 'emits a factual_claim link with claim as quote and payload fields' {
        $fc = [pscustomobject]@{ claim = 'CLAIM'; linked_taxonomy_nodes = @('saf-y-001'); doc_position = 3; evidence_criteria = 'high'; extraction_confidence = 0.5 }
        $summary = New-Summary -PovSummaries $null -FactualClaims @($fc)
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src2' -Live (New-Live 'saf-y-001'))
        $r.Count | Should -Be 1
        $r[0].node | Should -Be 'saf-y-001'
        $r[0].field | Should -Be 'factual_claim'
        $r[0].quote | Should -Be 'CLAIM'
        $r[0].payload.source_id | Should -Be 'src2'
        $r[0].payload.link_source | Should -Be 'factual_claim'
        $r[0].payload.quote | Should -Be 'CLAIM'
        $r[0].payload.doc_position | Should -Be 3
        $r[0].payload.evidence_level | Should -Be 'high'
        $r[0].payload.extraction_confidence | Should -Be 0.5
    }

    It 'skips factual-claim nodes that are not live and resolves survivors' {
        $fc = [pscustomobject]@{ claim = 'C'; linked_taxonomy_nodes = @('dead', 'old-2') }
        $summary = New-Summary -PovSummaries $null -FactualClaims @($fc)
        $map = [System.Collections.Generic.Dictionary[string, string]]::new()
        $map['old-2'] = 'new-2'
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src2' -Live (New-Live 'new-2') -ResolveMap $map)
        $r.Count | Should -Be 1
        $r[0].node | Should -Be 'new-2'
    }

    It 'skips a factual claim without linked_taxonomy_nodes' {
        $fc = [pscustomobject]@{ claim = 'C' }
        $summary = New-Summary -PovSummaries $null -FactualClaims @($fc)
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src2' -Live (New-Live 'x'))
        $r.Count | Should -Be 0
    }

    It 'returns nothing when summary has neither pov_summaries nor factual_claims' {
        $summary = New-Summary -PovSummaries $null -FactualClaims $null
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src' -Live (New-Live 'x'))
        $r.Count | Should -Be 0
    }

    It 'emits both key_point and factual_claim links from one summary in order' {
        $kp = [pscustomobject]@{ taxonomy_node_id = 'acc-x-001'; verbatim = 'V' }
        $block = [pscustomobject]@{ key_points = @($kp) }
        $fc = [pscustomobject]@{ claim = 'C'; linked_taxonomy_nodes = @('saf-y-001') }
        $summary = New-Summary -PovSummaries ([pscustomobject]@{ acc = $block }) -FactualClaims @($fc)
        $r = @(Get-NodeSourceIndexLink -Summary $summary -SourceId 'src' -Live (New-Live @('acc-x-001', 'saf-y-001')))
        $r.Count | Should -Be 2
        $r[0].field | Should -Be 'key_point'
        $r[1].field | Should -Be 'factual_claim'
    }
}
