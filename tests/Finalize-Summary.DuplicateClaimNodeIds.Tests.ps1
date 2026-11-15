# Tag: summary (t/292)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Finalize-Summary drops a node id repeated within one claim's linked_taxonomy_nodes (t/292).
.DESCRIPTION
    Spec source-identity 7.4 keeps a document's repeated links, so a repeated id becomes a duplicate
    fact in source_evidence_index.json. The fix is at the source: the summary writer keeps the first
    of each id, in order, and WARNs.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Repair-SummaryFactualClaims de-duplicates node ids per claim (t/292)' -Tag 'summary' {

    It 'keeps the first of each id in order, leaves clean claims alone, and WARNs once per repairing claim' {
        InModuleScope AITriad {
            $s = '{"factual_claims":[{"claim":"a","linked_taxonomy_nodes":["saf-beliefs-201","acc-beliefs-010","saf-beliefs-201","saf-beliefs-201"]},{"claim":"b","linked_taxonomy_nodes":["skp-intentions-144"]},{"claim":"c"}]}' | ConvertFrom-Json
            $errs = [System.Collections.Generic.List[string]]::new()
            # A simple function takes no common parameters, so capture its warning stream directly.
            $w = @(Repair-SummaryFactualClaims -SummaryObject $s -SchemaErrors $errs 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            @($s.factual_claims[0].linked_taxonomy_nodes) | Should -Be @('saf-beliefs-201', 'acc-beliefs-010')
            @($s.factual_claims[1].linked_taxonomy_nodes) | Should -Be @('skp-intentions-144')
            $s.factual_claims[2].PSObject.Properties['linked_taxonomy_nodes'] | Should -BeNullOrEmpty
            @($w).Count | Should -Be 1
            "$w" | Should -Match 'factual_claims\[0\] repeated 2 node id'
            $errs.Count | Should -Be 0
        }
    }

    It 'works on a dictionary-shaped summary too' {
        InModuleScope AITriad {
            $s = [ordered]@{ factual_claims = @([ordered]@{ claim = 'a'; linked_taxonomy_nodes = @('x-1', 'x-1') }) }
            $null = Repair-SummaryFactualClaims -SummaryObject $s -SchemaErrors ([System.Collections.Generic.List[string]]::new()) 3>&1
            @($s['factual_claims'][0]['linked_taxonomy_nodes']) | Should -Be @('x-1')
        }
    }

    It 'is case-sensitive, as node ids are' {
        InModuleScope AITriad {
            $s = '{"factual_claims":[{"claim":"a","linked_taxonomy_nodes":["saf-beliefs-201","SAF-beliefs-201"]}]}' | ConvertFrom-Json
            $w = @(Repair-SummaryFactualClaims -SummaryObject $s -SchemaErrors ([System.Collections.Generic.List[string]]::new()) 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            @($s.factual_claims[0].linked_taxonomy_nodes).Count | Should -Be 2
            @($w).Count | Should -Be 0
        }
    }
}
