# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Remove-MarkdownDataUri (t/4385): inline base64 images are stripped from snapshot text
    before a reader truncates it to a character window.
#>

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force -WarningAction SilentlyContinue
    $script:B64 = ('QUJD' * 4500)   # 18,000 chars of base64
}

Describe 'Remove-MarkdownDataUri (t/4385)' -Tag 'unit' {

    It 'strips an 18,000-char inline image so a 20,000-char window starts with the text' {
        InModuleScope AITriad -Parameters @{ B64 = $script:B64 } {
            param($B64)
            $snap = "![](data:image/svg+xml;base64,$B64)`n`n# Executive Order`n`nSection 1. Purpose. The policy of the United States is..."
            $r = Remove-MarkdownDataUri -Text $snap
            $r.UriCount | Should -Be 1
            $r.StrippedChars | Should -BeGreaterThan 18000
            $window = $r.Text.TrimStart()
            if ($window.Length -gt 20000) { $window = $window.Substring(0, 20000) }
            $window | Should -Match '^# Executive Order'
            $window | Should -Not -Match 'base64'
        }
    }

    It 'strips a bare data URI (an HTML img) and leaves the surrounding prose intact' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text 'Before <img src="data:image/png;base64,iVBORw0KGgo=" alt="x"> after the image.'
            $r.Text | Should -Be 'Before <img src="" alt="x"> after the image.'
            $r.UriCount | Should -Be 1
        }
    }

    It 'stops a bare URI at whitespace so the next words survive' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text 'see data:image/gif;base64,R0lGODlh The policy text follows'
            $r.Text | Should -Be 'see  The policy text follows'
        }
    }

    It 'counts several images and handles a title and media-type parameters' {
        InModuleScope AITriad {
            $t = "a ![one](data:image/png;base64,AAAA) b ![two](data:image/svg+xml;charset=utf-8;base64,BBBB `"t`") c"
            $r = Remove-MarkdownDataUri -Text $t
            $r.Text | Should -Be 'a  b  c'
            $r.UriCount | Should -Be 2
        }
    }

    It 'leaves text with no data URI, and ordinary image links, unchanged' {
        InModuleScope AITriad {
            $t = 'Plain text with ![a chart](https://example.org/c.png) and the word data: in prose.'
            $r = Remove-MarkdownDataUri -Text $t
            $r.Text | Should -Be $t
            $r.StrippedChars | Should -Be 0
            $r.UriCount | Should -Be 0
        }
    }

    It 'returns an empty result for empty input' {
        InModuleScope AITriad {
            $r = Remove-MarkdownDataUri -Text ''
            $r.Text | Should -Be ''
            $r.StrippedChars | Should -Be 0
        }
    }
}

Describe 'Invoke-OrgStanceExtraction strips data URIs before truncating (t/4385)' -Tag 'unit' {

    It 'calls Remove-MarkdownDataUri before applying MaxDocChars' {
        $src = Get-Content -Raw "$PSScriptRoot/../scripts/AITriad/Public/Invoke-OrgStanceExtraction.ps1"
        $strip = $src.IndexOf('Remove-MarkdownDataUri -Text')
        $trunc = $src.IndexOf('$docText.Substring(0, $MaxDocChars)')
        $strip | Should -BeGreaterThan 0
        $trunc | Should -BeGreaterThan $strip -Because 'the window must be cut from the stripped text'
    }
}
