# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/389: quote-grounding guard for key_points[].verbatim. A quote is meant to be an exact source
# quote, but chunked and FIRE runs return near-quotes (grounding 0.42 chunked vs 0.68 single-call, t/358#9).
#
# A quote is first split at its elision marks ("[...]", "...", the ellipsis character) into segments
# (CL audit t/389#8 a). Each segment is decided on its own, under the spec 7.2 key (ConvertTo-EvidenceKey):
#   - EXACT: the segment's key is a contiguous run of the source's key. Kept unchanged.
#   - SNAPPED: the segment aligns to one source span that covers >= 0.9 of its letters and is about as
#     long as the segment. The stored text is the source's own text, in whole source words.
#   - INTERLEAVED: the segment's letters are in the source in order, in runs of at least 12 that cover
#     >= 0.9 of it inside one window of about 1,500 letters, but not as one passage: other text sits
#     between them (a two-column or table layout, a page header, or sentences the model skipped without
#     an elision mark). It is stored as its source pieces, each the source's own text, and counted
#     (t/389#8 b; CL rulings t/389#11, t/389#15, p/70#77).
#   - otherwise DROPPED.
# Each kept segment or piece is stored as its own quote, so every stored string is in the source. An
# elision mark is never stored, because the model added it (t/389#11). A quote with no kept segment is dropped; the key point is kept, and its verbatim is
# removed when no quote is left.
#
# Thresholds are stipulated by CL (t/389). Matching runs on a working copy of the snapshot with the
# t/4394 mojibake repaired and repeated page footers and headers blanked; a copy of such a line inside
# a quote, and a URL inside a quote, are removed before matching (t/389#8 c). The working copy has the
# same length as the source, so every match maps back to the source's own text. Alignment is over
# letters and digits only, so PDF-glued words ("morecomputeisavailable") and corrupted characters
# inside a word still match (t/389#5, t/389#8 d).

$script:VerbatimSnapThreshold = 0.9
$script:VerbatimAnchorK = 6            # characters of an anchor looked up in the source
$script:VerbatimMinRun = 12            # a run must match at least this many characters to start or re-anchor
$script:VerbatimResyncSkip = 3         # characters either side may skip to continue a run (corruption, a typo)
$script:VerbatimResyncMin = 3          # and the continuation must then match at least this many
$script:VerbatimMaxRegions = 40        # candidate source places tried per segment
$script:VerbatimMaxRuns = 400          # matching runs collected per alignment
$script:VerbatimInterleaveWindow = 1500 # letters around a place searched for an interleaved quote (CL, t/389#11)
$script:VerbatimMaxInnerGap = 8        # source letters one skip inside a snapped span may hold (a corrupted word, not a header)
$script:VerbatimFooterMinRepeats = 3
$script:VerbatimFooterMaxChars = 80
$script:VerbatimElisionPattern = '\[\s*(?:\.{3,}|\u2026)\s*\]|\(\s*(?:\.{3,}|\u2026)\s*\)|\.{3,}|\u2026'
$script:VerbatimUrlPattern = '(?i)\b(?:https?://|www\.)[^\s<>"\)\]]+'

