# Tag: evidence-union (t/4337, docs/specs/source-identity.md section 7)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Asserts the PowerShell implementation (scripts/AITriad/Private/EvidenceUnion.ps1) against the shared
# fixture. The TypeScript implementation in lib/ asserts the same file, so the two stacks can't drift
# (SO e/347#2 condition 4). Regenerate the fixture with scripts/new_evidence_union_fixture.py.

BeforeDiscovery {
    $fx = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'fixtures' 'evidence-union-cases.json') | ConvertFrom-Json -AsHashtable
    $script:KeyCases = @($fx.key_cases)
    $script:NearCases = @($fx.near_cases)
    $script:LinkCases = @($fx.link_cases)
    $script:UnionCases = @($fx.union_cases)
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $raw = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'fixtures' 'evidence-union-cases.json')
    $script:Fixture = $raw | ConvertFrom-Json -AsHashtable
    # Links as ConvertFrom-Json (not -AsHashtable) gives them, the shape Get-SummaryEvidenceLink
    # emits and real callers pass.
    $script:FixtureObj = $raw | ConvertFrom-Json
}

Describe 'Evidence union fixture (spec section 7)' -Tag 'evidence-union' {

    It 'is version 1 of the section 7 fixture' {
        $script:Fixture.version | Should -Be 1
        $script:Fixture.spec | Should -BeExactly 'docs/specs/source-identity.md section 7'
    }

    Context '7.2 de-duplication key' {
        It '<name>' -ForEach $script:KeyCases {
            InModuleScope AITriad -Parameters @{ Q = $quote } { param($Q) ConvertTo-EvidenceKey -Quote $Q } |
                Should -BeExactly $expected_key
        }
    }

    Context '7.3 near-equal' {
        It '<name>' -ForEach $script:NearCases {
            $ka = InModuleScope AITriad -Parameters @{ Q = $a } { param($Q) ConvertTo-EvidenceKey -Quote $Q }
            $kb = InModuleScope AITriad -Parameters @{ Q = $b } { param($Q) ConvertTo-EvidenceKey -Quote $Q }
            $r1 = InModuleScope AITriad -Parameters @{ A = $ka; B = $kb } { param($A, $B) Test-EvidenceNearEqual -A $A -B $B }
            $r2 = InModuleScope AITriad -Parameters @{ A = $kb; B = $ka } { param($A, $B) Test-EvidenceNearEqual -A $A -B $B }
            $r1 | Should -Be $expected
            $r2 | Should -Be $expected -Because 'near-equal is symmetric'
        }
    }

    Context '7.1 links' {
        It '<name>' -ForEach $script:LinkCases {
            $idx = [array]::IndexOf(@($script:Fixture.link_cases.name), $name)
            $summary = @($script:FixtureObj.link_cases)[$idx].summary
            $got = @(InModuleScope AITriad -Parameters @{ S = $summary } { param($S) Get-SummaryEvidenceLink -Summary $S })
            $got.Count | Should -Be @($expected_links).Count
            for ($i = 0; $i -lt $got.Count; $i++) {
                $got[$i].node | Should -BeExactly $expected_links[$i].node
                $got[$i].field | Should -BeExactly $expected_links[$i].field
                $got[$i].quote | Should -BeExactly $expected_links[$i].quote
            }
        }
    }

    Context '7.4 union' {
        It '<name>' -ForEach $script:UnionCases {
            $members = @(foreach ($m in $members) {
                @{ Id = $m.id; Links = @(foreach ($l in @($m.links)) { [pscustomobject]@{ node = $l.node; field = $l.field; quote = $l.quote } }) }
            })
            $got = InModuleScope AITriad -Parameters @{ C = $canonical; M = $members } { param($C, $M) Merge-GroupEvidence -CanonicalId $C -Members $M }
            @($got.Keys | Sort-Object) | Should -Be @($expected.Keys | Sort-Object)
            foreach ($n in $expected.Keys) {
                $g = @($got[$n]); $e = @($expected[$n])
                $g.Count | Should -Be $e.Count -Because "node $n"
                for ($i = 0; $i -lt $e.Count; $i++) {
                    $g[$i].quote | Should -BeExactly $e[$i].quote
                    $g[$i].field | Should -BeExactly $e[$i].field
                    $g[$i].doc | Should -BeExactly $e[$i].doc
                    $gv = if ($g[$i].PSObject.Properties['via']) { $g[$i].via } else { $null }
                    $ev = if ($e[$i].ContainsKey('via')) { $e[$i].via } else { $null }
                    $gv | Should -Be $ev -Because "node $n entry $i via"
                }
            }
        }
    }
}

Describe 'Evidence union invariants' -Tag 'evidence-union' {
    It 'never drops a (node, group) attribution: every node any member links keeps at least one link' {
        foreach ($c in $script:Fixture.union_cases) {
            $linked = @($c.members | ForEach-Object { @($_.links) } | ForEach-Object { $_.node } | Sort-Object -Unique)
            $members = @(foreach ($m in $c.members) { @{ Id = $m.id; Links = @(foreach ($l in @($m.links)) { [pscustomobject]$l }) } })
            $got = InModuleScope AITriad -Parameters @{ C = $c.canonical; M = $members } { param($C, $M) Merge-GroupEvidence -CanonicalId $C -Members $M }
            foreach ($n in $linked) { @($got[$n]).Count | Should -BeGreaterThan 0 -Because "$($c.name): node $n" }
        }
    }

    It 'leaves the stored quote untouched: the key is used only for comparison' {
        $members = @(@{ Id = 'c-2026'; Links = @() }, @{ Id = 'c-2026-1'; Links = @([pscustomobject]@{ node = 'n1'; field = 'key_point'; quote = "governmentÆs plan" }) })
        $got = InModuleScope AITriad -Parameters @{ M = $members } { param($M) Merge-GroupEvidence -CanonicalId 'c-2026' -Members $M }
        $got['n1'][0].quote | Should -BeExactly "governmentÆs plan"
    }
}
