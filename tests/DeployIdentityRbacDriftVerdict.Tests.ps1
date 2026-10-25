# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4397: deploy-identity out-of-band RBAC grant drift detector.
#>

BeforeAll {
    . "$PSScriptRoot/../operations/devops/DeployIdentityRbacDriftVerdict.ps1"
    $script:RgScope = '/subscriptions/sub/resourceGroups/ai-triad'
}

Describe 'Get-DeployIdentityRbacDriftVerdict (t/4397)' -Tag 'devops' {

    It 'a healthy match (every expected assignment present, nothing extra) stays quiet' {
        $expected = @(
            @{ roleDefinitionName = 'Contributor'; roleScopeSuffix = ''; why = 'x' }
        )
        $live = @(
            [pscustomobject]@{ roleDefinitionName = 'Contributor'; scope = $script:RgScope }
        )
        $verdict = Get-DeployIdentityRbacDriftVerdict -Expected $expected -Live $live -RgScope $script:RgScope
        $verdict.ShouldAct | Should -BeFalse
        @($verdict.Violations).Count | Should -Be 0
    }

    It 'FIRE ARM: an expected assignment that disappeared is flagged missing' {
        $expected = @(
            @{ roleDefinitionName = 'Storage File Data Privileged Reader'; roleScopeSuffix = '/providers/Microsoft.Storage/storageAccounts/acct'; why = 't/4390' }
        )
        $live = @()
        $verdict = Get-DeployIdentityRbacDriftVerdict -Expected $expected -Live $live -RgScope $script:RgScope
        $verdict.ShouldAct | Should -BeTrue
        $verdict.Violations[0].Kind | Should -Be 'missing'
        $verdict.Violations[0].Role | Should -Be 'Storage File Data Privileged Reader'
    }

    It 'FIRE ARM: a live assignment not in the manifest is flagged extra' {
        $expected = @()
        $live = @(
            [pscustomobject]@{ roleDefinitionName = 'Owner'; scope = $script:RgScope }
        )
        $verdict = Get-DeployIdentityRbacDriftVerdict -Expected $expected -Live $live -RgScope $script:RgScope
        $verdict.ShouldAct | Should -BeTrue
        $verdict.Violations[0].Kind | Should -Be 'extra'
        $verdict.Violations[0].Role | Should -Be 'Owner'
    }

    It 'a role at the right name but WRONG scope counts as both missing (expected scope) and extra (actual scope) -- scope matters, not just role name' {
        $expected = @(
            @{ roleDefinitionName = 'Reader'; roleScopeSuffix = '/providers/Microsoft.Storage/storageAccounts/acctA'; why = 'x' }
        )
        $live = @(
            [pscustomobject]@{ roleDefinitionName = 'Reader'; scope = "$script:RgScope/providers/Microsoft.Storage/storageAccounts/acctB" }
        )
        $verdict = Get-DeployIdentityRbacDriftVerdict -Expected $expected -Live $live -RgScope $script:RgScope
        $verdict.ShouldAct | Should -BeTrue
        @($verdict.Violations | Where-Object { $_.Kind -eq 'missing' }).Count | Should -Be 1
        @($verdict.Violations | Where-Object { $_.Kind -eq 'extra' }).Count | Should -Be 1
    }

    It 'the real manifest shape (4 expected assignments, matching live) stays quiet -- regression guard against the actual deploy identity state' {
        $expected = @(
            @{ roleDefinitionName = 'Contributor'; roleScopeSuffix = ''; why = 'x' },
            @{ roleDefinitionName = 'User Access Administrator'; roleScopeSuffix = ''; why = 'x' },
            @{ roleDefinitionName = 'Storage Blob Data Contributor'; roleScopeSuffix = '/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw'; why = 'x' },
            @{ roleDefinitionName = 'Storage File Data Privileged Reader'; roleScopeSuffix = '/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw'; why = 'x' }
        )
        $live = @(
            [pscustomobject]@{ roleDefinitionName = 'Contributor'; scope = $script:RgScope }
            [pscustomobject]@{ roleDefinitionName = 'User Access Administrator'; scope = $script:RgScope }
            [pscustomobject]@{ roleDefinitionName = 'Storage Blob Data Contributor'; scope = "$script:RgScope/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw" }
            [pscustomobject]@{ roleDefinitionName = 'Storage File Data Privileged Reader'; scope = "$script:RgScope/providers/Microsoft.Storage/storageAccounts/staitriadkvwl3nywge4iw" }
        )
        $verdict = Get-DeployIdentityRbacDriftVerdict -Expected $expected -Live $live -RgScope $script:RgScope
        $verdict.ShouldAct | Should -BeFalse
    }
}
