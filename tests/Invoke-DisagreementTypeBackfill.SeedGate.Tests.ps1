# Tag: unit (t/351)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/351: the disagreement-type seed gate is majority-of-3 with sit-154 as the abstain anchor (rubric §3, #5056).
.DESCRIPTION
    The script runs on load (imports, reads situations.json, calls the AI), so its pure
    Get-SeedGateVerdict is lifted out with the parser, as the Scope tests do for
    Select-BackfillTarget, and the seed table and replicate count are read from the script's AST.
    No AI, no data.
#>

BeforeAll {
    $path = Join-Path $PSScriptRoot '..' 'scripts' 'Invoke-DisagreementTypeBackfill.ps1'
    $script:Ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    $fn = $script:Ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-SeedGateVerdict' }, $true)
    . ([scriptblock]::Create($fn.Extent.Text))
    $assign = { param($name) $script:Ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq $name }, $true) }
    $script:Expected = & ([scriptblock]::Create((& $assign '$SeedExpected').Right.Extent.Text))
    $script:Reps = & ([scriptblock]::Create((& $assign '$SeedReplicates').Right.Extent.Text))

    function New-Draw([hashtable]$Override = @{}) {
        $d = [ordered]@{}
        foreach ($k in $script:Expected.Keys) { $d[$k] = if ($Override.ContainsKey($k)) { $Override[$k] } else { $script:Expected[$k] } }
        $d
    }
}

Describe 'Seed table and replicate count (rubric §3, t/351)' -Tag 'unit' {

    It 'uses sit-154 as the abstain anchor, not the stale sit-050, and runs 3 replicates' {
        $script:Expected.Contains('sit-154') | Should -BeTrue
        $script:Expected['sit-154'] | Should -Be 'insufficient'
        $script:Expected.Contains('sit-050') | Should -BeFalse
        $script:Expected.Count | Should -Be 10
        @($script:Expected.Values | Where-Object { $_ -ne 'insufficient' }).Count | Should -Be 9
        $script:Reps | Should -Be 3
    }
}

Describe 'Get-SeedGateVerdict (t/351)' -Tag 'unit' {

    It 'passes when every replicate matches' {
        $v = Get-SeedGateVerdict -Replicates @((New-Draw), (New-Draw), (New-Draw)) -Expected $script:Expected
        $v.Pass | Should -BeTrue
        @($v.Misses).Count | Should -Be 0
    }

    It 'passes the t/246 run-1 pattern (9/9, 8/9, 9/9): one dissenting draw is outvoted' {
        $v = Get-SeedGateVerdict -Replicates @((New-Draw), (New-Draw @{ 'sit-430' = 'structural' }), (New-Draw)) -Expected $script:Expected
        $v.Pass | Should -BeTrue
        $v.Majority['sit-430'] | Should -Be 'interpretive'
    }

    It 'fails when a non-abstain seed''s majority is wrong, naming it and its draws' {
        $v = Get-SeedGateVerdict -Replicates @((New-Draw @{ 'sit-300' = 'interpretive' }), (New-Draw @{ 'sit-300' = 'interpretive' }), (New-Draw)) -Expected $script:Expected
        $v.Pass | Should -BeFalse
        @($v.Misses).Count | Should -Be 1
        $v.Misses[0].Id | Should -Be 'sit-300'
        $v.Misses[0].Majority | Should -Be 'interpretive'
        $v.Misses[0].Draws | Should -Be 'interpretive,interpretive,structural'
    }

    It 'fails when the abstain anchor''s majority is not insufficient' {
        $v = Get-SeedGateVerdict -Replicates @((New-Draw @{ 'sit-154' = 'interpretive' }), (New-Draw @{ 'sit-154' = 'interpretive' }), (New-Draw)) -Expected $script:Expected
        $v.Pass | Should -BeFalse
        $v.Misses[0].Id | Should -Be 'sit-154'
    }

    It 'fails when three draws disagree three ways (no majority)' {
        $v = Get-SeedGateVerdict -Replicates @((New-Draw @{ 'sit-447' = 'structural' }), (New-Draw @{ 'sit-447' = 'interpretive' }), (New-Draw)) -Expected $script:Expected
        $v.Pass | Should -BeFalse
        $v.Majority['sit-447'] | Should -BeNullOrEmpty
        $v.Misses[0].Id | Should -Be 'sit-447'
    }
}
