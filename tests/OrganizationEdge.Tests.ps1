# Tag: taxonomy (t/1526)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for the organization actor-relationship edge subsystem (t/1526):
    the OrganizationEdgesStore loader, the Test-OrganizationEdgeIntegrity
    validator, and the Get-/Import-OrganizationEdge public cmdlets.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Pester v5 scoping: helpers must be defined inside BeforeAll to be visible
    # to Describe/It blocks.
    function New-EdgeFixture {
        param(
            [Parameter(Mandatory)]
            [object[]]$Edges
        )
        $tmp = [System.IO.Path]::GetTempFileName()
        $payload = [ordered]@{
            _schema_version = '1.0.0'
            _doc            = 'test fixture'
            last_modified   = '2026-07-12'
            edges           = $Edges
        }
        $payload | ConvertTo-Json -Depth 8 | Set-Content -Path $tmp -Encoding utf8NoBOM
        return $tmp
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Live-file smoke — the shipped organization_edges.json passes integrity
# ─────────────────────────────────────────────────────────────────────────────
Describe 'organization_edges.json shipped file (t/1526)' -Tag 'taxonomy' {

    It 'Integrity check passes on the live registry' {
        InModuleScope AITriad {
            $r = Test-OrganizationEdgeIntegrity
            $r.Pass    | Should -BeTrue
            $r.Errors  | Should -Be 0
        }
    }

    It 'Ref-resolving integrity check passes on the live registry' {
        InModuleScope AITriad {
            $r = Test-OrganizationEdgeIntegrity -ResolveRefs
            $r.Pass    | Should -BeTrue
            $r.Errors  | Should -Be 0
        }
    }

    It 'All 25 orgs have at least one outbound edge' {
        $all = Get-OrganizationEdge
        $sources = @($all | ForEach-Object { $_.Source } | Sort-Object -Unique)
        $sources.Count | Should -Be 25
    }

    It 'Every currently-realized type family is populated in the backfill' {
        $all = Get-OrganizationEdge
        $types = @($all | ForEach-Object { $_.Type } | Sort-Object -Unique)
        # SUPPORTS_POLICY / OPPOSES_POLICY are reserved (HLD Non-Goal) — six others must be present.
        foreach ($required in 'ADVOCATES_FOR','OPPOSES','PUBLISHED','ALLIED_WITH','COMPETES_WITH','FUNDS') {
            $types | Should -Contain $required
        }
    }

    It 'No SUPPORTS_POLICY / OPPOSES_POLICY edges shipped (HLD Non-Goal)' {
        $all = Get-OrganizationEdge
        @($all | Where-Object { $_.Type -in 'SUPPORTS_POLICY','OPPOSES_POLICY' }).Count | Should -Be 0
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Integrity validator — negative cases via fixture files
# ─────────────────────────────────────────────────────────────────────────────
Describe 'Test-OrganizationEdgeIntegrity fixture cases (t/1526)' -Tag 'taxonomy' {

    It 'Flags a non-org source as error' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='sit-001'; target='org-002'; type='COMPETES_WITH'; rationale='invalid source shape' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass | Should -BeFalse
                @($r.Issues | Where-Object { $_.Field -eq 'source' -and $_.Severity -eq 'error' }).Count | Should -BeGreaterThan 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Flags an unknown type as error' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='org-002'; type='COLLABORATES_WITH'; rationale='bad type' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass | Should -BeFalse
                @($r.Issues | Where-Object { $_.Field -eq 'type' }).Count | Should -BeGreaterThan 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Flags a target family mismatch (org-to-org type given a sit-* target)' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='sit-023'; type='COMPETES_WITH'; rationale='wrong family' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass | Should -BeFalse
                @($r.Issues | Where-Object { $_.Field -eq 'target' }).Count | Should -BeGreaterThan 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Flags a self-loop' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='org-001'; type='ALLIED_WITH'; rationale='reflexive' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass | Should -BeFalse
                @($r.Issues | Where-Object { $_.Message -like '*self-loop*' }).Count | Should -BeGreaterThan 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Flags composite-key duplicates' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='org-002'; type='COMPETES_WITH'; rationale='first' }
            [ordered]@{ source='org-001'; target='org-002'; type='COMPETES_WITH'; rationale='second' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass | Should -BeFalse
                @($r.Issues | Where-Object { $_.Message -like '*duplicate*' }).Count | Should -BeGreaterThan 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Accepts a rejected-status edge with zero warnings (t/1557)' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='sit-023'; type='ADVOCATES_FOR'; rationale='r'; status='rejected' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass     | Should -BeTrue
                $r.Errors   | Should -Be 0
                $r.Warnings | Should -Be 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }

    It 'Accepts a well-formed fixture with all six populated types' {
        $fx = New-EdgeFixture @(
            [ordered]@{ source='org-001'; target='org-002'; type='COMPETES_WITH'; rationale='r' }
            [ordered]@{ source='org-007'; target='org-008'; type='ALLIED_WITH';   rationale='r' }
            [ordered]@{ source='org-005'; target='org-001'; type='FUNDS';         rationale='r' }
            [ordered]@{ source='org-001'; target='sit-023'; type='ADVOCATES_FOR'; rationale='r' }
            [ordered]@{ source='org-002'; target='sit-010'; type='OPPOSES';       rationale='r' }
            [ordered]@{ source='org-014'; target='nist-ai-rmf-1.0-2023'; type='PUBLISHED'; rationale='r' }
        )
        try {
            InModuleScope AITriad -Parameters @{ Path = $fx } {
                param($Path)
                $r = Test-OrganizationEdgeIntegrity -Path $Path
                $r.Pass   | Should -BeTrue
                $r.Errors | Should -Be 0
            }
        } finally { Remove-Item $fx -Force -ErrorAction SilentlyContinue }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-OrganizationEdge — filter semantics
# ─────────────────────────────────────────────────────────────────────────────
Describe 'Get-OrganizationEdge filter semantics (t/1526)' -Tag 'taxonomy' {

    It 'Returns typed [OrganizationEdge] instances' {
        $edges = Get-OrganizationEdge
        $edges.Count | Should -BeGreaterThan 0
        $edges[0].GetType().Name | Should -Be 'OrganizationEdge'
    }

    It 'Filters by -OrgId with default -Direction Out (source-only)' {
        $out = Get-OrganizationEdge -OrgId org-024
        # Every returned edge should have org-024 as source.
        foreach ($e in $out) { $e.Source | Should -Be 'org-024' }
        $out.Count | Should -BeGreaterThan 0
    }

    It '-Direction In returns edges where OrgId is the target' {
        $inEdges = Get-OrganizationEdge -OrgId org-002 -Direction In
        foreach ($e in $inEdges) { $e.Target | Should -Be 'org-002' }
        $inEdges.Count | Should -BeGreaterThan 0
    }

    It '-Direction Either matches source OR target' {
        $any = Get-OrganizationEdge -OrgId org-001 -Direction Either
        $out = Get-OrganizationEdge -OrgId org-001 -Direction Out
        $inn = Get-OrganizationEdge -OrgId org-001 -Direction In
        $any.Count | Should -Be ($out.Count + $inn.Count)
    }

    It 'Filters by -Type (any casing accepted)' {
        $lower = Get-OrganizationEdge -Type 'funds'
        $upper = Get-OrganizationEdge -Type 'FUNDS'
        $lower.Count | Should -Be $upper.Count
        $lower.Count | Should -BeGreaterThan 0
        foreach ($e in $upper) { $e.Type | Should -Be 'FUNDS' }
    }

    It 'Rejects an unknown -Type with ActionableError' {
        { Get-OrganizationEdge -Type 'COLLABORATES_WITH' } | Should -Throw
    }

    It 'Combines -OrgId + -Type + -Direction' {
        $r = Get-OrganizationEdge -OrgId org-024 -Type ALLIED_WITH -Direction Out
        foreach ($e in $r) {
            $e.Source | Should -Be 'org-024'
            $e.Type   | Should -Be 'ALLIED_WITH'
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-OrganizationEdge — status filter (t/299)
# ─────────────────────────────────────────────────────────────────────────────
Describe 'Get-OrganizationEdge -Status (t/299)' -Tag 'taxonomy' {

    BeforeAll {
        $script:statusPath = New-EdgeFixture -Edges @(
            [ordered]@{ source = 'org-001'; target = 'org-002'; type = 'ALLIED_WITH';   rationale = 'a'; source_refs = @(); status = 'approved' }
            [ordered]@{ source = 'org-001'; target = 'org-003'; type = 'COMPETES_WITH'; rationale = 'p'; source_refs = @(); status = 'proposed' }
            [ordered]@{ source = 'org-001'; target = 'org-004'; type = 'FUNDS';         rationale = 'r'; source_refs = @(); status = 'rejected' }
            [ordered]@{ source = 'org-001'; target = 'org-005'; type = 'OPPOSES';       rationale = 'n'; source_refs = @() }
        )
    }
    AfterAll {
        if (Test-Path $script:statusPath) { Remove-Item $script:statusPath -Force -ErrorAction SilentlyContinue }
        InModuleScope AITriad { Clear-OrganizationEdgesCache }
    }

    It 'excludes rejected edges by default, and counts a missing status as approved' {
        InModuleScope AITriad -Parameters @{ P = $script:statusPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Clear-OrganizationEdgesCache
            $r = @(Get-OrganizationEdge)
            @($r.Target | Sort-Object) | Should -Be @('org-002', 'org-003', 'org-005')
            ($r | Where-Object Target -eq 'org-005').Status | Should -Be 'approved'
        }
    }

    It '-Status rejected returns only the rejected edge' {
        InModuleScope AITriad -Parameters @{ P = $script:statusPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Clear-OrganizationEdgesCache
            $r = @(Get-OrganizationEdge -OrgId org-001 -Status rejected)
            $r.Count     | Should -Be 1
            $r[0].Target | Should -Be 'org-004'
        }
    }

    It '-Status with every value returns every edge' {
        InModuleScope AITriad -Parameters @{ P = $script:statusPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Clear-OrganizationEdgesCache
            @(Get-OrganizationEdge -Status approved, proposed, disputed, rejected).Count | Should -Be 4
            @(Get-OrganizationEdge -Status approved).Target | Sort-Object | Should -Be @('org-002', 'org-005')
        }
    }

    It 'returns an edge with an unknown status under any -Status, with a warning' {
        $odd = New-EdgeFixture -Edges @(
            [ordered]@{ source = 'org-001'; target = 'org-002'; type = 'ALLIED_WITH'; rationale = 'x'; source_refs = @(); status = 'pending-review' }
        )
        try {
            InModuleScope AITriad -Parameters @{ P = $odd } {
                param($P)
                $script:__testEdgePath = $P
                Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
                Clear-OrganizationEdgesCache
                $r = @(Get-OrganizationEdge -WarningVariable w -WarningAction SilentlyContinue)
                $r.Count | Should -Be 1
                "$w" | Should -Match "unknown status 'pending-review'"
                @(Get-OrganizationEdge -Status rejected -WarningAction SilentlyContinue).Count | Should -Be 1
            }
        } finally {
            Remove-Item $odd -Force -ErrorAction SilentlyContinue
            InModuleScope AITriad { Clear-OrganizationEdgesCache }
        }
    }

    It 'rejects an unknown -Status at binding' {
        { Get-OrganizationEdge -Status accepted } | Should -Throw
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Import-OrganizationEdge — upsert + validation
# ─────────────────────────────────────────────────────────────────────────────
Describe 'Import-OrganizationEdge upsert + validation (t/1526)' -Tag 'taxonomy' {

    BeforeEach {
        # Redirect the store to a private temp file so we don't touch the live registry.
        $script:tmpPath = [System.IO.Path]::GetTempFileName()
        ([ordered]@{
            _schema_version = '1.0.0'
            _doc            = 'test'
            last_modified   = '2026-07-12'
            edges           = @()
        }) | ConvertTo-Json -Depth 6 | Set-Content -Path $script:tmpPath -Encoding utf8NoBOM
    }
    AfterEach {
        if (Test-Path $script:tmpPath) { Remove-Item $script:tmpPath -Force -ErrorAction SilentlyContinue }
        # Clear the cache in the module so subsequent Describes reload the real file.
        InModuleScope AITriad { Clear-OrganizationEdgesCache }
    }

    # Redirects Get-OrganizationEdgesFilePath to the test's temp file. The mock
    # body reads $script:__testEdgePath from the MODULE scope (set inside
    # InModuleScope), because a plain closure over the test-scope $Path variable
    # does not survive the InModuleScope boundary.
    It 'Rejects an unknown type without writing' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            { Import-OrganizationEdge -Source org-001 -Target org-002 -Type 'COLLABORATES_WITH' -Rationale 'x' -Confirm:$false } | Should -Throw
        }
    }

    It 'Rejects a self-loop before writing' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            { Import-OrganizationEdge -Source org-001 -Target org-001 -Type ALLIED_WITH -Rationale 'x' -Confirm:$false } | Should -Throw
        }
    }

    It 'Adds a new edge (round-trip via Get)' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            $r = Import-OrganizationEdge -Source org-001 -Target org-002 -Type COMPETES_WITH -Rationale 'competitors' -Confirm:$false 6>$null 3>$null
            $r.Source | Should -Be 'org-001'
            $r.Target | Should -Be 'org-002'
            $r.Type   | Should -Be 'COMPETES_WITH'

            $edges = Get-OrganizationEdge
            @($edges).Count | Should -Be 1
            $edges[0].Rationale | Should -Be 'competitors'
        }
    }

    It 'Upserts by composite key (source, target, type) — same triple updates rationale' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Import-OrganizationEdge -Source org-001 -Target org-002 -Type COMPETES_WITH -Rationale 'first'  -Confirm:$false 6>$null 3>$null | Out-Null
            Import-OrganizationEdge -Source org-001 -Target org-002 -Type COMPETES_WITH -Rationale 'second' -Confirm:$false 6>$null 3>$null | Out-Null

            $edges = Get-OrganizationEdge
            @($edges).Count | Should -Be 1
            $edges[0].Rationale | Should -Be 'second'
        }
    }

    It 'Different type on the same (source,target) pair creates a distinct edge, not an update' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Import-OrganizationEdge -Source org-024 -Target org-001 -Type ALLIED_WITH -Rationale 'member'   -Confirm:$false 6>$null 3>$null | Out-Null
            Import-OrganizationEdge -Source org-024 -Target org-001 -Type FUNDS       -Rationale 'grant'    -Confirm:$false 6>$null 3>$null | Out-Null

            @(Get-OrganizationEdge).Count | Should -Be 2
        }
    }

    It 'Normalizes lower-case -Type input to canonical upper-case on write' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Import-OrganizationEdge -Source org-001 -Target org-002 -Type 'competes_with' -Rationale 'r' -Confirm:$false 6>$null 3>$null | Out-Null
            (Get-OrganizationEdge)[0].Type | Should -Be 'COMPETES_WITH'
        }
    }

    It '-InputObject parameter set accepts a hashtable payload' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            $obj = [PSCustomObject]@{
                source = 'org-005'; target = 'org-004'; type = 'FUNDS'; rationale = 'lead investor'
            }
            Import-OrganizationEdge -InputObject $obj -Confirm:$false 6>$null 3>$null | Out-Null
            $edges = Get-OrganizationEdge
            @($edges).Count     | Should -Be 1
            $edges[0].Source    | Should -Be 'org-005'
            $edges[0].Rationale | Should -Be 'lead investor'
        }
    }

    It 'Accepts -Status rejected (t/1557)' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            $r = Import-OrganizationEdge -Source org-001 -Target org-002 -Type COMPETES_WITH -Rationale 'no longer viable' -Status rejected -Confirm:$false 6>$null 3>$null
            $r.Status | Should -Be 'rejected'
            # Rejected edges are hidden by default since t/299; ask for them explicitly.
            @(Get-OrganizationEdge)                  | Should -HaveCount 0
            (Get-OrganizationEdge -Status rejected)[0].Status | Should -Be 'rejected'
        }
    }

    # t/1553#7 — single-element source_refs must serialize as JSON array, not scalar.
    # Regression fix: previously the record's source_refs field passed through
    # ConvertTo-Json without a typed cast, so single-element arrays unwrapped to
    # bare strings. Import-OrganizationEdge now uses [string[]] on the field so
    # array shape survives the serialization round-trip regardless of length.
    It 'A single-element source_refs survives as a JSON array (t/1553#7)' {
        InModuleScope AITriad -Parameters @{ P = $script:tmpPath } {
            param($P)
            $script:__testEdgePath = $P
            Mock Get-OrganizationEdgesFilePath { $script:__testEdgePath } -ModuleName AITriad
            Import-OrganizationEdge -InputObject ([PSCustomObject]@{
                source      = 'org-005'
                target      = 'org-007'
                type        = 'PUBLISHED'
                rationale   = 'array-shape guard'
                source_refs = @('single-src-id')
                status      = 'proposed'
            }) -Confirm:$false 6>$null 3>$null | Out-Null

            # Read the raw JSON to prove the serialized shape, not just the runtime object.
            $raw  = Get-Content $script:__testEdgePath -Raw | ConvertFrom-Json
            $edge = @($raw.edges | Where-Object { $_.target -eq 'org-007' })[0]
            $edge.source_refs                | Should -Not -BeNullOrEmpty
            $edge.source_refs.GetType().Name | Should -Be 'Object[]' -Because 'single-element source_refs must stay an array on disk'
            @($edge.source_refs).Count       | Should -Be 1
            $edge.source_refs[0]             | Should -Be 'single-src-id'
        }
    }
}
