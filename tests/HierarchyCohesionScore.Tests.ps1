# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
    t/4073: cohesion_score is a 0-1 ratio, the share of a cluster's unordered node pairs joined by
    at least one supportive edge (SUPPORTS, ASSUMES, SUPPORTED_BY, either direction). This matches
    the hierarchy-proposal prompt's threshold (cohesion_score >= 0.50) and its 0-1 interpretation table.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    function script:Get-Cohesion {
        param([string[]]$Ids, [object[]]$Edges)
        $set = [System.Collections.Generic.HashSet[string]]::new([string[]]$Ids)
        (& (Get-Module AITriad) { param($i, $s, $e) Get-HierarchyClusterEdgeStat -ClusterIds $i -IdSet $s -AllEdges $e } $Ids $set $Edges).Cohesion
    }
    function script:E { param($s, $t, $type = 'SUPPORTS') [pscustomobject]@{ source = $s; target = $t; type = $type } }
}

Describe 'Hierarchy cohesion_score (t/4073)' -Tag 'hierarchy' {
    It 'several supportive edges between the same two nodes count once (was 1.5)' {
        script:Get-Cohesion -Ids 'a', 'b' -Edges @((E a b), (E b a 'ASSUMES'), (E a b 'SUPPORTED_BY')) | Should -Be 1.0
    }
    It 'a two-node cluster with one supportive edge is fully cohesive (was 0.5)' {
        script:Get-Cohesion -Ids 'a', 'b' -Edges @((E a b)) | Should -Be 1.0
    }
    It 'is the share of unordered pairs supported: 3 nodes, 1 supported pair = 0.33' {
        script:Get-Cohesion -Ids 'a', 'b', 'c' -Edges @((E a b), (E b a)) | Should -Be 0.33
    }
    It 'never exceeds 1.0 for a fully and redundantly connected cluster' {
        $edges = foreach ($s in 'a', 'b', 'c') { foreach ($t in 'a', 'b', 'c') { if ($s -ne $t) { E $s $t; E $s $t 'ASSUMES' } } }
        script:Get-Cohesion -Ids 'a', 'b', 'c' -Edges @($edges) | Should -Be 1.0
    }
    It 'ignores non-supportive edges, self-loops and edges leaving the cluster' {
        script:Get-Cohesion -Ids 'a', 'b' -Edges @((E a b 'CONTRADICTS'), (E a a), (E a z)) | Should -Be 0.0
    }
    It 'a single-node cluster scores 0 (no pairs)' {
        script:Get-Cohesion -Ids 'a' -Edges @((E a a)) | Should -Be 0.0
    }
}
