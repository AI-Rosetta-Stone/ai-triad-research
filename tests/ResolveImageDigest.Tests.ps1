# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms tests for the deploy-by-digest resolver (t/3679, condition 4 fail-closed proof).
# Dot-sources operations/devops/Resolve-ImageDigest.ps1 (the co-located single source) and
# exercises the PURE matcher Resolve-ImageDigestFromImages against synthetic GHCR image lists —
# no network. The impure entrypoint is guarded by `$MyInvocation.InvocationName -ne '.'`, so
# dot-sourcing here defines the function without querying GHCR.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Resolve-ImageDigest.ps1'
    . $script:ScriptPath

    # GhcrImage-shaped stand-ins: the pure fn reads only .Tags (string[]) and .Digest (string).
    $script:DigestA = 'sha256:' + ('a' * 64)
    $script:DigestB = 'sha256:' + ('b' * 64)
    $script:FullSha = '30281107' + ('c' * 32)   # 40 hex chars
    function New-Img { param([string[]]$Tags, [string]$Digest) [pscustomobject]@{ Tags = $Tags; Digest = $Digest } }
}

Describe 'Resolve-ImageDigestFromImages — success arms' {
    It 'resolves an exact full-SHA tag to its immutable @sha256 ref' {
        $images = @(
            (New-Img -Tags @('latest', "sha-$script:FullSha") -Digest $script:DigestA),
            (New-Img -Tags @('sha-deadbeef1111111111111111111111111111beef') -Digest $script:DigestB)
        )
        $r = Resolve-ImageDigestFromImages -Sha $script:FullSha -Images $images
        $r.Digest   | Should -Be $script:DigestA
        $r.Tag      | Should -Be "sha-$script:FullSha"
        $r.ImageRef | Should -Be "ghcr.io/ai-rosetta-stone/taxonomy-editor@$script:DigestA"
    }

    It 'resolves a short-SHA prefix to the full-SHA-tagged image' {
        $images = @( (New-Img -Tags @("sha-$script:FullSha") -Digest $script:DigestA) )
        $r = Resolve-ImageDigestFromImages -Sha '30281107' -Images $images
        $r.Digest | Should -Be $script:DigestA
    }

    It 'honours a custom -Registry/-Package in the returned ref' {
        $images = @( (New-Img -Tags @("sha-$script:FullSha") -Digest $script:DigestA) )
        $r = Resolve-ImageDigestFromImages -Sha $script:FullSha -Images $images -Registry 'example.io' -Package 'org/app'
        $r.ImageRef | Should -Be "example.io/org/app@$script:DigestA"
    }
}

Describe 'Resolve-ImageDigestFromImages — fail-closed arms (condition 4)' {
    It 'THROWS on an empty SHA and refuses to default to :latest' {
        $images = @( (New-Img -Tags @('latest') -Digest $script:DigestA) )
        { Resolve-ImageDigestFromImages -Sha '' -Images $images } |
            Should -Throw -ExpectedMessage '*refusing to default to :latest*'
    }

    It 'THROWS on a non-hex SHA' {
        $images = @( (New-Img -Tags @("sha-$script:FullSha") -Digest $script:DigestA) )
        { Resolve-ImageDigestFromImages -Sha 'not-a-sha!!' -Images $images } |
            Should -Throw -ExpectedMessage '*not a valid hex commit SHA*'
    }

    It 'THROWS (not-found) when no image carries the sha- tag — and does NOT fall back to a :latest image' {
        $images = @( (New-Img -Tags @('latest', 'known-good') -Digest $script:DigestA) )
        { Resolve-ImageDigestFromImages -Sha $script:FullSha -Images $images } |
            Should -Throw -ExpectedMessage '*No GHCR image is tagged*'
    }

    It 'THROWS (not-found) on an empty image list' {
        { Resolve-ImageDigestFromImages -Sha $script:FullSha -Images @() } |
            Should -Throw -ExpectedMessage '*No GHCR image is tagged*'
    }

    It 'THROWS (ambiguous) when a short-SHA prefix matches two distinct digests' {
        $images = @(
            (New-Img -Tags @('sha-abc1234def') -Digest $script:DigestA),
            (New-Img -Tags @('sha-abc1234fed') -Digest $script:DigestB)
        )
        { Resolve-ImageDigestFromImages -Sha 'abc1234' -Images $images } |
            Should -Throw -ExpectedMessage '*Ambiguous*'
    }

    It 'does NOT throw ambiguous when two sha- tags point at the SAME digest' {
        $images = @(
            (New-Img -Tags @("sha-$script:FullSha") -Digest $script:DigestA),
            (New-Img -Tags @('sha-30281107aaaa') -Digest $script:DigestA)
        )
        $r = Resolve-ImageDigestFromImages -Sha '30281107' -Images $images
        $r.Digest | Should -Be $script:DigestA
    }

    It 'THROWS (malformed) when the matched image digest is not a sha256 form' {
        $images = @( (New-Img -Tags @("sha-$script:FullSha") -Digest 'not-a-digest') )
        { Resolve-ImageDigestFromImages -Sha $script:FullSha -Images $images } |
            Should -Throw -ExpectedMessage '*missing or malformed*'
    }
}
