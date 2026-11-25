# Tag: ingestion (t/629)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Get-BatchDebateContext names a debate by its id when the harvest manifest has no title (t/629).
.DESCRIPTION
    Harvest manifests the server writes no longer carry `debate_title` (the user's own text is kept out of
    the public data repo). A manifest has `debate_id`, `harvested_at` and `items[type, action, id, status]`.
    Under strict mode a bare read of the missing field threw and the whole manifest was skipped silently.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    function script:New-Harvests([object[]]$Manifests) {
        $dir = Join-Path $TestDrive ("harvests-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $n = 0
        foreach ($m in $Manifests) {
            $n++
            $text = if ($m -is [string]) { $m } else { $m | ConvertTo-Json -Depth 6 }
            [IO.File]::WriteAllText((Join-Path $dir "harvest-$n.json"), $text, [Text.UTF8Encoding]::new($false))
        }
        $dir
    }
    function script:Get-Context([string]$Dir) {
        InModuleScope AITriad -Parameters @{ Dir = $Dir } {
            param($Dir)
            Set-StrictMode -Version Latest
            $w = $null
            $ctx = Get-BatchDebateContext -HarvestsDir $Dir -WarningVariable w -WarningAction SilentlyContinue 6>$null
            [pscustomobject]@{ Context = $ctx; Warnings = @($w | ForEach-Object { "$_" }) }
        }
    }
}

Describe 'Get-BatchDebateContext (t/3910, t/629)' -Tag 'ingestion' {

    It 'a manifest with no debate_title names the debate by its debate_id, and says so once' {
        $dir = script:New-Harvests @(
            @{ debate_id = 'debate-7f3a'; harvested_at = '2026-11-25T12:00:00Z'; items = @(
                    @{ type = 'debate_ref'; action = 'add'; id = 'saf-beliefs-001'; status = 'applied' }
                    @{ type = 'debate_ref'; action = 'add'; id = 'acc-beliefs-002'; status = 'applied' }) }
            @{ debate_id = 'debate-91bc'; harvested_at = '2026-11-25T13:00:00Z'; items = @(
                    @{ type = 'debate_ref'; action = 'add'; id = 'saf-beliefs-001'; status = 'applied' }) })
        $r = script:Get-Context $dir
        @($r.Context['saf-beliefs-001'] | Sort-Object) | Should -Be @('debate-7f3a', 'debate-91bc')
        @($r.Context['acc-beliefs-002']) | Should -Be @('debate-7f3a')
        @($r.Warnings | Where-Object { $_ -match 'have no debate_title' }).Count | Should -Be 1 -Because 'the fallback is reported once, not per manifest'
        ($r.Warnings -join "`n") | Should -Match '2 harvest manifest\(s\) have no debate_title'
    }

    It 'an older manifest keeps its title; a mix of old and new works; nothing is $null' {
        $dir = script:New-Harvests @(
            @{ debate_title = 'Debate A'; debate_id = 'debate-old'; items = @(@{ type = 'debate_ref'; id = 'saf-beliefs-001'; status = 'applied' }) }
            @{ debate_id = 'debate-new'; items = @(@{ type = 'debate_ref'; action = 'add'; id = 'saf-beliefs-001'; status = 'applied' }) })
        $r = script:Get-Context $dir
        @($r.Context['saf-beliefs-001'] | Sort-Object) | Should -Be @('Debate A', 'debate-new')
        @($r.Context['saf-beliefs-001'] | Where-Object { $null -eq $_ }).Count | Should -Be 0
        ($r.Warnings -join "`n") | Should -Match '1 harvest manifest\(s\) have no debate_title'
    }

    It 'only applied debate_ref items count; other types and statuses are left out' {
        $dir = script:New-Harvests @(
            @{ debate_id = 'debate-x'; items = @(
                    @{ type = 'debate_ref'; action = 'add'; id = 'saf-beliefs-001'; status = 'rejected' }
                    @{ type = 'node'; action = 'add'; id = 'saf-beliefs-002'; status = 'applied' }
                    @{ type = 'debate_ref'; action = 'add'; id = 'saf-beliefs-003'; status = 'applied' }) })
        $r = script:Get-Context $dir
        @($r.Context.Keys) | Should -Be @('saf-beliefs-003')
    }

    It 'a manifest with neither a title nor an id is skipped with a WARN that names it; the others still load' {
        $dir = script:New-Harvests @(
            @{ harvested_at = '2026-11-25T12:00:00Z'; items = @(@{ type = 'debate_ref'; id = 'saf-beliefs-001'; status = 'applied' }) }
            @{ debate_id = 'debate-ok'; items = @(@{ type = 'debate_ref'; id = 'saf-beliefs-002'; status = 'applied' }) })
        $r = script:Get-Context $dir
        @($r.Context.Keys) | Should -Be @('saf-beliefs-002')
        ($r.Warnings -join "`n") | Should -Match 'harvest-1\.json has neither debate_title nor debate_id'
    }

    It 'a manifest with no items, an item with missing fields, and unreadable JSON do not throw' {
        $dir = script:New-Harvests @(
            @{ debate_id = 'debate-empty' }
            @{ debate_id = 'debate-partial'; items = @(@{ type = 'debate_ref' }, @{ type = 'debate_ref'; id = 'saf-beliefs-009'; status = 'applied' }) }
            '{ not json')
        $r = script:Get-Context $dir
        @($r.Context.Keys) | Should -Be @('saf-beliefs-009')
        $r.Context['saf-beliefs-009'] | Should -Be @('debate-partial')
    }

    It 'no harvests directory gives an empty context and no warning' {
        $r = script:Get-Context (Join-Path $TestDrive 'no-such-harvests')
        $r.Context.Count | Should -Be 0
        $r.Warnings.Count | Should -Be 0
    }
}
