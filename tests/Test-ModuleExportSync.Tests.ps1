# Tag: module (t/2336)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad'
    $PublicDir  = Join-Path $ModulePath 'Public'
    $PsdPath    = Join-Path $ModulePath 'AITriad.psd1'

    Import-Module (Join-Path $ModulePath 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    # Public/*.ps1 basenames == expected function names
    $script:PublicFiles   = @(Get-ChildItem $PublicDir -Filter '*.ps1' -File |
                               Select-Object -ExpandProperty BaseName)

    # FunctionsToExport from the manifest (psd1)
    $script:PsdExports    = @((Import-PowerShellDataFile $PsdPath).FunctionsToExport)

    # Functions actually exported by the psm1 (via Export-ModuleMember)
    $script:ModuleExports = @((Get-Module AITriad).ExportedFunctions.Keys)

    # t/150: functions AITriad deliberately RE-EXPORTS from its nested AIEnrich (no Public/ file). Each
    # one must really be defined by AIEnrich; anything else without a Public/ file is still an orphan.
    $script:ReExported = @('Invoke-AIApi')
}

Describe 'AITriad module export-list sync' -Tag 'module' {

    It 'Every Public/*.ps1 function is in Export-ModuleMember (psm1)' {
        $Missing = @($script:PublicFiles | Where-Object { $_ -notin $script:ModuleExports })
        $Missing.Count | Should -Be 0 -Because "Missing from Export-ModuleMember: $($Missing -join ', ')"
    }

    It 'Every Public/*.ps1 function is in FunctionsToExport (psd1)' {
        $Missing = @($script:PublicFiles | Where-Object { $_ -notin $script:PsdExports })
        $Missing.Count | Should -Be 0 -Because "Missing from FunctionsToExport: $($Missing -join ', ')"
    }

    It 'Export-ModuleMember has no entries without a backing Public/*.ps1 file' {
        $Orphans = @($script:ModuleExports | Where-Object { $_ -notin $script:PublicFiles -and $_ -notin $script:ReExported })
        $Orphans.Count | Should -Be 0 -Because "No backing .ps1 in Public/: $($Orphans -join ', ')"
    }

    It 'FunctionsToExport has no entries without a backing Public/*.ps1 file' {
        $Orphans = @($script:PsdExports | Where-Object { $_ -notin $script:PublicFiles -and $_ -notin $script:ReExported })
        $Orphans.Count | Should -Be 0 -Because "No backing .ps1 in Public/: $($Orphans -join ', ')"
    }

    It 'every re-exported function is exported by both lists and really defined by AIEnrich (t/150)' {
        foreach ($Name in $script:ReExported) {
            $Name | Should -BeIn $script:ModuleExports
            $Name | Should -BeIn $script:PsdExports
            (Get-Module AITriad).ExportedFunctions[$Name].ScriptBlock.Module.Name | Should -Be 'AIEnrich'
        }
    }
}
