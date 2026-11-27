# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/813 (t/811 spend brakes): FREE_POOL_DAILY_TOKENS_CAP (and prod's FREE_POOL_DAILY_CALLS_CAP) are wired as
# optional env vars. Empty default = the variable is ABSENT, so merging changes nothing until a value is passed.
# Prod and staging use separate parameters and neither env list may take the other's. Static parse of the real main.bicep.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw
    function Get-VarLine([string]$Name) {
        $m = [regex]::Match($script:Bicep, "(?m)^var $Name\s*=\s*(.+)$")
        if (-not $m.Success) { throw "var $Name not found in main.bicep" }
        $m.Groups[1].Value.Trim()
    }
}

Describe 'free-pool daily caps as optional env vars (t/813)' {
    It 'declares the three params, all defaulting to empty' {
        foreach ($p in 'freePoolDailyTokensCap', 'freePoolDailyCallsCap', 'freePoolDailyTokensCapStaging') {
            $script:Bicep | Should -Match "(?m)^param $p string = ''\s*$"
        }
    }

    It 'prod adds each variable only when its param is non-empty, from its own param' {
        Get-VarLine 'extraFreePoolTokensCap' | Should -Be "empty(freePoolDailyTokensCap) ? [] : [ { name: 'FREE_POOL_DAILY_TOKENS_CAP', value: freePoolDailyTokensCap } ]"
        Get-VarLine 'extraFreePoolCallsCap' | Should -Be "empty(freePoolDailyCallsCap) ? [] : [ { name: 'FREE_POOL_DAILY_CALLS_CAP', value: freePoolDailyCallsCap } ]"
        Get-VarLine 'containerEnv' | Should -Match 'extraFreePoolTokensCap, extraFreePoolCallsCap\)$'
    }

    It 'staging adds its token cap only when non-empty, from the staging param, and takes no prod extras' {
        Get-VarLine 'stagingExtraFreePoolTokensCap' | Should -Be "empty(freePoolDailyTokensCapStaging) ? [] : [ { name: 'FREE_POOL_DAILY_TOKENS_CAP', value: freePoolDailyTokensCapStaging } ]"
        $line = Get-VarLine 'stagingContainerEnv'
        $line | Should -Be 'concat(stagingBaseEnv, stagingExtraFreeTier, stagingExtraFreePoolTokensCap)'
        $line | Should -Not -MatchExactly '(?<![A-Za-z])extraFreePool(Tokens|Calls)Cap'
    }

    It 'baseEnv carries neither variable (a literal would reach both apps)' {
        $m = [regex]::Match($script:Bicep, '(?s)var baseEnv = \[.*?\r?\n\]')
        $m.Success | Should -BeTrue
        $m.Value | Should -Not -Match 'FREE_POOL_DAILY_TOKENS_CAP'
        $m.Value | Should -Not -Match 'FREE_POOL_DAILY_CALLS_CAP'
    }

    It 'leaves the existing staging calls cap wiring alone' {
        $script:Bicep | Should -Match "param freePoolDailyCallsCapStaging string = '300'"
        $script:Bicep | Should -Match "\{ name: 'FREE_POOL_DAILY_CALLS_CAP', value: stagingFreePoolCap \}"
    }
}
