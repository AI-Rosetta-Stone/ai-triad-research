# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4728: proves the CLI-drift predicate catches the exact 10-31 incident shape (a serving
# revision's env var not matching main.bicep's declared value), and that it never false-OKs
# when there's no serving revision at all (Quality's edge case, p/800#7).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Test-StagingEnvCliDrift.ps1')
}

Describe 'Get-EnvDriftVerdict' {
    It 'FIRE ARM: live value differs from Bicep-declared value (the 10-31 incident shape)' {
        $v = Get-EnvDriftVerdict -App 'taxonomy-editor-staging' -Key 'FREE_POOL_DAILY_CALLS_CAP' -LiveValue '1500' -BicepValue '5'
        $v.Outcome | Should -Be 'Mismatch'
        $v.Message | Should -Match 't/4728 CLI-drift class'
    }

    It 'PASS ARM: live value matches Bicep-declared value' {
        $v = Get-EnvDriftVerdict -App 'taxonomy-editor-staging' -Key 'FREE_POOL_DAILY_CALLS_CAP' -LiveValue '5' -BicepValue '5'
        $v.Outcome | Should -Be 'Match'
    }

    It 'EDGE CASE (Quality, p/800#7): no serving revision at all is SKIP, not a false Match' {
        $v = Get-EnvDriftVerdict -App 'taxonomy-editor-staging' -Key 'FREE_POOL_DAILY_CALLS_CAP' -LiveValue $null -BicepValue '5' `
            -Reason 'no ingress traffic entry has weight > 0'
        $v.Outcome | Should -Be 'Skip'
        $v.Message | Should -Match 'no serving revision found'
    }

    It 'an empty live value (for any other reason) is Undeterminable, not Mismatch or Match' {
        $v = Get-EnvDriftVerdict -App 'taxonomy-editor-staging' -Key 'FREE_POOL_DAILY_CALLS_CAP' -LiveValue $null -BicepValue '5' `
            -Reason "serving revision 'x' has no FREE_POOL_DAILY_CALLS_CAP set"
        $v.Outcome | Should -Be 'Undeterminable'
    }

    It 'an unresolvable Bicep value is Undeterminable' {
        $v = Get-EnvDriftVerdict -App 'taxonomy-editor-staging' -Key 'FREE_POOL_DAILY_CALLS_CAP' -LiveValue '5' -BicepValue $null
        $v.Outcome | Should -Be 'Undeterminable'
    }
}

Describe 'Get-BicepParamDefault' {
    It 'extracts freePoolDailyCallsCapStaging''s declared default from the real main.bicep' {
        $bicepPath = Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep'
        $text = Get-Content $bicepPath -Raw
        Get-BicepParamDefault -BicepText $text -ParamName 'freePoolDailyCallsCapStaging' | Should -Be '5'
    }

    It 'returns $null for a param that does not exist' {
        Get-BicepParamDefault -BicepText "param foo string = 'bar'" -ParamName 'nonexistent' | Should -BeNullOrEmpty
    }
}

Describe 'Get-ServingEnvValue (reused resolver — same fault arms as Test-AllowedOriginsFqdnParity.ps1)' {
    BeforeAll {
        function New-Traffic([string]$Rev, [int]$Weight, [switch]$Latest) {
            if ($Latest) { [PSCustomObject]@{ latestRevision = $true; weight = $Weight } }
            else { [PSCustomObject]@{ revisionName = $Rev; weight = $Weight } }
        }
    }

    It 'no weighted traffic -> UNKNOWN with a "no ingress traffic" reason, which Get-EnvDriftVerdict turns into Skip' {
        $s = Get-ServingEnvValue -Traffic @(New-Traffic 'app--a' 0) -RevisionValues @{ 'app--a' = '5' }
        $s.Value | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'weight > 0'
    }

    It 'a split across DIFFERENT values is UNKNOWN, with a split reason' {
        $s = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) `
            -RevisionValues @{ 'app--a' = '5'; 'app--b' = '1500' } -ValueLabel 'FREE_POOL_DAILY_CALLS_CAP'
        $s.Value | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'split'
    }

    It 'resolves the single weighted revision to its value' {
        $s = Get-ServingEnvValue -Traffic @((New-Traffic 'app--a' 100), (New-Traffic 'app--b' 0)) -RevisionValues @{ 'app--a' = '5'; 'app--b' = '1500' }
        $s.Value | Should -Be '5'
    }
}
