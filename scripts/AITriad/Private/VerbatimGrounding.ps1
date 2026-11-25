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
# U+FB00..U+FB04 (ff, fi, fl, ffi, ffl) as their UTF-8 bytes EF AC 80..84 read in code page 437.
$script:VerbatimLigatureMojibake = @(
    @("`u{2229}`u{00BC}`u{00C7}", 'ff'), @("`u{2229}`u{00BC}`u{00FC}", 'fi'), @("`u{2229}`u{00BC}`u{00E9}", 'fl'),
    @("`u{2229}`u{00BC}`u{00E2}", 'ffi'), @("`u{2229}`u{00BC}`u{00E4}", 'ffl')
)
# The start of a list or bibliography entry, tested on the first line of a paragraph (CL t/389#45, stipulated):
# a leading number ("113 ", "1416 R. Fang", "349. F. Heiding", "2)"), a bracketed tag ("[industry]"), or an
# author with initials ("Heiding, F." / "F. Heiding,").
$script:VerbatimEntryStartPattern = '^(?:\(?\p{Nd}{1,4}[.)*]?(?:\s+\S|(?=\p{Lu}))|\[[^\]\r\n]{1,40}\]|\p{Lu}[\p{L}\u2019''\-]+,\s+(?:\p{Lu}\.[ \u00A0]?)+|(?:\p{Lu}\.[ \u00A0]?)+\p{Lu}[\p{L}\u2019''\-]+,)'
$script:VerbatimFootnoteMaxGap = 500      # letters of footnote text that may sit between two words of a quote (CL t/389#52 (1), stipulated)
# The three refinements of CL t/389#61. Each can be switched off by an audit script to count it on its own.
$script:VerbatimRefAnywhere = $true        # (1) digits-only extra text is a reference wherever it sits
$script:VerbatimSplitAtExtraLine = $true   # (2) extra text on lines of its own splits the piece; it does not fail it
$script:VerbatimFoldMoreMojibake = $true   # (3) more mojibake folded in the model's quote; converter symbols blanked in the source
# (1) A reference: one to three digits, more of them after commas or a hyphen, or bracketed numerals ("[8]",
# "[8, 12]"). Never part of a longer number (a year), a decimal, a percentage or a word ("5G").
$script:VerbatimRefAnywherePattern = '(?<![\p{Nd}$])(?<!\p{Nd}[.,])(?:\[\s*\p{Nd}{1,3}(?:\s*[,\-]\s*\p{Nd}{1,3})*\s*\]|\p{Nd}{1,3}(?:[,\-]\p{Nd}{1,3})*)(?![\p{Nd}%\p{L}]|[.,]\p{Nd})'
# (3) Mojibake the model's quote can carry: the snapshot's damaged marks, damaged once more when the UTF-8
# bytes were read as Windows-1252 or Latin-1. Longest first. Each is a mark or a space, never a letter.
$script:VerbatimQuoteMojibakeMore = @(
    @("`u{00E2}`u{20AC}`u{2122}", "'"), @("`u{00E2}`u{20AC}`u{02DC}", "'"),
    @("`u{00E2}`u{20AC}`u{0153}", '"'), @("`u{00E2}`u{20AC}`u{009D}", '"'),
    @("`u{00E2}`u{20AC}`u{201D}", '-'), @("`u{00E2}`u{20AC}`u{201C}", '-'), @("`u{00E2}`u{20AC}`u{00A6}", '...'),
    @("`u{00E2}`u{20AC}", '"'),
    @("`u{00C3}`u{2020}", "'"), @("`u{00C3}`u{00A1}", ' '), @("`u{00C3}`u{00A0}", ' '),
    @("`u{00C3}`u{00BB}", '-'), @("`u{00C3}`u{00B9}", '-'),
    @("`u{00EF}`u{00BF}`u{00BD}", ' '), @("`u{FFFD}", ' ')
)
$script:VerbatimNbspBetweenLetters = $true  # CL t/389#63 (1): the a-acute that is a no-break space, between two letters, matches as a space
# CL t/389#64: the source side is normalised for matching, with three limits; and t/389#67 (1).
$script:VerbatimSourceNfkc = $true          # (1) the source's letters are NFKC-folded, as the quote's already are (a kept ligature character matches "fi")
$script:VerbatimNoSpaceDeletion = 'source'  # (2) a space is never deleted: 'source' fails a source space inside a quote word; 'both' also fails glued source words; 'none'
$script:VerbatimStoreModelWords = $true     # (3) where the normalised match holds, the model's own words are stored, not the source's text
$script:VerbatimNbspWordEdge = $true        # t/389#67 (1): the a-acute no-break space also at a word's start or end, never at the quote's own start or end
# CL t/389#70: matching lower-cases both sides (the spec 7.2 key does), so a quote can differ from the source in
# case alone. That is allowed only at the quote's first letter, or where the source word is all capitals (two
# letters or more; the model may write it in any capitalisation, t/389#72). Anywhere else the quote fails.
$script:VerbatimCaseRule = $true
# CL t/389#74. Each can be switched off by an audit script.
$script:VerbatimAlignExtras = $true          # a piece's letters are aligned to the quote's, so extra lines and the model's own digits are told apart
$script:VerbatimSplitAtGluedSidebar = $true  # a sidebar word glued to the end of a line ("couldLaw") splits the piece there
# CL t/389#76.
$script:VerbatimSymbolRef = $true            # a footnote symbol read as a letter, glued to a word's end ("Mishra" + the section sign's mojibake)
$script:VerbatimSymbolRefPattern = '(?<=\p{L})[' + [char]0xBA + [char]0xE7 + '](?=[\s,.;:)\]]|$)'
$script:VerbatimListJoinMin = 2              # commas of the model's own at this many line breaks of the source make a list join
$script:VerbatimRejectListJoin = $true
$script:VerbatimParenRefList = $true         # "(998, 1003)": a parenthesised list of two or more numerals is a reference
$script:VerbatimParenRefListPattern = '\(\s*\p{Nd}{1,4}\*?(?:\s*[,;]\s*\p{Nd}{1,4}\*?)+\s*\)'
$script:VerbatimCaseMaxPlaces = 25          # places in the source tried for a quote kept as written
$script:VerbatimHyphenBreakPattern = '^[-' + [char]0xAD + [char]0x2010 + [char]0x2011 + '][ \t]*\r?\n\s*$'   # a word broken over a line end
$script:VerbatimHeadAcrossRef = $true       # the snap reaches back over a reference to the quote's first words ("Causation 344 poses ...")
$script:VerbatimRejectDamagedWord = $true    # a stored piece with a word that is not the quote's word fails (CL t/389#56 (3))
$script:VerbatimDiag = [System.Collections.Generic.List[string]]::new()   # why the last quotes were rejected or changed; read and cleared by audit scripts only
$script:VerbatimRejectPieceDeletion = 'all'   # which stored classes may not hold source words the quote lacks: 'all', 'interleaved', 'none' (CL t/389#52 (4), #54 (2))
# A footnote reference glued to a word or to the punctuation after it: one to three digits (and more of them
# after commas, "5,21") that follow a letter or a closing mark and are followed by a space, a mark or the end.
$script:VerbatimGluedRefPattern = '(?<=[\p{L}.,;:!?"''\)\]' + [char]0x201D + [char]0x2019 + '])\p{Nd}{1,3}(?:,\p{Nd}{1,3})*(?=[\s.,;:!?\)\]]|$)'
$script:VerbatimRequireEndWords = $true  # a snapped segment must begin and end on the source's own words (CL t/389#47 (3))
$script:VerbatimListMarkerPattern = '^\(?\p{Nd}{1,3}[.)]$'   # "1." or "2)" on a line of its own: a list numeral, never a figure (CL t/389#42)
# UTF-8 bytes of the snapshot's own mojibake quote marks (U+00F4, U+00F6, U+00C6, U+00E6) read as Latin-1.
$script:VerbatimQuoteMojibake = @(
    @("`u{00C3}`u{00B4}", '"'), @("`u{00C3}`u{00B6}", '"'), @("`u{00C3}`u{0086}", "'"), @("`u{00C3}`u{00A6}", "'")
)
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
    # Ligatures whose UTF-8 bytes were read as code page 437 ("signi" + U+2229 U+00BC U+00FC + "cant" for
    # "significant"; t/389#45, H06). Without this the word does not match the model's quote, and the stored
    # piece starts after it. Same length, like the repairs above; only the matching copy changes.
    foreach ($P in $script:VerbatimLigatureMojibake) { $W = $W.Replace($P[0], $P[1].PadRight(3)) }
    # Same-length blanking of what is not text (t/389#20): HTML tags, and two mojibake forms of a
    # no-break space and an ellipsis that read as letters ("N.<a-acute>Li", "Ma, <a-grave> D. Hendrycks").
    $W = [regex]::Replace($W, $script:VerbatimHtmlTagPattern, { param($M) ' ' * $M.Length })
    $W = [regex]::Replace($W, '(?<!\p{Ll})\u00E1(?!\p{Ll})', ' ')
    $W = [regex]::Replace($W, '(?<=\s)\u00E0(?=\s)', ' ')
    # The same no-break space glued between a word and a mark ("are" + it + an opening quote; t/389#50, J08):
    # followed by a mark, it is not the last letter of a word.
    $W = [regex]::Replace($W, '\u00E1(?=[^\p{L}\p{Nd}\s])', ' ')
    if ($script:VerbatimFoldMoreMojibake) {
        # A fixed list of characters the converter leaves behind (CL t/389#61 (3)), blanked in the matching
        # copy only: the replacement character, a "(cid:12)" glyph name, and the masculine ordinal that a
        # section sign became, when it stands before a number or a capital ("DMCA " + it + "1202").
        $W = $W.Replace([string][char]0xFFFD, ' ')
        $W = [regex]::Replace($W, '\(cid:\p{Nd}{1,5}\)', { param($M) ' ' * $M.Length })
        $W = [regex]::Replace($W, '(?<![\p{L}\p{Nd}])º(?=[\p{Nd}\p{Lu}])', ' ')
    }
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
    # A word that NFKC changes (a ligature character, a full-width letter) goes into Chars folded, as the
    # quote's letters are (CL t/389#64 (1)). WordMap[i] then gives, for each folded letter of word i, the
    # offset in the word of the character it came from. A ligature the converter dropped is not restored.
    $CharsOut = [System.Text.StringBuilder]::new($Lower.Length)
    $CasedOut = [System.Text.StringBuilder]::new($Lower.Length)   # the same letters before lower-casing (CL t/389#70)
    $WordMap = @{}
    $KC = [System.Text.NormalizationForm]::FormKC
    $At = 0; $WordIx = 0
    foreach ($M in $Words) {
        $WordAt[$WordIx] = $At; $WordOffset[$WordIx] = $M.Index
        $Word = $M.Value
        if ($script:VerbatimSourceNfkc -and -not $Word.IsNormalized($KC)) {
            $Folded = [System.Text.StringBuilder]::new()
            $Map = [System.Collections.Generic.List[int]]::new()
            for ($C = 0; $C -lt $Word.Length; $C++) {
                foreach ($Ch in ([string]$Word[$C]).Normalize($KC).ToLowerInvariant().ToCharArray()) {
                    if ([char]::IsLetterOrDigit($Ch)) { [void]$Folded.Append($Ch); $Map.Add($C) }
                }
            }
            # Folding character by character must give what folding the word gives; else the word stays as it is.
            $Whole = [regex]::Replace($Word.Normalize($KC).ToLowerInvariant(), '[^\p{L}\p{Nd}]', '')
            if ($Folded.Length -gt 0 -and $Folded.ToString() -ceq $Whole) {
                $Word = $Whole
                $WordMap[$WordIx] = $Map.ToArray()
            }
        }
        [void]$CharsOut.Append($Word)
        # The cased copy of the word must line up with the lowered one letter for letter; where it does not,
        # the lowered word stands in (its case is then unknown and reads as lower case).
        $CasedWord = $W.Substring($M.Index, $M.Length)
        if ($CasedWord.Length -ne $Word.Length -or $CasedWord.ToLowerInvariant() -cne $Word) {
            $CasedWord = [regex]::Replace($CasedWord.Normalize($KC), '[^\p{L}\p{Nd}]', '')
            if ($CasedWord.Length -ne $Word.Length -or $CasedWord.ToLowerInvariant() -cne $Word) { $CasedWord = $Word }
        }
        [void]$CasedOut.Append($CasedWord)
        $At += $Word.Length; $WordIx++
    }
    [pscustomobject]@{
        Text       = $Text
        Key        = ' ' + (ConvertTo-EvidenceKey -Quote $Work) + ' '
        Chars      = $CharsOut.ToString()
        CharsCased = $CasedOut.ToString()   # Chars before lower-casing, letter for letter
        WordAt     = $WordAt
        WordOffset = $WordOffset
        WordMap    = $WordMap         # word index -> offsets within the word, for the words NFKC changed
        Footers    = $Footers
        BlankedAt  = $BlankedAt.ToArray()
        LineCounts = $Counts          # trimmed line (up to VerbatimFooterMaxChars) -> how often it occurs
        Work       = $Work            # Text with mojibake repaired and page furniture blanked, offset for offset
    }
}

