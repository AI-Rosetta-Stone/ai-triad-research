# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Characterization tests pinning the behavior of the pure helpers extracted from
# Invoke-GuardedRevisionDeactivate.ps1. Race-safe: dot-sources ONLY this one Private file.
BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-GuardedRevisionDeactivate.ps1')
}

Describe 'Get-FreshRevisionWeightInfo' {
    It 'reads trafficWeight and active from a well-formed revision object' {
        $fresh = [pscustomobject]@{ properties = [pscustomobject]@{ trafficWeight = 25; active = $true } }
        $r = Get-FreshRevisionWeightInfo -Fresh $fresh
        $r.Weight | Should -Be 25
        $r.Active | Should -BeTrue
    }
    It 'leaves Weight $null when trafficWeight is absent (never read as 0)' {
        $fresh = [pscustomobject]@{ properties = [pscustomobject]@{ active = $true } }
        $r = Get-FreshRevisionWeightInfo -Fresh $fresh
        $r.Weight | Should -BeNullOrEmpty
        $r.Active | Should -BeTrue
    }
    It 'defaults active to $false when absent' {
        $fresh = [pscustomobject]@{ properties = [pscustomobject]@{ trafficWeight = 0 } }
        $r = Get-FreshRevisionWeightInfo -Fresh $fresh
        $r.Weight | Should -Be 0
        $r.Active | Should -BeFalse
    }
    It 'returns null Weight and false Active for a null revision' {
        $r = Get-FreshRevisionWeightInfo -Fresh $null
        $r.Weight | Should -BeNullOrEmpty
        $r.Active | Should -BeFalse
    }
    It 'returns null Weight and false Active when properties is absent' {
        $r = Get-FreshRevisionWeightInfo -Fresh ([pscustomobject]@{ other = 1 })
        $r.Weight | Should -BeNullOrEmpty
        $r.Active | Should -BeFalse
    }
}

Describe 'Get-AppTrafficConfigInfo' {
    It 'reads traffic entries and latestRevisionName from a well-formed app object' {
        $app = [pscustomobject]@{ properties = [pscustomobject]@{
            configuration = [pscustomobject]@{ ingress = [pscustomobject]@{
                traffic = @([pscustomobject]@{ revisionName = 'r1'; weight = 100 }) } }
            latestRevisionName = 'r1' } }
        $r = Get-AppTrafficConfigInfo -App $app
        @($r.TrafficEntries).Count | Should -Be 1
        $r.TrafficEntries[0].revisionName | Should -Be 'r1'
        $r.LatestRevisionName | Should -Be 'r1'
    }
    It 'leaves TrafficEntries $null when the ingress traffic path is absent' {
        $app = [pscustomobject]@{ properties = [pscustomobject]@{ latestRevisionName = 'r2' } }
        $r = Get-AppTrafficConfigInfo -App $app
        $r.TrafficEntries | Should -BeNullOrEmpty
        $r.LatestRevisionName | Should -Be 'r2'
    }
    It 'returns nulls for a null app' {
        $r = Get-AppTrafficConfigInfo -App $null
        $r.TrafficEntries | Should -BeNullOrEmpty
        $r.LatestRevisionName | Should -BeNullOrEmpty
    }
    It 'returns nulls when properties is absent' {
        $r = Get-AppTrafficConfigInfo -App ([pscustomobject]@{ other = 1 })
        $r.TrafficEntries | Should -BeNullOrEmpty
        $r.LatestRevisionName | Should -BeNullOrEmpty
    }
}
