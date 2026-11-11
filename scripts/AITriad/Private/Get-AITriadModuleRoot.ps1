# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AITriadModuleRoot {
    <#
    .SYNOPSIS
        The module roots of an AITriad module directory: ModuleRoot, RepoRoot, IsDevInstall.
    .DESCRIPTION
        One copy of the root detection that AITriad.psm1 and AIEnrich.psm1 both need before
        anything else loads (t/153; AIEnrich used to mirror it, t/150). Dev layout: the directory
        is scripts/AITriad and the repo root two levels up holds .aitriad.json or CLAUDE.md. PSGallery
        or standalone install: the module directory is the root.

        Dependency-free on purpose: both modules dot-source this file at the very top, before
        Private/ (and, in AITriad.psm1, before Get-AICostPricing and the AI model config). It
        returns a [pscustomobject] rather than a module class because AIEnrich loads without
        AITriad's classes.
    .PARAMETER AITriadDir
        The AITriad module directory (the folder holding AITriad.psm1 and Private/).
    .EXAMPLE
        $roots = Get-AITriadModuleRoot -AITriadDir $PSScriptRoot
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AITriadDir)

    $Repo = Resolve-Path (Join-Path $AITriadDir '..' '..') -ErrorAction SilentlyContinue
    $IsDev = [bool]($Repo -and ((Test-Path (Join-Path $Repo.Path '.aitriad.json')) -or (Test-Path (Join-Path $Repo.Path 'CLAUDE.md'))))
    [pscustomobject]@{
        ModuleRoot   = $AITriadDir
        RepoRoot     = if ($IsDev) { $Repo.Path } else { $AITriadDir }
        IsDevInstall = $IsDev
    }
}