function Get-VerbatimTextOffset {
    # The offset in the snapshot text of the source character at $Position of Chars.
    param([object]$Source, [int]$Position)
    $I = [Array]::BinarySearch($Source.WordAt, $Position)
    if ($I -lt 0) { $I = (-bnot $I) - 1 }
    $Rel = $Position - $Source.WordAt[$I]
    if ($Source.PSObject.Properties['WordMap'] -and $Source.WordMap.Count -gt 0 -and $Source.WordMap.ContainsKey($I)) {
        $Map = $Source.WordMap[$I]
        return $Source.WordOffset[$I] + $Map[[Math]::Min($Rel, $Map.Count - 1)]
    }
    $Source.WordOffset[$I] + $Rel
}

function Get-VerbatimWordGap {
    # The letters of a text as the spec 7.2 key has them, and for each letter what stands before it:
    # Any[i] is true when anything at all separates letter i from letter i-1, Space[i] when that is white
    # space. A word broken over a line end with a hyphen ("inter-" / "national") is not white space.
    param([string]$Text)
    $S = $Text
    foreach ($Pair in $script:EvidenceMojibakeSequences) { $S = $S.Replace($Pair[0], $Pair[1]) }
    foreach ($Pair in $script:EvidenceMojibakeSingles) { $S = $S.Replace($Pair[0], $Pair[1]) }
    $S = $S.Normalize([System.Text.NormalizationForm]::FormKC)
    $Letters = [System.Text.StringBuilder]::new($S.Length)
    $Cased = [System.Text.StringBuilder]::new($S.Length)
    $Any = [System.Collections.Generic.List[bool]]::new()
    $Space = [System.Collections.Generic.List[bool]]::new()
    $GapFrom = -1
    for ($I = 0; $I -lt $S.Length; $I++) {
        if ([char]::IsLetterOrDigit($S[$I])) {
            $HasSpace = $false
            if ($GapFrom -ge 0) {
                $Gap = $S.Substring($GapFrom, $I - $GapFrom)
                $HasSpace = $Gap -match '\s' -and $Gap -notmatch $script:VerbatimHyphenBreakPattern
            }
            $Any.Add($GapFrom -ge 0); $Space.Add($HasSpace)
            [void]$Letters.Append([char]::ToLowerInvariant($S[$I]))
            [void]$Cased.Append($S[$I])
            $GapFrom = -1
        } elseif ($GapFrom -lt 0) { $GapFrom = $I }
    }
    [pscustomobject]@{ Letters = $Letters.ToString(); Cased = $Cased.ToString(); Any = $Any.ToArray(); Space = $Space.ToArray() }
}

function Get-VerbatimCaseVerdict {
    # Compares the case of a quote's letters with the source's, where the letters already agree when
    # lower-cased (CL t/389#70). $WordStart[i] says a source word begins at letter i.
    # Returns @{ Fail; First; Caps; At }: Fail when a difference is not permitted (At names the two words),
    # First when the quote's first letter differs, Caps when an all-capitals source word is in lower case.
    # $Declared: places in the quote's letters where the model marked the changed capital itself, as "[F]uture"
    # (read as the letter since t/389#20). A marked change is permitted and counted.
    param([string]$SourceCased, [bool[]]$WordStart, [string]$QuoteCased, [bool]$FirstAllowed, [int[]]$Declared = @())
    $R = @{ Fail = $false; First = $false; Caps = $false; Title = $false; Bracket = $false; At = ''; AtStart = $false; Unchecked = $false }
    if ($SourceCased -ceq $QuoteCased) { return $R }
    if ($SourceCased.Length -ne $QuoteCased.Length) { $R.Unchecked = $true; return $R }
    $N = $SourceCased.Length
    for ($I = 0; $I -lt $N; $I++) {
        if ($SourceCased[$I] -ceq $QuoteCased[$I]) { continue }
        if ($Declared -contains $I) { $R.Bracket = $true; continue }
        $W0 = $I; while ($W0 -gt 0 -and -not $WordStart[$W0]) { $W0-- }
        $W1 = $I + 1; while ($W1 -lt $N -and -not $WordStart[$W1]) { $W1++ }
        $SW = $SourceCased.Substring($W0, $W1 - $W0); $QW = $QuoteCased.Substring($W0, $W1 - $W0)
        # The source's word in capitals (a heading, small caps): the model may write it in any capitalisation
        # (CL t/389#72). Lower case and other capitalisations ("Introduction" for "INTRODUCTION") are counted apart.
        if ($SW.Length -ge 2 -and $SW -ceq $SW.ToUpperInvariant()) {
            if ($QW -ceq $QW.ToLowerInvariant()) { $R.Caps = $true } else { $R.Title = $true }
            $I = $W1 - 1; continue
        }
        if ($I -eq 0 -and $FirstAllowed) { $R.First = $true; continue }
        $R.Fail = $true; $R.At = "$SW | $QW"; $R.AtStart = ($I -eq 0)
        return $R
    }
    $R
}

function Get-VerbatimLetterMatch {
    # Aligns the letters of a source piece ($Have) to the letters the quote has for it ($Want), where the source
    # may hold extra text between them (a header line, a reference, a no-break space read as a letter) and
    # nothing else differs. Returns for each letter of $Have its place in $Want, or -1 for an extra letter;
    # $null when $Want is not in $Have in order in this way (a word differs). $LineStart[i] says letter i is
    # the first on its line: an extra stretch is laid on a line start when the letters allow either reading
    # ("... man" / "many" / "manufacturer": the extra is "many", not "y" + "man").
    param([string]$Have, [string]$Want, [bool[]]$LineStart = @())
    $M = [int[]]::new($Have.Length)
    for ($X = 0; $X -lt $M.Length; $X++) { $M[$X] = -1 }
    $I = 0; $J = 0
    while ($J -lt $Want.Length) {
        if ($I -ge $Have.Length) { return $null }
        if ($Have[$I] -ceq $Want[$J]) { $M[$I] = $J; $I++; $J++; continue }
        $K = [Math]::Min(8, $Want.Length - $J)
        $Next = $Have.IndexOf($Want.Substring($J, $K), $I, [System.StringComparison]::Ordinal)
        if ($Next -lt 0) { return $null }
        # The extra stretch is [$I, $Next). It can slide left while the letter before it equals its last letter.
        $A = $I; $B = $Next
        $Slide = 0
        while ($A - $Slide - 1 -ge 0 -and $M[$A - $Slide - 1] -ge 0 -and $Have[$A - $Slide - 1] -ceq $Have[$B - $Slide - 1]) { $Slide++ }
        $Use = 0
        if ($LineStart.Count -eq $Have.Length) {
            for ($S = 0; $S -le $Slide; $S++) { if ($LineStart[$A - $S]) { $Use = $S; break } }
        }
        for ($T = 1; $T -le $Use; $T++) { $M[$B - $T] = $M[$A - $T]; $M[$A - $T] = -1 }
        $I = $Next
    }
    , $M
}

