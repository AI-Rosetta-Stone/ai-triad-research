# Tag: supersession (t/4356 PR A, mirrors t/4354)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# The PowerShell supersession reader (scripts/AITriad/Private/TaxonomySupersession.ps1). The index is asserted
# against tests/fixtures/supersession-cases.json, which lib/debate/supersession.fixture.test.ts runs through TS
# buildSupersessionIndex (TL t/4356#7: one shared fixture, not a mirror).

BeforeDiscovery {
    $script:Cases = @((Get-Content -Raw -Path (Join-Path $PSScriptRoot 'fixtures' 'supersession-cases.json') | ConvertFrom-Json -AsHashtable).cases)
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    # Loads a fake POV cache (no disk), runs the real split, and pins the freshness cooldown so
    # Assert-TaxonomyCacheFresh doesn't reload the real data repo over it.
    function script:Set-FakeTaxonomy([hashtable]$Povs) {
        InModuleScope AITriad -Parameters @{ P = $Povs } {
            param($P)
            $script:TaxonomyData = @{}
            foreach ($k in $P.Keys) { $script:TaxonomyData[$k] = [pscustomobject]@{ nodes = @($P[$k] | ForEach-Object { [pscustomobject]$_ }) } }
            $script:TaxonomyCacheLastCheck = [DateTime]::UtcNow.AddHours(1)
            Update-TaxonomySupersessionCache 3>$null
        }
    }
    function script:N([string]$Id, [string]$By) { $h = [ordered]@{ id = $Id; label = "L $Id"; description = "D $Id" }; if ($By) { $h.superseded_by = $By }; $h }
}

AfterAll {
    Remove-Module AITriad -Force -ErrorAction SilentlyContinue
}

Describe 'New-TaxonomySupersessionIndex: shared fixture' -Tag 'supersession' {
    It '<id>' -ForEach $script:Cases {
        $r = InModuleScope AITriad -Parameters @{ C = $_ } {
            param($C)
            $warnings = [System.Collections.Generic.List[string]]::new()
            $nodes = @($C.nodes | ForEach-Object { [pscustomobject]$_ })
            $idx = New-TaxonomySupersessionIndex -Nodes $nodes -Warn { param($m) $warnings.Add($m) }
            $resolved = [ordered]@{}
            foreach ($k in $C.resolve.Keys) { $n = Resolve-TaxonomyNode -Index $idx -Id $k; $resolved[$k] = if ($n) { [string]$n.id } else { $null } }
            [pscustomobject]@{
                Selectable = [string[]]@((Select-SelectableTaxonomyNode -Nodes $nodes) | ForEach-Object id)
                Superseded = [string[]]@($idx.SupersededIds | Sort-Object)
                Resolved   = $resolved
                WarnKinds  = [string[]]@($warnings | ForEach-Object { if ($_ -match 'cycle') { 'cycle' } elseif ($_ -match 'not found') { 'dangling' } else { 'chain' } } | Sort-Object -Unique)
            }
        }
        $r.Selectable | Should -Be ([string[]]@($selectable))
        $r.Superseded | Should -Be ([string[]]@($superseded | Sort-Object))
        foreach ($k in $resolve.Keys) { $r.Resolved[$k] | Should -Be $resolve[$k] -Because "resolve($k)" }
        $r.WarnKinds | Should -Be ([string[]]@($warn_kinds | Sort-Object))
    }

    It 'never throws on an empty node list' {
        InModuleScope AITriad { (New-TaxonomySupersessionIndex -Nodes @()).SupersededIds.Count } | Should -Be 0
    }
}

Describe 'Module cache: selection vs lookup (AC1)' -Tag 'supersession' {
    BeforeAll {
        Set-FakeTaxonomy @{
            accelerationist = @((N 'acc-beliefs-001' 'acc-beliefs-002'), (N 'acc-beliefs-002'))
            safetyist       = @((N 'saf-beliefs-001'))
            skeptic         = @((N 'skp-beliefs-001'))
            situations      = @((N 'sit-001' 'sit-002'), (N 'sit-002'))
        }
    }

    It 'leaves a superseded node out of selection' {
        @(Get-Tax -POV accelerationist | ForEach-Object Id) | Should -Be @('acc-beliefs-002')
        InModuleScope AITriad { @($script:TaxonomyData['accelerationist'].nodes | ForEach-Object id) } | Should -Be @('acc-beliefs-002')
    }

    It 'returns the stored superseded node by exact id' {
        $n = InModuleScope AITriad { Get-TaxonomyNodeById -Id 'acc-beliefs-001' }
        $n.id | Should -BeExactly 'acc-beliefs-001'
        $n.superseded_by | Should -BeExactly 'acc-beliefs-002'
        @(Get-Tax -Id 'acc-beliefs-001' | ForEach-Object Id) | Should -Be @('acc-beliefs-001')
    }

    It 'resolves a superseded id to its survivor' {
        (InModuleScope AITriad { Get-TaxonomyNodeById -Id 'acc-beliefs-001' -Resolve }).id | Should -BeExactly 'acc-beliefs-002'
    }

    It 'keeps a wildcard -Id to selectable nodes, and -IncludeSuperseded returns every node' {
        @(Get-Tax -Id 'acc-*' | ForEach-Object Id) | Should -Be @('acc-beliefs-002')
        @(Get-Tax -POV accelerationist -IncludeSuperseded | ForEach-Object Id) | Should -Be @('acc-beliefs-001', 'acc-beliefs-002')
    }

    It 'never filters situations (TS loader parity)' {
        @(Get-Tax -POV situations | ForEach-Object Id) | Should -Be @('sit-001', 'sit-002')
    }

    It 'returns $null for an unknown id' {
        InModuleScope AITriad { Get-TaxonomyNodeById -Id 'acc-beliefs-999' } | Should -BeNullOrEmpty
    }
}

