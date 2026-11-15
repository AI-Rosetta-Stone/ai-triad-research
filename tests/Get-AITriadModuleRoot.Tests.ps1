# Tag: unit (t/153)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Get-AITriadModuleRoot: the one root detection AITriad.psm1 and AIEnrich.psm1 share (t/153).
.DESCRIPTION
    Dot-sources the file on its own, as both modules do before anything else loads, so these
    tests also prove it has no dependencies. The cross-module parity guard stays in
    AICallLog.ImportOrder.Tests.ps1.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Get-AITriadModuleRoot.ps1')

    function New-Layout {
        param([string]$Marker)
        $repo = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $mod  = Join-Path $repo 'scripts' 'AITriad'
        New-Item -ItemType Directory -Path $mod -Force | Out-Null
        if ($Marker) { Set-Content -Path (Join-Path $repo $Marker) -Value '{}' }
        [pscustomobject]@{ Repo = (Resolve-Path $repo).Path; Module = $mod }
    }
}

Describe 'Get-AITriadModuleRoot (t/153)' -Tag 'unit' {

    It 'treats a repo root holding <Marker> as a dev install' -TestCases @(
        @{ Marker = '.aitriad.json' }, @{ Marker = 'CLAUDE.md' }
    ) {
        param($Marker)
        $l = New-Layout -Marker $Marker
        $r = Get-AITriadModuleRoot -AITriadDir $l.Module
        $r.ModuleRoot   | Should -Be $l.Module
        $r.RepoRoot     | Should -Be $l.Repo
        $r.IsDevInstall | Should -BeTrue
    }

    It 'treats the module directory as the root when no repo marker is two levels up (PSGallery layout)' {
        $l = New-Layout -Marker $null
        $r = Get-AITriadModuleRoot -AITriadDir $l.Module
        $r.RepoRoot     | Should -Be $l.Module
        $r.IsDevInstall | Should -BeFalse
    }

    It 'gives AITriad and AIEnrich the same roots on this checkout' {
        $aitriad = Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -PassThru -WarningAction SilentlyContinue
        $aienrich = Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -PassThru -WarningAction SilentlyContinue
        $a = & $aitriad  { [pscustomobject]@{ M = $script:ModuleRoot; R = $script:RepoRoot; D = $script:IsDevInstall } }
        $e = & $aienrich { [pscustomobject]@{ M = $script:ModuleRoot; R = $script:RepoRoot; D = $script:IsDevInstall } }
        $e.M | Should -Be $a.M
        $e.R | Should -Be $a.R
        $e.D | Should -Be $a.D
        $a.D | Should -BeTrue
        Test-Path (Join-Path $a.R '.aitriad.json') | Should -BeTrue
    }
}
