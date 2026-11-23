# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for operations/devops/Test-OvershootBoundGate.ps1 (t/467, t/468, TL p/12#144).
.DESCRIPTION
    Prod: maxReplicas 1 passes; above 1 needs a valid attestation in the prod span.
    Staging: the ternary resolves with -StagingLoadTestSize; the resolved value must equal
    -ExpectedStagingReplicas; above 1 needs a valid attestation in the staging span.
    Fail closed on a missing anchor, and an attestation in the other app's span does not count.
#>

Describe 'Test-OvershootBoundGate (t/467, t/468)' {

    BeforeAll {
        $script:GateScript = "$PSScriptRoot/../operations/devops/Test-OvershootBoundGate.ps1"

        # A two-app fixture shaped like deploy/azure/main.bicep.
        function script:New-BicepFixture (
            [int]$ProdReplicas,
            [int]$StagingOrdinary = 1,
            [int]$StagingLoadTest = 3,
            [string]$ProdAttestation = '',
            [string]$StagingAttestation = ''
        ) {
            $f = [System.IO.Path]::GetTempFileName()
            $prodAttestLine = if ($ProdAttestation) { "`n// $ProdAttestation" } else { '' }
            $stagingAttestLine = if ($StagingAttestation) { "`n        // $StagingAttestation" } else { '' }
            Set-Content -Path $f -Value @"
        // maxReplicas capped at 1 (t/4176 incident): prod stays at one replica.$prodAttestLine
        maxReplicas: $ProdReplicas

        // t/4203: max $StagingLoadTest with an HTTP scale rule only while stagingLoadTestSize=true.$stagingAttestLine
        maxReplicas: stagingLoadTestSize ? $StagingLoadTest : $StagingOrdinary
"@
            return $f
        }
    }

    Context 'prod' {
        It 'passes when prod maxReplicas is 1 and staging is at its expected 1' {
            $f = New-BicepFixture -ProdReplicas 1
            try { { & $script:GateScript -BicepPath $f } | Should -Not -Throw }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails when prod maxReplicas is 3 with no attestation' {
            $f = New-BicepFixture -ProdReplicas 3
            try { { & $script:GateScript -BicepPath $f } | Should -Throw '*without a reviewed overshoot bound*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'passes when prod maxReplicas is 3 and the bound is reviewed in a valid ticket' {
            $f = New-BicepFixture -ProdReplicas 3 -ProdAttestation '@OVERSHOOT_BOUND_REVIEWED: t/467'
            try { { & $script:GateScript -BicepPath $f } | Should -Not -Throw }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails when the prod attestation has no valid ticket reference' {
            $f = New-BicepFixture -ProdReplicas 3 -ProdAttestation '@OVERSHOOT_BOUND_REVIEWED: reviewed'
            try { { & $script:GateScript -BicepPath $f } | Should -Throw '*without a reviewed overshoot bound*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails closed when the maxReplicas anchor is missing' {
            $f = [System.IO.Path]::GetTempFileName()
            Set-Content -Path $f -Value "maxReplicas: 3`n"
            try { { & $script:GateScript -BicepPath $f } | Should -Throw '*could not parse prod*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }
    }

    Context 'staging' {
        It 'passes when staging resolves to its expected 1 (load test off)' {
            $f = New-BicepFixture -ProdReplicas 1
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $false } | Should -Not -Throw }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails when the load test resolves staging to 3 and the gate expects 1' {
            $f = New-BicepFixture -ProdReplicas 1
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $true } | Should -Throw '*Overshoot bound gate FAILED*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails when the load test resolves staging to 3, the gate expects 3, and there is no attestation' {
            $f = New-BicepFixture -ProdReplicas 1
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $true -ExpectedStagingReplicas 3 } | Should -Throw '*without a reviewed overshoot bound*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'passes when the load test resolves staging to 3, the gate expects 3, and the bound is reviewed' {
            $f = New-BicepFixture -ProdReplicas 1 -StagingAttestation '@OVERSHOOT_BOUND_REVIEWED: t/468'
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $true -ExpectedStagingReplicas 3 } | Should -Not -Throw }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails on any staging value other than the expected one, even when attested' {
            $f = New-BicepFixture -ProdReplicas 1 -StagingAttestation '@OVERSHOOT_BOUND_REVIEWED: t/468'
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $true -ExpectedStagingReplicas 2 } | Should -Throw '*Overshoot bound gate FAILED*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'does not count a prod attestation for staging' {
            $f = New-BicepFixture -ProdReplicas 1 -ProdAttestation '@OVERSHOOT_BOUND_REVIEWED: t/468'
            try { { & $script:GateScript -BicepPath $f -StagingLoadTestSize $true -ExpectedStagingReplicas 3 } | Should -Throw '*without a reviewed overshoot bound*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }

        It 'fails closed when the staging ternary anchor is missing' {
            $f = [System.IO.Path]::GetTempFileName()
            Set-Content -Path $f -Value "// maxReplicas capped at 1 (t/4176)`nmaxReplicas: 1`n"
            try { { & $script:GateScript -BicepPath $f } | Should -Throw '*could not parse staging*' }
            finally { Remove-Item $f -ErrorAction SilentlyContinue }
        }
    }
}
