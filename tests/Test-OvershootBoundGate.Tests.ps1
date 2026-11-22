# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for operations/devops/Test-OvershootBoundGate.ps1 (t/467, TL p/16#219 condition 1b).
.DESCRIPTION
    Both arms, plus fail-closed parsing:
      maxReplicas 1, no attestation        -> pass
      maxReplicas 3, no attestation        -> fail
      maxReplicas 3, valid attestation     -> pass
      maxReplicas 3, malformed attestation -> fail
      attestation outside the span         -> fail (only the span counts)
      anchor missing                       -> fail (fail closed)
#>

Describe 'Test-OvershootBoundGate (t/467)' {

    BeforeAll {
        $script:GateScript = "$PSScriptRoot/../operations/devops/Test-OvershootBoundGate.ps1"

        function script:New-BicepFixture ([int]$MaxReplicas, [string]$Attestation = '') {
            $f = [System.IO.Path]::GetTempFileName()
            $attestLine = if ($Attestation) { "`n// $Attestation" } else { '' }
            Set-Content -Path $f -Value @"
// maxReplicas capped at 1 (t/4176 incident): prod stays at one replica.$attestLine
maxReplicas: $MaxReplicas
"@
            return $f
        }
    }

    It 'passes when prod maxReplicas is 1, with no attestation' {
        $f = New-BicepFixture -MaxReplicas 1
        try { { & $script:GateScript -BicepPath $f } | Should -Not -Throw }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'fails when prod maxReplicas is 3, with no attestation' {
        $f = New-BicepFixture -MaxReplicas 3
        try { { & $script:GateScript -BicepPath $f } | Should -Throw '*without a reviewed overshoot bound*' }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'passes when prod maxReplicas is 3 and the bound is reviewed in a valid ticket' {
        $f = New-BicepFixture -MaxReplicas 3 -Attestation '@OVERSHOOT_BOUND_REVIEWED: t/467'
        try { { & $script:GateScript -BicepPath $f } | Should -Not -Throw }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'fails when the attestation has no valid ticket reference' {
        $f = New-BicepFixture -MaxReplicas 3 -Attestation '@OVERSHOOT_BOUND_REVIEWED: reviewed'
        try { { & $script:GateScript -BicepPath $f } | Should -Throw '*without a reviewed overshoot bound*' }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'ignores an attestation placed outside the maxReplicas span' {
        $f = [System.IO.Path]::GetTempFileName()
        Set-Content -Path $f -Value @"
// @OVERSHOOT_BOUND_REVIEWED: t/467
// unrelated block
// maxReplicas capped at 1 (t/4176)
maxReplicas: 3
"@
        try { { & $script:GateScript -BicepPath $f } | Should -Throw '*without a reviewed overshoot bound*' }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }

    It 'fails closed when the maxReplicas anchor is missing' {
        $f = [System.IO.Path]::GetTempFileName()
        Set-Content -Path $f -Value "maxReplicas: 3`n"
        try { { & $script:GateScript -BicepPath $f } | Should -Throw '*could not parse*' }
        finally { Remove-Item $f -ErrorAction SilentlyContinue }
    }
}