function Get-VerbatimSource {
    # Everything matching needs from one snapshot, built once per document:
    #   Text     the snapshot as given (stored text is cut from this)
    #   Key      the working copy's spec 7.2 key, padded with a space each side
    #   Chars    the working copy's letters and digits, lowercased, as one string
    #   WordAt, WordOffset  the map from a position in Chars back to an offset in Text
    #   Footers  the short repeated lines that were blanked (page footers and headers)
    #   BlankedAt  where each of those lines starts in Text
    param([string]$Text)
    if ($null -eq $Text) { $Text = '' }
    $W = $Text
    foreach ($P in $script:EvidenceMojibakeSequences) {
        $To = $P[1]; $From = $P[0]
        $W = $W.Replace($From, $To + (' ' * ($From.Length - $To.Length)))
    }
    foreach ($P in $script:EvidenceMojibakeSingles) { $W = $W.Replace($P[0], $P[1]) }
    $Lines = $W -split "(\r?\n)"
    $Counts = @{}
    foreach ($L in $Lines) {
        $T = $L.Trim()
        if ($T.Length -gt 0 -and $T.Length -le $script:VerbatimFooterMaxChars) { $Counts[$T] = 1 + [int]$Counts[$T] }
    }
    $Footers = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $Out = [System.Text.StringBuilder]::new($W.Length)
    $BlankedAt = [System.Collections.Generic.List[int]]::new()   # start offsets of the blanked lines, ascending
    foreach ($L in $Lines) {
        $T = $L.Trim()
        if ($T.Length -gt 0 -and $T.Length -le $script:VerbatimFooterMaxChars -and $Counts[$T] -ge $script:VerbatimFooterMinRepeats) {
            [void]$Footers.Add($T)
            $BlankedAt.Add($Out.Length)
            [void]$Out.Append((' ' * $L.Length))
        } else {
            [void]$Out.Append($L)
        }
    }
    $Work = $Out.ToString()
    # Lowercasing is per UTF-16 unit, so the lowered copy keeps the working copy's offsets.
    $Lower = $Work.ToLowerInvariant()
    # Chars is cut from the lowered copy word by word. WordAt[i] is where word i starts in Chars and
    # WordOffset[i] where it starts in Text, so a Chars position maps back to a Text offset.
    $Words = [regex]::Matches($Lower, '[\p{L}\p{Nd}]+')
    $WordAt = [int[]]::new($Words.Count)
    $WordOffset = [int[]]::new($Words.Count)
    $At = 0; $WordIx = 0
    foreach ($M in $Words) {
        $WordAt[$WordIx] = $At; $WordOffset[$WordIx] = $M.Index
        $At += $M.Length; $WordIx++
    }
    [pscustomobject]@{
        Text       = $Text
        Key        = ' ' + (ConvertTo-EvidenceKey -Quote $Work) + ' '
        Chars      = [regex]::Replace($Lower, '[^\p{L}\p{Nd}]+', '')
        WordAt     = $WordAt
        WordOffset = $WordOffset
        Footers    = $Footers
        BlankedAt  = $BlankedAt.ToArray()
    }
}

function Get-VerbatimTextOffset {
    # The offset in the snapshot text of the source character at $Position of Chars.
    param([object]$Source, [int]$Position)
    $I = [Array]::BinarySearch($Source.WordAt, $Position)
    if ($I -lt 0) { $I = (-bnot $I) - 1 }
    $Source.WordOffset[$I] + ($Position - $Source.WordAt[$I])
}

function Test-VerbatimExact {
    # True when the quote's spec 7.2 key is a contiguous run of whole key tokens of the source.
    param([object]$Source, [string]$Quote)
    $QKey = ConvertTo-EvidenceKey -Quote $Quote
    if ([string]::IsNullOrEmpty($QKey)) { return $false }
    $Source.Key.Contains(" $QKey ", [System.StringComparison]::Ordinal)
}

