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
#     >= 0.9 of it inside one window of about 6,000 letters, but not as one passage: other text sits
#     between them (a two-column or table layout, a page header, or sentences the model skipped without
#     an elision mark). It is stored as its source pieces, each the source's own text, and counted
#     (t/389#8 b; CL rulings t/389#11, t/389#15, p/70#77).
#   - otherwise DROPPED.
# Each kept segment or piece is stored as its own quote, so every stored string is in the source. An
# elision mark is never stored, because the model added it (t/389#11). A quote with no kept segment is dropped; the key point is kept, and its verbatim is
# removed when no quote is left.
#
# Thresholds are stipulated by CL (t/389). Matching runs on a working copy of the snapshot with the
# t/4394 mojibake repaired, HTML tags blanked, and repeated page footers and headers blanked; a copy of such a line inside
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
$script:VerbatimInterleaveWindow = 6000 # letters around a place searched for in-order runs (CL: 1,500 lost real quotes, t/389#20)
$script:VerbatimMaxInnerGap = 8        # source letters one skip inside a snapped span may hold (a corrupted word, not a header)
$script:VerbatimFooterMinRepeats = 3
$script:VerbatimFooterMaxChars = 80
$script:VerbatimFooterMinWords = 3     # a page header has at least this many words
$script:VerbatimPageNumberPattern = '^(?i)(?:page\s+\d{1,4}(?:\s+of\s+\d{1,4})?|\d{1,4}\s*(?:of|/)\s*\d{1,4})$'
$script:VerbatimHtmlTagPattern = '(?i)</?(?:a|abbr|article|aside|b|blockquote|br|caption|cite|code|div|em|figcaption|figure|footer|h[1-6]|header|hr|i|img|li|mark|nav|ol|p|pre|q|s|section|small|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?:\s[^<>\r\n]{0,400})?/?>'
$script:VerbatimBlankLineRegex = [regex]::new('\r?\n(?:[ \t]*\r?\n)+')   # one or more blank lines
$script:VerbatimFigureLinePattern = '^[^\p{L}\r\n]*\p{Nd}[^\p{L}\r\n]*$'      # a line with a digit and no letter
$script:VerbatimFigureTokenPattern = '(?<!\S)[^\p{L}\s]*\p{Nd}[^\p{L}\s]*(?!\S)'  # a word with a digit and no letter
$script:VerbatimElisionMaxGap = 1000   # letters between two segments of an elided quote (CL t/389#40, stipulated; to be revisited)
$script:VerbatimWordTail = 2           # source letters past a quote word's end that a stored piece may take (a plural)
$script:VerbatimElisionPattern = '\[\s*(?:\.{3,}|\u2026)\s*\]|\(\s*(?:\.{3,}|\u2026)\s*\)|(?:\.[ \u00A0]){2,}\.|\.{3,}|\u2026'
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
    # Same-length blanking of what is not text (t/389#20): HTML tags, and two mojibake forms of a
    # no-break space and an ellipsis that read as letters ("N.<a-acute>Li", "Ma, <a-grave> D. Hendrycks").
    $W = [regex]::Replace($W, $script:VerbatimHtmlTagPattern, { param($M) ' ' * $M.Length })
    $W = [regex]::Replace($W, '(?<!\p{Ll})\u00E1(?!\p{Ll})', ' ')
    $W = [regex]::Replace($W, '(?<=\s)\u00E0(?=\s)', ' ')
    $Lines = $W -split "(\r?\n)"
    # A page header or footer (CL rulings t/389#20, #24, p/70#83, t/389#30): a line of at most
    # VerbatimFooterMaxChars characters and at least VerbatimFooterMinWords words that occurs
    # VerbatimFooterMinRepeats times or more, compared with case, AND sits at a page boundary:
    #   - one of the first two or last two non-blank lines of a page, where pages are separated by form
    #     feeds (what the PDF converters emit); or
    #   - next to a page-number line of the form "Page 3", "3 of 9" or "3 / 9".
    # A bare number line is not a boundary: tables are full of them. A repeated line anywhere else is
    # document text (a table's row label, a note printed in every section). One- and two-word lines are
    # never headers. Blanking only hides text from matching; stored text is never changed by it.
    $Counts = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::Ordinal)
    $Trimmed = [string[]]::new($Lines.Count)
    $PageOf = [int[]]::new($Lines.Count)
    $PageNo = 0
    for ($I = 0; $I -lt $Lines.Count; $I += 2) {
        if ($Lines[$I].IndexOf([char]12) -ge 0) { $PageNo++ }
        $PageOf[$I] = $PageNo
        $T = $Lines[$I].Trim()
        $Trimmed[$I] = $T
        if ($T.Length -gt 0 -and $T.Length -le $script:VerbatimFooterMaxChars) {
            $N0 = 0
            [void]$Counts.TryGetValue($T, [ref]$N0)
            $Counts[$T] = $N0 + 1
        }
    }
    # The non-blank lines, in order; a line is at a page edge when it is one of the first two or last two
    # of its page. With no form feed anywhere there are no pages to speak of, and no edges.
    $NonBlank = [System.Collections.Generic.List[int]]::new()
    for ($I = 0; $I -lt $Lines.Count; $I += 2) { if ($Trimmed[$I].Length -gt 0) { $NonBlank.Add($I) } }
    $AtBoundary = [bool[]]::new($Lines.Count)
    for ($J = 0; $J -lt $NonBlank.Count; $J++) {
        $I = $NonBlank[$J]
        $Edge = $false
        if ($PageNo -gt 0) {
            foreach ($D in 1, 2) {
                if ($J - $D -lt 0 -or $PageOf[$NonBlank[$J - $D]] -ne $PageOf[$I]) { $Edge = $true }
                if ($J + $D -ge $NonBlank.Count -or $PageOf[$NonBlank[$J + $D]] -ne $PageOf[$I]) { $Edge = $true }
            }
        }
        if (-not $Edge) {
            foreach ($N in ($J - 1), ($J + 1)) {
                if ($N -ge 0 -and $N -lt $NonBlank.Count -and $Trimmed[$NonBlank[$N]] -match $script:VerbatimPageNumberPattern) { $Edge = $true }
            }
        }
        $AtBoundary[$I] = $Edge
    }
    $Footers = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $Out = [System.Text.StringBuilder]::new($W.Length)
    $BlankedAt = [System.Collections.Generic.List[int]]::new()   # start offsets of the blanked lines, ascending
    for ($I = 0; $I -lt $Lines.Count; $I++) {
        $L = $Lines[$I]
        $Blank = $false
        if ($I % 2 -eq 0 -and $Trimmed[$I].Length -gt 0 -and $AtBoundary[$I]) {
            $T = $Trimmed[$I]
            $Seen0 = 0
            if ($Counts.TryGetValue($T, [ref]$Seen0) -and $Seen0 -ge $script:VerbatimFooterMinRepeats -and
                $T.Split([char[]]" `t", [System.StringSplitOptions]::RemoveEmptyEntries).Count -ge $script:VerbatimFooterMinWords) {
                $Blank = $true
                [void]$Footers.Add($T)
            }
        }
        if ($Blank) {
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
    # Returns @{ Matched; First; Last; MaxGap; Pieces }: characters matched, the first and last source
    # positions, the most source characters skipped at one place inside the match (text the quote doesn't
    # have), and the match as pieces: stretches of source with no skip of more than VerbatimMaxInnerGap
    # characters inside them. A piece is @{ First; Last; QFirst; QLast; Head; Tail }: its source and quote
    # positions, and how many characters at its start and at its end match one for one.
    param([string]$Hay, [string]$Q, [int]$From, [int]$To)
    $N = $Q.Length
    $K = $script:VerbatimAnchorK
    $MinRun = [Math]::Min($script:VerbatimMinRun, $N)
    $None = @{ Matched = 0; First = -1; Last = -1; MaxGap = 0; Pieces = @() }
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
    $Pieces = [System.Collections.Generic.List[object]]::new()
    $PieceStart = -1; $PieceQStart = -1; $Head = 0; $Tail = 0
    for ($C = 0; $C -lt $Chain.Count; $C++) {
        $I = $Chain[$C]
        if ($PieceStart -lt 0) { $PieceStart = $Hs[$I] + $Trim[$I]; $PieceQStart = $Qs[$I] + $Trim[$I]; $Head = $Ls[$I] - $Trim[$I] }
        $Tail = $Ls[$I] - $Trim[$I]
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
            $Tail = $BestLen
            if ($BestDh -gt $MaxGap) { $MaxGap = $BestDh }
            if ($Cursor - 1 -gt $Last) { $Last = $Cursor - 1 }
        }
        # Source text between the end of this run and the start of the next one. More than a corrupted
        # word's worth ends the piece.
        $Gap = if ($C + 1 -lt $Chain.Count) { $HEnd - $Cursor } else { 0 }
        if ($Gap -gt $MaxGap) { $MaxGap = $Gap }
        if ($C + 1 -eq $Chain.Count -or $Gap -gt $script:VerbatimMaxInnerGap) {
            $Pieces.Add(@{ First = $PieceStart; Last = $Cursor - 1; QFirst = $PieceQStart; QLast = $A - 1; Head = $Head; Tail = $Tail })
            $PieceStart = -1
        }
    }
    @{ Matched = $Matched; First = $First; Last = $Last; MaxGap = $MaxGap; Pieces = $Pieces.ToArray() }
}

