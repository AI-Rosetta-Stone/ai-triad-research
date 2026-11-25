# Tag: taxonomy (refactor characterization)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-ProposalApply that PIN the current observable behavior
    across every action branch (NEW/RELABEL/MERGE/SPLIT/REORDER/DEPTH_EXPAND/WIDTH_EXPAND and
    the error guards). Added to protect a behavior-preserving complexity refactor.
.DESCRIPTION
    RACE-SAFE: dot-sources ONLY the single Private file under test and provides lightweight
    stubs for every collaborator it calls, so it never Import-Modules the (concurrently-edited)
    batch worktree module. Stubs capture the object that would be written to disk and the
    arguments of the policy-recount / tag-validation hooks, which is all the observable contract
    this function has (its return object, the written data shape, and the hook invocations).
#>

BeforeAll {
    $script:Target = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-ProposalApply.ps1'

    # --- Stubs for every collaborator Invoke-ProposalApply calls -------------------------
    $script:TaxDir = Join-Path ([System.IO.Path]::GetTempPath()) "proposalapply-char-$(New-Guid)"
    New-Item -ItemType Directory -Path $script:TaxDir -Force | Out-Null
    # The function Test-Path's the pov file, so the files must exist on disk (content is
    # irrelevant: Read-PovTaxonomyFile is stubbed to hand back an in-memory object).
    foreach ($f in @('accelerationist.json','safetyist.json','skeptic.json','situations.json')) {
        Set-Content -Path (Join-Path $script:TaxDir $f) -Value '{}'
    }
    $script:RepoRoot = 'unused'

    function Get-TaxonomyDir { $script:TaxDir }
    function Read-PovTaxonomyFile { param($Path) $script:RawData }
    function Write-PovTaxonomyFile { param($Path, $Data) $script:WrittenData = $Data }
    function Test-PovNodeId {
        param($Id, $Category)
        if ($script:FailNodeId) { throw "invalid node id '$Id'" }
        return $true
    }
    function Add-ChangeHistoryEntry { param($Node, $Action, $Fields) }
    function Add-TextHistoryEntry { param($Node, $Field, $Value, $Source, $Previous, $Reason) }
    function Set-NodeAphorism { param($Node, $Pov, $Reason) }
    function New-SituationNode {
        param($Id, $Label, $Description)
        [PSCustomObject]@{ id = $Id; label = $Label; description = $Description; interpretations = @() }
    }
    function Get-GraphAttributePolicyIds { param($GraphAttributes) @() }
    function Invoke-PovTagsValidation {
        param($Entries, $Goal)
        if ($script:FailTagValidation) { throw 'tag not registered' }
        $script:TagValidationCalls += , @{ Entries = $Entries; Goal = $Goal }
    }
    function Invoke-NodePolicyRegistration {
        param($NodeId, $PriorPolicyIds, $Caller)
        $script:PolicyRegCalls += , @{ NodeId = $NodeId; PriorPolicyIds = $PriorPolicyIds; Caller = $Caller }
    }

    . $script:Target

    function New-Node([hashtable]$Props) { [PSCustomObject]$Props }
    function New-Raw([object[]]$Nodes) { [PSCustomObject]@{ last_modified = '2026-01-01'; nodes = @($Nodes) } }
    function New-Proposal([hashtable]$Props) { [PSCustomObject]$Props }
    function Apply($Proposal) { Invoke-ProposalApply -Proposal $Proposal -WarningAction SilentlyContinue }
}