function Get-VerbatimLooseCaseVerdict {
    # The case verdict for a quote against a passage that holds its letters in order with other text between
    # them (page-marker lines, a footnote). Unchecked when the letters cannot be lined up.
    param([string]$SourceText, [string]$QuoteText, [bool]$FirstAllowed, [string]$DeclaredFrom = $QuoteText)
    $None = @{ Fail = $false; First = $false; Caps = $false; Title = $false; Bracket = $false; At = ''; AtStart = $false; Unchecked = $true }
    $SG = Get-VerbatimWordGap -Text $SourceText
    $QG = Get-VerbatimWordGap -Text $QuoteText
    if ($QG.Letters.Length -eq 0) { return $None }
    $M = Get-VerbatimLetterMatch -Have $SG.Letters -Want $QG.Letters
    if ($null -eq $M) { return $None }
    $Cased = [System.Text.StringBuilder]::new($QG.Letters.Length)
    $WordStart = [bool[]]::new($QG.Letters.Length)
    $Declared = [System.Collections.Generic.List[int]]::new()
    foreach ($D in @(Get-VerbatimDeclaredCase -Text $DeclaredFrom)) { $Declared.Add($D) }
    $SourceDeclared = @(Get-VerbatimDeclaredCase -Text $SourceText)
    for ($I = 0; $I -lt $M.Length; $I++) {
        if ($M[$I] -lt 0) { continue }
        [void]$Cased.Append($SG.Cased[$I])
        $WordStart[$M[$I]] = ($I -eq 0) -or $SG.Any[$I] -or ($M[$I - 1] -lt 0)
        if ($SourceDeclared -contains $I) { $Declared.Add($M[$I]) }
    }
    Get-VerbatimCaseVerdict -SourceCased $Cased.ToString() -WordStart $WordStart -QuoteCased $QG.Cased -FirstAllowed $FirstAllowed -Declared $Declared.ToArray()
}

function Test-VerbatimListJoin {
    # True when a quote kept as written joins list items that the source prints on lines of their own, with
    # commas or semicolons the source does not have (CL t/389#76): the words are the source's, the sentence is
    # the model's. Counted at the places between two letters where the quote has the mark and the source has a
    # line break and no such mark.
    param([object]$Source, [string]$Quote)
    if (-not $Source.PSObject.Properties['CharsCased']) { return $false }
    $Gaps = {
        param($T)
        $X = $T
        foreach ($Pair in $script:EvidenceMojibakeSequences) { $X = $X.Replace($Pair[0], $Pair[1]) }
        foreach ($Pair in $script:EvidenceMojibakeSingles) { $X = $X.Replace($Pair[0], $Pair[1]) }
        $X = $X.Normalize([System.Text.NormalizationForm]::FormKC)
        $Out = [System.Collections.Generic.List[string]]::new()
        $Cur = [System.Text.StringBuilder]::new()
        foreach ($Ch in $X.ToCharArray()) {
            if ([char]::IsLetterOrDigit($Ch)) { $Out.Add($Cur.ToString()); [void]$Cur.Clear() } else { [void]$Cur.Append($Ch) }
        }
        $Out.Add($Cur.ToString())
        , $Out
    }
    $QG = Get-VerbatimWordGap -Text $Quote
    $N = $QG.Letters.Length
    if ($N -lt 2) { return $false }
    $P = $Source.CharsCased.IndexOf($QG.Cased, [System.StringComparison]::Ordinal)
    if ($P -lt 0) { $P = $Source.Chars.IndexOf($QG.Letters, [System.StringComparison]::Ordinal) }
    if ($P -lt 0) { return $false }
    $A0 = Get-VerbatimTextOffset -Source $Source -Position $P
    $A1 = (Get-VerbatimTextOffset -Source $Source -Position ($P + $N - 1)) + 1
    $Txt = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Source.Text.Length) { $Source.Work } else { $Source.Text }
    $SGaps = & $Gaps $Txt.Substring($A0, $A1 - $A0)
    $QGaps = & $Gaps $Quote
    if ($SGaps.Count -ne $QGaps.Count) { return $false }
    $Joins = 0
    for ($I = 1; $I -lt $QGaps.Count - 1; $I++) {
        if ($QGaps[$I] -match '[,;]' -and $SGaps[$I] -notmatch '[,;]' -and $SGaps[$I].Contains([char]10)) { $Joins++ }
    }
    $Joins -ge $script:VerbatimListJoinMin
}

function Get-VerbatimDeclaredCase {
    # Where, in a quote's letters, the model put a single letter in square brackets before a word ("[F]uture").
    param([string]$Text)
    @(foreach ($M in [regex]::Matches($Text, '\[\p{L}\](?=\p{L})')) { (Get-VerbatimWordGap -Text $Text.Substring(0, $M.Index)).Letters.Length })
}

function Get-VerbatimExactCaseVerdict {
    # The case verdict for a quote whose key is in the source as written. The key says nothing of where, so
    # the quote's letters are looked up in the source's; any place where the case passes will do.
    # $DeclaredFrom: the quote before its noise was removed; that removal turns "[F]uture" into "Future".
    param([object]$Source, [string]$Quote, [bool]$FirstAllowed, [string]$DeclaredFrom = $Quote)
    $Q = Get-VerbatimWordGap -Text $Quote
    $None = @{ Fail = $false; First = $false; Caps = $false; Title = $false; Bracket = $false; At = ''; AtStart = $false; Unchecked = $false }
    $Declared = @(Get-VerbatimDeclaredCase -Text $DeclaredFrom)
    $KeyText = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Source.Text.Length) { $Source.Work } else { $Source.Text }
    if ($Q.Letters.Length -eq 0 -or -not $Source.PSObject.Properties['CharsCased']) { $None.Unchecked = $true; return $None }
    if ($Source.CharsCased.Contains($Q.Cased, [System.StringComparison]::Ordinal)) { return $None }
    $Best = $null
    $P = 0
    for ($Tried = 0; $Tried -lt $script:VerbatimCaseMaxPlaces; $Tried++) {
        $P = $Source.Chars.IndexOf($Q.Letters, $P, [System.StringComparison]::Ordinal)
        if ($P -lt 0) { break }
        $WordStart = [bool[]]::new($Q.Letters.Length)
        $W = [Array]::BinarySearch($Source.WordAt, $P)
        if ($W -lt 0) { $W = -bnot $W }
        for (; $W -lt $Source.WordAt.Count -and $Source.WordAt[$W] -lt $P + $Q.Letters.Length; $W++) { $WordStart[$Source.WordAt[$W] - $P] = $true }
        # A letter the source itself has in brackets ("[i]ndividual", an editorial change in the source's own
        # quotation) is a marked change too (CL t/389#74 (1)).
        $Here = [System.Collections.Generic.List[int]]::new()
        foreach ($D in $Declared) { $Here.Add($D) }
        for ($X = 0; $X -lt $Q.Letters.Length; $X++) {
            if ($Source.CharsCased[$P + $X] -ceq $Q.Cased[$X]) { continue }
            $Off = Get-VerbatimTextOffset -Source $Source -Position ($P + $X)
            if ($Off -gt 0 -and $Off + 1 -lt $KeyText.Length -and $KeyText[$Off - 1] -eq '[' -and $KeyText[$Off + 1] -eq ']') { $Here.Add($X) }
        }
        $V = Get-VerbatimCaseVerdict -SourceCased $Source.CharsCased.Substring($P, $Q.Letters.Length) -WordStart $WordStart -QuoteCased $Q.Cased -FirstAllowed $FirstAllowed -Declared $Here.ToArray()
        if (-not $V.Fail) { return $V }
        if ($null -eq $Best) { $Best = $V }
        $P++
    }
    if ($null -eq $Best) {
        # Not found by a plain search of the letters (a character that is a letter only after folding): place
        # the quote by alignment and judge the case over that passage.
        $Snap = Find-VerbatimSnap -Source $Source -Quote $Quote
        if ($Snap -and $Snap.Contiguous) {
            return (Get-VerbatimLooseCaseVerdict -SourceText $KeyText.Substring($Snap.Start, $Snap.End - $Snap.Start) -QuoteText $Quote -FirstAllowed $FirstAllowed -DeclaredFrom $DeclaredFrom)
        }
        $None.Unchecked = $true; return $None
    }
    $Best
}

