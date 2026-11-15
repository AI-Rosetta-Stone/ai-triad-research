# Tag: unit (t/334)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    The t/4572 NLI write-freeze: only recalibrated consumers are unfrozen (t/334).
.DESCRIPTION
    OrgClaimMatching was recalibrated under t/334 (CL sign-off p/70#52), so its key is in the
    committed set. Every other consumer stays frozen by default, and an unknown key is frozen.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Test-NliDirectionalGateFrozen (t/4572 freeze, t/334)' -Tag 'unit' {

    It 'OrgClaimMatching is recalibrated, so it is not frozen (any casing)' {
        InModuleScope AITriad {
            Test-NliDirectionalGateFrozen -Consumer 'OrgClaimMatching' | Should -BeFalse
            Test-NliDirectionalGateFrozen -Consumer 'orgclaimmatching' | Should -BeFalse
        }
    }

    It 'the consumers not yet recalibrated stay frozen: <Consumer>' -TestCases @(
        @{ Consumer = 'PolarityGatePass' }, @{ Consumer = 'QbafConflictAnalysis' }, @{ Consumer = 'SomeFutureConsumer' }
    ) {
        param($Consumer)
        InModuleScope AITriad -Parameters @{ C = $Consumer } {
            param($C)
            Test-NliDirectionalGateFrozen -Consumer $C | Should -BeTrue
        }
    }

    It 'the recalibrated set holds exactly OrgClaimMatching' {
        InModuleScope AITriad {
            @($script:NliDirectionalGateRecalibratedConsumers) | Should -Be @('OrgClaimMatching')
        }
    }
}
