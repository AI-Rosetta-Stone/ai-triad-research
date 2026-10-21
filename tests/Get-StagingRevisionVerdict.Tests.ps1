# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4376: a deploy-staging re-run must reuse its existing staging-<sha7> revision (same image), never
# re-create it — re-creating is rejected by ACA and leaves the app provisioningState=Failed.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'azure' 'Get-StagingRevisionVerdict.ps1')
    $Ref = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:ac36c9f72e1c5ce21062479938df432ed4af08c936770e658a73b7db36c8eb6a'
}

Describe 'Get-StagingRevisionVerdict' {
    It 'no revision with this suffix (first run for the commit) -> create' {
        $v = Get-StagingRevisionVerdict -ExistingImage $null -ExpectedImageRef $Ref
        $v.Action | Should -Be 'create'
        $v.Reason | Should -Be 'no-existing-revision'
    }

    It 'an empty image string (revision show returned nothing) -> create' {
        $v = Get-StagingRevisionVerdict -ExistingImage '' -ExpectedImageRef $Ref
        $v.Action | Should -Be 'create'
    }

    It 'FIRE ARM (t/4376): revision exists with the intended image (a re-run) -> reuse, NOT create' {
        $v = Get-StagingRevisionVerdict -ExistingImage $Ref -ExpectedImageRef $Ref
        $v.Action | Should -Be 'reuse'
        $v.Reason | Should -Be 'existing-revision-same-image'
    }

    It 'revision exists with a DIFFERENT image -> refuse (fail closed)' {
        $other = 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:4e9109a074516b32c8554158dd2c7744269c5b88f4f7ccb3304ec3d709381d02'
        $v = Get-StagingRevisionVerdict -ExistingImage $other -ExpectedImageRef $Ref
        $v.Action | Should -Be 'refuse'
        $v.Reason | Should -Be 'existing-revision-different-image'
    }
}
