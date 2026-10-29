# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Is an org stance claim's `text` a verbatim span of its source snapshot? (t/4382)
.DESCRIPTION
    Both strings are normalized the same way before an ordinal substring check, so the test is
    insensitive to formatting but not to wording:
      - curly single quotes / apostrophes -> ' ; curly double quotes -> "
      - markdown link syntax [text](url) -> text (t/4610)
      - markdown emphasis and code characters * _ ` removed
      - whitespace runs (including newlines and NBSP) collapsed to one space; ends trimmed
    A paraphrase fails; a span that differs only in line wrapping, quote style or markdown passes.
    A claim text containing "..." is elision-aware (t/4609): each non-empty segment around "..." must
    appear in the normalized snapshot in order, not necessarily contiguous.
#>
function ConvertTo-StanceVerbatimForm {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    # Classes built from code points so this file stays ASCII: PowerShell treats curly quotes in
    # source as string delimiters.
    $single = '[' + (-join ([char[]](0x2018, 0x2019, 0x201A, 0x201B, 0x2032))) + ']'
    $double = '[' + (-join ([char[]](0x201C, 0x201D, 0x201E, 0x201F, 0x2033))) + ']'
    $t = $Text -replace $single, "'" -replace $double, '"'
    $t = $t -replace '\[([^\]]*)\]\([^)]*\)', '$1'
    $t = $t -replace '[*_`]', ''
    ($t -replace ('[\s' + [char]0x00A0 + ']+'), ' ').Trim()
}

function Test-StanceTextVerbatim {
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [AllowNull()][AllowEmptyString()][string]$Text,
        [AllowNull()][AllowEmptyString()][string]$Snapshot
    )
    $needle = ConvertTo-StanceVerbatimForm $Text
    if ($needle -eq '') { return $false }
    $haystack = ConvertTo-StanceVerbatimForm $Snapshot
    $segments = @($needle -split '\.\.\.' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($segments.Count -eq 0) { return $false }
    $pos = 0
    foreach ($seg in $segments) {
        $idx = $haystack.IndexOf($seg, $pos, [StringComparison]::Ordinal)
        if ($idx -lt 0) { return $false }
        $pos = $idx + $seg.Length
    }
    $true
}