function Get-VerbatimAlignment {
    # Aligns the quote's letters and digits ($Q) to the source characters from $From up to $To.
    #   1. Every maximal run is collected: a place where at least VerbatimMinRun characters of the quote
    #      match the source one for one (or fewer, when the run reaches the end of the quote).
    #   2. The chain of runs that covers the most quote characters is chosen. Runs keep the quote's order
    #      and the source's order: without the order a run match is evidence of nothing (CL, t/389#11).
    #   3. In order, the gap after each run is then walked with short skips on either side, so a corrupted
    #      or mistyped character inside a word doesn't end the match.
    # Returns @{ Matched; First; Last; MaxGap; PieceFirst; PieceLast }: characters matched, the first and
    # last source positions, the most source characters skipped at one place inside the match (text the
    # quote doesn't have), and the match as pieces: stretches of source with no skip of more than
    # VerbatimMaxInnerGap characters inside them.
    param([string]$Hay, [string]$Q, [int]$From, [int]$To)
    $N = $Q.Length
    $K = $script:VerbatimAnchorK
    $MinRun = [Math]::Min($script:VerbatimMinRun, $N)
    $None = @{ Matched = 0; First = -1; Last = -1; MaxGap = 0; PieceFirst = @(); PieceLast = @() }
    if ($To - $From -lt $K -or $N -lt $K) { return $None }

    # 1. Maximal runs.
    $Qs = [System.Collections.Generic.List[int]]::new()
    $Hs = [System.Collections.Generic.List[int]]::new()
    $Ls = [System.Collections.Generic.List[int]]::new()
    for ($A = 0; $A + $K -le $N -and $Qs.Count -lt $script:VerbatimMaxRuns; $A++) {
        $G = $Q.Substring($A, $K)
        $P = $From; $Tries = 0
        while ($Tries -lt 16 -and $P + $K -le $To) {
            $P = $Hay.IndexOf($G, $P, $To - $P, [System.StringComparison]::Ordinal)
            if ($P -lt 0) { break }
            $Tries++
            # Not the start of a run when the characters before also match: that run was collected earlier.
            if (-not ($A -gt 0 -and $P -gt $From -and $Q[$A - 1] -ceq $Hay[$P - 1])) {
                $X = $A + $K; $Y = $P + $K
                while ($X -lt $N -and $Y -lt $To -and $Q[$X] -ceq $Hay[$Y]) { $X++; $Y++ }
                $L = $X - $A
                if ($L -ge $MinRun -or $A + $L -eq $N) { $Qs.Add($A); $Hs.Add($P); $Ls.Add($L) }
            }
            $P++
        }
    }
    $R = $Qs.Count
    if ($R -eq 0) { return $None }

    # 2. Best chain. Runs are already in quote order. A run that overlaps the one before it is trimmed
    #    at its head, and must still have VerbatimResyncMin characters left.
    $Score = [int[]]::new($R); $Prev = [int[]]::new($R); $Trim = [int[]]::new($R)
    $BestI = 0
    for ($I = 0; $I -lt $R; $I++) {
        $Score[$I] = $Ls[$I]; $Prev[$I] = -1; $Trim[$I] = 0
        for ($J = 0; $J -lt $I; $J++) {
            if ($Qs[$J] -ge $Qs[$I]) { continue }
            $O = [Math]::Max(0, $Qs[$J] + $Ls[$J] - $Qs[$I])
            if ($Hs[$J] -ge $Hs[$I]) { continue }
            $O = [Math]::Max($O, $Hs[$J] + $Ls[$J] - $Hs[$I])
            $Eff = $Ls[$I] - $O
            if ($Eff -lt $script:VerbatimResyncMin) { continue }
            if ($Score[$J] + $Eff -gt $Score[$I]) { $Score[$I] = $Score[$J] + $Eff; $Prev[$I] = $J; $Trim[$I] = $O }
        }
        if ($Score[$I] -gt $Score[$BestI]) { $BestI = $I }
    }
    $Chain = [System.Collections.Generic.List[int]]::new()
    for ($I = $BestI; $I -ge 0; $I = $Prev[$I]) { $Chain.Insert(0, $I) }

    $Matched = $Score[$BestI]
    $First = [int]::MaxValue; $Last = -1
    foreach ($I in $Chain) {
        $S = $Hs[$I] + $Trim[$I]; $E = $Hs[$I] + $Ls[$I] - 1
        if ($S -lt $First) { $First = $S }
        if ($E -gt $Last) { $Last = $E }
    }

    # 3. Walk each gap: from the end of a run, up to the start of the next one (or the end of the quote
    #    and the window after the last run).
    $MaxGap = 0
    $PieceFirst = [System.Collections.Generic.List[int]]::new()
    $PieceLast = [System.Collections.Generic.List[int]]::new()
    $PieceStart = -1
    for ($C = 0; $C -lt $Chain.Count; $C++) {
        $I = $Chain[$C]
        if ($PieceStart -lt 0) { $PieceStart = $Hs[$I] + $Trim[$I] }
        $A = $Qs[$I] + $Ls[$I]; $Cursor = $Hs[$I] + $Ls[$I]
        if ($C + 1 -lt $Chain.Count) {
            $Nx = $Chain[$C + 1]
            $QEnd = $Qs[$Nx] + $Trim[$Nx]; $HEnd = $Hs[$Nx] + $Trim[$Nx]
        } else {
            $QEnd = $N; $HEnd = $To
        }
        while ($A -lt $QEnd -and $Cursor -lt $HEnd) {
            $BestLen = 0; $BestDq = 0; $BestDh = 0
            for ($Dq = 0; $Dq -le $script:VerbatimResyncSkip; $Dq++) {
                for ($Dh = 0; $Dh -le $script:VerbatimResyncSkip; $Dh++) {
                    if ($Dq -eq 0 -and $Dh -eq 0) { continue }
                    $X = $A + $Dq; $Y = $Cursor + $Dh; $L = 0
                    while ($X -lt $QEnd -and $Y -lt $HEnd -and $Q[$X] -ceq $Hay[$Y]) { $X++; $Y++; $L++ }
                    if ($L -gt $BestLen) { $BestLen = $L; $BestDq = $Dq; $BestDh = $Dh }
                }
            }
            if ($BestLen -lt [Math]::Min($script:VerbatimResyncMin, $QEnd - $A) -or $BestLen -eq 0) { break }
            $A += $BestDq + $BestLen; $Cursor += $BestDh + $BestLen
            $Matched += $BestLen
            if ($BestDh -gt $MaxGap) { $MaxGap = $BestDh }
            if ($Cursor - 1 -gt $Last) { $Last = $Cursor - 1 }
        }
        # Source text between the end of this run and the start of the next one. More than a corrupted
        # word's worth ends the piece.
        $Gap = if ($C + 1 -lt $Chain.Count) { $HEnd - $Cursor } else { 0 }
        if ($Gap -gt $MaxGap) { $MaxGap = $Gap }
        if ($C + 1 -eq $Chain.Count -or $Gap -gt $script:VerbatimMaxInnerGap) {
            $PieceFirst.Add($PieceStart); $PieceLast.Add($Cursor - 1)
            $PieceStart = -1
        }
    }
    @{ Matched = $Matched; First = $First; Last = $Last; MaxGap = $MaxGap; PieceFirst = $PieceFirst.ToArray(); PieceLast = $PieceLast.ToArray() }
}

