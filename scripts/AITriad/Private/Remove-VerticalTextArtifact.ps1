# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Strips vertical-text artifacts (ArXiv watermarks, rotated margin text) from markdown.
.DESCRIPTION
    A run of 10 or more lines of one or two non-space characters (blank lines inside the run
    included) is removed. Shorter runs are kept unchanged. Extracted unchanged from
    Import-AITriadDocument (t/4337) so ingestion can build the snapshot before creating the doc
    directory.
#>
function Remove-VerticalTextArtifact {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Markdown)

    $Lines = $Markdown -split "`n"
    $CleanLines = [System.Collections.Generic.List[string]]::new($Lines.Count)
    $RunBuf     = [System.Collections.Generic.List[int]]::new()
    $ShortCount = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $Trimmed = $Lines[$i].Trim()
        $IsShort = ($Trimmed.Length -ge 1 -and $Trimmed.Length -le 2 -and $Trimmed -match '^\S{1,2}$')
        $IsBlank = ($Trimmed.Length -eq 0)
        if ($IsShort -or ($IsBlank -and $RunBuf.Count -gt 0)) {
            $RunBuf.Add($i)
            if ($IsShort) { $ShortCount++ }
        } else {
            if ($ShortCount -ge 10) {
                Write-Info "Stripped $($RunBuf.Count) lines of vertical-text artifact (lines $($RunBuf[0]+1)-$($RunBuf[$RunBuf.Count-1]+1))"
            } else {
                foreach ($j in $RunBuf) { $CleanLines.Add($Lines[$j]) }
            }
            $CleanLines.Add($Lines[$i])
            $RunBuf.Clear()
            $ShortCount = 0
        }
    }
    if ($ShortCount -ge 10) {
        Write-Info "Stripped $($RunBuf.Count) lines of vertical-text artifact (lines $($RunBuf[0]+1)-$($RunBuf[$RunBuf.Count-1]+1))"
    } elseif ($RunBuf.Count -gt 0) {
        foreach ($j in $RunBuf) { $CleanLines.Add($Lines[$j]) }
    }
    $CleanLines -join "`n"
}