function Get-VerbatimQuoteCut {
    # The model's own text for letters $From..$To of its quote ($QuoteLetters are the quote's key letters),
    # with the marks that are attached to its first and last word. $null when it cannot be cut cleanly.
    param([string]$Quote, [string]$QuoteLetters, [int]$From, [int]$To)
    if ($From -lt 0 -or $To -le $From -or $To -gt $QuoteLetters.Length) { return $null }
    if ($From -eq 0 -and $To -eq $QuoteLetters.Length) { return $Quote.Trim() }
    $Count = { param($C) ((ConvertTo-EvidenceKey -Quote $Quote.Substring(0, $C)) -replace ' ', '').Length }
    $First = {
        # The shortest prefix of the quote that holds $Target letters.
        param($Target)
        $Lo = 0; $Hi = $Quote.Length
        while ($Lo -lt $Hi) {
            $Mid = [int][Math]::Floor(($Lo + $Hi) / 2)
            if ((& $Count $Mid) -ge $Target) { $Hi = $Mid } else { $Lo = $Mid + 1 }
        }
        $Lo
    }
    $S = (& $First ($From + 1)) - 1
    $E = & $First $To
    if ($S -lt 0 -or $E -le $S) { return $null }
    $S2 = $S
    while ($S2 -gt 0 -and -not [char]::IsWhiteSpace($Quote[$S2 - 1]) -and -not [char]::IsLetterOrDigit($Quote[$S2 - 1])) { $S2-- }
    if ($S2 -eq 0 -or [char]::IsWhiteSpace($Quote[$S2 - 1])) { $S = $S2 }
    $E2 = $E
    while ($E2 -lt $Quote.Length -and -not [char]::IsWhiteSpace($Quote[$E2]) -and -not [char]::IsLetterOrDigit($Quote[$E2])) { $E2++ }
    if ($E2 -eq $Quote.Length -or [char]::IsWhiteSpace($Quote[$E2])) { $E = $E2 }
    $Cut = $Quote.Substring($S, $E - $S).Trim()
    if (((ConvertTo-EvidenceKey -Quote $Cut) -replace ' ', '') -cne $QuoteLetters.Substring($From, $To - $From)) { return $null }
    $Cut
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

function Test-VerbatimHeadPartial {
    # Does a piece that starts at $At start inside a source word? A letter before it means yes. A digit before
    # a letter does not: "125Large-scale" is a glued footnote reference and then the word.
    param([string]$Text, [int]$At)
    if ($At -le 0 -or $At -ge $Text.Length) { return $false }
    $Before = $Text[$At - 1]
    if ([char]::IsLetter($Before)) { return $true }
    [char]::IsDigit($Before) -and [char]::IsDigit($Text[$At])
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
    $PieceNo = 0
    $HeadGain = 0   # quote letters found by looking back over a reference; they count as matched
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
        # Where the piece begins and ends in the quote's letters (for the edge rule, t/389#47 (3)).
        $QS = $P.QFirst + $Ds; $QE = $P.QLast + 1 - $De
        if ($Letters -le 0) { continue }
        $FirstPos = $P.First + $Ds
        # The quote's first words can sit just before the piece with only a reference between them
        # ("Causation 344 poses a significant challenge"): too short to be placed as a piece of their own,
        # and the walk only goes forward. Look back over one reference of up to three digits; the words
        # must stand there exactly, starting a source word. The reference itself comes out later.
        if ($script:VerbatimHeadAcrossRef -and $PieceNo -eq 0 -and $QS -gt 0 -and $QS -le 60) {
            $HeadLetters = $Q.Substring(0, $QS)
            for ($Kd = 1; $Kd -le 3; $Kd++) {
                $RefAt = $FirstPos - $Kd
                if ($RefAt - $HeadLetters.Length -lt 0 -or -not [char]::IsDigit($Hay[$RefAt])) { break }
                if ($Hay.Substring($RefAt - $HeadLetters.Length, $HeadLetters.Length) -ceq $HeadLetters -and
                    [Array]::BinarySearch($Source.WordAt, $RefAt - $HeadLetters.Length) -ge 0) {
                    $FirstPos = $RefAt - $HeadLetters.Length; $Letters += $QS; $HeadGain = $QS; $QS = 0
                    break
                }
            }
        }
        $PieceNo++
        $PS = Get-VerbatimTextOffset -Source $Source -Position $FirstPos
        $PE = (Get-VerbatimTextOffset -Source $Source -Position ($P.Last - $De)) + 1
        # Finish the source's own word when only a letter or two of it is left.
        $More = 0
        # Read from the repaired copy: in the raw text a mojibake no-break space is a letter. And a word that
        # ends in a letter does not go on into digits: "SMEs3" is the word and a glued footnote reference.
        $EdgeText = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Text.Length) { $Source.Work } else { $Text }
        $EndsInLetter = $PE -gt 0 -and [char]::IsLetter($EdgeText[$PE - 1])
        while ($PE + $More -lt $EdgeText.Length -and $(if ($EndsInLetter) { [char]::IsLetter($EdgeText[$PE + $More]) } else { [char]::IsLetterOrDigit($EdgeText[$PE + $More]) })) { $More++ }
        # TailAdded: source letters past the quote's last matched letter that the piece took (the source says
        # "models", the quote "model"). MidWordEnd: the source's word goes on further than that.
        $TailAdded = 0
        if ($More -le $script:VerbatimWordTail) { $PE += $More; $TailAdded = $More }
        $MidWordEnd = $More -gt $script:VerbatimWordTail
        # The second half of a word the piece before lost to a hyphenated break ("cod-" ... "ing") goes too.
        if ($CarryHyphen) {
            $W0 = $PS
            while ($W0 -lt $PE -and [char]::IsLetterOrDigit($Text[$W0])) { $W0++ }
            $Letters -= ($W0 - $PS)
            $QS += ($W0 - $PS)
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
            $QE -= ($PE - $W1); $TailAdded = 0; $MidWordEnd = $false
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
                $LineText = $Text.Substring($Line.Start, $Line.End - $Line.Start).Trim()
                # A list numeral ("1.") on its own line is a word of the text that follows it, not a chart value.
                if ($LineText -match $script:VerbatimFigureLinePattern -and $LineText -notmatch $script:VerbatimListMarkerPattern -and $FigureSeen.Add($Line.Start)) {
                    $FigureLines.Add([pscustomobject]@{ Start = $Line.Start; End = $Line.End; PieceStart = $PS; PieceEnd = $PE })
                }
            }
        }
        if ($Skips.Count -eq 0) {
            $Pieces.Add([pscustomobject]@{ Start = $PS; End = $PE; QuoteLetters = $Letters; QStart = $QS; QEnd = $QE
                    TailAdded = $TailAdded; MidWordEnd = $MidWordEnd; HeadPartial = (Test-VerbatimHeadPartial -Text $EdgeText -At $PS) })
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
            if ($PartLetters -gt 0) {
                # Only the first part begins where the piece did and only the last ends where it did.
                $IsFirst = $Part.Start -eq $PS; $IsLast = $Part.End -eq $PE
                $Pieces.Add([pscustomobject]@{ Start = $Part.Start; End = $Part.End; QuoteLetters = [Math]::Min($PartLetters, $Letters)
                        QStart = $(if ($IsFirst) { $QS } else { -1 }); QEnd = $(if ($IsLast) { $QE } else { -1 })
                        TailAdded = $(if ($IsLast) { $TailAdded } else { 0 }); MidWordEnd = ($IsLast -and $MidWordEnd)
                        HeadPartial = ($IsFirst -and (Test-VerbatimHeadPartial -Text $EdgeText -At $PS)) })
            }
        }
    }
    if ($Pieces.Count -eq 0) { return $null }
    # One passage only when nothing else sits inside it (CL ruling t/389#15): one piece, about as long as
    # the quote, with no run of other source text and no header line inside it.
    $Contiguous = ($Pieces.Count -eq 1) -and ($Best.Span -le $Tight) -and ($Best.MaxGap -le $script:VerbatimMaxInnerGap)
    [pscustomobject]@{
        Start        = $Pieces[0].Start
        End          = $Pieces[$Pieces.Count - 1].End
        Coverage     = [Math]::Min($N, $Best.Matched + $HeadGain) / $N
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
    # A quote mark the model copied from a damaged snapshot and that was damaged once more on the way: the
    # snapshot's "o-diaeresis" for a closing quote arrives as "A-tilde, pilcrow" (t/389#50, i406). They are
    # quote marks, not letters of a word.
    foreach ($P in $script:VerbatimQuoteMojibake) { $Q = $Q.Replace($P[0], $P[1]) }
    if ($script:VerbatimFoldMoreMojibake) {
        # The quote is folded like the source (CL t/389#61 (3)): the further forms of the same marks, the
        # ligatures, and the no-break space that reads as a-acute.
        foreach ($P in $script:VerbatimQuoteMojibakeMore) { $Q = $Q.Replace($P[0], $P[1]) }
        foreach ($P in $script:VerbatimLigatureMojibake) { $Q = $Q.Replace($P[0], $P[1]) }
        $Q = [regex]::Replace($Q, '(?<!\p{Ll})á(?!\p{Ll})', ' ')
        $Q = [regex]::Replace($Q, 'á(?=[^\p{L}\p{Nd}\s])', ' ')
    }
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

function Find-VerbatimTailAfterFootnote {
    # The quote's last words, when the source prints them after a footnote that the page layout put in the
    # middle of the sentence (CL t/389#52 (1), stipulated). $Tail is the quote's letters after the snapped
    # piece; $After is where the piece ends in the source text. Found when
    #   - the piece does not end a sentence (the quote resumes mid-sentence after the footnote),
    #   - what follows starts, at the start of a line, with a footnote number,
    #   - and within VerbatimFootnoteMaxGap letters the source has $Tail as whole words.
    # Returns the text offset where the tail ends, or -1.
    param([object]$Source, [string]$Tail, [int]$After)
    if ($Tail.Length -eq 0 -or $After -le 0 -or $After -ge $Source.Text.Length) { return -1 }
    $Text = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Source.Text.Length) { $Source.Work } else { $Source.Text }
    if ($Text[$After - 1] -match '[.!?]') { return -1 }
    $Rest = $Text.Substring($After, [Math]::Min($Text.Length - $After, 40))
    if ($Rest -notmatch '^[ \t]*\r?\n\s*\p{Nd}{1,4}(?:[.)\s]|$)') { return -1 }
    $W = [Array]::BinarySearch($Source.WordOffset, $After)
    if ($W -lt 0) { $W = -bnot $W }
    if ($W -ge $Source.WordAt.Count) { return -1 }
    $From = $Source.WordAt[$W]
    $Limit = [Math]::Min($Source.Chars.Length, $From + $script:VerbatimFootnoteMaxGap + $Tail.Length)
    $P = $From
    while ($P -lt $Limit) {
        $P = $Source.Chars.IndexOf($Tail, $P, $Limit - $P, [System.StringComparison]::Ordinal)
        if ($P -lt 0) { return -1 }
        $StartsWord = [Array]::BinarySearch($Source.WordAt, $P) -ge 0
        $EndsWord = ($P + $Tail.Length -ge $Source.Chars.Length) -or ([Array]::BinarySearch($Source.WordAt, $P + $Tail.Length) -ge 0)
        if ($StartsWord -and $EndsWord -and $P -gt $From) { return (Get-VerbatimTextOffset -Source $Source -Position ($P + $Tail.Length - 1)) + 1 }
        $P++
    }
    -1
}

