# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/389: quote-grounding guard for key_points[].verbatim. A quote is meant to be an exact source
# quote, but chunked and FIRE runs return near-quotes (grounding 0.42 chunked vs 0.68 single-call, t/358#9).
# For each quote, under the spec 7.2 key (ConvertTo-EvidenceKey):
#   - an exact key match is kept unchanged;
#   - otherwise the best source span is found, and the quote is SNAPPED to it when the span covers >= 0.9
#     of the quote's characters. The stored text is the source's own text;
#   - otherwise the quote is DROPPED. The key point is kept, and its verbatim is removed when no quote is left.
# Thresholds are stipulated by CL (t/389). Matching runs on a working copy of the snapshot with the
# t/4394 mojibake repaired and repeated page footers blanked. The working copy has the same length as the
# source, so every match maps back to the source's own text. The snap is character-level, so PDF-glued
# words ("morecomputeisavailable") and corrupted characters inside a word still count (t/389#5).

$script:VerbatimSnapThreshold = 0.9
$script:VerbatimAnchorK = 3
$script:VerbatimCharAnchorK = 6
$script:VerbatimMaxAnchorHits = 200
$script:VerbatimFooterMinRepeats = 3
$script:VerbatimFooterMaxChars = 80

function Get-VerbatimWorkText {
    # A same-length working copy of the snapshot for matching only: the t/4394 mojibake sequences and
    # singles (spec 7.2 step 1) are replaced by a same-length ASCII form, and page footers and headers
    # (a short line repeated at least VerbatimFooterMinRepeats times) are blanked, keeping their line breaks.
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $W = $Text
    foreach ($P in $script:EvidenceMojibakeSequences) {
        $To = $P[1]; $From = $P[0]
        $Pad = ' ' * ($From.Length - $To.Length)
        $W = $W.Replace($From, $To + $Pad)
    }
    foreach ($P in $script:EvidenceMojibakeSingles) { $W = $W.Replace($P[0], $P[1]) }
    $Lines = $W -split "(\r?\n)"
    $Counts = @{}
    foreach ($L in $Lines) {
        $T = $L.Trim()
        if ($T.Length -gt 0 -and $T.Length -le $script:VerbatimFooterMaxChars) { $Counts[$T] = 1 + [int]$Counts[$T] }
    }
    $Out = [System.Text.StringBuilder]::new()
    foreach ($L in $Lines) {
        $T = $L.Trim()
        if ($T.Length -gt 0 -and $T.Length -le $script:VerbatimFooterMaxChars -and $Counts[$T] -ge $script:VerbatimFooterMinRepeats) {
            [void]$Out.Append((' ' * $L.Length))
        } else {
            [void]$Out.Append($L)
        }
    }
    $Out.ToString()
}

function Get-VerbatimSourceIndex {
    # The working text as spec 7.2 key tokens, each with its character span, plus a trigram index.
    param([string]$Text)
    $Keys = [System.Collections.Generic.List[string]]::new()
    $Starts = [System.Collections.Generic.List[int]]::new()
    $Ends = [System.Collections.Generic.List[int]]::new()
    $Cache = @{}
    foreach ($M in [regex]::Matches($Text, '[\p{L}\p{Nd}]+')) {
        $Raw = $M.Value
        if (-not $Cache.ContainsKey($Raw)) { $Cache[$Raw] = ConvertTo-EvidenceKey -Quote $Raw }
        $K = $Cache[$Raw]
        if ([string]::IsNullOrEmpty($K)) { continue }
        foreach ($Part in $K.Split(' ')) {
            if ([string]::IsNullOrEmpty($Part)) { continue }
            $Keys.Add($Part); $Starts.Add($M.Index); $Ends.Add($M.Index + $M.Length)
        }
    }
    $K = $script:VerbatimAnchorK
    $Grams = @{}
    for ($I = 0; $I + $K -le $Keys.Count; $I++) {
        $G = ($Keys.GetRange($I, $K)) -join ' '
        if (-not $Grams.ContainsKey($G)) { $Grams[$G] = [System.Collections.Generic.List[int]]::new() }
        $Grams[$G].Add($I)
    }
    [pscustomobject]@{ Keys = $Keys; Starts = $Starts; Ends = $Ends; Text = $Text; Grams = $Grams }
}

