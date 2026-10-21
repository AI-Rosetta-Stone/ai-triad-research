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

    It 'an UNKNOWN verdict carries the resolver reason in its message' {
        $v = Get-DigestParityVerdict -ProdImage 'img@sha256:aaa' -StagingImage '' -StagingReason 'traffic is split'
        $v.Determinable | Should -Be $false
        $v.Message | Should -Match 'staging: traffic is split'
    }
}

# t/4399: parity must compare the revisions each app SERVES, never the app template.
Describe 'Get-ServingImage' {
    BeforeAll {
        $X = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:5b0aa967'
        $Y = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:f6649470'
        function New-Traffic([string]$Rev, [int]$Weight, [switch]$Latest) {
            if ($Latest) { [PSCustomObject]@{ latestRevision = $true; weight = $Weight } }
            else { [PSCustomObject]@{ revisionName = $Rev; weight = $Weight } }
        }
    }

    It 'resolves the single weighted revision to its image' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 100), (New-Traffic 'app--b' 0)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $Y }
        $s.Image | Should -Be $X
        $s.Revisions | Should -Be @('app--a=100%')
    }

    It 'resolves latestRevision:true through latestRevisionName' {
        $s = Get-ServingImage -Traffic @(New-Traffic -Latest -Weight 100) -LatestRevisionName 'app--new' -RevisionImages @{ 'app--new' = $Y }
        $s.Image | Should -Be $Y
    }

    It 'a split across DIFFERENT images is UNKNOWN, with a split reason' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $Y }
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'split'
    }

    It 'a split across revisions on the SAME image resolves to that image' {
        $s = Get-ServingImage -Traffic @((New-Traffic 'app--a' 50), (New-Traffic 'app--b' 50)) -RevisionImages @{ 'app--a' = $X; 'app--b' = $X }
        $s.Image | Should -Be $X
    }

    It 'no weighted traffic is UNKNOWN' {
        $s = Get-ServingImage -Traffic @(New-Traffic 'app--a' 0) -RevisionImages @{ 'app--a' = $X }
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'weight > 0'
    }

    It 'null/empty traffic is UNKNOWN, not a throw' {
        (Get-ServingImage -Traffic @($null) -RevisionImages @{}).Image | Should -BeNullOrEmpty
        (Get-ServingImage -Traffic @() -RevisionImages @{}).Image | Should -BeNullOrEmpty
    }

    It 'a serving revision with no resolvable image is UNKNOWN' {
        $s = Get-ServingImage -Traffic @(New-Traffic 'app--a' 100) -RevisionImages @{}
        $s.Image | Should -BeNullOrEmpty
        $s.Reason | Should -Match 'app--a'
    }

    It 'REGRESSION (10-21 run 39621165861): templates both name X, but staging traffic is pinned to a Y revision -> MISMATCH' {
        # After a prod Bicep apply, prod's image X is in BOTH templates and a new staging revision on X
        # exists at 0%; staging traffic stays pinned to its previous revision on Y. The old template
        # read said PARITY-OK here.
        $prod = Get-ServingImage -Traffic @(New-Traffic 'taxonomy-editor--deploy-6789ee9' 100) -RevisionImages @{ 'taxonomy-editor--deploy-6789ee9' = $X }
        $staging = Get-ServingImage -Traffic @((New-Traffic 'taxonomy-editor-staging--staging-deac973' 100), (New-Traffic 'taxonomy-editor-staging--0000253' 0)) `
            -RevisionImages @{ 'taxonomy-editor-staging--staging-deac973' = $Y; 'taxonomy-editor-staging--0000253' = $X }
        $v = Get-DigestParityVerdict -ProdImage $prod.Image -StagingImage $staging.Image `
            -ProdRevisions ($prod.Revisions -join ', ') -StagingRevisions ($staging.Revisions -join ', ')
        $v.Determinable | Should -Be $true
        $v.Match | Should -Be $false
        $v.Message | Should -Match 'staging-deac973=100%'
    }
}
