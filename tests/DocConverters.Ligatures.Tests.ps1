# Tag: ingestion (t/681)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/681: a PDF snapshot holds a ligature's letters, not the U+FB0x character.
.DESCRIPTION
    The PDF tools return typographic ligatures as single characters. Quotes and search are written in
    letters, and the snapshots repaired under t/652 hold letters, so the converter writes letters too.
    Only U+FB00 to U+FB06 change; no other character is normalized.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'DocConverters.psm1') -Force
    $script:Expand = { param([string]$T) & (Get-Module DocConverters) { param($T) Expand-PdfLigature -Text $T } $T }
    $script:C = { param([int]$Cp) [string][char]$Cp }
}

Describe 'Expand-PdfLigature (t/681)' -Tag 'ingestion' {

    It 'writes the letters of <Name>' -ForEach @(
        @{ Name = 'ff'; Cp = 0xFB00; Letters = 'ff' }, @{ Name = 'fi'; Cp = 0xFB01; Letters = 'fi' }, @{ Name = 'fl'; Cp = 0xFB02; Letters = 'fl' }
        @{ Name = 'ffi'; Cp = 0xFB03; Letters = 'ffi' }, @{ Name = 'ffl'; Cp = 0xFB04; Letters = 'ffl' }
        @{ Name = 'long s t'; Cp = 0xFB05; Letters = 'st' }, @{ Name = 'st'; Cp = 0xFB06; Letters = 'st' }
    ) {
        & $script:Expand ('a' + (& $script:C $Cp) + 'z') | Should -BeExactly ('a' + $Letters + 'z')
    }

    It 'changes a word as a reader expects' {
        & $script:Expand ('signi' + (& $script:C 0xFB01) + 'cant e' + (& $script:C 0xFB00) + 'ect, o' + (& $script:C 0xFB03) + 'ce') |
            Should -BeExactly 'significant effect, office'
    }

    It 'normalizes nothing else: other compatibility characters, accents and typography stay as they are' {
        # A non-breaking space, a superscript two, a full-width A, an e with acute, a curly apostrophe, an en dash.
        $Other = (& $script:C 0x00A0) + (& $script:C 0x00B2) + (& $script:C 0xFF21) + (& $script:C 0x00E9) + (& $script:C 0x2019) + (& $script:C 0x2013)
        & $script:Expand $Other | Should -BeExactly $Other
    }

    It 'returns an empty or missing text as it came' {
        & $script:Expand '' | Should -BeExactly ''
    }
}

Describe 'ConvertFrom-Pdf writes ligature letters (t/681)' -Tag 'ingestion' {

    It 'the markitdown path returns letters for a ligature in the tool''s output' {
        $Pdf = Join-Path $TestDrive 'doc.pdf'
        Set-Content -LiteralPath $Pdf -Value 'not really a pdf'
        # A stub in the module's scope shadows any real markitdown: it writes its text to the -o path.
        & (Get-Module DocConverters) {
            param($Out)
            $script:LigatureStubOut = $Out
            function script:markitdown {
                $i = [array]::IndexOf($args, '-o')
                if ($i -ge 0) { [IO.File]::WriteAllText($args[$i + 1], $script:LigatureStubOut, [Text.UTF8Encoding]::new($false)) }
                $global:LASTEXITCODE = 0
            }
            function script:Test-ExternalTool { param($Name) $Name -eq 'markitdown' }
        } ('A speci' + (& $script:C 0xFB01) + 'c in' + (& $script:C 0xFB02) + 'uence.')
        try {
            ConvertFrom-Pdf -PdfPath $Pdf 6>$null | Should -BeExactly 'A specific influence.'
        } finally {
            Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'DocConverters.psm1') -Force
        }
    }
}