function Find-VerbatimSnap {
    # The best in-order alignment of a quote to the source. Returns $null, or { Start; End; Coverage;
    # Contiguous; Pieces; QuoteLetters; FigureLines }. Coverage is the share of the quote's letters matched. Contiguous
    # says the match is one passage: about as long as the quote, with no other text inside it. Pieces are
    # the matched stretches of source, in order, as { Start; End; QuoteLetters }: source offsets, and how
    # many of the quote's letters the piece covers. There is one piece when Contiguous, and several when
    # other text sits between them. Start/End span all the pieces.
    #
    # A piece begins and ends on a word of the quote (CL ruling t/389#20): a match that stops inside a
    # quote word, as at a hyphenated line break ("fron-" ... "tier"), gives that word up. Then it takes up
    # to VerbatimWordTail more source letters to finish the source's word (a plural).
    param([object]$Source, [string]$Quote)
    $QKey = ConvertTo-EvidenceKey -Quote $Quote
    $Q = $QKey -replace ' ', ''
    if ([string]::IsNullOrEmpty($Q)) { return $null }
    $N = $Q.Length
    $Hay = $Source.Chars
    $K = $script:VerbatimAnchorK
    if ($N -lt $K -or $Hay.Length -lt $K) { return $null }
    $Slack = [int][Math]::Ceiling($N / 4) + 8
    $Tight = $N + $Slack
    # Candidate places: where an anchor taken from the quote occurs in the source. Anchors of one run's
    # length are tried as well as short ones, and the rarest are used first, so a common phrase ("labour
    # market" in a long report) doesn't use up the candidates before the right place is reached.
    $Anchors = [System.Collections.Generic.List[object]]::new()
    foreach ($Len in @([Math]::Min($script:VerbatimMinRun, $N), $K) | Select-Object -Unique) {
        $Step = [Math]::Max(1, [int]($Len / 3))
        for ($QI = 0; $QI + $Len -le $N; $QI += $Step) {
            $G = $Q.Substring($QI, $Len)
            $Hits = [System.Collections.Generic.List[int]]::new()
            $P = 0
            while ($Hits.Count -le $script:VerbatimMaxRegions) {
                $P = $Hay.IndexOf($G, $P, [System.StringComparison]::Ordinal)
                if ($P -lt 0) { break }
                $Hits.Add($P); $P++
            }
            if ($Hits.Count -gt 0) { $Anchors.Add([pscustomobject]@{ QI = $QI; Hits = $Hits; Len = $Len }) }
        }
    }
    $Places = [System.Collections.Generic.List[int]]::new()   # the quote's start, were it one passage
    $Seen = @{}
    foreach ($Anchor in ($Anchors | Sort-Object { $_.Hits.Count }, { -$_.Len }, QI)) {
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
            return @{ First = $R.First; Last = $R.Last; Matched = $R.Matched; Span = $Span; MaxGap = $R.MaxGap; Pieces = $R.Pieces }
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
        # Then other text between the quote's lines or sentences: one window of about
        # VerbatimInterleaveWindow letters around the place, still in order (CL rulings t/389#11, t/389#20).
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

    # Where the quote's words begin and end, as positions in $Q.
    $Boundary = [bool[]]::new($N + 1)
    $At = 0
    $Boundary[0] = $true
    foreach ($Token in $QKey.Split(' ')) { $At += $Token.Length; if ($At -le $N) { $Boundary[$At] = $true } }

    $Text = $Source.Text
    $Pieces = [System.Collections.Generic.List[object]]::new()
    $CarryHyphen = $false
    $FigureLines = [System.Collections.Generic.List[object]]::new()
    $FigureSeen = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($P in $Best.Pieces) {
        # A piece that starts or ends inside a quote word: take the rest of the word when the source has
        # it right there (the neighbouring piece's run had claimed those letters), else give the word up.
        $Ds = 0
        if (-not $Boundary[$P.QFirst]) {
            $Back = 1
            while ($P.QFirst - $Back -gt 0 -and -not $Boundary[$P.QFirst - $Back]) { $Back++ }
            $Fits = ($P.First - $Back -ge 0)
            for ($J = 1; $Fits -and $J -le $Back; $J++) { if ($Q[$P.QFirst - $J] -cne $Hay[$P.First - $J]) { $Fits = $false } }
            if ($Fits) { $Ds = -$Back }
            else { while ($P.QFirst + $Ds -le $N -and -not $Boundary[$P.QFirst + $Ds]) { $Ds++ } }
        }
        $De = 0
        if (-not $Boundary[$P.QLast + 1]) {
            $Fwd = 1
            while ($P.QLast + 1 + $Fwd -lt $N -and -not $Boundary[$P.QLast + 1 + $Fwd]) { $Fwd++ }
            $Fits = ($P.Last + $Fwd -lt $Hay.Length)
            for ($J = 1; $Fits -and $J -le $Fwd; $J++) { if ($Q[$P.QLast + $J] -cne $Hay[$P.Last + $J]) { $Fits = $false } }
            if ($Fits) { $De = -$Fwd }
            else { while ($P.QLast + 1 - $De -ge 0 -and -not $Boundary[$P.QLast + 1 - $De]) { $De++ } }
        }
        # Only the part that matches one for one can be given up letter by letter.
        if ($Ds -gt $P.Head -or $De -gt $P.Tail) { continue }
        $Letters = ($P.QLast + 1 - $De) - ($P.QFirst + $Ds)
        if ($Letters -le 0) { continue }
        $PS = Get-VerbatimTextOffset -Source $Source -Position ($P.First + $Ds)
        $PE = (Get-VerbatimTextOffset -Source $Source -Position ($P.Last - $De)) + 1
        # Finish the source's own word when only a letter or two of it is left.
        $More = 0
        while ($PE + $More -lt $Text.Length -and [char]::IsLetterOrDigit($Text[$PE + $More])) { $More++ }
        if ($More -le $script:VerbatimWordTail) { $PE += $More }
        # The second half of a word the piece before lost to a hyphenated break ("cod-" ... "ing") goes too.
        if ($CarryHyphen) {
            $W0 = $PS
            while ($W0 -lt $PE -and [char]::IsLetterOrDigit($Text[$W0])) { $W0++ }
            $Letters -= ($W0 - $PS)
            while ($W0 -lt $PE -and -not [char]::IsLetterOrDigit($Text[$W0])) { $W0++ }
            $PS = $W0
        }
        # A piece that ends with the first half of a hyphenated word (a hyphen, then a break or other text)
        # gives that half up: it is not a word (CL, t/389#24).
        $CarryHyphen = $false
        if ($PE -lt $Text.Length -and $Text[$PE] -eq '-' -and ($PE + 1 -ge $Text.Length -or [char]::IsWhiteSpace($Text[$PE + 1]))) {
            $W1 = $PE
            while ($W1 -gt $PS -and [char]::IsLetterOrDigit($Text[$W1 - 1])) { $W1-- }
            $Letters -= ($PE - $W1)
            while ($W1 -gt $PS -and -not [char]::IsLetterOrDigit($Text[$W1 - 1])) { $W1-- }
            $PE = $W1
            $CarryHyphen = $true
        }
        if ($PE -le $PS -or $Letters -le 0) { continue }
        # A blanked header or footer line inside a piece splits it: the line is not quote text.
        # A numbers-only line next to a blank line (a chart or table value, a page or footnote number) does
        # not split a piece; it is reported in FigureLines and Resolve-VerbatimSegment decides (t/389#40).
        $Skips = [System.Collections.Generic.List[object]]::new()
        if ($Source.BlankedAt.Count -gt 0) {
            $B = [Array]::BinarySearch($Source.BlankedAt, $PS)
            if ($B -lt 0) { $B = -bnot $B }
            for (; $B -lt $Source.BlankedAt.Count -and $Source.BlankedAt[$B] -lt $PE; $B++) {
                $Cut = $Source.BlankedAt[$B]
                $LineEnd = $Text.IndexOfAny([char[]]"`r`n", $Cut)
                $Skips.Add(@{ Start = $Cut; End = $(if ($LineEnd -lt 0) { $PE } else { [Math]::Min($PE, $LineEnd) }) })
            }
        }
        foreach ($Gap in $script:VerbatimBlankLineRegex.Matches($Text.Substring($PS, $PE - $PS))) {
            $G0 = $PS + $Gap.Index; $G1 = $G0 + $Gap.Length
            $L0 = $Text.LastIndexOf([char]10, [Math]::Max(0, $G0 - 1)) + 1
            $L1 = $Text.IndexOf([char]10, $G1); if ($L1 -lt 0) { $L1 = $Text.Length }
            # Trim: with CRLF line ends the line after the gap still carries its carriage return.
            foreach ($Line in @(@{ Start = $L0; End = $G0 }, @{ Start = $G1; End = $L1 })) {
                if ($Text.Substring($Line.Start, $Line.End - $Line.Start).Trim() -match $script:VerbatimFigureLinePattern -and $FigureSeen.Add($Line.Start)) {
                    $FigureLines.Add([pscustomobject]@{ Start = $Line.Start; End = $Line.End; PieceStart = $PS; PieceEnd = $PE })
                }
            }
        }
        if ($Skips.Count -eq 0) {
            $Pieces.Add([pscustomobject]@{ Start = $PS; End = $PE; QuoteLetters = $Letters })
            continue
        }
        # Split at each; the quote's letters are shared out by the parts' own letters.
        $Parts = [System.Collections.Generic.List[object]]::new()
        $From = $PS
        foreach ($Skip in ($Skips | Sort-Object { $_.Start })) {
            if ($Skip.Start -gt $From) { $Parts.Add(@{ Start = $From; End = $Skip.Start }) }
            if ($Skip.End -gt $From) { $From = $Skip.End }
        }
        if ($PE -gt $From) { $Parts.Add(@{ Start = $From; End = $PE }) }
        foreach ($Part in $Parts) {
            $PartLetters = ([regex]::Replace($Text.Substring($Part.Start, $Part.End - $Part.Start), '[^\p{L}\p{Nd}]', '')).Length
            if ($PartLetters -gt 0) { $Pieces.Add([pscustomobject]@{ Start = $Part.Start; End = $Part.End; QuoteLetters = [Math]::Min($PartLetters, $Letters) }) }
        }
    }
    if ($Pieces.Count -eq 0) { return $null }
    # One passage only when nothing else sits inside it (CL ruling t/389#15): one piece, about as long as
    # the quote, with no run of other source text and no header line inside it.
    $Contiguous = ($Pieces.Count -eq 1) -and ($Best.Span -le $Tight) -and ($Best.MaxGap -le $script:VerbatimMaxInnerGap)
    [pscustomobject]@{
        Start        = $Pieces[0].Start
        End          = $Pieces[$Pieces.Count - 1].End
        Coverage     = $Best.Matched / $N
        Contiguous   = $Contiguous
        Pieces       = $Pieces.ToArray()
        QuoteLetters = $N
        FigureLines  = $FigureLines.ToArray()
    }
}

function Remove-VerbatimQuoteNoise {
    # The quote without a URL, without a copy of a blanked page footer or header line (t/389#8 c), and
    # without the brackets of a one-letter alteration (t/389#20).
    param([object]$Source, [string]$Quote)
    $Q = [regex]::Replace($Quote, $script:VerbatimUrlPattern, ' ')
    # "[F]uture": the model's bracketed change of one letter's case. The letter is the source's.
    $Q = [regex]::Replace($Q, '\[(\p{L})\](?=\p{L})', '$1')
    # A header line is removed only when it is the smaller part of the quote. A quote that is mostly
    # the repeated line (a table's row label with its numbers) is not a quote of the text around a header.
    $Letters = { param($T) ([regex]::Replace($T, '[^\p{L}\p{Nd}]', '')).Length }
    $Before = & $Letters $Q
    foreach ($F in $Source.Footers) {
        if ($F.Length -ge 8 -and $Q.Length -gt $F.Length -and $Q.Contains($F, [System.StringComparison]::Ordinal)) {
            $Without = $Q.Replace($F, ' ')
            $Left = & $Letters $Without
            if ($Left -ge $script:VerbatimMinRun -and 2 * $Left -ge $Before) { $Q = $Without }
        }
    }
    if ($Q -ceq $Quote) { return $Quote }
    [regex]::Replace($Q, '\s{2,}', ' ').Trim()
}

function Get-VerbatimFigureVerdict {
    # What the numbers-only lines inside a placed quote mean for it (CL rulings t/389#40, stipulated).
    # A line is the quote's own figure when the quote's letters match the source better with the line than
    # without it; otherwise it is a marker (a page or footnote number the quote does not have).
    #   Verdict 'drop'  two or more of the quote's figures sit on lines of their own, or quote text goes on
    #                   after one: a label and chart cells, not a passage ("label / 72% / 63%").
    #           'keep'  exactly one, and it ends its piece: a label and its one value. Stored whole; the
    #                   figure is never cut out of a quote that states it.
    #           'none'  no figure of the quote is on a line of its own.
    # MarkerLetters: the letters and digits of the marker lines, for the marker rule in Resolve-VerbatimSegment.
    param([object]$Source, [object]$Snap, [string]$Quote)
    $Out = [pscustomobject]@{ Verdict = 'none'; Markers = 0; MarkerLetters = 0 }
    if (-not $Snap -or @($Snap.FigureLines).Count -eq 0) { return $Out }
    $Letters = { param($T) (ConvertTo-EvidenceKey -Quote $T) -replace ' ', '' }
    $Q = & $Letters $Quote
    $Text = $Source.Text
    $Own = 0; $OwnNotLast = $false
    foreach ($F in $Snap.FigureLines) {
        $Line = $Text.Substring($F.Start, $F.End - $F.Start)
        $LineLetters = (& $Letters $Line).Length
        if ($LineLetters -eq 0) { continue }
        # Compare within the piece, taking the whole line even where the piece stops short of its end ("63" of "63%").
        $From = [Math]::Min($F.PieceStart, $F.Start); $To = [Math]::Max($F.PieceEnd, $F.End)
        $With = & $Letters $Text.Substring($From, $To - $From)
        $Without = & $Letters ($Text.Substring($From, $F.Start - $From) + ' ' + $Text.Substring($F.End, $To - $F.End))
        $MWith = (Get-VerbatimAlignment -Hay $With -Q $Q -From 0 -To $With.Length).Matched
        $MWithout = (Get-VerbatimAlignment -Hay $Without -Q $Q -From 0 -To $Without.Length).Matched
        if ($MWithout -lt $MWith) {
            $Own++
            if ((& $Letters $Text.Substring($F.End, $To - $F.End)).Length -gt 0) { $OwnNotLast = $true }
        } else {
            $Out.Markers++; $Out.MarkerLetters += $LineLetters
        }
    }
    if ($Own -ge 2 -or $OwnNotLast) { $Out.Verdict = 'drop' } elseif ($Own -eq 1) { $Out.Verdict = 'keep' }
    $Out
}

function Resolve-VerbatimSegment {
    # Decides one elision-free segment. Returns { Decision; Texts; Coverage; Start; End }: Decision is 'exact',
    # 'snapped', 'interleaved' or 'dropped', Texts is what to store, in order (empty when dropped), and
    # Start/End are the segment's place in the source text when it was located ($null when it was not).
    # An interleaved segment is stored as its matched source pieces, each the source's own text: kept as
    # the model wrote it, it would read as one continuous passage, which it isn't (CL ruling p/70#77).
    param([object]$Source, [string]$Segment)
    $Result = {
        param($Decision, $Texts, $Coverage, $Snap)
        [pscustomobject]@{ Decision = $Decision; Texts = @($Texts); Coverage = $Coverage
            Start = $(if ($Snap) { $Snap.Start } else { $null }); End = $(if ($Snap) { $Snap.End } else { $null }) }
    }
    # A quote with a figure standing as its own word may run from a line of text onto chart or table values
    # on lines of their own (CL rulings p/70#93, t/389#40). Its words then match exactly and it may still not
    # be a passage, so such a quote is placed in the source before it is accepted as written.
    $Snap = $null
    $HasFigure = $Segment -match $script:VerbatimFigureTokenPattern
    if (Test-VerbatimExact -Source $Source -Quote $Segment) {
        if ($HasFigure) {
            $Snap = Find-VerbatimSnap -Source $Source -Quote $Segment
            if ((Get-VerbatimFigureVerdict -Source $Source -Snap $Snap -Quote $Segment).Verdict -eq 'drop') {
                return (& $Result 'dropped' @() $(if ($Snap) { [double]$Snap.Coverage } else { 0.0 }) $null)
            }
        }
        return (& $Result 'exact' @($Segment) 1.0 $Snap)
    }
    $Clean = Remove-VerbatimQuoteNoise -Source $Source -Quote $Segment
    if ($Clean -cne $Segment -and (Test-VerbatimExact -Source $Source -Quote $Clean)) {
        if ($HasFigure) {
            $Snap = Find-VerbatimSnap -Source $Source -Quote $Clean
            if ((Get-VerbatimFigureVerdict -Source $Source -Snap $Snap -Quote $Clean).Verdict -eq 'drop') {
                return (& $Result 'dropped' @() $(if ($Snap) { [double]$Snap.Coverage } else { 0.0 }) $null)
            }
        }
        return (& $Result 'snapped' @($Clean) 1.0 $Snap)
    }
    $Snap = Find-VerbatimSnap -Source $Source -Quote $Clean
    $Coverage = if ($Snap) { $Snap.Coverage } else { 0.0 }
    if ($Snap -and $Coverage -ge $script:VerbatimSnapThreshold) {
        $Figure = Get-VerbatimFigureVerdict -Source $Source -Snap $Snap -Quote $Clean
        if ($Figure.Verdict -eq 'drop') { return (& $Result 'dropped' @() $Coverage $null) }
        # A page or footnote number between two lines of the quote (t/389#40 ruling 2): when every letter of
        # the quote is in the source in one stretch and the only other text in that stretch is such marker
        # lines, the model's quote is stored exactly as written, as one piece. Nothing is split at a marker.
        if ($Figure.Markers -gt 0 -and $Snap.Contiguous -and $Clean -ceq $Segment -and $Coverage -ge 1.0) {
            $SpanLetters = ((ConvertTo-EvidenceKey -Quote $Source.Text.Substring($Snap.Start, $Snap.End - $Snap.Start)) -replace ' ', '').Length
            if ($SpanLetters - $Figure.MarkerLetters -eq $Snap.QuoteLetters) {
                return (& $Result 'snapped' @($Segment) 1.0 $Snap)
            }
        }
        $Texts = [System.Collections.Generic.List[string]]::new()
        $StoredLetters = 0
        foreach ($P in $Snap.Pieces) {
            # A piece too short to have been placed by itself is not stored as a quote.
            if ($P.QuoteLetters -lt $script:VerbatimMinRun) { continue }
            $T = $Source.Text.Substring($P.Start, $P.End - $P.Start).Trim()
            # Markdown table cells are source text but not prose; a piece that runs across them is not
            # stored (CL, t/389#24).
            if ($T -match '\|\s[^|\r\n]*\|' -or $T -match '(?m)^\s*\|') { continue }
            $Texts.Add($T)
            $StoredLetters += $P.QuoteLetters
        }
        # What is stored must itself cover the quote (CL ruling t/389#20): pieces that add up to less read
        # as fragments of other text, not as the quote.
        # [double] on both: with an int 1 for full coverage, Min binds its int overload and rounds the share up.
        $Coverage = [Math]::Min([double]$Coverage, [double]$StoredLetters / [double]$Snap.QuoteLetters)
        if ($Texts.Count -gt 0 -and $Coverage -ge $script:VerbatimSnapThreshold) {
            $Decision = if ($Snap.Contiguous) { 'snapped' } else { 'interleaved' }
            return (& $Result $Decision $Texts.ToArray() $Coverage $Snap)
        }
    }
    & $Result 'dropped' @() $Coverage $null
}

function Test-VerbatimElisionGap {
    # May two segments of an elided quote stand as one quote (CL ruling t/389#40 (4), stipulated)? They must
    # be in source order, at most VerbatimElisionMaxGap letters apart, with no layout marker in the gap: a
    # page break, a blanked page header, a table row, or a numbers-only line (a chart value, a page number).
    param([object]$Source, [int]$PrevEnd, [int]$NextStart)
    if ($NextStart -lt $PrevEnd) { return $false }
    $Gap = $Source.Text.Substring($PrevEnd, $NextStart - $PrevEnd)
    if (([regex]::Replace($Gap, '[^\p{L}\p{Nd}]', '')).Length -gt $script:VerbatimElisionMaxGap) { return $false }
    if ($Gap.IndexOf([char]12) -ge 0) { return $false }
    if ($Gap -match '(?m)^\s*\|' -or $Gap -match '\|\s[^|\r\n]*\|') { return $false }
    if ($Gap -match '(?m)^[^\p{L}\r\n]*\p{Nd}[^\p{L}\r\n]*\r?$') { return $false }
    if ($Source.BlankedAt.Count -gt 0) {
        $B = [Array]::BinarySearch($Source.BlankedAt, $PrevEnd)
        if ($B -lt 0) { $B = -bnot $B }
        if ($B -lt $Source.BlankedAt.Count -and $Source.BlankedAt[$B] -lt $NextStart) { return $false }
    }
    $true
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
    $AllLetters = 0
    foreach ($Part in $Parts) {
        $PartLetters = ((ConvertTo-EvidenceKey -Quote $Part) -replace ' ', '').Length
        $AllLetters += $PartLetters
        # A fragment shorter than one run can't be placed in the source, so it can't be kept as a quote.
        if ($PartLetters -lt $script:VerbatimMinRun) { continue }
        $R = Resolve-VerbatimSegment -Source $Source -Segment $Part
        if ($R.Coverage -gt $BestCoverage) { $BestCoverage = $R.Coverage }
        if ($R.Decision -eq 'dropped') { continue }
        # Where the segment is, for the elision rule below. A segment accepted as written was not placed yet.
        if ($null -eq $R.Start) {
            $At = Find-VerbatimSnap -Source $Source -Quote $R.Texts[0]
            if ($At) { $R.Start = $At.Start; $R.End = $At.End }
        }
        Add-Member -InputObject $R -NotePropertyName Letters -NotePropertyValue $PartLetters
        $Kept.Add($R)
    }
    if ($Kept.Count -eq 0) { $Dropped.Coverage = $BestCoverage; return $Dropped }
    # An elision joins sentences of one passage (CL ruling t/389#40 (4)): consecutive segments must be in
    # source order, close together, with no layout marker between them (Test-VerbatimElisionGap). The kept
    # segments are cut into runs wherever that fails; the run that holds the most of the quote is stored,
    # and only if it holds VerbatimSnapThreshold of the whole quote. Otherwise the quote is dropped: its
    # parts are from different places and the stored quote would join them.
    if ($Kept.Count -gt 1) {
        $Runs = [System.Collections.Generic.List[object]]::new()
        $Run = [System.Collections.Generic.List[object]]::new()
        foreach ($R in $Kept) {
            if ($Run.Count -gt 0) {
                $Prev = $Run[$Run.Count - 1]
                $Together = ($null -ne $Prev.End -and $null -ne $R.Start) -and (Test-VerbatimElisionGap -Source $Source -PrevEnd $Prev.End -NextStart $R.Start)
                if (-not $Together) { $Runs.Add($Run); $Run = [System.Collections.Generic.List[object]]::new() }
            }
            $Run.Add($R)
        }
        $Runs.Add($Run)
        if ($Runs.Count -gt 1) {
            $BestRun = $null; $BestLetters = -1
            foreach ($Candidate in $Runs) {
                $L = 0; foreach ($R in $Candidate) { $L += $R.Letters }
                if ($L -gt $BestLetters) { $BestLetters = $L; $BestRun = $Candidate }
            }
            $Share = if ($AllLetters -gt 0) { [double]$BestLetters / [double]$AllLetters } else { 0.0 }
            if ($Share -lt $script:VerbatimSnapThreshold) { $Dropped.Coverage = [Math]::Min([double]$BestCoverage, $Share); return $Dropped }
            $Kept = $BestRun
        }
    }
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
