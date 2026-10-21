# Tag: ingestion (t/4394)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4394: the PDF converters capture tool output through a UTF-8 file, never through stdout.
.DESCRIPTION
    Capturing a native tool's stdout decodes it through the console code page (cp437 on Windows),
    which turned U+2019 into U+00C6 or U+0393 U+00C7 U+00D6 in 500+ snapshots. That decode only
    happens on Windows consoles, so these tests pin the mechanism instead: stub tools (functions in
    the module's scope shadow any real executable) produce the text ONLY through the file route.
    The live repro with the real markitdown on a real damaged PDF is recorded on t/4394.
    No smart punctuation appears as a literal here: PowerShell treats U+2018/U+2019 as quote delimiters.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'DocConverters.psm1') -Force

    # Expected text: every character the old capture mangled, with CRLF line endings from the tool.
    $c = { param([int[]]$cp) -join ($cp | ForEach-Object { [char]$_ }) }
    $script:Expected = 'The government' + (& $c 0x2019) + 's view: ' + (& $c 0x201C) + 'no' + (& $c 0x201D) +
                       ' ' + (& $c 0x2014) + ' pages 3' + (& $c 0x2013) + '4' + (& $c 0x2026) + ' caf' + (& $c 0x00E9)
    $script:ToolOutput = $Expected + "`r`nsecond line"

    $script:Pdf = Join-Path $TestDrive 'doc.pdf'
    Set-Content -LiteralPath $Pdf -Value 'not really a pdf'

    # Stubs: each writes the expected text, as UTF-8, ONLY to the path given after its output flag,
    # and prints nothing to stdout. They record their arguments and the PYTHONIOENCODING they saw.
    & (Get-Module DocConverters) {
        param($Out)
        $script:StubOut = $Out
        $script:StubCalls = [System.Collections.Generic.List[object]]::new()
        function script:Write-StubFile([string]$Path) { [IO.File]::WriteAllText($Path, $script:StubOut, [Text.UTF8Encoding]::new($false)) }
        function script:markitdown {
            $script:StubCalls.Add([pscustomobject]@{ Tool = 'markitdown'; Args = @($args); PyEnc = $env:PYTHONIOENCODING })
            $i = [array]::IndexOf($args, '-o'); if ($i -ge 0) { Write-StubFile $args[$i + 1] }
            $global:LASTEXITCODE = 0
        }
        function script:mutool {
            $script:StubCalls.Add([pscustomobject]@{ Tool = 'mutool'; Args = @($args) })
            $i = [array]::IndexOf($args, '-o'); if ($i -ge 0) { Write-StubFile $args[$i + 1] }
            $global:LASTEXITCODE = 0
        }
        function script:pdftotext {
            $script:StubCalls.Add([pscustomobject]@{ Tool = 'pdftotext'; Args = @($args) })
            if ($args -contains '-enc') { Write-StubFile $args[-1] }
            $global:LASTEXITCODE = 0
        }
    } $ToolOutput
    function script:Get-StubCalls([string]$Tool) { & (Get-Module DocConverters) { param($T) @($script:StubCalls | Where-Object Tool -eq $T) } $Tool }
}

AfterAll {
    & (Get-Module DocConverters) { Remove-Item function:script:markitdown, function:script:mutool, function:script:pdftotext, function:script:Write-StubFile -ErrorAction SilentlyContinue }
}

Describe 'PDF converters read tool output as UTF-8 from a file (t/4394)' -Tag 'ingestion' {

    BeforeEach { & (Get-Module DocConverters) { $script:StubCalls.Clear() } }

    It 'markitdown: passes -o, reads the file back exactly (LF endings), with PYTHONIOENCODING=utf-8 scoped to the call' {
        $env:PYTHONIOENCODING = 'sentinel'
        try {
            $md = ConvertFrom-MarkItDown -FilePath $Pdf 6>$null
            $md | Should -BeExactly ($Expected + "`nsecond line")
            $call = @(Get-StubCalls 'markitdown')
            $call.Count | Should -Be 1
            $call[0].Args | Should -Contain '-o'
            $call[0].PyEnc | Should -Be 'utf-8'
            $env:PYTHONIOENCODING | Should -Be 'sentinel'      # restored afterwards
        }
        finally { $env:PYTHONIOENCODING = $null }
    }

    It 'markitdown: leaves no temp file behind' {
        $null = ConvertFrom-MarkItDown -FilePath $Pdf 6>$null
        $out = (@(Get-StubCalls 'markitdown')[0].Args)[-1]
        Test-Path -LiteralPath $out | Should -BeFalse
    }

    It 'mutool fallback: passes -o and reads the file back exactly' {
        Mock -ModuleName DocConverters Test-ExternalTool { $Name -eq 'mutool' }
        $md = ConvertFrom-Pdf -PdfPath $Pdf 6>$null
        $md | Should -BeExactly ($Expected + "`nsecond line")
        (@(Get-StubCalls 'mutool')[0].Args) | Should -Contain '-o'
    }

    It 'pdftotext fallback: pins -enc UTF-8, and the smart punctuation survives' {
        Mock -ModuleName DocConverters Test-ExternalTool { $Name -eq 'pdftotext' }
        $md = ConvertFrom-Pdf -PdfPath $Pdf 6>$null
        $args1 = @(Get-StubCalls 'pdftotext')[0].Args
        $i = [array]::IndexOf($args1, '-enc')
        $i | Should -BeGreaterOrEqual 0
        $args1[$i + 1] | Should -Be 'UTF-8'
        $md | Should -Match ([regex]::Escape([string][char]0x2019))
    }
}