function Resolve-VerbatimSegment {
    # Decides one elision-free segment. Returns { Decision; Texts; Coverage; Start; End }: Decision is 'exact',
    # 'snapped', 'interleaved' or 'dropped', Texts is what to store, in order (empty when dropped), and
    # Start/End are the segment's place in the source text when it was located ($null when it was not).
    # An interleaved segment is stored as its matched source pieces, each the source's own text: kept as
    # the model wrote it, it would read as one continuous passage, which it isn't (CL ruling p/70#77).
    # $QuoteStart: the segment begins the quote (its first letter may differ in case, CL t/389#70).
    param([object]$Source, [string]$Segment, [bool]$QuoteStart = $true)
    # The case rule for a segment kept as written. True when it fails; what was permitted is counted.
    $CaseFails = {
        param($Text)
        if (-not $script:VerbatimCaseRule) { return $false }
        $V = Get-VerbatimExactCaseVerdict -Source $Source -Quote $Text -FirstAllowed $QuoteStart -DeclaredFrom $Segment
        if ($V.Unchecked) { $script:VerbatimDiag.Add('case not checked: the quote was not placed letter for letter'); return $false }
        if ($V.Fail) {
            $script:VerbatimDiag.Add("case word: $($V.At)")
            if ($V.AtStart) { $script:VerbatimDiag.Add('case differs at the start of a later segment or piece') }
            $script:VerbatimDiag.Add('case differs (as written)'); return $true
        }
        if ($V.First) { $script:VerbatimDiag.Add('case: first letter of the quote, permitted') }
        if ($V.Caps) { $script:VerbatimDiag.Add('case: capitals in the source, lower case in the quote, permitted') }
        if ($V.Title) { $script:VerbatimDiag.Add('case: capitals in the source, other capitalisation in the quote, permitted') }
        if ($V.Bracket) { $script:VerbatimDiag.Add('case: letter the model put in brackets, permitted') }
        $false
    }
    # The same for a segment stored as written across marker lines or a footnote: the passage holds other text.
    $LooseCaseFails = {
        param($From, $To)
        if (-not $script:VerbatimCaseRule) { return $false }
        $Txt = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Source.Text.Length) { $Source.Work } else { $Source.Text }
        $V = Get-VerbatimLooseCaseVerdict -SourceText $Txt.Substring($From, $To - $From) -QuoteText $Segment -FirstAllowed $QuoteStart
        if ($V.Unchecked) { $script:VerbatimDiag.Add('case not checked: the quote was not placed letter for letter'); return $false }
        if ($V.Fail) {
            $script:VerbatimDiag.Add("case word: $($V.At)")
            if ($V.AtStart) { $script:VerbatimDiag.Add('case differs at the start of a later segment or piece') }
            $script:VerbatimDiag.Add('case differs (as written)'); return $true
        }
        if ($V.First) { $script:VerbatimDiag.Add('case: first letter of the quote, permitted') }
        if ($V.Caps) { $script:VerbatimDiag.Add('case: capitals in the source, lower case in the quote, permitted') }
        if ($V.Title) { $script:VerbatimDiag.Add('case: capitals in the source, other capitalisation in the quote, permitted') }
        if ($V.Bracket) { $script:VerbatimDiag.Add('case: letter the model put in brackets, permitted') }
        $false
    }
    $CaseDrop = {
        $D = [pscustomobject]@{ Decision = 'dropped'; Texts = @(); Coverage = 1.0; Start = $null; End = $null }
        Add-Member -InputObject $D -NotePropertyName Rejected -NotePropertyValue $true
        $D
    }
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
        if (& $CaseFails $Segment) { return (& $CaseDrop) }
        if ($script:VerbatimRejectListJoin -and (Test-VerbatimListJoin -Source $Source -Quote $Segment)) {
            $script:VerbatimDiag.Add('list join (as written)'); return (& $CaseDrop)
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
        if (& $CaseFails $Clean) { return (& $CaseDrop) }
        if ($script:VerbatimRejectListJoin -and (Test-VerbatimListJoin -Source $Source -Quote $Clean)) {
            $script:VerbatimDiag.Add('list join (as written)'); return (& $CaseDrop)
        }
        return (& $Result 'snapped' @($Clean) 1.0 $Snap)
    }
    # The quote exactly as the model wrote it, URL and all, with only marker lines between its lines (F01: a
    # citation with its URL, a page number in the middle). The noise-free copy below would not match a
    # source that does have the URL, so the model's own text is tried first.
    if ($Clean -cne $Segment) {
        $Whole = Find-VerbatimSnap -Source $Source -Quote $Segment
        if ($Whole -and $Whole.Contiguous -and $Whole.Coverage -ge 1.0) {
            $WholeFigure = Get-VerbatimFigureVerdict -Source $Source -Snap $Whole -Quote $Segment
            if ($WholeFigure.Verdict -ne 'drop' -and $WholeFigure.Markers -gt 0) {
                $WholeLetters = ((ConvertTo-EvidenceKey -Quote $Source.Text.Substring($Whole.Start, $Whole.End - $Whole.Start)) -replace ' ', '').Length
                if ($WholeLetters - $WholeFigure.MarkerLetters -eq $Whole.QuoteLetters) {
                    if (& $LooseCaseFails $Whole.Start $Whole.End) { return (& $CaseDrop) }
                    return (& $Result 'snapped' @($Segment) 1.0 $Whole)
                }
            }
        }
    }
    $Snap = Find-VerbatimSnap -Source $Source -Quote $Clean
    $Coverage = if ($Snap) { $Snap.Coverage } else { 0.0 }
    # The quote's last words printed after a footnote in mid-sentence (t/389#52 (1)): one piece from the
    # quote's first letter that stops short, and the rest right after the footnote. The whole quote is then
    # in the source in order with only footnote text skipped, and is stored as the model wrote it.
    if ($Snap -and $Snap.Contiguous -and $Clean -ceq $Segment -and @($Snap.Pieces).Count -eq 1) {
        $Only = $Snap.Pieces[0]
        if ($Only.QStart -eq 0 -and -not $Only.HeadPartial -and $Only.QEnd -lt $Snap.QuoteLetters -and $Only.QEnd -ge $script:VerbatimMinRun) {
            $QLetters = (ConvertTo-EvidenceKey -Quote $Clean) -replace ' ', ''
            $TailEnd = Find-VerbatimTailAfterFootnote -Source $Source -Tail $QLetters.Substring($Only.QEnd) -After $Only.End
            if ($TailEnd -gt 0) {
                if (& $LooseCaseFails $Snap.Start $TailEnd) { return (& $CaseDrop) }
                $R = & $Result 'snapped' @($Segment) 1.0 $Snap
                $R.End = $TailEnd
                return $R
            }
        }
    }
    if ($Snap -and $Coverage -ge $script:VerbatimSnapThreshold) {
        $Figure = Get-VerbatimFigureVerdict -Source $Source -Snap $Snap -Quote $Clean
        if ($Figure.Verdict -eq 'drop') { return (& $Result 'dropped' @() $Coverage $null) }
        # A page or footnote number between two lines of the quote (t/389#40 ruling 2): when every letter of
        # the quote is in the source in one stretch and the only other text in that stretch is such marker
        # lines, the model's quote is stored exactly as written, as one piece. Nothing is split at a marker.
        if ($Figure.Markers -gt 0 -and $Snap.Contiguous -and $Clean -ceq $Segment -and $Coverage -ge 1.0) {
            $SpanLetters = ((ConvertTo-EvidenceKey -Quote $Source.Text.Substring($Snap.Start, $Snap.End - $Snap.Start)) -replace ' ', '').Length
            if ($SpanLetters - $Figure.MarkerLetters -eq $Snap.QuoteLetters) {
                if (& $LooseCaseFails $Snap.Start $Snap.End) { return (& $CaseDrop) }
                return (& $Result 'snapped' @($Segment) 1.0 $Snap)
            }
        }
        $Texts = [System.Collections.Generic.List[string]]::new()
        $ModelTextDiffers = $false
        $StoredPieces = [System.Collections.Generic.List[object]]::new()
        $StoredLetters = 0
        # A stored piece is the source's text, and it must be the model's words in order, letter for letter
        # once mojibake, ligatures, hyphen breaks, case and punctuation are folded (CL t/389#52 (4), #54 (2),
        # #56). The only omissions allowed are the ones the model marked with an elision. So a snap now mends
        # layout only: line breaks, hyphenation, marks, page furniture. What fails:
        #   - a word the model left out with no mark ("Meta CEO Mark Zuckerberg" for "Mark Zuckerberg");
        #   - a word that differs: damaged in the source ("resuts") or changed by the model. Storing the
        #     source's text would store the misspelling; storing the model's would store text the source
        #     lacks. (This ends the t/389#5 behaviour of snapping across a corrupted word.)
        # Footnote references glued to a word or its punctuation ("curve5,21.", "harms.12 Developers") are
        # not words: they come out of the stored piece where the quote does not have them.
        # VerbatimRejectPieceDeletion: 'all' (every stored class), 'interleaved', or 'none'.
        $CleanedPiece = @{}
        $UsePieces = @($Snap.Pieces)
        $IsContiguous = [bool]$Snap.Contiguous
        $Mode = [string]$script:VerbatimRejectPieceDeletion
        $CheckPieces = $Mode -eq 'all' -or ($Mode -eq 'interleaved' -and -not $Snap.Contiguous)
        if ($CheckPieces) {
            $KeyText = if ($Source.PSObject.Properties['Work'] -and $Source.Work.Length -eq $Source.Text.Length) { $Source.Work } else { $Source.Text }
            $Letters = { param($T) (ConvertTo-EvidenceKey -Quote $T) -replace ' ', '' }
            $QLetters = & $Letters $Clean
            $RefPattern = if ($script:VerbatimRefAnywhere) { $script:VerbatimRefAnywherePattern } else { $script:VerbatimGluedRefPattern }
            $Queue = [System.Collections.Generic.List[object]]::new()
            foreach ($P in $Snap.Pieces) { $Queue.Add($P) }
            $Checked = [System.Collections.Generic.List[object]]::new()
            $QGap = $null
            $Guard = 0
            while ($Queue.Count -gt 0) {
                $P = $Queue[0]; $Queue.RemoveAt(0)
                if ($P.QuoteLetters -lt $script:VerbatimMinRun -or ($Guard++) -gt 64) { $Checked.Add($P); continue }
                # A part of a piece cut at a page header has no place of its own in the quote; it is judged by
                # the count alone, below.
                $Want = if ($P.QStart -ge 0 -and $P.QEnd -gt $P.QStart -and $P.QEnd -le $QLetters.Length) { $QLetters.Substring($P.QStart, $P.QEnd - $P.QStart) } else { $null }
                $PieceWork = $KeyText.Substring($P.Start, $P.End - $P.Start)
                # Walk the piece: its text between references, and each reference. A reference stays when the
                # quote has those digits at that place (the model wrote them), and comes out when it does not.
                $Have = [System.Text.StringBuilder]::new()
                $Remove = [System.Collections.Generic.List[object]]::new()   # references: out of the stored piece
                $Ignore = [System.Collections.Generic.List[object]]::new()   # no-break spaces: not compared, but stored
                # The a-acute that is the converter's no-break space, between two letters (CL t/389#63 (1)):
                # it matches as a space when the quote has no such letter at that place. A real a-acute the
                # model wrote is in the quote and stays. The stored text keeps the source's character.
                # The piece's letters aligned to the quote's (CL t/389#74): which source letters the quote has, and
                # which are extra. Without it a digit the model wrote ("900 billion", "August 7") after an extra
                # line looked like a reference, and the piece failed instead of splitting at the line.
                $MatchJ = $null
                $LetterIx = [int[]]::new($PieceWork.Length)
                if ($null -ne $Want -and $script:VerbatimAlignExtras) {
                    $LineStart = [System.Collections.Generic.List[bool]]::new()
                    $FirstOnLine = $true; $Count = 0
                    for ($K = 0; $K -lt $PieceWork.Length; $K++) {
                        $LetterIx[$K] = -1
                        if ($PieceWork[$K] -eq [char]10) { $FirstOnLine = $true; continue }
                        if ([char]::IsLetterOrDigit($PieceWork[$K])) { $LetterIx[$K] = $Count; $Count++; $LineStart.Add($FirstOnLine); $FirstOnLine = $false }
                    }
                    $Got0 = & $Letters $PieceWork
                    # One character, one letter: else the places cannot be mapped back and the older test is used.
                    if ($Got0.Length -eq $Count) { $MatchJ = Get-VerbatimLetterMatch -Have $Got0 -Want $Want -LineStart $LineStart.ToArray() }
                }
                $Marks = [System.Collections.Generic.List[object]]::new()
                if ($script:VerbatimParenRefList) {
                    foreach ($M in [regex]::Matches($PieceWork, $script:VerbatimParenRefListPattern)) { $Marks.Add(@{ M = $M; Ref = $true; Edge = $false }) }
                }
                foreach ($M in [regex]::Matches($PieceWork, $RefPattern)) { $Marks.Add(@{ M = $M; Ref = $true; Edge = $false }) }
                # A footnote symbol the snapshot has as a letter, glued to the end of a word (an author's
                # affiliation mark): a reference like the digits, out where the quote does not have it.
                if ($script:VerbatimSymbolRef) {
                    foreach ($M in [regex]::Matches($PieceWork, $script:VerbatimSymbolRefPattern)) { $Marks.Add(@{ M = $M; Ref = $true; Edge = $false; Sym = $true }) }
                }
                if ($script:VerbatimNbspBetweenLetters) {
                    foreach ($M in [regex]::Matches($PieceWork, '(?<=\p{L})á(?=\p{L})')) { $Marks.Add(@{ M = $M; Ref = $false; Edge = $false }) }
                }
                # The same character at a word's start or end (CL t/389#67 (1)): after a space or a line
                # break, or at a line end. The quote has a space there. Not at the quote's own start or end,
                # where it has none: there the character still fails the quote.
                if ($script:VerbatimNbspWordEdge) {
                    foreach ($M in [regex]::Matches($PieceWork, '(?<!\p{L})á(?=\p{L})|(?<=\p{L})á(?!\p{L})')) { $Marks.Add(@{ M = $M; Ref = $false; Edge = $true }) }
                }
                $At = 0
                foreach ($Mark in ($Marks | Sort-Object { $_.M.Index }, { -$_.M.Length })) {
                    $M = $Mark.M
                    if ($M.Index -lt $At) { continue }
                    [void]$Have.Append((& $Letters $PieceWork.Substring($At, $M.Index - $At)))
                    $Token = if ($Mark.Ref -and -not $Mark['Sym']) { [regex]::Replace($M.Value, '[^\p{Nd}]', '') } else { & $Letters $M.Value }
                    if ($null -ne $MatchJ) {
                        # The model wrote the mark when the alignment found every letter of it in the quote.
                        $InQuote = $true; $HasLetter = $false
                        for ($K = $M.Index; $K -lt $M.Index + $M.Length; $K++) {
                            if ($LetterIx[$K] -ge 0) { $HasLetter = $true; if ($MatchJ[$LetterIx[$K]] -lt 0) { $InQuote = $false } }
                        }
                        $Wrote = $HasLetter -and $InQuote
                    } else {
                        $Wrote = $null -ne $Want -and $Have.Length + $Token.Length -le $Want.Length -and $Want.Substring($Have.Length, $Token.Length) -ceq $Token
                    }
                    $AtQuoteEdge = $Mark.Edge -and $null -ne $Want -and (($Have.Length -eq 0 -and $P.QStart -eq 0) -or
                        ($Have.Length -ge $Want.Length -and $P.QEnd -eq $QLetters.Length))
                    if ($Wrote -or $null -eq $Want -or $AtQuoteEdge) { [void]$Have.Append($Token) } elseif ($Mark.Ref) { $Remove.Add($M) } else { $Ignore.Add($M) }
                    $At = $M.Index + $M.Length
                }
                [void]$Have.Append((& $Letters $PieceWork.Substring($At)))
                $Got = $Have.ToString()
                $Why = $null
                if ($null -eq $Want) {
                    if ($Got.Length -gt $P.QuoteLetters) { $Why = 'left-out word' }
                } elseif ($Got -cne $Want) {
                    # More letters in the source: it has text the quote does not. The same number or fewer: a
                    # word differs, damaged in the source or changed by the model.
                    $Why = if ($Got.Length -gt $Want.Length) { 'left-out word' } else { 'word differs' }
                }
                if ($Why -eq 'left-out word' -and $null -ne $MatchJ -and $script:VerbatimSplitAtExtraLine) {
                    # Extra text on lines of its own splits the piece (t/389#61 (2)), here for any number of such
                    # stretches (a 'Demo' label, then a running header). A sidebar word glued to the end of a
                    # line, a capital straight after a lower-case letter of the quote's word ("couldLaw"), splits
                    # it too (CL t/389#74). Any other extra text fails the piece as before.
                    $Skip = [bool[]]::new($PieceWork.Length)
                    foreach ($M in @($Remove) + @($Ignore)) { for ($K = $M.Index; $K -lt $M.Index + $M.Length; $K++) { $Skip[$K] = $true } }
                    $IsQuote = { param($K) $LetterIx[$K] -ge 0 -and -not $Skip[$K] -and $MatchJ[$LetterIx[$K]] -ge 0 }
                    $IsExtra = { param($K) $LetterIx[$K] -ge 0 -and -not $Skip[$K] -and $MatchJ[$LetterIx[$K]] -lt 0 }
                    $Cuts = [System.Collections.Generic.List[object]]::new()
                    $CanSplit = $true
                    $K = 0
                    while ($K -lt $PieceWork.Length) {
                        if (-not (& $IsExtra $K)) { $K++; continue }
                        $C0 = $K; $C1 = $K; $K2 = $K + 1
                        while ($K2 -lt $PieceWork.Length -and -not (& $IsQuote $K2)) { if (& $IsExtra $K2) { $C1 = $K2 }; $K2++ }
                        $LineStart0 = $PieceWork.LastIndexOf([char]10, $C0) + 1
                        $LineEnd = $PieceWork.IndexOf([char]10, $C1); if ($LineEnd -lt 0) { $LineEnd = $PieceWork.Length }
                        $Before = 0; for ($X = $LineStart0; $X -lt $C0; $X++) { if (& $IsQuote $X) { $Before++ } }
                        $After = 0; for ($X = $C1 + 1; $X -lt $LineEnd; $X++) { if (& $IsQuote $X) { $After++ } }
                        if ($LineStart0 -gt 0 -and $LineEnd -lt $PieceWork.Length -and $Before -eq 0 -and $After -eq 0) {
                            $Cuts.Add(@{ From = $LineStart0; To = $LineEnd; Kind = 'split at extra line' })
                        } elseif ($script:VerbatimSplitAtGluedSidebar -and $After -eq 0 -and $LineEnd -lt $PieceWork.Length -and $C0 -gt 0 -and
                            [char]::IsLower($PieceWork[$C0 - 1]) -and [char]::IsUpper($PieceWork[$C0]) -and (& $IsQuote ($C0 - 1)) -and
                            $PieceWork.IndexOf([char]10, $C0, $C1 - $C0 + 1) -lt 0) {
                            $Cuts.Add(@{ From = $C0; To = $LineEnd; Kind = 'split at a sidebar word glued to the line end' })
                        } else { $CanSplit = $false; break }
                        $K = $K2
                    }
                    if ($CanSplit -and $Cuts.Count -gt 0) {
                        $Parts = [System.Collections.Generic.List[object]]::new()
                        $From = 0
                        foreach ($Cut in @($Cuts) + @(@{ From = $PieceWork.Length; To = $PieceWork.Length; Kind = '' })) {
                            $First = -1; $Last = -1; $N = 0
                            for ($X = $From; $X -lt $Cut.From; $X++) {
                                if (& $IsQuote $X) { if ($First -lt 0) { $First = $X }; $Last = $X; $N++ }
                            }
                            if ($N -gt 0) {
                                $S0 = $From; while ($S0 -lt $Cut.From -and [char]::IsWhiteSpace($PieceWork[$S0])) { $S0++ }
                                $E0 = $Cut.From; while ($E0 -gt $S0 -and [char]::IsWhiteSpace($PieceWork[$E0 - 1])) { $E0-- }
                                $Parts.Add([pscustomobject]@{ Start = $P.Start + $S0; End = $P.Start + $E0; QuoteLetters = $N
                                        QStart = $P.QStart + $MatchJ[$LetterIx[$First]]; QEnd = $P.QStart + $MatchJ[$LetterIx[$Last]] + 1
                                        TailAdded = 0; MidWordEnd = $false; HeadPartial = $false })
                            }
                            $From = $Cut.To
                        }
                        # Only when the model's words go on after the last extra stretch.
                        $LastQuoteAt = -1; for ($X = $PieceWork.Length - 1; $X -ge 0; $X--) { if (& $IsQuote $X) { $LastQuoteAt = $X; break } }
                        if ($Parts.Count -ge 2 -and $LastQuoteAt -ge $Cuts[$Cuts.Count - 1].To) {
                            $Parts[0].HeadPartial = $P.HeadPartial
                            $Parts[$Parts.Count - 1].TailAdded = $P.TailAdded; $Parts[$Parts.Count - 1].MidWordEnd = $P.MidWordEnd
                            for ($X = $Parts.Count - 1; $X -ge 0; $X--) { $Queue.Insert(0, $Parts[$X]) }
                            $IsContiguous = $false
                            foreach ($Kind in @($Cuts | ForEach-Object { $_.Kind } | Select-Object -Unique)) { $script:VerbatimDiag.Add($Kind) }
                            continue
                        }
                    }
                }
                elseif ($Why -eq 'left-out word' -and $null -ne $Want -and $script:VerbatimSplitAtExtraLine) {
                    # (2) Extra text that stands on lines of its own (a running header, a sidebar, table or chart
                    # cells) is not part of the passage and is not a word the model left out. The piece is
                    # split around those lines and the quote becomes interleaved. Only when the model's words
                    # go on after it, and when everything else in the piece is the quote's, letter for letter.
                    $I = 0; while ($I -lt $Want.Length -and $Got[$I] -ceq $Want[$I]) { $I++ }
                    $J = 0; while ($J -lt $Want.Length - $I -and $Got[$Got.Length - 1 - $J] -ceq $Want[$Want.Length - 1 - $J]) { $J++ }
                    if ($I + $J -eq $Want.Length -and $I -ge $script:VerbatimMinRun -and $J -ge 1) {
                        # Where the extra letters are in the piece's text: count letters, skipping the references taken out.
                        $Skip = [bool[]]::new($PieceWork.Length)
                        foreach ($M in @($Remove) + @($Ignore)) { for ($K = $M.Index; $K -lt $M.Index + $M.Length; $K++) { $Skip[$K] = $true } }
                        $Seen = 0; $ExtraFrom = -1; $ExtraTo = -1; $Total = 0
                        for ($K = 0; $K -lt $PieceWork.Length; $K++) {
                            if ($Skip[$K] -or -not [char]::IsLetterOrDigit($PieceWork[$K])) { continue }
                            if ($Seen -eq $I -and $ExtraFrom -lt 0) { $ExtraFrom = $K }
                            if ($Seen -eq $Got.Length - $J - 1) { $ExtraTo = $K + 1 }
                            $Seen++; $Total++
                        }
                        if ($Total -eq $Got.Length -and $ExtraFrom -ge 0 -and $ExtraTo -gt $ExtraFrom) {
                            $LineStart = $PieceWork.LastIndexOf([char]10, $ExtraFrom) + 1
                            $LineEnd = $PieceWork.IndexOf([char]10, $ExtraTo); if ($LineEnd -lt 0) { $LineEnd = $PieceWork.Length }
                            $OnLines = 0
                            for ($K = $LineStart; $K -lt $LineEnd; $K++) { if (-not $Skip[$K] -and [char]::IsLetterOrDigit($PieceWork[$K])) { $OnLines++ } }
                            if ($LineStart -gt 0 -and $LineEnd -lt $PieceWork.Length -and $OnLines -eq $Got.Length - $Want.Length) {
                                $Left = [pscustomobject]@{ Start = $P.Start; End = $P.Start + $PieceWork.Substring(0, $LineStart).TrimEnd().Length
                                    QuoteLetters = $I; QStart = $P.QStart; QEnd = $P.QStart + $I; TailAdded = 0; MidWordEnd = $false; HeadPartial = $P.HeadPartial }
                                $RightStart = $LineEnd; while ($RightStart -lt $PieceWork.Length -and [char]::IsWhiteSpace($PieceWork[$RightStart])) { $RightStart++ }
                                $Right = [pscustomobject]@{ Start = $P.Start + $RightStart; End = $P.End
                                    QuoteLetters = $J; QStart = $P.QStart + $I; QEnd = $P.QEnd; TailAdded = $P.TailAdded; MidWordEnd = $P.MidWordEnd; HeadPartial = $false }
                                $Queue.Insert(0, $Right); $Queue.Insert(0, $Left)
                                $IsContiguous = $false
                                $script:VerbatimDiag.Add('split at extra line')
                                continue
                            }
                        }
                    }
                }
                if ($Why -eq 'word differs' -and -not $script:VerbatimRejectDamagedWord) { $Why = $null; $Remove.Clear() }
                if ($Why -eq 'word differs') {
                    # Is every difference a ligature the source lost ("e?ective", "speci c", "sta " for staff)?
                    # It fails all the same (CL t/389#63 (2): no folding), and is named apart: these are the
                    # drops a repair of the converter would recover.
                    $WI = 0; $GI = 0; $Lost = 0; $OnlyLigatures = $true
                    while ($WI -lt $Want.Length) {
                        if ($GI -lt $Got.Length -and $Want[$WI] -ceq $Got[$GI]) { $WI++; $GI++; continue }
                        $Lig = $null
                        foreach ($Cand in 'ffi', 'ffl', 'ff', 'fi', 'fl') { if ($WI + $Cand.Length -le $Want.Length -and $Want.Substring($WI, $Cand.Length) -ceq $Cand) { $Lig = $Cand; break } }
                        if ($null -eq $Lig) { $OnlyLigatures = $false; break }
                        $WI += $Lig.Length; $Lost++
                    }
                    if ($OnlyLigatures -and $GI -eq $Got.Length -and $Lost -gt 0) { $Why = 'word differs: lost ligature' }
                }
                # The letters agree. Now the spaces (CL t/389#64 (2)): white-space runs count as one space, and
                # a space is never deleted. A source space inside a word of the quote ("arti ficial" for
                # "artificial") fails. Source words printed with no space between them, where the quote has
                # one, are counted, and fail only when the switch says 'both'.
                $Glued = 0
                $CaseSeen = $null
                if (-not $Why -and $null -ne $Want -and ($script:VerbatimNoSpaceDeletion -ne 'none' -or $script:VerbatimCaseRule)) {
                    $Shown = [System.Text.StringBuilder]::new($PieceWork)
                    # A space the working copy has only as padding (a repaired mojibake mark or ligature, a blanked
                    # tag) is not a space of the source: "EU" + a damaged apostrophe + "s" is one word.
                    if ($KeyText.Length -eq $Source.Text.Length) {
                        for ($K = 0; $K -lt $PieceWork.Length; $K++) {
                            if ([char]::IsWhiteSpace($PieceWork[$K]) -and -not [char]::IsWhiteSpace($Source.Text[$P.Start + $K])) { $Shown[$K] = [char]0x200B }
                        }
                    }
                    foreach ($M in (@($Remove) + @($Ignore) | Sort-Object Index -Descending)) {
                        [void]$Shown.Remove($M.Index, $M.Length)
                        if ($Ignore.Contains($M)) { [void]$Shown.Insert($M.Index, ' ') }
                    }
                    $SGap = Get-VerbatimWordGap -Text $Shown.ToString()
                    if ($null -eq $QGap) { $QGap = Get-VerbatimWordGap -Text $Clean }
                    if ($SGap.Letters -cne $Want -or $QGap.Letters -cne $QLetters) {
                        $script:VerbatimDiag.Add('space check not run: letters differ between the two readings')
                    } else {
                        if ($script:VerbatimCaseRule) {
                            $WordStart = [bool[]]$SGap.Any.Clone(); $WordStart[0] = $true
                            $CaseSeen = Get-VerbatimCaseVerdict -SourceCased $SGap.Cased -WordStart $WordStart `
                                -QuoteCased $QGap.Cased.Substring($P.QStart, $Want.Length) -FirstAllowed ($QuoteStart -and $P.QStart -eq 0) `
                                -Declared (@(Get-VerbatimDeclaredCase -Text $Segment | ForEach-Object { $_ - $P.QStart }) + @(Get-VerbatimDeclaredCase -Text $Shown.ToString()))
                        }
                        $Split = 0
                        for ($K = 1; $K -lt $Want.Length; $K++) {
                            if ($script:VerbatimNoSpaceDeletion -eq 'none') { break }
                            if ($SGap.Space[$K] -and -not $QGap.Any[$P.QStart + $K]) {
                                if ($Split -eq 0) {
                                    # For audits: the quote's word that the source has in two.
                                    $W0 = $K; while ($W0 -gt 0 -and -not $QGap.Any[$P.QStart + $W0]) { $W0-- }
                                    $W1 = $K; while ($W1 -lt $Want.Length -and -not $QGap.Any[$P.QStart + $W1]) { $W1++ }
                                    $script:VerbatimDiag.Add("split word: $($Want.Substring($W0, $K - $W0)) | $($Want.Substring($K, $W1 - $K))")
                                }
                                $Split++
                            }
                            elseif ($QGap.Space[$P.QStart + $K] -and -not $SGap.Any[$K]) { $Glued++ }
                        }
                        if ($Split -gt 0) { $Why = 'source splits a word' }
                        elseif ($Glued -gt 0 -and $script:VerbatimNoSpaceDeletion -eq 'both') { $Why = 'source glues words' }
                        if (-not $Why -and $null -ne $CaseSeen) {
                            if ($CaseSeen.Fail) {
                                $script:VerbatimDiag.Add("case word: $($CaseSeen.At)")
                                if ($CaseSeen.AtStart) { $script:VerbatimDiag.Add('case differs at the start of a later segment or piece') }
                                $Why = 'case differs'
                            }
                            elseif ($CaseSeen.Unchecked) { $script:VerbatimDiag.Add('case not checked: the quote was not placed letter for letter') }
                            else {
                                if ($CaseSeen.First) { $script:VerbatimDiag.Add('case: first letter of the quote, permitted') }
                                if ($CaseSeen.Caps) { $script:VerbatimDiag.Add('case: capitals in the source, lower case in the quote, permitted') }
                                if ($CaseSeen.Title) { $script:VerbatimDiag.Add('case: capitals in the source, other capitalisation in the quote, permitted') }
                                if ($CaseSeen.Bracket) { $script:VerbatimDiag.Add('case: letter the model put in brackets, permitted') }
                            }
                        }
                    }
                }
                if ($Glued -gt 0 -and -not $Why) { $script:VerbatimDiag.Add('source glues words, stored') }
                if ($Ignore.Count -gt 0 -and -not $Why) { $script:VerbatimDiag.Add('no-break space matched as a space') }
                if ($Why) {
                    $script:VerbatimDiag.Add("$Why ($(if ($Snap.Contiguous) { 'one piece' } else { 'interleaved' }))")
                    $Rejection = & $Result 'dropped' @() $Coverage $null
                    Add-Member -InputObject $Rejection -NotePropertyName Rejected -NotePropertyValue $true
                    return $Rejection
                }
                if ($Remove.Count -gt 0) {
                    $script:VerbatimDiag.Add('reference digits removed')
                    # The same character ranges come out of the source's own text (the two copies share offsets).
                    $Raw = [System.Text.StringBuilder]::new($Source.Text.Substring($P.Start, $P.End - $P.Start))
                    for ($K = $Remove.Count - 1; $K -ge 0; $K--) { [void]$Raw.Remove($Remove[$K].Index, $Remove[$K].Length) }
                    $CleanedPiece[$P.Start] = $Raw.ToString()
                }
                $Checked.Add($P)
            }
            $UsePieces = $Checked.ToArray()
        }
        foreach ($P in $UsePieces) {
            # A piece too short to have been placed by itself is not stored as a quote.
            if ($P.QuoteLetters -lt $script:VerbatimMinRun) { continue }
            $T = if ($CleanedPiece.ContainsKey($P.Start)) { $CleanedPiece[$P.Start].Trim() } else { $Source.Text.Substring($P.Start, $P.End - $P.Start).Trim() }
            # Markdown table cells are source text but not prose; a piece that runs across them is not
            # stored (CL, t/389#24).
            if ($T -match '\|\s[^|\r\n]*\|' -or $T -match '(?m)^\s*\|') { continue }
            # Where the match holds, what is stored is the model's own words for the piece (CL t/389#64 (3)).
            if ($script:VerbatimStoreModelWords -and $CheckPieces) {
                $Mine = Get-VerbatimQuoteCut -Quote $Clean -QuoteLetters $QLetters -From $P.QStart -To $P.QEnd
                if ($null -ne $Mine) {
                    if ($Mine -cne $T) { $ModelTextDiffers = $true }
                    $T = $Mine
                } else {
                    $script:VerbatimDiag.Add('model words not cut for a piece: source text stored')
                }
            }
            $Texts.Add($T)
            $StoredPieces.Add($P)
            $StoredLetters += $P.QuoteLetters
        }
        # What is stored must itself cover the quote (CL ruling t/389#20): pieces that add up to less read
        # as fragments of other text, not as the quote.
        # [double] on both: with an int 1 for full coverage, Min binds its int overload and rounds the share up.
        $Coverage = [Math]::Min([double]$Coverage, [double]$StoredLetters / [double]$Snap.QuoteLetters)
        if ($Texts.Count -gt 0 -and $Coverage -ge $script:VerbatimSnapThreshold -and $script:VerbatimRequireEndWords) {
            # The stored text is the source's. It must begin with the quote's first word and end with its last:
            # the first stored piece starts at the quote's first letter on the start of a source word, and the
            # last ends at the quote's last letter on the end of a source word. Otherwise the model changed,
            # added or cut a word at the edge ("Toward" for the source's "Towards"; "model" for "models"): the
            # quote is not verbatim there, and storing the source's word would store text the model did not
            # give us (CL t/389#47 (3)). Judged by position, not by comparing the words' text, so mojibake in
            # the source's copy of the word does not matter.
            $Head = $StoredPieces[0]; $Tail = $StoredPieces[$StoredPieces.Count - 1]
            if ($Head.QStart -ne 0 -or $Head.HeadPartial -or $Tail.QEnd -ne $Snap.QuoteLetters -or $Tail.TailAdded -gt 0 -or $Tail.MidWordEnd) {
                $script:VerbatimDiag.Add('edge word')
                $EdgeDrop = & $Result 'dropped' @() $Coverage $null
                # The segment IS in the source, but not as the model wrote it at its edge: a rejection, as
                # against a segment the source does not have at all (Resolve-VerbatimQuote treats them apart).
                Add-Member -InputObject $EdgeDrop -NotePropertyName Rejected -NotePropertyValue $true
                return $EdgeDrop
            }
        }
        if ($Texts.Count -gt 0 -and $Coverage -ge $script:VerbatimSnapThreshold) {
            $Decision = if ($IsContiguous) { 'snapped' } else { 'interleaved' }
            if ($ModelTextDiffers) { $script:VerbatimDiag.Add('model words stored, text differs from the source') }
            return (& $Result $Decision $Texts.ToArray() $Coverage $Snap)
        }
    }
    & $Result 'dropped' @() $Coverage $null
}

