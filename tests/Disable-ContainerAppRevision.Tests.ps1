# Tag: taxonomy (t/1500)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Disable-ContainerAppRevision (t/1500 Phase 3).
.DESCRIPTION
    Mocks Invoke-Az and Get-Command so tests run without a live Azure login.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Disable-ContainerAppRevision (t/1500)' -Tag 'taxonomy' {

    BeforeEach {
        InModuleScope AITriad {
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith {
                [PSCustomObject]@{ Source = 'az' }
            }
        }
    }

    It 'Happy path: Invoke-Az succeeds, returns Deactivated=$true' {
        InModuleScope AITriad {
            Mock Invoke-Az -MockWith { $null }

            $r = Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad' -Confirm:$false

            $r.RevisionName | Should -Be 'taxonomy-editor--rev-bad'
            $r.Deactivated  | Should -Be $true
            $r.Timestamp    | Should -Not -BeNullOrEmpty
        }
    }

    It 'Invoke-Az throws: returns Deactivated=$false with a warning, does not throw' {
        InModuleScope AITriad {
            Mock Invoke-Az -MockWith { throw 'simulated az failure' }
            Mock Write-Warning -MockWith {}

            # Run the cmdlet; capture result inside the scope where $r is valid.
            $r = Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad' -Confirm:$false

            $r.Deactivated | Should -Be $false
            Should -Invoke Write-Warning -Times 1 -Scope It
        }
    }

    It '-WhatIf returns without calling Invoke-Az' {
        InModuleScope AITriad {
            Mock Invoke-Az -MockWith { throw 'should not be called' }

            # -WhatIf causes ShouldProcess to return $false, so the cmdlet
            # returns early with Deactivated=$false and never calls Invoke-Az.
            $r = Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad' -WhatIf

            $r.Deactivated | Should -Be $false
            Should -Invoke Invoke-Az -Times 0 -Scope It
        }
    }

    It 'ActionableError when az not on PATH: throws with the actionable message' {
        InModuleScope AITriad {
            Mock Get-Command -ParameterFilter { $Name -eq 'az' } -MockWith { $null }

            # -AsErrorRecord (t/4237): the thrown record carries the Goal/Error text.
            { Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad' -Confirm:$false -ErrorAction Stop } |
                Should -Throw -ExpectedMessage '*Azure CLI (az) not found on PATH*'
        }
    }
}