function Get-VerbatimWordSpan {
    # Moves a matched stretch of the snapshot to whole source words. $Start is the first matched character
    # and $End is one past the last. At each end, the source word the match stops inside is taken whole when
    # at least half of its letters were matched (a corrupted first letter stays the source's own, t/389#11
    # S10), and left out otherwise (one letter shared with the next column's first word is not a match).
    # Returns @{ Start; End }; End <= Start when nothing is left.
    param([string]$Text, [int]$Start, [int]$End, [int]$Floor = 0)
    $Ws = $Start
    while ($Ws -gt $Floor -and [char]::IsLetterOrDigit($Text[$Ws - 1])) { $Ws-- }
    if ($Ws -lt $Start) {
        $We = $Start
        while ($We -lt $Text.Length -and [char]::IsLetterOrDigit($Text[$We])) { $We++ }
        if (2 * ([Math]::Min($We, $End) - $Start) -ge ($We - $Ws)) { $Start = $Ws }
        else {
            $Start = $We
            while ($Start -lt $End -and -not [char]::IsLetterOrDigit($Text[$Start])) { $Start++ }
        }
    }
    $We = $End
    while ($We -lt $Text.Length -and [char]::IsLetterOrDigit($Text[$We])) { $We++ }
    if ($We -gt $End) {
        $Ws = $End
        while ($Ws -gt $Start -and [char]::IsLetterOrDigit($Text[$Ws - 1])) { $Ws-- }
        if (2 * ($End - $Ws) -ge ($We - $Ws)) { $End = $We }
        else {
            $End = $Ws
            while ($End -gt $Start -and -not [char]::IsLetterOrDigit($Text[$End - 1])) { $End-- }
        }
    }
    @{ Start = $Start; End = $End }
}

