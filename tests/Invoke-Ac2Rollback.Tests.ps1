# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4309 TL review (e/361#9): Invoke-Ac2Rollback.ps1 must label an exception that happens
    AFTER the traffic shift succeeded as a rollback that happened (RolledBack/RecheckFailed),
    never as an unrecoverable target -- and must still label a PRE-shift exception the old way.
.DESCRIPTION
    `az`, `Import-Module`, and the AITriad module functions are shadowed as plain functions in
    each test's own scope. Command resolution checks the nearest scope first, so these win over
    the real `az` executable (function beats application by default precedence) and over
    whatever `Import-Module -Force` would otherwise load into Global (a nearer scope always
    wins over Global, regardless of what's reloaded there) -- so the real module is never
    actually loaded or invoked by this test.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Invoke-Ac2Rollback.ps1'
}

Describe 'Invoke-Ac2Rollback (t/4309, TL review -- trafficShifted labeling)' -Tag 'devops' {

    BeforeEach {
        function Import-Module { param($Name, [switch]$Force) }
        function az { '{"active":true,"weight":100}' }
        function Set-ContainerAppTraffic { param($RevisionName, $AppName, $ResourceGroup, $MaxAttempts, $RetryIntervalSec) }
        function Disable-ContainerAppRevision { param($RevisionName, $AppName, $ResourceGroup) }
        function Test-TaxEditorHealth { param($BaseUrl, $TimeoutSec, $MaxAttempts, $RetryIntervalSec); [PSCustomObject]@{ Healthy = $true } }
    }

    It 'ARM (a): the shift succeeds and Disable-ContainerAppRevision throws AFTER it -- RolledBack=true, TargetUnrecoverable=false, RecheckFailed=true, reason carries the exception' {
        function Disable-ContainerAppRevision { throw 'disable boom' }
        $result = & $script:ScriptPath -TargetRevision 'rev-a' -NewRevisionToDisable 'rev-b' -AppUrl 'https://example.test'
        $result.RolledBack | Should -BeTrue
        $result.TargetUnrecoverable | Should -BeFalse
        $result.RecheckFailed | Should -BeTrue
        $result.RecheckReason | Should -Match 'disable boom'
    }

    It 'ARM (b): the throw happens BEFORE the shift (the initial revision-show read) -- TargetUnrecoverable=true, RolledBack=false, the pre-existing arm still works' {
        function az { throw 'revision show boom' }
        function Set-ContainerAppTraffic { throw 'should never be called -- the shift must not run after a pre-shift failure' }
        $result = & $script:ScriptPath -TargetRevision 'rev-a' -NewRevisionToDisable 'rev-b' -AppUrl 'https://example.test'
        $result.TargetUnrecoverable | Should -BeTrue
        $result.RolledBack | Should -BeFalse
        $result.RecheckReason | Should -Match 'revision show boom'
    }
}
