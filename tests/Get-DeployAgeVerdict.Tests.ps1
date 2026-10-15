# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4194, SO condition C3 (p/682#16): a git ERROR exit code (128+) must never be read as "not an
# ancestor" (exit 1) — those are different things and conflating them refuses a deploy on a git
# hiccup, not a real older-commit case.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-DeployAgeVerdict.ps1')
}

Describe 'Get-DeployAgeVerdict' {
    It 'no active prod revision (first deploy) -> proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName '' -MergeBaseExitCode $null
        $v.Action | Should -Be 'proceed'
        $v.Reason | Should -Be 'no-active-prod-revision'
    }

    It 'exit 0 (is-ancestor) -> proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 0
        $v.Action | Should -Be 'proceed'
        $v.Reason | Should -Be 'is-ancestor'
    }

    It 'FIRE ARM: exit 1 (confirmed NOT an ancestor) -> refuse' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 1
        $v.Action | Should -Be 'refuse'
        $v.Reason | Should -Be 'not-ancestor-older-deploy'
        $v.RunningShort | Should -Be '7eb71fb'
    }

    It 'SO C3 FIX: exit 128 (a real git ERROR, e.g. a bad ref) -> warn-proceed, NOT refuse' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode 128
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'git-error-exit-128'
    }

    It 'an unparseable revision name -> warn-proceed (fail open), regardless of exit code' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'some-hand-created-revision' -MergeBaseExitCode 1
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'unparseable-revision-name'
    }

    It 'a parseable name but an unresolvable SHA (merge-base never ran) -> warn-proceed' {
        $v = Get-DeployAgeVerdict -ProdRevisionName 'taxonomy-editor--deploy-7eb71fb-87472' -MergeBaseExitCode $null
        $v.Action | Should -Be 'warn-proceed'
        $v.Reason | Should -Be 'unresolvable-sha'
    }
}
