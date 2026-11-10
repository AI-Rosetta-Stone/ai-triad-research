# Tag: unit (t/247)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/247: scripts/data-mutations/FreezeHash.ps1 hashes the checkout-independent form (CRLF -> LF).
.DESCRIPTION
    The vectors are pinned here and in scripts/test_freeze_hash.py, so the PowerShell and Python
    helpers can't drift apart.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 'FreezeHash.ps1')
    $script:Utf8 = [System.Text.Encoding]::UTF8
    $script:Vectors = @(
        @{ Name = 'crlf'; Bytes = $script:Utf8.GetBytes("{`r`n  `"a`": 1`r`n}`r`n"); Hash = '5e36b6560513586ced65eca0e8b025fe88edbcab82ba2cb67a5fcb2d7b202383' }
        @{ Name = 'lf'; Bytes = $script:Utf8.GetBytes("{`n  `"a`": 1`n}`n"); Hash = '5e36b6560513586ced65eca0e8b025fe88edbcab82ba2cb67a5fcb2d7b202383' }
        @{ Name = 'lone-cr'; Bytes = [byte[]](0x61, 0x0D, 0x62, 0x0D, 0x0A); Hash = '367d1c77eadc1495a7db4200f46a8b90ea1fa926282722d308c05a65098a4112' }
        @{ Name = 'bom'; Bytes = [byte[]](0xEF, 0xBB, 0xBF, 0x78, 0x0D, 0x0A); Hash = 'dc79faf9efbee8e42b42346da7a977c74a27581ae8f3465f431176f43e521415' }
        @{ Name = 'empty'; Bytes = [byte[]]@(); Hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
    )
}

Describe 'FreezeHash (t/247)' -Tag 'unit' {
    It 'matches the pinned vectors shared with freeze_hash.py' {
        foreach ($v in $script:Vectors) { Get-FreezeSha256 -Bytes $v.Bytes | Should -BeExactly $v.Hash -Because $v.Name }
    }

    It 'a CRLF and an LF file with the same content get the same hash; Test-FreezeSha256 accepts both' {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) "freezehash-$(Get-Random)"
        $null = New-Item -ItemType Directory -Path $dir
        try {
            [System.IO.File]::WriteAllBytes((Join-Path $dir 'crlf.json'), $script:Vectors[0].Bytes)
            [System.IO.File]::WriteAllBytes((Join-Path $dir 'lf.json'), $script:Vectors[1].Bytes)
            Get-FreezeSha256 -Path (Join-Path $dir 'crlf.json') | Should -BeExactly (Get-FreezeSha256 -Path (Join-Path $dir 'lf.json'))
            Test-FreezeSha256 -Path (Join-Path $dir 'crlf.json') -Expected $script:Vectors[1].Hash -Basis $script:FreezeHashBasis | Should -BeTrue
        } finally { Remove-Item -LiteralPath $dir -Recurse -Force }
    }

    It 'Test-FreezeSha256 refuses an unknown hash_basis' {
        { Test-FreezeSha256 -Path $PSCommandPath -Expected 'x' -Basis 'sha256-raw' } | Should -Throw -ExpectedMessage '*sha256-lf*'
    }
}