function Get-VerbatimCharIndex {
    # The working text as one lowercase string of letters and digits, with each character's source offset,
    # plus a character k-gram index. Spaces, punctuation and corrupted symbols are left out, so glued words match.
    param([string]$Text)
    $Chars = [System.Text.StringBuilder]::new()
    $Offsets = [System.Collections.Generic.List[int]]::new()
    for ($I = 0; $I -lt $Text.Length; $I++) {
        $C = $Text[$I]
        if ([char]::IsLetterOrDigit($C)) {
            [void]$Chars.Append([char]::ToLowerInvariant($C))
            $Offsets.Add($I)
        }
    }
    $S = $Chars.ToString()
    $K = $script:VerbatimCharAnchorK
    $Grams = @{}
    for ($I = 0; $I + $K -le $S.Length; $I++) {
        $G = $S.Substring($I, $K)
        if (-not $Grams.ContainsKey($G)) { $Grams[$G] = [System.Collections.Generic.List[int]]::new() }
        $Grams[$G].Add($I)
    }
    [pscustomobject]@{ Chars = $S; Offsets = $Offsets; Grams = $Grams; Text = $Text }
}

function Find-VerbatimSnap {
    # The best source span for a quote, by character coverage. Returns $null, or @{ Start; End; Coverage }
    # where Start/End are source character offsets and Coverage is the share of the quote's characters
    # matched in that span (a character multiset overlap, in a window of the quote's length plus slack).
    param([object]$Index, [string]$Quote)
    $QKey = ConvertTo-EvidenceKey -Quote $Quote
    $Q = $QKey -replace ' ', ''
    if ([string]::IsNullOrEmpty($Q)) { return $null }
    $N = $Q.Length
    $Bag = @{}
    foreach ($C in $Q.ToCharArray()) { $Bag[$C] = 1 + [int]$Bag[$C] }
    $Hay = $Index.Chars
    $K = $script:VerbatimCharAnchorK
    $Best = $null
    $Hits = 0
    $Seen = @{}
    for ($QI = 0; $QI + $K -le $N; $QI += $K) {
        $G = $Q.Substring($QI, $K)
        if (-not $Index.Grams.ContainsKey($G)) { continue }
        foreach ($P in $Index.Grams[$G]) {
            if (++$Hits -gt $script:VerbatimMaxAnchorHits) { break }
            $S0 = [Math]::Max(0, $P - $QI)
            if ($Seen.ContainsKey($S0)) { continue }
            $Seen[$S0] = $true
            $E0 = [Math]::Min($Hay.Length, $S0 + $N + [Math]::Ceiling($N / 4) + 8)
            # Longest common subsequence of the quote against the window: quote characters matched in order,
            # with skipped source characters (glue, corruption, footers) and skipped quote characters (insertions)
            # both allowed. The matched source positions give the span.
            $W = $E0 - $S0
            $Dp = New-Object 'int[,]' ($N + 1), ($W + 1)
            for ($A = $N - 1; $A -ge 0; $A--) {
                for ($B = $W - 1; $B -ge 0; $B--) {
                    if ($Q[$A] -ceq $Hay[$S0 + $B]) { $Dp[$A, $B] = 1 + $Dp[($A + 1), ($B + 1)] }
                    else { $Dp[$A, $B] = [Math]::Max($Dp[($A + 1), $B], $Dp[$A, ($B + 1)]) }
                }
            }
            $Matched = $Dp[0, 0]
            if ($Matched -eq 0) { continue }
            # Walk forward to recover the matched source positions, and the first and last of them.
            $FirstJ = -1; $LastJ = -1
            $A = 0; $B = 0
            while ($A -lt $N -and $B -lt $W) {
                if ($Q[$A] -ceq $Hay[$S0 + $B] -and $Dp[$A, $B] -eq (1 + $Dp[($A + 1), ($B + 1)])) {
                    if ($FirstJ -lt 0) { $FirstJ = $S0 + $B }
                    $LastJ = $S0 + $B; $A++; $B++
                } elseif ($Dp[($A + 1), $B] -ge $Dp[$A, ($B + 1)]) { $A++ }
                else { $B++ }
            }
            $Span = $LastJ - $FirstJ + 1
            if ($Best -eq $null -or $Matched -gt $Best.Matched -or ($Matched -eq $Best.Matched -and $Span -lt $Best.Span)) {
                $Best = @{ First = $FirstJ; Last = $LastJ; Matched = $Matched; Span = $Span }
            }
        }
        if ($Hits -gt $script:VerbatimMaxAnchorHits) { break }
    }
    if ($null -eq $Best) { return $null }
    # The span runs from the first matched character to the last, so it begins and ends on quote text.
    [pscustomobject]@{
        Start    = $Index.Offsets[$Best.First]
        End      = $Index.Offsets[$Best.Last] + 1
        Coverage = $Best.Matched / $N
    }
}

