# Tag: summarization (t/384)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    The numeric-grounding guard's four tightenings (t/384), each behind a flag: percent-aware matching,
    scale suffixes, leading-dot decimals and superscript exponents. Each is tested on and off.
.DESCRIPTION
    Each flag is measured on its own against the corpus (CL's rule). These tests pin the behaviour
    the flags are meant to have, and that the flags-off keys are the t/375 keys.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    # Runs the guard on one claim against one snapshot, with the given flags, and returns the number dropped.
    function Invoke-NumericDrop([string]$Claim, [string]$Snapshot, [hashtable]$Flags) {
        $Sum = [pscustomobject]@{ factual_claims = @([pscustomobject]@{ claim = $Claim }) }
        $Prev = $null
        $Result = & (Get-Module AITriad) {
            param($Claim, $Snapshot, $Flags, $Sum)
            $Saved = @{} + $script:NumericGroundingFeatures
            foreach ($K in $Saved.Keys) { $script:NumericGroundingFeatures[$K] = $false }
            foreach ($K in $Flags.Keys) { $script:NumericGroundingFeatures[$K] = $Flags[$K] }
            try { Remove-NumericallyUngroundedClaims -SummaryObject $Sum -SnapshotText $Snapshot -ThisDocId 'doc-t384' 3>$null }
            finally { foreach ($K in $Saved.Keys) { $script:NumericGroundingFeatures[$K] = $Saved[$K] } }
        } $Claim $Snapshot $Flags $Sum
        $Result
    }
}

Describe 'Numeric-grounding tightenings (t/384)' -Tag 'summarization' {

    Context 'Percent-aware matching' {
        It 'drops a percent claim when the source has the number only as a count' {
            $Src = 'Five of ten tasks were automated in the study.'
            Invoke-NumericDrop 'Half of tasks, 5%, were automated.' $Src @{ Percent = $true } | Should -Be 1
        }
        It 'keeps a percent claim when the source states it as a percent' {
            $Src = 'Automation reached 5 percent of tasks in the study.'
            Invoke-NumericDrop 'Automation reached 5% of tasks.' $Src @{ Percent = $true } | Should -Be 0
        }
        It 'the t/375 behaviour, percent off: a bare 5 grounds 5%' {
            $Src = '5 of ten tasks were automated in the study.'
            Invoke-NumericDrop 'Half of tasks, 5%, were automated.' $Src @{ Percent = $false } | Should -Be 0
        }
    }

    Context 'Scale suffixes' {
        It 'grounds a claim 75,000 by the source 75K when scale is on' {
            Invoke-NumericDrop 'Roughly 75,000 workers were retrained.' 'About 75K workers were retrained.' @{ Scale = $true } | Should -Be 0
        }
        It 'grounds a claim 2.3 billion by the source 2.3 billion when scale is on' {
            Invoke-NumericDrop 'Spending reached 2.3 billion dollars.' 'Spending reached 2.3 billion dollars in 2025.' @{ Scale = $true } | Should -Be 0
        }
        It 'a claim 75K needs its full value 75000 in the source' {
            Invoke-NumericDrop 'About 75K workers were retrained.' 'About 75,000 workers were retrained.' @{ Scale = $true } | Should -Be 0
        }
        It 'grounds a claim 75K by a plain 75 in the source (the t/375 match still holds)' {
            Invoke-NumericDrop 'About 75K workers were retrained.' 'About 75 workers were retrained.' @{ Scale = $true } | Should -Be 0
        }
        It 'drops a scaled claim whose full value the source lacks' {
            Invoke-NumericDrop 'About 75K workers were retrained.' 'About 7,500 workers were retrained.' @{ Scale = $true } | Should -Be 1
        }
    }

    Context 'Leading-dot decimals' {
        It 'grounds a claim .5 by the source 0.5' {
            Invoke-NumericDrop 'The rate was .5 per year.' 'The rate was 0.5 per year.' @{ LeadingDot = $true } | Should -Be 0
        }
        It 'does not read .5 as the number 5' {
            Invoke-NumericDrop 'The rate was .5 per year.' 'The rate was 5 per year.' @{ LeadingDot = $true } | Should -Be 1
        }
    }

    Context 'Superscript exponents' {
        It 'grounds a claim 10^26 by the PDF concatenation 1026' {
            Invoke-NumericDrop 'Training used 10^26 FLOPs.' 'Training used 1026 FLOPs.' @{ Superscript = $true } | Should -Be 0
        }
        It 'drops 10^26 when neither 1026 nor 10^26 appears' {
            Invoke-NumericDrop 'Training used 10^26 FLOPs.' 'Training used 1025 FLOPs.' @{ Superscript = $true } | Should -Be 1
        }
    }

    Context 'Flags off reproduce the t/375 keys' {
        It 'a claim with percent, scale, dot and exponent forms is judged on plain numbers' {
            Invoke-NumericDrop 'Rose 5% to 75K.' 'Rose 5 to 75.' @{} | Should -Be 0
        }
    }

    Context 'A flag changes only what its own rule covers (t/384#10)' {
        It 'with <Flag> alone, numbers the flag does not touch are judged as the merged guard judges them' -ForEach @(
            @{ Flag = 'Percent' }, @{ Flag = 'Scale' }, @{ Flag = 'LeadingDot' }, @{ Flag = 'Superscript' }
        ) {
            # PDF glue before a number, a number after a letter, and a count: none is a percent, a scale
            # suffix, a leading dot or an exponent.
            $Src = 'The attack succeeded across1,000 trials on model v2 with 37 probes.'
            foreach ($Claim in 'There were 1,000 trials.', 'Model 2 was used.', 'It used 37 probes.', 'There were 999 trials.') {
                $Off = Invoke-NumericDrop $Claim $Src @{}
                Invoke-NumericDrop $Claim $Src @{ $Flag = $true } | Should -Be $Off -Because "$Flag on, claim: $Claim"
            }
        }

        It 'with leading-dot off and another flag on, .5 is still read as 5' {
            Invoke-NumericDrop 'The rate was .5 per day.' 'A total of 5 per day.' @{ Scale = $true } | Should -Be (Invoke-NumericDrop 'The rate was .5 per day.' 'A total of 5 per day.' @{})
        }

        It 'with superscript off and another flag on, 10^26 is still 10 and 26' {
            $Src = 'Runs reach 10 units in 26 cases.'
            Invoke-NumericDrop 'Runs exceed 10^26 operations.' $Src @{ Percent = $true } | Should -Be (Invoke-NumericDrop 'Runs exceed 10^26 operations.' $Src @{})
            Invoke-NumericDrop 'Runs exceed 10^26 operations.' 'Runs reach 10 units.' @{ Percent = $true } | Should -Be (Invoke-NumericDrop 'Runs exceed 10^26 operations.' 'Runs reach 10 units.' @{})
        }
    }
}