Describe 'Default edge views skip superseded endpoints' -Tag 'supersession' {
    BeforeAll {
        Set-FakeTaxonomy @{
            accelerationist = @((N 'acc-beliefs-001' 'acc-beliefs-002'), (N 'acc-beliefs-002'))
            safetyist       = @((N 'saf-beliefs-001'))
            skeptic         = @((N 'skp-beliefs-001'))
        }
        $edges = @{ edges = @(
                @{ source = 'acc-beliefs-001'; target = 'saf-beliefs-001'; type = 'SUPPORTS'; status = 'approved'; confidence = 0.9; bidirectional = $false; rationale = 'r'; discovered_at = '2026-01-01'; model = 'm' },
                @{ source = 'acc-beliefs-002'; target = 'saf-beliefs-001'; type = 'SUPPORTS'; status = 'approved'; confidence = 0.9; bidirectional = $false; rationale = 'r'; discovered_at = '2026-01-01'; model = 'm' },
                @{ source = 'saf-beliefs-001'; target = 'skp-beliefs-001'; type = 'SUPPORTS'; status = 'approved'; confidence = 0.9; bidirectional = $false; rationale = 'r'; discovered_at = '2026-01-01'; model = 'm' }
            ) }
        $script:EdgeDir = Join-Path $TestDrive 'tax'
        New-Item -ItemType Directory -Path $script:EdgeDir -Force | Out-Null
        $edges | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:EdgeDir 'edges.json') -Encoding utf8NoBOM
        foreach ($pov in 'accelerationist', 'safetyist', 'skeptic') {
            $ns = InModuleScope AITriad -Parameters @{ P = $pov } { param($P) $script:TaxonomyAllNodesByPov[$P] }
            @{ nodes = @($ns) } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:EdgeDir "$pov.json") -Encoding utf8NoBOM
        }
        $d = $script:EdgeDir
        Mock -ModuleName AITriad Get-TaxonomyDir { param($ChildPath) if ($ChildPath) { Join-Path $d $ChildPath } else { $d } }.GetNewClosure()
    }

    It 'Get-Edge leaves out an edge touching a superseded node' {
        @(Get-Edge | ForEach-Object { "$($_.Source)>$($_.Target)" }) | Should -Be @('acc-beliefs-002>saf-beliefs-001', 'saf-beliefs-001>skp-beliefs-001')
    }

    It 'Get-Edge -IncludeSuperseded and -Id still reach it' {
        @(Get-Edge -IncludeSuperseded).Count | Should -Be 3
        (Get-Edge -Id 'edg-00001').Source | Should -BeExactly 'acc-beliefs-001'
    }

    It 'Find-GraphPath does not walk through a superseded node' {
        (Find-GraphPath -From 'acc-beliefs-001' -To 'skp-beliefs-001' 6>$null 3>$null).path_count | Should -Be 0
        (Find-GraphPath -From 'acc-beliefs-002' -To 'skp-beliefs-001' 6>$null 3>$null).path_count | Should -BeGreaterThan 0
        (Find-GraphPath -From 'acc-beliefs-001' -To 'skp-beliefs-001' -IncludeSuperseded 6>$null 3>$null).path_count | Should -BeGreaterThan 0
    }

    It 'Read-PovTaxonomyNodes -Selectable drops superseded nodes; without it returns the file' {
        $sel = InModuleScope AITriad { Read-PovTaxonomyNodes -Pov accelerationist -Selectable }
        @($sel | ForEach-Object id) | Should -Be @('acc-beliefs-002')
        $all = InModuleScope AITriad { Read-PovTaxonomyNodes -Pov accelerationist }
        @($all | ForEach-Object id) | Should -Be @('acc-beliefs-001', 'acc-beliefs-002')
    }
}