function Find-VerbatimOccurrenceAfter {
    # The first place at or after $AfterOffset where $Text stands in the source as whole words, as
    # { Start; End } text offsets, or $null. Used to place a segment of an elided quote after the segment
    # before it (CL ruling t/389#42 (2)): a phrase that occurs more than once is otherwise placed at
    # whichever occurrence the matcher met first, which may be before the previous segment.
    param([object]$Source, [string]$Text, [int]$AfterOffset)
    $Key = (ConvertTo-EvidenceKey -Quote $Text) -replace ' ', ''
    if ($Key.Length -lt $script:VerbatimMinRun) { return $null }
    $W = [Array]::BinarySearch($Source.WordOffset, $AfterOffset)
    if ($W -lt 0) { $W = -bnot $W }
    if ($W -ge $Source.WordAt.Count) { return $null }
    $P = $Source.WordAt[$W]
    while ($true) {
        $P = $Source.Chars.IndexOf($Key, $P, [System.StringComparison]::Ordinal)
        if ($P -lt 0) { return $null }
        # Whole words only: the match must begin where a source word begins and end where one ends.
        $StartsWord = [Array]::BinarySearch($Source.WordAt, $P) -ge 0
        $EndsWord = ($P + $Key.Length -ge $Source.Chars.Length) -or ([Array]::BinarySearch($Source.WordAt, $P + $Key.Length) -ge 0)
        if ($StartsWord -and $EndsWord) {
            return [pscustomobject]@{
                Start = (Get-VerbatimTextOffset -Source $Source -Position $P)
                End   = (Get-VerbatimTextOffset -Source $Source -Position ($P + $Key.Length - 1)) + 1
            }
        }
        $P++
    }
}

