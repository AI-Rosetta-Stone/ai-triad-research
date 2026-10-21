# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Add-SummaryUnmappedConcepts {
    <#
    .SYNOPSIS
        Aggregates one summary's unmapped_concepts into $UnmappedAgg, keyed by a normalized
        (whitespace-collapsed, lowercased) concept text (t/3910 extraction from
        Get-TaxonomyHealthData). Mutates $UnmappedAgg in place (hashtable, reference type).
    .PARAMETER Summary
        The parsed summary document.
    .PARAMETER DocId
        The doc id attributing this aggregation.
    .PARAMETER UnmappedAgg
        Normalized-key -> aggregation hashtable, mutated in place.
    .PARAMETER OncePerDoc
        For a marked copy's summary under the duplicate-group evidence union (spec 7.5, t/4337): a
        concept counts only when DocId (the canonical) isn't already among its ContributingDocs,
        and then once. So a doc and its copies can never make a concept look frequent by repetition
        (the health report's Frequency >= 3 strong-candidate bar).
    .OUTPUTS
        [int] the count of unmapped concepts seen in this summary (the caller's per-doc
        DocUnmapped counter).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][AllowNull()]$Summary,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][hashtable]$UnmappedAgg,
        [switch]$OncePerDoc
    )

    Set-StrictMode -Version Latest

    $DocUnmapped = 0
    if (-not ($Summary.PSObject.Properties['unmapped_concepts'] -and $Summary.unmapped_concepts)) { return $DocUnmapped }

    foreach ($Concept in @($Summary.unmapped_concepts)) {
        if ($null -eq $Concept) { continue }
        $DocUnmapped++
        if ($Concept.PSObject.Properties['concept']) { $ConceptText = $Concept.concept } else { $ConceptText = "$Concept" }
        $NormKey = ($ConceptText -replace '\s+', ' ').Trim().ToLower()
        if (-not $NormKey) { continue }
        if ($OncePerDoc -and $UnmappedAgg.ContainsKey($NormKey) -and $DocId -in $UnmappedAgg[$NormKey].ContributingDocs) { continue }

        if ($Concept.PSObject.Properties['suggested_pov'])      { $SugPov = $Concept.suggested_pov }      else { $SugPov = $null }
        if ($Concept.PSObject.Properties['suggested_category']) { $SugCat = $Concept.suggested_category } else { $SugCat = $null }
        if (-not $UnmappedAgg.ContainsKey($NormKey)) {
            $UnmappedAgg[$NormKey] = @{
                Concept           = $ConceptText
                NormalizedKey     = $NormKey
                Frequency         = 0
                SuggestedPov      = $SugPov
                SuggestedCategory = $SugCat
                ContributingDocs  = [System.Collections.Generic.List[string]]::new()
                Reasons           = [System.Collections.Generic.List[string]]::new()
            }
        }
        $UnmappedAgg[$NormKey].Frequency++
        if ($DocId -notin $UnmappedAgg[$NormKey].ContributingDocs) {
            $UnmappedAgg[$NormKey].ContributingDocs.Add($DocId)
        }
        if ($Concept.PSObject.Properties['reason']) { $ReasonText = $Concept.reason } else { $ReasonText = $null }
        if ($ReasonText -and $ReasonText -notin $UnmappedAgg[$NormKey].Reasons) {
            $UnmappedAgg[$NormKey].Reasons.Add($ReasonText)
        }
    }

    return $DocUnmapped
}
