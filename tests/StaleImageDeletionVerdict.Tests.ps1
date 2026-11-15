# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# t/4966 both-arms proof for the GHCR cleanup decision: an old known-good image (and the
# untagged child manifests of any tagged index) must be kept; an old orphaned untagged
# version must still be deleted.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Get-GhcrVersionTag.ps1')
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'StaleImageDeletionVerdict.ps1')

    function New-Ver {
        param([long]$Id, [string]$Digest, [int]$AgeDays, [string[]]$Tags = @())
        [pscustomobject]@{
            id         = $Id
            name       = $Digest
            updated_at = [datetimeoffset]::UtcNow.AddDays(-$AgeDays).ToString('o')
            metadata   = [pscustomobject]@{ container = [pscustomobject]@{ tags = @($Tags) } }
        }
    }
    $script:Cutoff = [datetimeoffset]::UtcNow.AddDays(-30)
}

Describe 'Get-StaleImageDeletionVerdict (t/4966)' -Tag 'health' {

    It 'keeps an old version tagged known-good and deletes an old untagged orphan' {
        $versions = @(
            New-Ver -Id 1 -Digest 'sha256:kg'     -AgeDays 90 -Tags @('known-good', 'sha-aaa')
            New-Ver -Id 2 -Digest 'sha256:orphan' -AgeDays 90
        )
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 0
        @($v.ToDelete.id) | Should -Be @(2)
        @($v.ToDelete.id) | Should -Not -Contain 1
    }

    It 'keeps the untagged child manifests of an old known-good index' {
        $versions = @(
            New-Ver -Id 10 -Digest 'sha256:kgindex'   -AgeDays 90 -Tags @('known-good', 'sha-aaa')
            New-Ver -Id 11 -Digest 'sha256:kgamd64'   -AgeDays 90
            New-Ver -Id 12 -Digest 'sha256:kgattest'  -AgeDays 90
            New-Ver -Id 13 -Digest 'sha256:orphan'    -AgeDays 90
        )
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 0 `
            -ProtectedDigests @('sha256:kgamd64', 'sha256:kgattest')
        @($v.ToDelete.id) | Should -Be @(13)
        @($v.Protected.id | Sort-Object) | Should -Be @(11, 12)
    }

    It 'without protected digests, the same children ARE deleted (the pre-t/4966 hazard)' {
        $versions = @(
            New-Ver -Id 10 -Digest 'sha256:kgindex' -AgeDays 90 -Tags @('known-good')
            New-Ver -Id 11 -Digest 'sha256:kgamd64' -AgeDays 90
        )
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 0
        @($v.ToDelete.id) | Should -Be @(11)
    }

    It 'protects a known-good digest even if it were listed untagged (rule 2 stands alone)' {
        # Same digest appearing twice: once tagged known-good, once with an empty tag list.
        $versions = @(
            New-Ver -Id 20 -Digest 'sha256:kg' -AgeDays 90 -Tags @('known-good')
            New-Ver -Id 21 -Digest 'sha256:kg' -AgeDays 90
        )
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 0
        @($v.ToDelete).Count | Should -Be 0
        @($v.Protected.id) | Should -Be @(21)
    }

    It 'never deletes a tagged version, whatever the tag' {
        $versions = @(New-Ver -Id 30 -Digest 'sha256:rel' -AgeDays 400 -Tags @('v1.0.0'))
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 0
        @($v.ToDelete).Count | Should -Be 0
        $v.TotalUntagged | Should -Be 0
    }

    It 'keeps a version whose tags property is absent (fail safe)' {
        $noTags = [pscustomobject]@{
            id = 40; name = 'sha256:x'; updated_at = [datetimeoffset]::UtcNow.AddDays(-90).ToString('o')
            metadata = [pscustomobject]@{ container = [pscustomobject]@{} }
        }
        $v = Get-StaleImageDeletionVerdict -Versions @($noTags) -Cutoff $script:Cutoff -KeepLatest 0
        @($v.ToDelete).Count | Should -Be 0
    }

    It 'keeps the newest KeepLatest untagged and anything newer than the cutoff' {
        $versions = @(
            New-Ver -Id 50 -Digest 'sha256:a' -AgeDays 5
            New-Ver -Id 51 -Digest 'sha256:b' -AgeDays 60
            New-Ver -Id 52 -Digest 'sha256:c' -AgeDays 70
            New-Ver -Id 53 -Digest 'sha256:d' -AgeDays 80
        )
        $v = Get-StaleImageDeletionVerdict -Versions $versions -Cutoff $script:Cutoff -KeepLatest 2
        @($v.ToDelete.id | Sort-Object) | Should -Be @(52, 53)
        $v.KeptCount | Should -Be 2
        $v.TotalUntagged | Should -Be 4
    }

    It 'returns an empty delete set for no versions' {
        $v = Get-StaleImageDeletionVerdict -Versions @() -Cutoff $script:Cutoff
        @($v.ToDelete).Count | Should -Be 0
    }
}

# t/4966: only deploy-azure.yml's tag-known-good job may move the known-good tag.
Describe 'known-good tag writers (t/4966)' -Tag 'health' {
    BeforeAll { $script:Root = Join-Path $PSScriptRoot '..' }

    It 'only Set-TaxEditorKnownGood writes the known-good manifest' {
        $hits = @(Get-ChildItem (Join-Path $script:Root 'scripts'), (Join-Path $script:Root 'operations'), (Join-Path $script:Root 'deploy') -Recurse -File -Include *.ps1, *.psm1, *.sh, *.mjs |
            Select-String -Pattern 'manifests/known-good' -SimpleMatch |
            ForEach-Object { Split-Path $_.Path -Leaf } | Sort-Object -Unique)
        $hits | Should -Be @('Set-TaxEditorKnownGood.ps1')
    }

    It 'only deploy-azure.yml calls Set-TaxEditorKnownGood, once' {
        $calls = @(Get-ChildItem (Join-Path $script:Root '.github' 'workflows') -File -Filter *.yml |
            Select-String -Pattern '^\s*[^#]*Set-TaxEditorKnownGood\s+-' |
            ForEach-Object { Split-Path $_.Path -Leaf })
        $calls | Should -Be @('deploy-azure.yml')
    }
}
