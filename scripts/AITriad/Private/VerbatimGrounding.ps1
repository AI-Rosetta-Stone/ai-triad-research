# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/389: quote-grounding guard for key_points[].verbatim. A quote is meant to be an exact source
# quote, but chunked and FIRE runs return near-quotes (grounding 0.42 chunked vs 0.68 single-call, t/358#9).
# For each quote, under the spec 7.2 key (ConvertTo-EvidenceKey):
#   - an exact key match is kept unchanged;
#   - otherwise the best contiguous source span is found, and the quote is SNAPPED to it when the span
#     covers >= 0.9 of the quote's normalized characters. The stored text is the source's own text;
#   - otherwise the quote is DROPPED. The key point is kept, and its verbatim is removed when no quote is left.
# Thresholds are stipulated by CL (t/389). Snapping uses a trigram index over the snapshot, so cost is
# O(snapshot) per document plus a few window alignments per quote.

$script:VerbatimSnapThreshold = 0.9
$script:VerbatimAnchorK = 3
$script:VerbatimMaxAnchorHits = 200

function Get-VerbatimSourceIndex {
    # The snapshot as spec 7.2 key tokens, each with its raw character span, plus a trigram index.
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

function Find-VerbatimSnap {
    # The best contiguous source span for a quote. Returns $null, or @{ Start; End; Coverage } where
    # Start/End are raw character offsets in the snapshot and Coverage is the matched share of the quote's characters.
    param([object]$Index, [string]$Quote)
    $QKey = ConvertTo-EvidenceKey -Quote $Quote
    if ([string]::IsNullOrEmpty($QKey)) { return $null }
    $Q = @($QKey.Split(' ') | Where-Object { $_ })
    $N = $Q.Count
    $QChars = ($Q | Measure-Object -Property Length -Sum).Sum
    if ($QChars -eq 0) { return $null }
    $Keys = $Index.Keys
    $K = [Math]::Min($script:VerbatimAnchorK, $N)
    $Best = $null
    $Hits = 0
    for ($QI = 0; $QI + $K -le $N; $QI++) {
        $G = ($Q[$QI..($QI + $K - 1)]) -join ' '
        if (-not $Index.Grams.ContainsKey($G)) { continue }
        foreach ($P in $Index.Grams[$G]) {
            if (++$Hits -gt $script:VerbatimMaxAnchorHits) { break }
            $S = $P - $QI
            if ($S -lt 0) { continue }
            $E = [Math]::Min($Keys.Count - 1, $S + $N + [Math]::Ceiling($N / 2) + 2)
            # LCS over the window: which quote tokens align, in order, to source tokens.
            $W = $E - $S + 1
            $Dp = New-Object 'int[,]' ($N + 1), ($W + 1)
            for ($A = $N - 1; $A -ge 0; $A--) {
                for ($B = $W - 1; $B -ge 0; $B--) {
                    if ($Q[$A] -ceq $Keys[$S + $B]) { $Dp[$A, $B] = 1 + $Dp[($A + 1), ($B + 1)] + 0 }
                    else { $Dp[$A, $B] = [Math]::Max($Dp[($A + 1), $B], $Dp[$A, ($B + 1)]) }
                }
            }
            # Walk the table to recover the matched source positions.
            $Matched = [System.Collections.Generic.List[int]]::new()
            $MA = 0; $MB = 0; $Chars = 0
            while ($MA -lt $N -and $MB -lt $W) {
                if ($Q[$MA] -ceq $Keys[$S + $MB]) {
                    $Matched.Add($S + $MB); $Chars += $Q[$MA].Length; $MA++; $MB++
                } elseif ($Dp[($MA + 1), $MB] -ge $Dp[$MA, ($MB + 1)]) { $MA++ }
                else { $MB++ }
            }
            if ($Matched.Count -eq 0) { continue }
            $Better = ($null -eq $Best) -or ($Chars -gt $Best.Chars) -or
                ($Chars -eq $Best.Chars -and ($Matched[$Matched.Count - 1] - $Matched[0]) -lt ($Best.Last - $Best.First))
            if ($Better) { $Best = @{ Chars = $Chars; First = $Matched[0]; Last = $Matched[$Matched.Count - 1] } }
        }
        if ($Hits -gt $script:VerbatimMaxAnchorHits) { break }
    }
    if ($null -eq $Best) { return $null }
    [pscustomobject]@{
        Start    = $Index.Starts[$Best.First]
        End      = $Index.Ends[$Best.Last]
        Coverage = $Best.Chars / $QChars
    }
}

function Test-VerbatimExact {
    # True when the quote's spec 7.2 key appears as a contiguous run of the snapshot's key tokens.
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
    foreach ($Camp in 'accelerationist', 'safetyist', 'skeptic') {
        $CampData = Get-SummaryField $Pov $Camp
        if (-not $CampData -or -not (Test-SummaryField $CampData 'key_points')) { continue }
        # Assign first: Get-SummaryField returns `, $value`, so @(Get-SummaryField ...) would nest the list.
        $KPs = Get-SummaryField $CampData 'key_points'
        for ($I = 0; $I -lt $KPs.Count; $I++) {
            $Kp = $KPs[$I]
            if ($null -eq $Kp -or -not (Test-SummaryField $Kp 'verbatim')) { continue }
            $Raw = Get-SummaryField $Kp 'verbatim'
            if ($null -eq $Raw) { continue }
            $IsList = $Raw -is [System.Collections.IList]
            if ($null -eq $Index) { $Index = Get-VerbatimSourceIndex -Text $SnapshotText }
            $Kept = [System.Collections.Generic.List[string]]::new()
            foreach ($Quote in @($Raw)) {
                if ($Quote -isnot [string] -or [string]::IsNullOrWhiteSpace($Quote)) { continue }
                if (Test-VerbatimExact -Index $Index -Quote $Quote) { $Kept.Add($Quote); continue }
                $Snap = Find-VerbatimSnap -Index $Index -Quote $Quote
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
