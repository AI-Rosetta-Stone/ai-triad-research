# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-SnapshotMojibake {
    <#
    .SYNOPSIS
        Lossless read-side repair of console-code-page mojibake in a snapshot body (t/4394).
    .DESCRIPTION
        ConvertFrom-MarkItDown used to capture markitdown's stdout, which PowerShell decoded through
        the Windows console code page (cp437). The result depends on what Python wrote:
          - variant 'cp1252-as-cp437': Python wrote cp1252, so U+2019 became U+00C6 ("governmentXs"),
            curly quotes became U+00F4/U+00F6, dashes U+00FB/U+00F9, e-acute U+0398.
          - variant 'utf8-as-cp437': Python wrote UTF-8, so U+2019 became U+0393 U+00C7 U+00D6.
        Both invert exactly: encode the body back to cp437 bytes (one byte per char), then decode the
        bytes with the encoding Python used. Confirmed on 418/418 signature docs (t/4394#2, #3) and on
        a live markitdown run (t/4394).

        The file on disk is never rewritten: content_sha256 is computed over the snapshot as written
        (source-identity spec 1.1), so the repair happens on read, like Remove-MarkdownDataUri (t/4386).

        This is the LOSSLESS whole-body inverse, for display and model input. It is NOT a comparison
        key: ConvertTo-EvidenceKey (#3661) is a separate, deliberately lossy char map for matching.

        Gate (t/4394#3 as amended by #4, refined by a corpus measurement recorded on t/4394):
          1. Split off the wrapper at the first "---" rule line; it is our own clean UTF-8, never touched.
          2. Leave the body unless it has non-ASCII and every character is cp437-encodable.
          3. 'utf8-as-cp437', strict: the cp437 bytes decode as strict UTF-8 and change the text.
          3b. 'utf8-as-cp437', lenient: only with a clear signature (>= 3 U+0393 U+00C7 pairs). Decode each
              valid UTF-8 sequence and keep the original char for each invalid byte. 30 corpus docs had a
              few sequences broken after conversion (most often a lone 0xA0, the tail of a no-break space),
              which made the strict decode reject the whole body -- and the agreed gate then applied the
              cp1252 arm, producing double mojibake.
          4. 'cp1252-as-cp437': the bytes decode as strict cp1252, the result gains
             U+2019/U+201C/U+201D/U+2013/U+2014, the body holds a variant-A char
             (U+00C6 U+00E6 U+00F4 U+00F6 U+00FB U+00F9 U+0398), AND the result shows typographic
             evidence: an in-word apostrophe; both curly double quotes; an em dash between letters; a
             spaced dash; or an en dash between digits. Clean French/German pass the two #4 guards
             (o-circumflex -> U+201C, o-umlaut -> U+201D, u-circumflex mid-word -> en dash, "ou" with a
             grave accent -> em dash before a space) but produce none of this evidence.
          5. Otherwise leave it.
    .PARAMETER Text
        The whole snapshot text (wrapper + body).
    .OUTPUTS
        [pscustomobject] { Text; Variant = 'none' | 'utf8-as-cp437' | 'cp1252-as-cp437' }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([AllowNull()][AllowEmptyString()][string]$Text)
    Set-StrictMode -Version Latest

    $unchanged = [pscustomobject]@{ Text = $Text; Variant = 'none' }
    if ([string]::IsNullOrEmpty($Text)) { return $unchanged }

    # Characters are built from code points: a literal U+2019/U+201C/U+201D in PowerShell source is a
    # quote delimiter, and an escape can be decoded back into a literal on its way to disk.
    $c = { param([int[]]$cp) -join ($cp | ForEach-Object { [char]$_ }) }

    # 1. Wrapper: the HTML comment + metadata block, up to and including the first '---' rule line.
    $rule = [regex]::Match($Text, '\r?\n---\r?\n')
    if ($rule.Success) {
        $head = $Text.Substring(0, $rule.Index + $rule.Length)
        $body = $Text.Substring($rule.Index + $rule.Length)
    }
    else {
        $head = ''
        $body = $Text
    }

    # 2. Only a body with non-ASCII that is wholly cp437-encodable can be this mojibake.
    if ($body -notmatch '[^\x00-\x7F]') { return $unchanged }
    $strictE = [Text.EncoderFallback]::ExceptionFallback
    $strictD = [Text.DecoderFallback]::ExceptionFallback
    $cp437   = [Text.Encoding]::GetEncoding(437, $strictE, $strictD)
    try { $bytes = $cp437.GetBytes($body) }
    catch [Text.EncoderFallbackException] { return $unchanged }

    # 3. UTF-8 written, cp437 read. Checked first: its bytes often also decode as cp1252, wrongly.
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    try {
        $asUtf8 = $utf8.GetString($bytes)
        if ($asUtf8 -cne $body) { return [pscustomobject]@{ Text = $head + $asUtf8; Variant = 'utf8-as-cp437' } }
    }
    catch [Text.DecoderFallbackException] { }

    # 3b. Lenient UTF-8, only with a clear variant-B signature (see .DESCRIPTION).
    $bLead = & $c 0x0393, 0x00C7
    if ([regex]::Matches($body, [regex]::Escape($bLead)).Count -ge 3) {
        $sb = [Text.StringBuilder]::new($body.Length)
        $i = 0
        while ($i -lt $bytes.Length) {
            $b0 = $bytes[$i]
            if ($b0 -lt 0x80) { [void]$sb.Append([char]$b0); $i++; continue }
            $len = if ($b0 -ge 0xC2 -and $b0 -le 0xDF) { 2 } elseif ($b0 -ge 0xE0 -and $b0 -le 0xEF) { 3 } elseif ($b0 -ge 0xF0 -and $b0 -le 0xF4) { 4 } else { 0 }
            $seq = $null
            if ($len -gt 0 -and ($i + $len) -le $bytes.Length) {
                try { $seq = $utf8.GetString($bytes, $i, $len) } catch [Text.DecoderFallbackException] { $seq = $null }
            }
            if ($null -ne $seq) { [void]$sb.Append($seq); $i += $len }
            else { [void]$sb.Append($body[$i]); $i++ }   # cp437 is one byte per char: byte i is body char i
        }
        $lenient = $sb.ToString()
        if ($lenient -cne $body) { return [pscustomobject]@{ Text = $head + $lenient; Variant = 'utf8-as-cp437' } }
    }

    # 4. cp1252 written, cp437 read.
    $cp1252 = [Text.Encoding]::GetEncoding(1252, $strictE, $strictD)
    try { $asCp1252 = $cp1252.GetString($bytes) }
    catch [Text.DecoderFallbackException] { return $unchanged }

    $rsq = & $c 0x2019; $ldq = & $c 0x201C; $rdq = & $c 0x201D; $en = & $c 0x2013; $em = & $c 0x2014
    $smart        = '[' + $rsq + $ldq + $rdq + $en + $em + ']'
    $gain         = [regex]::Matches($asCp1252, $smart).Count -gt [regex]::Matches($body, $smart).Count
    $variantAChar = $body -cmatch ('[' + (& $c 0x00C6, 0x00E6, 0x00F4, 0x00F6, 0x00FB, 0x00F9, 0x0398) + ']')
    $typographic  = ($asCp1252 -cmatch ('[A-Za-z]' + $rsq + '[A-Za-z]')) -or
                    ($asCp1252.Contains($ldq) -and $asCp1252.Contains($rdq)) -or
                    ($asCp1252 -cmatch ('[A-Za-z]' + $em + '[A-Za-z]')) -or
                    ($asCp1252 -cmatch (' [' + $en + $em + '] ')) -or
                    ($asCp1252 -cmatch ('\d' + $en + '\d'))
    if ($gain -and $variantAChar -and $typographic) {
        return [pscustomobject]@{ Text = $head + $asCp1252; Variant = 'cp1252-as-cp437' }
    }

    $unchanged
}