function Test-VerbatimExact {
    # True when the quote's spec 7.2 key appears as a contiguous run of the working text's key tokens.
    param([object]$Index, [string]$Quote)
    $QKey = ConvertTo-EvidenceKey -Quote $Quote
    if ([string]::IsNullOrEmpty($QKey)) { return $false }
    $Q = @($QKey.Split(' ') | Where-Object { $_ })
    $N = $Q.Count
    $K = [Math]::Min($script:VerbatimAnchorK, $N)
    $Anchor = ($Q[0..($K - 1)]) -join ' '
    if (-not $Index.Grams.ContainsKey($Anchor)) { return $false }
    foreach ($I in $Index.Grams[$Anchor]) {
        if ($I + $N -gt $Index.Keys.Count) { continue }
        $Match = $true
        for ($J = 0; $J -lt $N; $J++) {
            if ($Index.Keys[$I + $J] -cne $Q[$J]) { $Match = $false; break }
        }
        if ($Match) { return $true }
    }
    $false
}

function Repair-SummaryKeyPointVerbatim {
    <#
    .SYNOPSIS
        Keeps each key_point verbatim quote grounded in the snapshot (t/389): exact quotes stay, near
        quotes are snapped to the source's own text, and the rest are dropped with the key point kept.
    .OUTPUTS
        [hashtable] @{ Snapped = <int>; Dropped = <int> }
    #>
    param([object]$SummaryObject, [string]$SnapshotText, [string]$ThisDocId)
    $Result = @{ Snapped = 0; Dropped = 0 }
    if (-not (Test-SummaryField $SummaryObject 'pov_summaries')) { return $Result }
    $Pov = Get-SummaryField $SummaryObject 'pov_summaries'
    if (-not $Pov) { return $Result }
    $Index = $null
    $CharIndex = $null
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
            if ($null -eq $Index) {
                $Work = Get-VerbatimWorkText -Text $SnapshotText
                $Index = Get-VerbatimSourceIndex -Text $Work
                $CharIndex = Get-VerbatimCharIndex -Text $Work
            }
            $Kept = [System.Collections.Generic.List[string]]::new()
            foreach ($Quote in @($Raw)) {
                if ($Quote -isnot [string] -or [string]::IsNullOrWhiteSpace($Quote)) { continue }
                if (Test-VerbatimExact -Index $Index -Quote $Quote) { $Kept.Add($Quote); continue }
                $Snap = Find-VerbatimSnap -Index $CharIndex -Quote $Quote
                if ($Snap -and $Snap.Coverage -ge $script:VerbatimSnapThreshold) {
                    $Source = $SnapshotText.Substring($Snap.Start, $Snap.End - $Snap.Start)
                    $Kept.Add($Source)
                    if ($Source -cne $Quote) {
                        $Result.Snapped++
                        Write-Warning "Finalize-Summary: $ThisDocId $Camp key_points[$I] verbatim snapped to the source text (t/389): $($Quote.Substring(0, [Math]::Min(100, $Quote.Length)))"
                    }
                } else {
                    $Result.Dropped++
                    Write-Warning "Finalize-Summary: $ThisDocId $Camp key_points[$I] verbatim dropped, not found in the snapshot (t/389): $($Quote.Substring(0, [Math]::Min(100, $Quote.Length)))"
                }
            }
            # A string stays a string (one quote or none); a list stays a list, and an empty list becomes null.
            if ($Kept.Count -eq 0) { $New = $null }
            elseif ($IsList) { $New = $Kept.ToArray() }
            else { $New = $Kept[0] }
            if ($Kp -is [System.Collections.IDictionary]) { $Kp['verbatim'] = $New }
            else { $Kp.verbatim = $New }
        }
    }
    $Result
}
