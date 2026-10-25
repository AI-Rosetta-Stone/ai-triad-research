# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

$script:RagBackMatterHeading = '^\s{0,3}#{1,6}\s*(references|bibliography|works cited|literature cited|acknowledge?ments?)\b'

function Split-RagQueryWindows {
    <#
    .SYNOPSIS
        Splits a RAG query text into embedding-sized windows that together cover all of it (t/4468).
    .DESCRIPTION
        The chunk and whole-document RAG queries used to embed only the text's first 2000 chars (or 500 words), so
        the taxonomy candidate set reflected the opening ~3% of a ~60k-char chunk. This returns windows in document
        order, each at most -MaxChars long (all-MiniLM-L6-v2 sees ~256 word-pieces, about 1000 chars):
          1. split on markdown headings (#, ##, ...) so a window does not straddle sections;
          2. drop back-matter sections (References, Bibliography, Works/Literature Cited, Acknowledgements) unless
             -KeepBackMatter: they carry no claims and attract noise (CL t/4468#2 item 3); the count is returned;
          3. a section longer than -MaxChars is split on blank-line paragraph breaks, then on sentence ends, then
             hard-split at -MaxChars;
          4. adjacent small pieces are packed together up to -MaxChars, so short sections do not each become a
             near-empty window.
        Whitespace-only pieces are dropped; no other non-whitespace text is lost.
    .PARAMETER Text
        The query text (a chunk, or a whole document).
    .PARAMETER MaxChars
        Upper bound per window. Default 900, the piece size Invoke-BatchEmbeddings uses (stipulated, t/4468#2).
    .PARAMETER KeepBackMatter
        Keep back-matter sections instead of dropping them.
    .OUTPUTS
        [pscustomobject] @{ Windows = string[]; SkippedSections = int }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [AllowEmptyString()][string]$Text,
        [ValidateRange(200, 4000)][int]$MaxChars = 900,
        [switch]$KeepBackMatter
    )
    Set-StrictMode -Version Latest
    $result = { param([string[]]$w, [int]$s) [pscustomobject]@{ Windows = [string[]]$w; SkippedSections = $s } }
    if ([string]::IsNullOrWhiteSpace($Text)) { return (& $result @() 0) }
    $norm = $Text -replace "`r`n", "`n"

    # 1. Sections: a new section starts at each markdown heading line.
    $sections = [System.Collections.Generic.List[string]]::new()
    $cur = [System.Text.StringBuilder]::new()
    foreach ($line in $norm -split "`n") {
        if ($line -match '^\s{0,3}#{1,6}\s' -and $cur.Length -gt 0) { $sections.Add($cur.ToString()); [void]$cur.Clear() }
        [void]$cur.Append($line).Append("`n")
    }
    if ($cur.Length -gt 0) { $sections.Add($cur.ToString()) }

    # 2. Back matter.
    $skipped = 0
    if (-not $KeepBackMatter) {
        $kept = [System.Collections.Generic.List[string]]::new()
        foreach ($sec in $sections) {
            $first = ($sec -split "`n", 2)[0]
            if ($first -match $script:RagBackMatterHeading) { $skipped++ } else { $kept.Add($sec) }
        }
        $sections = $kept
    }

    # 3. Pieces no longer than MaxChars: paragraphs, then sentences, then hard split.
    $pieces = [System.Collections.Generic.List[string]]::new()
    $addPiece = {
        param([string]$s)
        $t = $s.Trim()
        if (-not $t) { return }
        if ($t.Length -le $MaxChars) { $pieces.Add($t); return }
        $sentences = [regex]::Split($t, '(?<=[.!?])\s+')
        $buf = [System.Text.StringBuilder]::new()
        foreach ($sn in $sentences) {
            if (-not $sn) { continue }
            if ($sn.Length -gt $MaxChars) {
                if ($buf.Length -gt 0) { $pieces.Add($buf.ToString().Trim()); [void]$buf.Clear() }
                for ($o = 0; $o -lt $sn.Length; $o += $MaxChars) { $pieces.Add($sn.Substring($o, [Math]::Min($MaxChars, $sn.Length - $o)).Trim()) }
                continue
            }
            if ($buf.Length -gt 0 -and ($buf.Length + 1 + $sn.Length) -gt $MaxChars) { $pieces.Add($buf.ToString().Trim()); [void]$buf.Clear() }
            if ($buf.Length -gt 0) { [void]$buf.Append(' ') }
            [void]$buf.Append($sn)
        }
        if ($buf.Length -gt 0) { $pieces.Add($buf.ToString().Trim()) }
    }
    foreach ($sec in $sections) {
        if ($sec.Trim().Length -le $MaxChars) { & $addPiece $sec; continue }
        foreach ($para in [regex]::Split($sec, "\n\s*\n")) { & $addPiece $para }
    }

    # 4. Pack adjacent pieces up to MaxChars (order is kept).
    $windows = [System.Collections.Generic.List[string]]::new()
    $pack = [System.Text.StringBuilder]::new()
    foreach ($p in $pieces) {
        if (-not $p) { continue }
        if ($pack.Length -gt 0 -and ($pack.Length + 2 + $p.Length) -gt $MaxChars) { $windows.Add($pack.ToString()); [void]$pack.Clear() }
        if ($pack.Length -gt 0) { [void]$pack.Append("`n`n") }
        [void]$pack.Append($p)
    }
    if ($pack.Length -gt 0) { $windows.Add($pack.ToString()) }
    & $result $windows.ToArray() $skipped
}

# Stipulated RAG window parameters (t/4468#2 provenance): the window size matches Invoke-BatchEmbeddings' piece
# size; the cap bounds scoring cost on very long queries (beyond it windows are sampled evenly, with a WARN).
$script:RagWindowChars = 900
$script:RagMaxWindows = 512
