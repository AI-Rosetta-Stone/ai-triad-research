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

    It 'is version 3 of the section 7 fixture (v3 adds summary-only chunks and chunk_of, t/355)' {
        $script:Fixture.version | Should -Be 3
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

Describe 'Summary-only chunks, chunk_of and N2 (fixture v3, t/355 R1 to R7)' -Tag 'evidence-union' {

    BeforeAll {
        # The fixture's docs, as the functions take them: Docs (HasSource, Mark), the summaries, and the N2 fields.
        $script:V3Docs = {
            param($DocsObj)
            $h = @{}; $sum = @{}; $meta = @{}
            foreach ($p in $DocsObj.PSObject.Properties) {
                $d = $p.Value
                $mark = if ($d.PSObject.Properties['mark']) { $d.mark } else { $null }
                $h[$p.Name] = [pscustomobject]@{ HasSource = [bool]$d.has_source; Mark = $mark }
                $sum[$p.Name] = $d.summary
                if ($d.PSObject.Properties['chunk_generated_at'] -or $d.PSObject.Properties['chunk_model']) {
                    $m = @{}
                    if ($d.PSObject.Properties['chunk_generated_at']) { $m['chunk_generated_at'] = (& $script:NormScalar $d.chunk_generated_at) }
                    if ($d.PSObject.Properties['chunk_model']) { $m['chunk_model'] = [string]$d.chunk_model }
                    $meta[$p.Name] = $m
                }
            }
            @{ H = $h; S = $sum; M = $meta }
        }
        # One comparable line per kept entry. Timestamps are normalized, because ConvertFrom-Json turns them into DateTime.
        $script:NormScalar = {
            param($v)
            if ($null -eq $v) { return '' }
            if ($v -is [datetime]) { return $v.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
            $s = [string]$v
            $d = [datetime]::MinValue
            if ($s -match '^\d{4}-\d{2}-\d{2}T' -and [datetime]::TryParse($s, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$d)) {
                return $d.ToString('yyyy-MM-ddTHH:mm:ssZ')
            }
            $s
        }
        # Accepts a dictionary (node -> entries) or a parsed object with the same shape.
        $script:UnionLines = {
            param($U, $Norm)
            $lines = [System.Collections.Generic.List[string]]::new()
            $pairs = if ($U -is [System.Collections.IDictionary]) {
                @($U.Keys | ForEach-Object { [pscustomobject]@{ K = [string]$_; V = $U[$_] } })
            } else {
                @($U.PSObject.Properties | ForEach-Object { [pscustomobject]@{ K = [string]$_.Name; V = $_.Value } })
            }
            foreach ($pair in @($pairs | Sort-Object K)) {
                foreach ($e in @($pair.V)) {
                    $fields = foreach ($name in 'node', 'field', 'quote', 'doc', 'via', 'chunk_of', 'chunk_generated_at', 'chunk_model') {
                        $v = if ($e -is [System.Collections.IDictionary]) { $e[$name] } else { $p = $e.PSObject.Properties[$name]; if ($p) { $p.Value } else { $null } }
                        & $Norm $v
                    }
                    $lines.Add(($fields -join '|'))
                }
            }
            ,$lines.ToArray()
        }
    }

    It 'R1: every resolve case resolves as the reference says (d, base with source, transitive)' {
        foreach ($c in $script:FixtureObj.resolve_cases) {
            $d = & $script:V3Docs $c.docs
            $got = InModuleScope AITriad -Parameters @{ H = $d.H; I = [string]$c.id } { param($H, $I) Resolve-EvidenceDocId -Id $I -Docs $H }
            $got | Should -Be $c.expected -Because $c.name
        }
    }

    It 'R2 to R4: each chunk case unions to the reference, with via, chunk_of and N2 attribution' {
        foreach ($c in $script:FixtureObj.chunk_union_cases) {
            $d = & $script:V3Docs $c.docs
            $got = InModuleScope AITriad -Parameters @{ H = $d.H; S = $d.S; M = $d.M; C = [string]$c.canonical } {
                param($H, $S, $M, $C)
                $members = @(Get-EvidenceGroupMembers -Canonical $C -Docs $H | ForEach-Object {
                        $meta = if ($M.ContainsKey($_.Id)) { $M[$_.Id] } else { @{} }
                        [pscustomobject]@{ Id = $_.Id; Kind = $_.Kind; Via = $_.Via
                            ChunkGeneratedAt = $meta['chunk_generated_at']; ChunkModel = $meta['chunk_model']
                            Links = @(Get-SummaryEvidenceLink $S[$_.Id]) } })
                $canon = [pscustomobject]@{ Id = $C; Kind = 'canonical'; Links = @(Get-SummaryEvidenceLink $S[$C]) }
                Merge-GroupEvidence -CanonicalId $C -Members (@($canon) + $members)
            }
            $gotLines = & $script:UnionLines $got $script:NormScalar
            $expLines = & $script:UnionLines $c.expected $script:NormScalar
            ($gotLines -join "`n") | Should -Be ($expLines -join "`n") -Because $c.name
        }
    }

    It 'R5: the group of each chunk case is one document' {
        foreach ($c in $script:FixtureObj.chunk_union_cases) {
            $d = & $script:V3Docs $c.docs
            $n = InModuleScope AITriad -Parameters @{ H = $d.H; C = [string]$c.canonical } {
                param($H, $C)
                $ids = @($C) + @(Get-EvidenceGroupMembers -Canonical $C -Docs $H | ForEach-Object { $_.Id })
                @($ids | ForEach-Object { Resolve-EvidenceDocId -Id $_ -Docs $H } | Select-Object -Unique).Count
            }
            $n | Should -Be $c.expected_documents -Because $c.name
        }
    }

    It 'R6: extraction keeps every kept fact, including via and chunk_of, for each chunk case' {
        foreach ($c in $script:FixtureObj.chunk_union_cases) {
            $d = & $script:V3Docs $c.docs
            $got = InModuleScope AITriad -Parameters @{ H = $d.H; S = $d.S; M = $d.M; C = [string]$c.canonical } {
                param($H, $S, $M, $C)
                $members = @(Get-EvidenceGroupMembers -Canonical $C -Docs $H | ForEach-Object {
                        $meta = if ($M.ContainsKey($_.Id)) { $M[$_.Id] } else { @{} }
                        [pscustomobject]@{ Id = $_.Id; Kind = $_.Kind; Via = $_.Via
                            ChunkGeneratedAt = $meta['chunk_generated_at']; ChunkModel = $meta['chunk_model']
                            Links = @(Get-SummaryEvidenceLink $S[$_.Id]) } })
                $canon = [pscustomobject]@{ Id = $C; Kind = 'canonical'; Links = @(Get-SummaryEvidenceLink $S[$C]) }
                Merge-GroupEvidence -CanonicalId $C -Members (@($canon) + $members)
            }
            # t/373#3 and t/160: extraction keeps every kept fact, including via and chunk_of.
            $gotLines = & $script:UnionLines $got $script:NormScalar
            $expLines = & $script:UnionLines $c.expected_extracted $script:NormScalar
            ($gotLines -join "`n") | Should -Be ($expLines -join "`n") -Because $c.name
        }
    }
}