AfterAll {
    Remove-Item -LiteralPath $script:TaxDir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-ProposalApply characterization' -Tag 'taxonomy' {

    BeforeEach {
        $script:FailNodeId = $false
        $script:FailTagValidation = $false
        $script:WrittenData = $null
        $script:TagValidationCalls = @()
        $script:PolicyRegCalls = @()
        $script:RawData = $null
    }

    Context 'guards' {
        It 'rejects an unknown POV without writing' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{ pov = 'nope'; action = 'NEW' })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be 'Unknown POV: nope'
            $script:WrittenData | Should -BeNullOrEmpty
        }

        It 'rejects an unknown action' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'FLARG' })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be 'Unknown action: FLARG'
            $script:WrittenData | Should -BeNullOrEmpty
        }
    }

    Context 'NEW' {
        It 'adds a node and writes, with empty PovTagReview' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'NEW'; suggested_id = 'skp-beliefs-001'
                category = 'Beliefs'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeTrue -Because $r.Error
            $r.Error | Should -BeNullOrEmpty
            @($r.PovTagReview).Count | Should -Be 0
            @($script:WrittenData.nodes).Count | Should -Be 1
            $script:WrittenData.nodes[0].id | Should -Be 'skp-beliefs-001'
            $script:WrittenData.last_modified | Should -Not -Be '2026-01-01'
        }

        It 'rejects an ID collision' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001' })
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'NEW'; suggested_id = 'skp-beliefs-001'
                category = 'Beliefs'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "Node ID 'skp-beliefs-001' already exists"
            $script:WrittenData | Should -BeNullOrEmpty
        }

        It 'propagates a Test-PovNodeId failure' {
            $script:FailNodeId = $true
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'NEW'; suggested_id = 'skp-xx-001'
                category = 'Beliefs'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "invalid node id 'skp-xx-001'"
        }

        It 'uses New-SituationNode for the situations POV' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{
                pov = 'situations'; action = 'NEW'; suggested_id = 'sit-foo-001'
                category = 'Foo'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeTrue -Because $r.Error
            $script:WrittenData.nodes[0].id | Should -Be 'sit-foo-001'
        }
    }

    Context 'RELABEL' {
        It 'rejects a missing target' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'RELABEL'; target_node_id = 'skp-x-001'; label = 'New'; description = $null })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "Target node 'skp-x-001' not found"
        }

        It 'updates the label in place' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; label = 'Old'; description = 'D' })
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'RELABEL'; target_node_id = 'skp-beliefs-001'; label = 'New'; description = $null })
            $r.Success | Should -BeTrue -Because $r.Error
            $script:WrittenData.nodes[0].label | Should -Be 'New'
        }
    }

    Context 'MERGE' {
        It 'rejects a missing survivor' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'MERGE'; surviving_node_id = 'skp-s-001'; merge_node_ids = @('skp-s-001'); label = $null; description = $null })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "Surviving node 'skp-s-001' not found"
        }

        It 'unions pov_tags, removes merged nodes, validates and reports' {
            $script:RawData = New-Raw @(
                New-Node @{ id = 'skp-beliefs-001'; label = 'Survivor'; pov_tags = @('critical') }
                New-Node @{ id = 'skp-beliefs-002'; label = 'Merged'; pov_tags = @('critical', 'rights-based') }
            )
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'MERGE'; surviving_node_id = 'skp-beliefs-001'
                merge_node_ids = @('skp-beliefs-001', 'skp-beliefs-002'); label = $null; description = $null
            })
            $r.Success | Should -BeTrue -Because $r.Error
            @($script:WrittenData.nodes).Count | Should -Be 1
            @($script:WrittenData.nodes[0].pov_tags | Sort-Object) -join ',' | Should -Be 'critical,rights-based'
            @($r.PovTagReview).Count | Should -Be 1
            $r.PovTagReview[0].Reason | Should -Be 'merge-union'
            @($script:TagValidationCalls).Count | Should -Be 1
        }
    }

    Context 'SPLIT' {
        It 'rejects a split with no children' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; category = 'Beliefs'; children = @() })
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'SPLIT'; target_node_id = 'skp-beliefs-001'; children = @() })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be 'SPLIT proposal has no children'
        }

        It 'creates children that inherit the parent pov_tags' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; category = 'Beliefs'; children = @(); pov_tags = @('critical') })
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'SPLIT'; target_node_id = 'skp-beliefs-001'
                children = @(
                    (New-Proposal @{ suggested_id = 'skp-beliefs-010'; label = 'A'; description = 'da' })
                    (New-Proposal @{ suggested_id = 'skp-beliefs-011'; label = 'B'; description = 'db' })
                )
            })
            $r.Success | Should -BeTrue -Because $r.Error
            @($script:WrittenData.nodes).Count | Should -Be 3
            @($r.PovTagReview).Count | Should -Be 2
            $r.PovTagReview[0].Reason | Should -Be 'split-inherit'
            ($script:WrittenData.nodes | Where-Object { $_.id -eq 'skp-beliefs-001' }).children -join ',' | Should -Be 'skp-beliefs-010,skp-beliefs-011'
        }
    }

    Context 'REORDER' {
        It 'rejects a missing new parent' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; parent_id = $null })
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'REORDER'; target_node_id = 'skp-beliefs-001'; new_parent_id = 'skp-missing-001' })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "New parent 'skp-missing-001' not found — exact match required"
        }

        It 'reparents the target' {
            $script:RawData = New-Raw @(
                New-Node @{ id = 'skp-beliefs-001'; parent_id = $null; children = @() }
                New-Node @{ id = 'skp-beliefs-002'; parent_id = $null; children = @() }
            )
            $r = Apply (New-Proposal @{ pov = 'skeptic'; action = 'REORDER'; target_node_id = 'skp-beliefs-001'; new_parent_id = 'skp-beliefs-002' })
            $r.Success | Should -BeTrue -Because $r.Error
            ($script:WrittenData.nodes | Where-Object { $_.id -eq 'skp-beliefs-001' }).parent_id | Should -Be 'skp-beliefs-002'
            ($script:WrittenData.nodes | Where-Object { $_.id -eq 'skp-beliefs-002' }).children -join ',' | Should -Be 'skp-beliefs-001'
        }
    }

    Context 'DEPTH_EXPAND' {
        It 'rejects more than 3 sub-groups' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; category = 'Beliefs'; children = @() })
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'DEPTH_EXPAND'; target_node_id = 'skp-beliefs-001'
                children = @(
                    (New-Proposal @{ suggested_id = 'a'; label = 'a'; description = 'a' })
                    (New-Proposal @{ suggested_id = 'b'; label = 'b'; description = 'b' })
                    (New-Proposal @{ suggested_id = 'c'; label = 'c'; description = 'c' })
                    (New-Proposal @{ suggested_id = 'd'; label = 'd'; description = 'd' })
                )
            })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be 'DEPTH_EXPAND exceeds max 3 node changes per proposal'
        }

        It 'creates an intermediate node and reparents assigned children' {
            $script:RawData = New-Raw @(
                New-Node @{ id = 'skp-beliefs-001'; category = 'Beliefs'; children = @('skp-beliefs-050') }
                New-Node @{ id = 'skp-beliefs-050'; category = 'Beliefs'; parent_id = 'skp-beliefs-001'; children = @() }
            )
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'DEPTH_EXPAND'; target_node_id = 'skp-beliefs-001'
                children = @(
                    (New-Proposal @{ suggested_id = 'skp-beliefs-020'; label = 'Grp'; description = 'g'; assigned_children = @('skp-beliefs-050') })
                )
            })
            $r.Success | Should -BeTrue -Because $r.Error
            @($script:WrittenData.nodes).Count | Should -Be 3
            ($script:WrittenData.nodes | Where-Object { $_.id -eq 'skp-beliefs-050' }).parent_id | Should -Be 'skp-beliefs-020'
            ($script:WrittenData.nodes | Where-Object { $_.id -eq 'skp-beliefs-020' }).children -join ',' | Should -Be 'skp-beliefs-050'
        }
    }

    Context 'WIDTH_EXPAND' {
        It 'adds a node like NEW' {
            $script:RawData = New-Raw @()
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'WIDTH_EXPAND'; suggested_id = 'skp-beliefs-030'
                category = 'Beliefs'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeTrue -Because $r.Error
            @($script:WrittenData.nodes).Count | Should -Be 1
            $script:WrittenData.nodes[0].id | Should -Be 'skp-beliefs-030'
        }

        It 'rejects an ID collision' {
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-030' })
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'WIDTH_EXPAND'; suggested_id = 'skp-beliefs-030'
                category = 'Beliefs'; label = 'L'; description = 'D'
            })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be "Node ID 'skp-beliefs-030' already exists"
        }
    }

    Context 'tag validation failure' {
        It 'refuses the whole apply and writes nothing' {
            $script:FailTagValidation = $true
            $script:RawData = New-Raw @(New-Node @{ id = 'skp-beliefs-001'; category = 'Beliefs'; children = @(); pov_tags = @('critical') })
            $r = Apply (New-Proposal @{
                pov = 'skeptic'; action = 'SPLIT'; target_node_id = 'skp-beliefs-001'
                children = @((New-Proposal @{ suggested_id = 'skp-beliefs-010'; label = 'A'; description = 'da' }))
            })
            $r.Success | Should -BeFalse
            $r.Error | Should -Be 'tag not registered'
            $script:WrittenData | Should -BeNullOrEmpty
        }
    }
}
