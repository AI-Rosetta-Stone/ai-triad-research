# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/375 fix 2: phrases where a figure should be but the converted text has none. Some PDFs
# (e.g. Google Docs prints) carry their numbers as images or equation glyphs, so the text layer
# reads "will impact less than of all work tasks". Each pattern is a word that needs a number
# right after it, followed by a word that can't be one. \s+ spans the line breaks such PDFs leave.
$script:SnapshotNumericGapPatterns = @(
    # "less than of all work tasks", "more than and"
    '\b(?:less|more|fewer|greater) than\s+(?:of|and|over)\b'
    # "productivity increase of and", "growth boost of only over". No leading \b: the same text
    # layers glue words ("GDP growthboost of only over").
    '(?:increase|decrease|boost|growth|rise|drop|decline|reduction|gain)s? of\s+(?:only\s+)?(?:and|over|by)\b'
    # "cumulative GDP growth by over the same period" ("by and" isn't used: in the corpus it is
    # mostly a lost citation or plain "used by and under", not a lost figure)
    '\bby\s+over\s+the\b'
    # "the estimated trillion in planned CapEx", "approximately trillion in 2022"
    '\b(?:estimated|than|only|approximately|nearly|roughly)\s+(?:trillion|billion|million)\b(?![-\w])'
)

function Measure-SnapshotNumericGaps {
    <#
    .SYNOPSIS
        Counts places in a snapshot where a figure is missing from the text (t/375 fix 2).
    .DESCRIPTION
        A non-zero count means the source's text layer lost its numbers. Summaries of such a
        snapshot tend to invent the missing figures, so the import records the count in
        metadata.numeric_gaps and WARNs; the doc is a candidate for OCR or a re-source.
    .PARAMETER Text
        The snapshot markdown.
    .OUTPUTS
        [int] the number of gap matches across all patterns.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )
    $Count = 0
    foreach ($Pattern in $script:SnapshotNumericGapPatterns) {
        $Count += [regex]::Matches($Text, $Pattern, 'IgnoreCase').Count
    }
    $Count
}
