# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-PovClassificationSample {
    <#
    .SYNOPSIS
        Builds CHESS's classification input from the WHOLE document, not just its opening (t/4477).
    .DESCRIPTION
        The pre-fix query was the title plus the document's first 500 words, so a document whose stance
        only shows up after its introduction was classified on its opening alone — the same class of bug
        as t/4468's RAG query truncation.

        This windows the document with Split-RagQueryWindows (t/4468; back-matter already dropped), then
        takes an EVENLY SPACED, section-stratified sample: the opening sentence or two of windows spread
        across the whole document, packed up to -WordBudget words (same budget CHESS already expects, so
        the billed call count and per-call cost are unchanged — CL t/4477#3).

        Windows are picked evenly by position, never by embedding similarity to a POV camp: a camp-mean
        vector averages hundreds of node descriptions into a near-generic centroid, and picking windows
        that score strongest against it would feed the classifier the embedder's own bias and confound
        the before/after measurement (CL t/4477#3).
    .PARAMETER Windows
        Document windows, in order (from Split-RagQueryWindows.Windows).
    .PARAMETER WordBudget
        Target word count for the sample. Default 500, matching the pre-fix budget.
    .PARAMETER MaxWindowsSampled
        Upper bound on how many windows contribute a sentence, so a very long document's sample stays an
        even spread rather than drifting toward one that happens to pack more windows into the budget.
        Any windows beyond this many are not sampled; -- there is no cap-WARN here because, unlike RAG
        candidate scoring, under-sampling a classification input degrades gracefully (CHESS still sees a
        wider spread than the old first-500-words query) rather than silently dropping a candidate.
    .OUTPUTS
        [string] the sample text (sentences only, no window text verbatim beyond the first sentence/two).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Windows,
        [ValidateRange(50, 5000)][int]$WordBudget = 500,
        [ValidateRange(1, 200)][int]$MaxWindowsSampled = 40
    )

    Set-StrictMode -Version Latest

    if (@($Windows).Count -eq 0) { return '' }

    # Evenly spaced indices over 0..N-1 that INCLUDE both endpoints (so the sample always reaches the
    # document's last window, not just "every Kth starting from 0"): index(k) = floor(k*(N-1)/(K-1)).
    function script:Get-EvenIndices([int]$N, [int]$K) {
        if ($K -ge $N) { return @(0..($N - 1)) }
        if ($K -le 1) { return @(0) }
        $Idx = [System.Collections.Generic.List[int]]::new()
        # PowerShell variable names are case-insensitive: the loop variable must NOT be $k — it would
        # collide with the parameter $K and make "$k -lt $K" permanently false.
        for ($Step = 0; $Step -lt $K; $Step++) {
            $i = [int][Math]::Floor($Step * ($N - 1) / ($K - 1))
            if (-not $Idx.Contains($i)) { [void]$Idx.Add($i) }
        }
        $Idx
    }

    $TotalWindows = @($Windows).Count
    $CandidateCount = [Math]::Min($TotalWindows, $MaxWindowsSampled)
    $CandidateIndices = Get-EvenIndices $TotalWindows $CandidateCount

    $SentencePattern = '.*?[.!?](?:\s|$)'
    $Pieces = [System.Collections.Generic.List[string]]::new()
    foreach ($Idx in $CandidateIndices) {
        $W = $Windows[$Idx]
        $Matches = @([regex]::Matches($W, $SentencePattern) | Select-Object -First 2 | ForEach-Object Value)
        $Piece = if ($Matches.Count -gt 0) { ($Matches -join ' ').Trim() } else { $W.Trim() }
        if ($Piece) { $Pieces.Add($Piece) }
    }
    if ($Pieces.Count -eq 0) { return '' }

    # If every candidate piece fits the budget, keep them all. Otherwise THIN THEM OUT EVENLY rather than
    # greedily keeping a prefix — a tight budget must not collapse the sample back to "the opening only,"
    # which is exactly the bug this function exists to fix.
    $WordCounts = @($Pieces | ForEach-Object { @($_ -split '\s+').Count })
    $TotalPieceWords = ($WordCounts | Measure-Object -Sum).Sum
    if ($TotalPieceWords -le $WordBudget) {
        $Selected = $Pieces
    }
    else {
        $AvgWords = [Math]::Max(1.0, ($WordCounts | Measure-Object -Average).Average)
        $FitCount = [Math]::Max(1, [Math]::Min($Pieces.Count, [int][Math]::Floor($WordBudget / $AvgWords)))
        $SelIndices = Get-EvenIndices $Pieces.Count $FitCount
        $Selected = @($SelIndices | ForEach-Object { $Pieces[$_] })
    }

    # Final trim to the exact word budget (the average-based estimate above can overshoot slightly).
    $Words = 0
    $Out = [System.Collections.Generic.List[string]]::new()
    foreach ($P in $Selected) {
        $PWords = @($P -split '\s+').Count
        if ($Out.Count -gt 0 -and ($Words + $PWords) -gt $WordBudget) { break }
        $Out.Add($P)
        $Words += $PWords
    }

    $Out -join ' '
}
