# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4194 prevention item 3: both arms of the pure digest-parity predicate (no Azure calls).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Test-ProdStagingDigestParity.ps1')
}

Describe 'Get-DigestParityVerdict' {
    It 'FIRE ARM: different digests -> Match=false, Determinable=true' {
        $v = Get-DigestParityVerdict -ProdImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620' -StagingImage 'ghcr.io/jpsnover/taxonomy-editor@sha256:3a29f431'
        $v.Match | Should -Be $false
        $v.Determinable | Should -Be $true
        $v.Message | Should -Match 'DIFFERENT images'
    }

    It 'PASS ARM: same digest -> Match=true' {
        $same = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620'
        $v = Get-DigestParityVerdict -ProdImage $same -StagingImage $same
        $v.Match | Should -Be $true
        $v.Determinable | Should -Be $true
    }

    It 'an empty prod image is UNDETERMINABLE, not a false match or a false mismatch' {
        $v = Get-DigestParityVerdict -ProdImage '' -StagingImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620'
        $v.Determinable | Should -Be $false
        $v.Match | Should -Be $false
    }

    It 'an empty staging image is UNDETERMINABLE' {
        $v = Get-DigestParityVerdict -ProdImage 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:16286620' -StagingImage ''
        $v.Determinable | Should -Be $false
    }

    It 'both empty is UNDETERMINABLE' {
        $v = Get-DigestParityVerdict -ProdImage '' -StagingImage ''
        $v.Determinable | Should -Be $false
    }
}