function Find-VerbatimSnap {
    # The best in-order alignment of a quote to the source. Returns $null, or { Start; End; Coverage;
    # Contiguous; Pieces }: Start/End are source character offsets, widened to whole source words, Coverage
    # is the share of the quote's letters matched, and Contiguous says the match is one passage: about as
    # long as the quote, with no other text inside it. Pieces are the matched stretches of source as
    # { Start; End } offsets, in order: one when Contiguous, several when other text sits between them.
    param([object]$Source, [string]$Quote)
    $Q = (ConvertTo-EvidenceKey -Quote $Quote) -replace ' ', ''
    if ([string]::IsNullOrEmpty($Q)) { return $null }
    $N = $Q.Length
    $Hay = $Source.Chars
    $K = $script:VerbatimAnchorK
    if ($N -lt $K -or $Hay.Length -lt $K) { return $null }
    $Slack = [int][Math]::Ceiling($N / 4) + 8
    $Tight = $N + $Slack
    # Candidate places: where an anchor taken from the quote occurs in the source. The rarest anchors
    # are used first, so a common opening ("thereis") doesn't use up the candidates.
    $Anchors = [System.Collections.Generic.List[object]]::new()
    for ($QI = 0; $QI + $K -le $N; $QI += $K) {
        $G = $Q.Substring($QI, $K)
        $Hits = [System.Collections.Generic.List[int]]::new()
        $P = 0
        while ($Hits.Count -le $script:VerbatimMaxRegions) {
            $P = $Hay.IndexOf($G, $P, [System.StringComparison]::Ordinal)
            if ($P -lt 0) { break }
            $Hits.Add($P); $P++
        }
        if ($Hits.Count -gt 0) { $Anchors.Add([pscustomobject]@{ QI = $QI; Hits = $Hits }) }
    }
    $Places = [System.Collections.Generic.List[int]]::new()   # the quote's start, were it one passage
    $Seen = @{}
    foreach ($Anchor in ($Anchors | Sort-Object { $_.Hits.Count }, QI)) {
        foreach ($P in $Anchor.Hits) {
            if ($Places.Count -ge $script:VerbatimMaxRegions) { break }
            $S0 = $P - $Anchor.QI
            $Bucket = [int][Math]::Floor($S0 / [Math]::Max(1, [int]($Slack / 2)))
            if (-not $Seen.ContainsKey($Bucket)) { $Seen[$Bucket] = $true; $Places.Add($S0) }
        }
        if ($Places.Count -ge $script:VerbatimMaxRegions) { break }
    }
    if ($Places.Count -eq 0) { return $null }
    $Better = {
        param($Cur, $R)
        if ($R.Matched -eq 0) { return $Cur }
        $Span = $R.Last - $R.First + 1
        if ($null -eq $Cur -or $R.Matched -gt $Cur.Matched -or ($R.Matched -eq $Cur.Matched -and $Span -lt $Cur.Span)) {
            return @{ First = $R.First; Last = $R.Last; Matched = $R.Matched; Span = $Span; MaxGap = $R.MaxGap
                PieceFirst = $R.PieceFirst; PieceLast = $R.PieceLast }
        }
        $Cur
    }
    # One passage first: a window about as long as the quote.
    $Best = $null
    foreach ($S0 in $Places) {
        $From = [Math]::Max(0, $S0 - $Slack)
        $To = [Math]::Min($Hay.Length, [Math]::Max(0, $S0) + $Tight)
        $Best = & $Better $Best (Get-VerbatimAlignment -Hay $Hay -Q $Q -From $From -To $To)
    }
    if ($null -eq $Best -or ($Best.Matched / $N) -lt $script:VerbatimSnapThreshold -or $Best.Span -gt $Tight -or
        $Best.MaxGap -gt $script:VerbatimMaxInnerGap) {
        # Then a layout that puts other text between the quote's lines: one window of about
        # VerbatimInterleaveWindow letters around the place, still in order (CL ruling t/389#11).
        $WideBest = $null
        $Back = [int]($script:VerbatimInterleaveWindow / 6)
        foreach ($S0 in $Places) {
            $From = [Math]::Max(0, $S0 - $Back)
            $To = [Math]::Min($Hay.Length, [Math]::Max(0, $S0) + [Math]::Max($script:VerbatimInterleaveWindow - $Back, $Tight))
            $WideBest = & $Better $WideBest (Get-VerbatimAlignment -Hay $Hay -Q $Q -From $From -To $To)
        }
        if ($null -ne $WideBest -and ($null -eq $Best -or $WideBest.Matched -gt $Best.Matched)) { $Best = $WideBest }
    }
    if ($null -eq $Best) { return $null }
    # Whole words: the stored text never begins or ends inside a source word.
    $Text = $Source.Text
    $Whole = Get-VerbatimWordSpan -Text $Text -Start (Get-VerbatimTextOffset -Source $Source -Position $Best.First) `
        -End ((Get-VerbatimTextOffset -Source $Source -Position $Best.Last) + 1)
    $Start = $Whole.Start; $End = $Whole.End
    # One passage only when nothing else sits inside it (CL ruling t/389#15): no run of other source
    # text between the quote's words, and no blanked page header or footer line inside the span.
    $Contiguous = ($Best.Span -le $Tight) -and ($Best.MaxGap -le $script:VerbatimMaxInnerGap)
    if ($Contiguous -and $Source.BlankedAt.Count -gt 0) {
        $B = [Array]::BinarySearch($Source.BlankedAt, $Start)
        if ($B -lt 0) { $B = -bnot $B }
        if ($B -lt $Source.BlankedAt.Count -and $Source.BlankedAt[$B] -lt $End) { $Contiguous = $false }
    }
    $Pieces = [System.Collections.Generic.List[object]]::new()
    if ($Contiguous) {
        $Pieces.Add([pscustomobject]@{ Start = $Start; End = $End })
    } else {
        $Floor = 0
        for ($I = 0; $I -lt $Best.PieceFirst.Count; $I++) {
            $Whole = Get-VerbatimWordSpan -Text $Text -Floor $Floor `
                -Start (Get-VerbatimTextOffset -Source $Source -Position $Best.PieceFirst[$I]) `
                -End ((Get-VerbatimTextOffset -Source $Source -Position $Best.PieceLast[$I]) + 1)
            $PS = $Whole.Start; $PE = $Whole.End
            if ($PE -le $PS) { continue }
            # A blanked header or footer line inside a piece splits it: the line is not quote text.
            $Cuts = [System.Collections.Generic.List[int]]::new()
            if ($Source.BlankedAt.Count -gt 0) {
                $B = [Array]::BinarySearch($Source.BlankedAt, $PS)
                if ($B -lt 0) { $B = -bnot $B }
                for (; $B -lt $Source.BlankedAt.Count -and $Source.BlankedAt[$B] -lt $PE; $B++) { $Cuts.Add($Source.BlankedAt[$B]) }
            }
            $At = $PS
            foreach ($Cut in $Cuts) {
                if ($Cut -gt $At) { $Pieces.Add([pscustomobject]@{ Start = $At; End = $Cut }) }
                $LineEnd = $Text.IndexOfAny([char[]]"`r`n", $Cut)
                $At = if ($LineEnd -lt 0) { $PE } else { [Math]::Min($PE, $LineEnd) }
            }
            if ($PE -gt $At) { $Pieces.Add([pscustomobject]@{ Start = $At; End = $PE }) }
            $Floor = $PE
        }
    }
    [pscustomobject]@{
        Start      = $Start
        End        = $End
        Coverage   = $Best.Matched / $N
        Contiguous = $Contiguous
        Pieces     = $Pieces.ToArray()
    }
}

function Remove-VerbatimQuoteNoise {
    # The quote without a URL and without a copy of a blanked page footer or header line (t/389#8 c).
    param([object]$Source, [string]$Quote)
    $Q = [regex]::Replace($Quote, $script:VerbatimUrlPattern, ' ')
    foreach ($F in $Source.Footers) {
        if ($F.Length -ge 8 -and $Q.Length -gt $F.Length -and $Q.Contains($F, [System.StringComparison]::Ordinal)) { $Q = $Q.Replace($F, ' ') }
    }
    if ($Q -ceq $Quote) { return $Quote }
    [regex]::Replace($Q, '\s{2,}', ' ').Trim()
}

function Resolve-VerbatimSegment {
    # Decides one elision-free segment. Returns { Decision; Texts; Coverage }: Decision is 'exact',
    # 'snapped', 'interleaved' or 'dropped', and Texts is what to store, in order (empty when dropped).
    # An interleaved segment is stored as its matched source pieces, each the source's own text: kept as
    # the model wrote it, it would read as one continuous passage, which it isn't (CL ruling p/70#77).
    param([object]$Source, [string]$Segment)
    if (Test-VerbatimExact -Source $Source -Quote $Segment) {
        return [pscustomobject]@{ Decision = 'exact'; Texts = @($Segment); Coverage = 1.0 }
    }
    $Clean = Remove-VerbatimQuoteNoise -Source $Source -Quote $Segment
    if ($Clean -cne $Segment -and (Test-VerbatimExact -Source $Source -Quote $Clean)) {
        return [pscustomobject]@{ Decision = 'snapped'; Texts = @($Clean); Coverage = 1.0 }
    }
    $Snap = Find-VerbatimSnap -Source $Source -Quote $Clean
    $Coverage = if ($Snap) { $Snap.Coverage } else { 0.0 }
    if ($Snap -and $Coverage -ge $script:VerbatimSnapThreshold) {
        $Texts = [System.Collections.Generic.List[string]]::new()
        foreach ($P in $Snap.Pieces) {
            $T = $Source.Text.Substring($P.Start, $P.End - $P.Start).Trim()
            # A piece too short to have been placed by itself is not stored as a quote.
            if (([regex]::Replace($T, '[^\p{L}\p{Nd}]', '')).Length -ge $script:VerbatimMinRun) { $Texts.Add($T) }
        }
        if ($Texts.Count -gt 0) {
            $Decision = if ($Snap.Contiguous) { 'snapped' } else { 'interleaved' }
            return [pscustomobject]@{ Decision = $Decision; Texts = $Texts.ToArray(); Coverage = $Coverage }
        }
    }
    [pscustomobject]@{ Decision = 'dropped'; Texts = @(); Coverage = $Coverage }
}

function Resolve-VerbatimQuote {
    # Decides one quote. Returns { Decision; Texts; Coverage; Segments; KeptSegments; SegmentDecisions }.
    #   Texts     what to store, in order: one string per kept segment, or several for a segment kept as
    #             source pieces. No elision mark is stored: a mark the model added is not source text, so
    #             an elided quote becomes its segments (t/389#11 S23).
    #   Decision  'exact' (one segment, stored as written), 'snapped' (the stored text differs from the
    #             quote: source text in place of the model's, a segment removed, or the quote split at its
    #             elisions), 'interleaved' (at least one kept segment is in the source in order but not as
    #             one passage, and is stored as its source pieces) or 'dropped'.
    #   Coverage  the lowest coverage among the kept segments, or the best reached when dropped.
    #   SegmentDecisions  the decision behind each stored string, in the order of Texts.
    param([object]$Source, [string]$Quote)
    $Parts = @([regex]::Split($Quote, $script:VerbatimElisionPattern) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    $Dropped = [pscustomobject]@{ Decision = 'dropped'; Texts = @(); Coverage = 0.0; Segments = $Parts.Count; KeptSegments = 0; SegmentDecisions = @() }
    if ($Parts.Count -eq 0) { return $Dropped }
    if ($Parts.Count -eq 1 -and $Parts[0] -ceq $Quote.Trim()) {
        $R = Resolve-VerbatimSegment -Source $Source -Segment $Quote
        if ($R.Decision -eq 'dropped') { $Dropped.Coverage = $R.Coverage; return $Dropped }
        return [pscustomobject]@{ Decision = $R.Decision; Texts = @($R.Texts); Coverage = $R.Coverage; Segments = 1; KeptSegments = 1
            SegmentDecisions = @($R.Texts | ForEach-Object { $R.Decision }) }
    }
    $Kept = [System.Collections.Generic.List[object]]::new()
    $BestCoverage = 0.0
    foreach ($Part in $Parts) {
        # A fragment shorter than one run can't be placed in the source, so it can't be kept as a quote.
        if (((ConvertTo-EvidenceKey -Quote $Part) -replace ' ', '').Length -lt $script:VerbatimMinRun) { continue }
        $R = Resolve-VerbatimSegment -Source $Source -Segment $Part
        if ($R.Coverage -gt $BestCoverage) { $BestCoverage = $R.Coverage }
        if ($R.Decision -ne 'dropped') { $Kept.Add($R) }
    }
    if ($Kept.Count -eq 0) { $Dropped.Coverage = $BestCoverage; return $Dropped }
    $MinCoverage = 1.0
    foreach ($R in $Kept) { if ($R.Coverage -lt $MinCoverage) { $MinCoverage = $R.Coverage } }
    $Interleaved = @($Kept | Where-Object { $_.Decision -eq 'interleaved' }).Count
    # Any segment found across a layout makes the quote interleaved (t/389#15, S29). Otherwise the stored
    # text changed, which is a snap.
    $Decision = if ($Interleaved -gt 0) { 'interleaved' } else { 'snapped' }
    [pscustomobject]@{
        Decision = $Decision; Texts = @($Kept | ForEach-Object { $_.Texts })
        Coverage = $MinCoverage; Segments = $Parts.Count; KeptSegments = $Kept.Count
        SegmentDecisions = @(foreach ($R in $Kept) { foreach ($T in $R.Texts) { $R.Decision } })
    }
}

function Repair-SummaryKeyPointVerbatim {
    <#
    .SYNOPSIS
        Keeps each key_point verbatim quote grounded in the snapshot (t/389): exact quotes stay, near
        quotes are snapped to the source's own text, an elided quote becomes its grounded segments, a
        quote found in order but not as one passage becomes its source pieces, and the rest are dropped
        with the key point kept.
    .OUTPUTS
        [hashtable] @{ Quotes = <int>; Snapped = <int>; Dropped = <int>; Interleaved = <int> }
        Quotes is the number of quotes examined.
    #>
    param([object]$SummaryObject, [string]$SnapshotText, [string]$ThisDocId)
    $Result = @{ Quotes = 0; Snapped = 0; Dropped = 0; Interleaved = 0 }
    if (-not (Test-SummaryField $SummaryObject 'pov_summaries')) { return $Result }
    $Pov = Get-SummaryField $SummaryObject 'pov_summaries'
    if (-not $Pov) { return $Result }
    $Source = $null
    foreach ($Camp in 'accelerationist', 'safetyist', 'skeptic') {
        $CampData = Get-SummaryField $Pov $Camp
        if (-not $CampData -or -not (Test-SummaryField $CampData 'key_points')) { continue }
        # Assign first: Get-SummaryField returns `, $value`, so @(Get-SummaryField ...) would nest the list.
        $KPs = Get-SummaryField $CampData 'key_points'
        for ($I = 0; $I -lt @($KPs).Count; $I++) {
            $Kp = @($KPs)[$I]
            if ($null -eq $Kp -or -not (Test-SummaryField $Kp 'verbatim')) { continue }
            $Raw = Get-SummaryField $Kp 'verbatim'
            if ($null -eq $Raw) { continue }
            $IsList = $Raw -is [System.Collections.IList]
            if ($null -eq $Source) { $Source = Get-VerbatimSource -Text $SnapshotText }
            $Kept = [System.Collections.Generic.List[string]]::new()
            foreach ($Quote in @($Raw)) {
                if ($Quote -isnot [string] -or [string]::IsNullOrWhiteSpace($Quote)) { continue }
                $Result.Quotes++
                $R = Resolve-VerbatimQuote -Source $Source -Quote $Quote
                $Preview = $Quote.Substring(0, [Math]::Min(100, $Quote.Length))
                foreach ($T in $R.Texts) { $Kept.Add($T) }
                switch ($R.Decision) {
                    'exact' { }
                    'snapped' {
                        if ($R.Texts.Count -ne 1 -or $R.Texts[0] -cne $Quote) {
                            $Result.Snapped++
                            $What = if ($R.Segments -gt 1) { "kept as $($R.KeptSegments) of its $($R.Segments) segments, in the source's text" } else { 'snapped to the source text' }
                            Write-Warning "Finalize-Summary: $ThisDocId $Camp key_points[$I] verbatim $What (t/389): $Preview"
                        }
                    }
                    'interleaved' {
                        $Result.Interleaved++
                        Write-Warning "Finalize-Summary: $ThisDocId $Camp key_points[$I] verbatim stored as $($R.Texts.Count) source piece(s): its text is in the snapshot in order but not as one passage, as in a two-column or table layout or where sentences were skipped (t/389): $Preview"
                    }
                    default {
                        $Result.Dropped++
                        Write-Warning "Finalize-Summary: $ThisDocId $Camp key_points[$I] verbatim dropped, not found in the snapshot (t/389): $Preview"
                    }
                }
            }
            # No quote left: null. A list stays a list. A string stays a string unless the quote became
            # several segments or pieces, which are stored as a list (the array form of t/296).
            if ($Kept.Count -eq 0) { $New = $null }
            elseif ($IsList -or $Kept.Count -gt 1) { $New = $Kept.ToArray() }
            else { $New = $Kept[0] }
            if ($Kp -is [System.Collections.IDictionary]) { $Kp['verbatim'] = $New }
            else { $Kp.verbatim = $New }
        }
    }
    $Result
}
