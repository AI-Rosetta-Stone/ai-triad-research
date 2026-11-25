# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/624 (t/617 design A, Security condition 1): prod's class-A state moves to the Azure Files share
# 'taxonomy-state-prod', which staging must never mount. Bicep has no cross-resource assertion, so
# this static parse of the real main.bicep is the guard: only the prod container app may reference
# the 'taxonomy-state-prod' storage, and only one env storage registration may point at that share.
# Same approach as BicepStagingFreeTierKey.Tests.ps1.

BeforeAll {
    $script:Bicep = Get-Content (Join-Path $PSScriptRoot '..' 'deploy' 'azure' 'main.bicep') -Raw

    function Get-AppBlock([string]$AppName) {
        $m = [regex]::Match($script:Bicep, "(?s)(?m)^resource \w+ 'Microsoft\.App/containerApps@[^']+' = \{\s*\r?\n\s*name:\s*'$([regex]::Escape($AppName))'.*?(?=\r?\n(resource|var|param|output|module) )")
        if (-not $m.Success) { throw "container app '$AppName' not found in main.bicep" }
        $m.Value
    }

    $script:Prod = Get-AppBlock 'taxonomy-editor'
    $script:Staging = Get-AppBlock 'taxonomy-editor-staging'
    $script:StorageRef = "storageName:\s*'taxonomy-state-prod'"
}

Describe 'Prod-only state share isolation (t/624, t/617)' {

    It 'the prod app mounts the taxonomy-state-prod storage' {
        $script:Prod | Should -Match $script:StorageRef
    }

    It 'the staging app never references the taxonomy-state-prod storage' {
        $script:Staging | Should -Not -Match 'taxonomy-state-prod'
    }

    It 'no container app other than prod references the taxonomy-state-prod storage' {
        $refs = [regex]::Matches($script:Bicep, $script:StorageRef)
        $refs.Count | Should -Be 1
        $script:Prod.Contains($refs[0].Value) | Should -BeTrue
    }

    It 'exactly one env storage registration points at the taxonomy-state-prod share' {
        $shares = [regex]::Matches($script:Bicep, "shareName:\s*'taxonomy-state-prod'")
        $shares.Count | Should -Be 1
    }

    It 'the staging app does not set AI_TRIAD_STATE_ROOT under /mnt/prod-state' {
        $script:Staging | Should -Not -Match '/mnt/prod-state'
    }
}
