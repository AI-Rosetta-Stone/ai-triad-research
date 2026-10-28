# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function ConvertTo-TemporalBoundRange {
    <#
    .SYNOPSIS
        t/4474: parses a factual_claim's free-text temporal_bound into a [FromYear, ToYear]
        range, or $null when it can't be parsed (never guessed).
    .DESCRIPTION
        Recognizes the three forms the extraction prompt documents
        (pov-summary-schema.prompt): "by <year>" (open start), "<year>-<year>" (a range),
        and a bare "<year>" (a one-year point). Anything else -- null, free text with no
        4-digit year, "timeless" -- returns $null, which the caller treats as "no temporal
        information available" and therefore compatible with everything (conservative:
        never gates a pair it can't actually reason about).
    #>
    param([string]$TemporalBound)
    if ([string]::IsNullOrWhiteSpace($TemporalBound)) { return $null }
    $t = $TemporalBound.Trim()

    if ($t -match '^by\s+(\d{4})$') { return @{ From = [int]::MinValue; To = [int]$Matches[1] } }
    if ($t -match '^(\d{4})\s*-\s*(\d{4})$') { return @{ From = [int]$Matches[1]; To = [int]$Matches[2] } }
    if ($t -match '^(\d{4})$') { return @{ From = [int]$Matches[1]; To = [int]$Matches[1] } }
    $null
}

function Test-TemporalBoundsOverlap {
    <#
    .SYNOPSIS
        t/4474: whether two factual_claims' temporal_bound values are compatible with
        confirming a conflict (rebut/attack) between them.
    .DESCRIPTION
        Returns $true (compatible -- do not block the conflict) whenever either bound is
        missing or unparseable (ConvertTo-TemporalBoundRange), since there is nothing to
        reason about and this gate must never produce a false negative on absent data.
        When both parse, returns whether their [From, To] ranges overlap -- two claims
        about non-overlapping windows ("2023-2025" vs "2030-2035") aren't necessarily in
        tension and should not be auto-confirmed as a conflict from node-overlap alone.
    .PARAMETER BoundA
    .PARAMETER BoundB
        Each claim's raw temporal_bound string (or $null).
    #>
    param([string]$BoundA, [string]$BoundB)
    $RangeA = ConvertTo-TemporalBoundRange -TemporalBound $BoundA
    $RangeB = ConvertTo-TemporalBoundRange -TemporalBound $BoundB
    if ($null -eq $RangeA -or $null -eq $RangeB) { return $true }
    ($RangeA.From -le $RangeB.To) -and ($RangeB.From -le $RangeA.To)
}
