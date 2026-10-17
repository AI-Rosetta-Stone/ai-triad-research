# Tag: health (t/1498)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Get-ContainerAppRevision -Mode Active|Stale|Fqdn (t/1498).
.DESCRIPTION
    Mocks Invoke-Az so tests run without a live Azure login. Verifies each
    query mode against the exact --query pattern deploy-azure.yml inlines.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-ContainerAppRevision (t/1498)' -Tag 'health' {

    BeforeEach {
        InModuleScope AITriad {
            # Simulate that az is on PATH.
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith {
                [PSCustomObject]@{ Source = 'az' }
            }
        }
    }

    It 'Active mode returns only revisions with trafficWeight > 0' {
        InModuleScope AITriad {
            $mockJson = @(
                [PSCustomObject]@{
                    name = 'taxonomy-editor--rev-active'
                    properties = [PSCustomObject]@{
                        trafficWeight = 100
                        active = $true
                        fqdn = 'taxonomy-editor--rev-active.azurecontainerapps.io'
                        createdTime = '2026-07-10T12:00:00'
                    }
                }
                [PSCustomObject]@{
                    name = 'taxonomy-editor--rev-stale'
                    properties = [PSCustomObject]@{
                        trafficWeight = 0
                        active = $true
                        fqdn = 'taxonomy-editor--rev-stale.azurecontainerapps.io'
                        createdTime = '2026-07-01T12:00:00'
                    }
                }
                [PSCustomObject]@{
                    name = 'taxonomy-editor--rev-inactive'
                    properties = [PSCustomObject]@{
                        trafficWeight = 0
                        active = $false
                        fqdn = 'taxonomy-editor--rev-inactive.azurecontainerapps.io'
                        createdTime = '2026-06-01T12:00:00'
                    }
                }
            ) | ConvertTo-Json -Depth 6 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            $r = @(Get-ContainerAppRevision -Mode Active)

            @($r).Count           | Should -Be 1
            $r[0].Name            | Should -Be 'taxonomy-editor--rev-active'
            $r[0].TrafficWeight   | Should -Be 100
            $r[0].Active          | Should -Be $true
        }
    }

    It 'Stale mode returns active revisions with trafficWeight == 0 (skips traffic-receiving and deactivated)' {
        InModuleScope AITriad {
            $mockJson = @(
                [PSCustomObject]@{
                    name = 'active-with-traffic'
                    properties = [PSCustomObject]@{ trafficWeight = 100; active = $true; fqdn = ''; createdTime = '' }
                }
                [PSCustomObject]@{
                    name = 'stale-active'
                    properties = [PSCustomObject]@{ trafficWeight = 0; active = $true; fqdn = ''; createdTime = '' }
                }
                [PSCustomObject]@{
                    name = 'inactive'
                    properties = [PSCustomObject]@{ trafficWeight = 0; active = $false; fqdn = ''; createdTime = '' }
                }
            ) | ConvertTo-Json -Depth 6 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            $r = @(Get-ContainerAppRevision -Mode Stale)

            @($r).Count     | Should -Be 1
            $r[0].Name      | Should -Be 'stale-active'
        }
    }

    It 'Fqdn mode returns FQDN for a specific revision (requires -RevisionName)' {
        InModuleScope AITriad {
            $mockJson = ([PSCustomObject]@{
                name = 'taxonomy-editor--rev-abc'
                properties = [PSCustomObject]@{
                    trafficWeight = 0
                    active = $true
                    fqdn = 'taxonomy-editor--rev-abc.azurecontainerapps.io'
                    createdTime = '2026-07-10T12:00:00'
                }
            }) | ConvertTo-Json -Depth 6 -Compress

            Mock Invoke-Az -MockWith { $mockJson }

            $r = Get-ContainerAppRevision -Mode Fqdn -RevisionName 'taxonomy-editor--rev-abc'

            $r.Name         | Should -Be 'taxonomy-editor--rev-abc'
            $r.Fqdn         | Should -Be 'taxonomy-editor--rev-abc.azurecontainerapps.io'
        }
    }

    It 'Fqdn mode without -RevisionName throws' {
        InModuleScope AITriad {
            # -AsErrorRecord (t/4237): the thrown record carries the Goal/Error text.
            { Get-ContainerAppRevision -Mode Fqdn -ErrorAction Stop } |
                Should -Throw -ExpectedMessage '*-RevisionName is required when -Mode Fqdn*'
        }
    }

    It 'Throws when az is not on PATH' {
        InModuleScope AITriad {
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith { $null }

            { Get-ContainerAppRevision -Mode Active -ErrorAction Stop } | Should -Throw
        }
    }
}