function Test-VerbatimElisionGap {
    # May two segments of an elided quote stand as one quote (CL ruling t/389#45, stipulated; it replaces
    # t/389#40 (4) and t/389#42 (1))? An elision may join two segments only if the source text between them
    # is running prose. They must be in source order, and the gap fails if it has
    #   (a) a paragraph that starts a list or bibliography entry (VerbatimEntryStartPattern);
    #   (b) a table row;
    #   (c) a page marker: a page break, a blanked page header, or a numbers-only line;
    #   (d) more than VerbatimElisionMaxGap letters.
    # Two references joined by an ellipsis are in order and close together, and are still not one passage.
    param([object]$Source, [int]$PrevEnd, [int]$NextStart)
    if ($NextStart -lt $PrevEnd) { return $false }
    $Gap = $Source.Text.Substring($PrevEnd, $NextStart - $PrevEnd)
    if (([regex]::Replace($Gap, '[^\p{L}\p{Nd}]', '')).Length -gt $script:VerbatimElisionMaxGap) { return $false }
    if ($Gap -match '(?m)^\s*\|' -or $Gap -match '\|\s[^|\r\n]*\|') { return $false }
    # One page boundary inside a paragraph is still running prose (CL t/389#47 (1), t/389#50): the paragraph
    # does not end at the page break, and a footnote marker inside a sentence does not end it either. So ONE
    # page break and ONE numbers-only line of bare numbers ("27", "5 5") are allowed. A chart is two or more
    # numbers-only lines, or a value that is not a bare number ("64%"); either fails the gap.
    # Lines are taken whole: the gap's first stretch is the rest of the previous segment's line (a footnote
    # reference after its full stop, ".180", is not a line of its own) and its last stretch is the start of
    # the next segment's line.
    if (([regex]::Matches($Gap, "`f")).Count -gt 1) { return $false }
    $GapLines = $Gap -split '\r?\n'
    $FirstWhole = if ($PrevEnd -eq 0 -or $Source.Text[$PrevEnd - 1] -eq [char]10) { 0 } else { 1 }
    $NumberLines = 0
    for ($I = $FirstWhole; $I -lt $GapLines.Count - 1; $I++) {
        if ($GapLines[$I] -match '^[^\p{L}]*\p{Nd}[^\p{L}]*$') {
            $NumberLines++
            if ($NumberLines -ge 2 -or $GapLines[$I].Trim([char[]]" `t`f") -notmatch '^[\p{Nd}\s*]+$') { return $false }
        }
    }
    # The first line of each paragraph in the gap starts no list or bibliography entry. The gap's own first
    # stretch continues the previous segment's line, so it is not a paragraph start. Its last stretch may be
    # the start of the next segment's entry ("... \n\n113 " before the segment), so the test reads a little
    # way into the segment. A number alone on its line is the page or footnote number judged above.
    $Reach = [Math]::Min($Source.Text.Length, $NextStart + 24)
    $Paragraphs = [regex]::Split($Source.Text.Substring($PrevEnd, $Reach - $PrevEnd), '\r?\n[ \t]*(?:\r?\n[ \t]*)+')
    for ($I = 1; $I -lt $Paragraphs.Count; $I++) {
        $First = ($Paragraphs[$I] -split '\r?\n')[0].Trim([char[]]" `t`f")
        if ($First.Length -eq 0 -or $First -match '^[^\p{L}]*\p{Nd}[^\p{L}]*$') { continue }
        if ($First -cmatch $script:VerbatimEntryStartPattern) { return $false }
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
    $AnyRejected = $false   # a segment the source has, rejected at its edge (t/389#47 (3))
    $RunCut = $false        # a link between two kept segments failed (t/389#45)
    foreach ($Part in $Parts) {
        $PartLetters = ((ConvertTo-EvidenceKey -Quote $Part) -replace ' ', '').Length
        $AllLetters += $PartLetters
        # A fragment shorter than one run can't be placed in the source, so it can't be kept as a quote.
        if ($PartLetters -lt $script:VerbatimMinRun) { continue }
        $R = Resolve-VerbatimSegment -Source $Source -Segment $Part -QuoteStart ([object]::ReferenceEquals($Part, $Parts[0]))
        if ($R.Coverage -gt $BestCoverage) { $BestCoverage = $R.Coverage }
        if ($R.Decision -eq 'dropped') {
            if ($R.PSObject.Properties['Rejected'] -and $R.Rejected) { $AnyRejected = $true }
            continue
        }
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
                # Place the segment at its first occurrence after the one before it (t/389#42 (2)). Only a
                # segment stored as one text can be placed again; with no later occurrence it stays where
                # it was found, and the pair is then out of order.
                if ($null -ne $Prev.End -and @($R.Texts).Count -eq 1) {
                    $Later = Find-VerbatimOccurrenceAfter -Source $Source -Text $R.Texts[0] -AfterOffset $Prev.End
                    if ($Later) { $R.Start = $Later.Start; $R.End = $Later.End }
                }
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
            $Kept = $BestRun
            $RunCut = $true
        }
    }
    # What is stored must hold VerbatimSnapThreshold of the whole quote, whichever way the rest was lost: a
    # segment the source does not have, one too short to place, one rejected at its edge, or one outside
    # the run. A smaller part is a partial quote that misstates the claim (CL t/389#42 (3), t/389#50; this
    # replaces the S23 behaviour of t/389#11, which stored whatever segment was found).
    $KeptLetters = 0; foreach ($R in $Kept) { $KeptLetters += $R.Letters }
    $Share = if ($AllLetters -gt 0) { [double]$KeptLetters / [double]$AllLetters } else { 0.0 }
    if ($Share -lt $script:VerbatimSnapThreshold) { $Dropped.Coverage = [Math]::Min([double]$BestCoverage, $Share); return $Dropped }
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
