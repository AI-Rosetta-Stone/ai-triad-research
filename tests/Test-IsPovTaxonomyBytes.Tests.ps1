# Tag: taxonomy
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests the raw-bytes POV pre-check (Test-IsPovTaxonomyBytes) that lets the
    taxonomy loaders skip ConvertFrom-Json on non-POV files.
.DESCRIPTION
    The contract that matters: the pre-check may only return $false where the
    authoritative gate (Test-IsPovTaxonomyData, after ConvertFrom-Json) also
    returns $false. A false negative here silently drops a POV from
    $script:TaxonomyData. Each shape is therefore checked against the real gate,
    not against a hard-coded expectation alone. Data-repo independent.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-IsPovTaxonomyBytes never rejects what Test-IsPovTaxonomyData accepts' -Tag 'taxonomy' {

    It '<Name> (BOM=<Bom>)' -ForEach @(
        foreach ($Case in @(
            @{ Name = 'POV node file';              Json = '{"nodes":[{"id":"acc-desires-001","label":"L"}]}' }
            @{ Name = 'uppercase Nodes / ID keys';  Json = '{"Nodes":[{"ID":"x"}]}' }
            @{ Name = 'empty nodes array';          Json = '{"nodes":[]}' }
            @{ Name = 'nodes is a single object';   Json = '{"nodes":{"id":"x"}}' }
            @{ Name = 'root-level array';           Json = '[{"nodes":[{"id":1}]}]' }
            @{ Name = 'trailing comma';             Json = '{"nodes":[{"id":1},],}' }
            @{ Name = 'comment';                    Json = '{/* c */ "nodes":[{"id":1}]}' }
            @{ Name = 'sidecar log (node_id)';      Json = '{"nodes":[{"node_id":"x"}]}' }
            @{ Name = 'no nodes property';          Json = '{"cruxes":[]}' }
            @{ Name = 'nodes only nested';          Json = '{"a":{"nodes":[{"id":1}]}}' }
            @{ Name = 'first node is a string';     Json = '{"nodes":["x"]}' }
            @{ Name = 'empty object';               Json = '{}' }
        )) {
            @{ Name = $Case.Name; Json = $Case.Json; Bom = $false }
            @{ Name = $Case.Name; Json = $Case.Json; Bom = $true }
        }
    ) {
        InModuleScope AITriad -Parameters @{ Json = $Json; Bom = $Bom } {
            param($Json, $Bom)
            $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Json)
            if ($Bom) { $Bytes = [byte[]](0xEF, 0xBB, 0xBF) + $Bytes }
            $Fast = Test-IsPovTaxonomyBytes -Bytes $Bytes -FileName 'case.json'
            $Full = Test-IsPovTaxonomyData ($Json | ConvertFrom-Json)
            if ($Full) { $Fast | Should -BeTrue -Because 'a shape the full gate accepts must never be pre-filtered out' }
        }
    }
}

Describe 'Test-IsPovTaxonomyBytes rejects the shapes it is meant to skip' -Tag 'taxonomy' {

    It 'Rejects a file with no nodes property (source_index.json shape)' {
        InModuleScope AITriad {
            $Bytes = [System.Text.Encoding]::UTF8.GetBytes('{"sources":{"doc-a":{"title":"T"}}}')
            Test-IsPovTaxonomyBytes -Bytes $Bytes | Should -BeFalse
        }
    }

    It 'Rejects a sidecar log whose nodes carry node_id, not id (t/1834 shape)' {
        InModuleScope AITriad {
            $Bytes = [System.Text.Encoding]::UTF8.GetBytes('{"node_count":1,"nodes":[{"node_id":"acc-beliefs-003"}]}')
            Test-IsPovTaxonomyBytes -Bytes $Bytes | Should -BeFalse
        }
    }

    It 'Accepts, with a WARN, bytes System.Text.Json cannot read, so the full parse decides' {
        InModuleScope AITriad {
            $Bytes = [System.Text.Encoding]::Unicode.GetBytes('{"nodes":[{"id":1}]}')   # UTF-16
            $Out = @(Test-IsPovTaxonomyBytes -Bytes $Bytes -FileName 'utf16.json' 3>&1)
            @($Out | Where-Object { $_ -is [bool] }) | Should -Be @($true)
            "$(@($Out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] }))" |
                Should -Match 'fast shape check could not read utf16\.json'
        }
    }

    It 'Accepts empty input (the full parse reports it)' {
        InModuleScope AITriad {
            Test-IsPovTaxonomyBytes -Bytes ([byte[]]@()) | Should -BeTrue
        }
    }
}
