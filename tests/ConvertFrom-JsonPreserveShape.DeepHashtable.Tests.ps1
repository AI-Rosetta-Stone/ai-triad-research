# Tag: data-shape (t/4425)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# ConvertFrom-JsonPreserveShape -AsDeepHashtable gives the `ConvertFrom-Json -AsHashtable` shape (OrderedHashtable
# at every level, so [hashtable] parameters and $x["k"] indexing keep working) without its datetime coercion, which
# on PS 7.4 rewrote whole-file conflict timestamps (".440Z" -> ".44Z", t/4366#3). Used by the conflict rewriters.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Json = '{"id":"c1","created_at":"2026-01-01T00:00:00.440Z","instances":[{"doc_id":"d1","at":"2026-02-02T10:20:30Z"}],"one":["x"],"empty":[],"n":{"deep":{"k":1.5}}}'
}

AfterAll { Remove-Module AITriad -Force -ErrorAction SilentlyContinue }

Describe 'ConvertFrom-JsonPreserveShape -AsDeepHashtable (t/4425)' -Tag 'data-shape' {
    It 'returns OrderedHashtable objects at every level, and they are [hashtable]' {
        $h = InModuleScope AITriad -Parameters @{ J = $script:Json } { param($J) ConvertFrom-JsonPreserveShape -Json $J -AsDeepHashtable }
        $h | Should -BeOfType [System.Management.Automation.OrderedHashtable]
        $h['instances'][0] | Should -BeOfType [System.Management.Automation.OrderedHashtable]
        $h['n']['deep'] -is [hashtable] | Should -BeTrue
        $h['instances'][0]['doc_id'] | Should -BeExactly 'd1'
        @($h.Keys) | Should -Be @('id', 'created_at', 'instances', 'one', 'empty', 'n') -Because 'source key order is kept'
    }

    It 'keeps datetime strings verbatim and array shapes, so a rewrite is exact' {
        $h = InModuleScope AITriad -Parameters @{ J = $script:Json } { param($J) ConvertFrom-JsonPreserveShape -Json $J -AsDeepHashtable }
        $h['created_at'] | Should -BeOfType [string]
        $h['created_at'] | Should -BeExactly '2026-01-01T00:00:00.440Z'
        @($h['one']).Count | Should -Be 1
        ($h | ConvertTo-Json -Depth 10 -Compress) | Should -BeExactly $script:Json
    }

    It 'differs from plain -AsHashtable exactly where the drift was (the arm this fixes)' {
        $plain = $script:Json | ConvertFrom-Json -AsHashtable
        if ($plain['created_at'] -isnot [datetime]) { Set-ItResult -Skipped -Because 'this runtime does not coerce dates (PS 7.5+ -DateKind default)'; return }
        ($plain | ConvertTo-Json -Depth 10 -Compress) | Should -Not -BeExactly $script:Json
    }
}

Describe 'POV-summary conflict append keeps existing timestamps (t/4425)' -Tag 'data-shape' {
    It 'appends an instance without rewriting an existing ".440Z" timestamp' {
        $dir = Join-Path $TestDrive 'conflicts'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $existing = [ordered]@{
            claim_id = 'conflict-x'; claim_label = 'x'; created_at = '2026-01-01T00:00:00.440Z'
            instances = @([ordered]@{ doc_id = 'd1'; logged_at = '2026-02-02T10:20:30.100Z' }); linked_taxonomy_nodes = @('acc-beliefs-001')
        }
        [System.IO.File]::WriteAllText((Join-Path $dir 'conflict-x.json'), ($existing | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
        InModuleScope AITriad -Parameters @{ D = $dir } {
            param($D)
            Mock Write-OK { }; Mock Write-Info { }; Mock Assert-DataWriteAllowed { }
            Add-POVSummaryHintedConflict -HintId 'conflict-x' -Context @{
                ConflictsDir = $D; DocId = 'd2'; Instance = [ordered]@{ doc_id = 'd2'; logged_at = '2026-03-03T00:00:00Z' }; LinkedNodes = @('saf-beliefs-001')
            }
        }
        $text = [System.IO.File]::ReadAllText((Join-Path $dir 'conflict-x.json'))
        $text | Should -Match '"created_at": "2026-01-01T00:00:00.440Z"'
        $text | Should -Match '"logged_at": "2026-02-02T10:20:30.100Z"'
        $after = $text | ConvertFrom-Json
        @($after.instances.doc_id) | Should -Be @('d1', 'd2')
        @($after.linked_taxonomy_nodes) | Should -Be @('acc-beliefs-001', 'saf-beliefs-001')
    }
}
