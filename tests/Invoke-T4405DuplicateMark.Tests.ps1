# Tag: data-mutation (t/4405)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Get-SummaryLinkedNodes (scripts/data-mutations/t4405/Invoke-T4405DuplicateMark.ps1).
.DESCRIPTION
    Invoke-T4405DuplicateMark.ps1 is a /data-mutation script with an executable body (it reads git trees and
    the frozen list at load), so these tests cannot dot-source it. They lift its top-level function
    definitions out of the AST and define them in isolation, exercising only the pure Get-SummaryLinkedNodes
    (the node ids a summary links over the four C9 link fields, SO e/344#13). Pins the current behaviour so the
    t/4405 complexity refactor (gh#5377) that splits it into per-field helpers stays behaviour-preserving.
#>

BeforeAll {
    Set-StrictMode -Version Latest
    $file = Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4405' 'Invoke-T4405DuplicateMark.ps1'
    $src = Get-Content -LiteralPath $file -Raw
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
    # Define every top-level function without running the script body (which does real I/O at load).
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        . ([scriptblock]::Create($fn.Extent.Text))
    }
    function script:Linked([string]$Json) { Get-SummaryLinkedNodes ($Json | ConvertFrom-Json) }
}

Describe 'Get-SummaryLinkedNodes' -Tag 'data-mutation' {
    It 'returns an empty ordinal HashSet for a null summary' {
        $r = Get-SummaryLinkedNodes $null
        $r.GetType().Name | Should -BeExactly 'HashSet`1'
        $r.Count | Should -Be 0
    }

    It 'returns an empty set for a summary with none of the four link fields' {
        $r = Get-SummaryLinkedNodes ([pscustomobject]@{})
        @($r).Count | Should -Be 0
    }

    It 'collects taxonomy_node_id from pov_summaries key_points across every pov' {
        $r = Linked '{ "pov_summaries": { "acc": { "key_points": [ {"taxonomy_node_id":"acc-bel-001"}, {"taxonomy_node_id":"acc-bel-002"} ] }, "saf": { "key_points": [ {"taxonomy_node_id":"saf-int-005"} ] } } }'
        @($r | Sort-Object) | Should -Be @('acc-bel-001', 'acc-bel-002', 'saf-int-005')
    }

    It 'skips a key_point with no taxonomy_node_id and an empty id' {
        $r = Linked '{ "pov_summaries": { "acc": { "key_points": [ {"taxonomy_node_id":"acc-bel-001"}, {"text":"no id"}, {"taxonomy_node_id":""} ] } } }'
        @($r) | Should -Be @('acc-bel-001')
    }

    It 'skips a null pov value or a pov with no key_points, without error' {
        $r = Linked '{ "pov_summaries": { "skp": null, "cc": { "other": 1 }, "acc": { "key_points": [ {"taxonomy_node_id":"acc-bel-003"} ] } } }'
        @($r) | Should -Be @('acc-bel-003')
    }

    It 'collects linked and potential taxonomy nodes from factual_claims, skipping a null claim' {
        $r = Linked '{ "factual_claims": [ { "linked_taxonomy_nodes": ["acc-bel-001","cc-des-009"], "potential_taxonomy_nodes": ["skp-int-003"] }, null, { "linked_taxonomy_nodes": [] } ] }'
        @($r | Sort-Object) | Should -Be @('acc-bel-001', 'cc-des-009', 'skp-int-003')
    }

    It 'collects resolved_node_id from unmapped_concepts, skipping missing and empty ids' {
        $r = Linked '{ "unmapped_concepts": [ { "resolved_node_id":"saf-des-010" }, { "concept":"x" }, { "resolved_node_id":"" } ] }'
        @($r) | Should -Be @('saf-des-010')
    }

    It 'dedups ordinally across all four field groups' {
        $json = '{ "pov_summaries": { "acc": { "key_points": [ {"taxonomy_node_id":"acc-bel-001"}, {"taxonomy_node_id":"acc-bel-002"} ] }, "saf": { "key_points": [ {"taxonomy_node_id":"saf-int-005"} ] } }, "factual_claims": [ { "linked_taxonomy_nodes": ["acc-bel-001","cc-des-009"], "potential_taxonomy_nodes": ["skp-int-003"] } ], "unmapped_concepts": [ { "resolved_node_id":"saf-des-010" } ] }'
        $r = Linked $json
        $r.Count | Should -Be 6
        @($r | Sort-Object) | Should -Be @('acc-bel-001', 'acc-bel-002', 'cc-des-009', 'saf-des-010', 'saf-int-005', 'skp-int-003')
    }

    It 'returns a HashSet whose Contains is case-sensitive (ordinal)' {
        $r = Linked '{ "unmapped_concepts": [ { "resolved_node_id":"saf-des-010" } ] }'
        $r.Contains('saf-des-010') | Should -BeTrue
        $r.Contains('SAF-DES-010') | Should -BeFalse
    }
}
