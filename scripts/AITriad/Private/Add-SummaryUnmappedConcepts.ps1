# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-SummaryConceptProp {
    # Behavior-preserving helper (t/3910 extraction): return $Concept.$Name when the property
    # exists, else $Default. Mirrors the per-property PSObject.Properties guards inlined previously.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$Concept,
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()]$Default
    )
    Set-StrictMode -Version Latest
    # unary comma on both returns: a bare return enumerates an array value, so suggested_pov ["x"] would
    # arrive as a scalar and [] as $null. The comma preserves scalars, arrays and empty arrays intact.
    if ($Concept.PSObject.Properties[$Name]) { return , $Concept.$Name }
    return , $Default
}

function Add-NormalizedUnmappedConcept {
    # Behavior-preserving helper (t/3910 extraction): aggregate one non-null concept into
    # $UnmappedAgg in place. Caller is responsible for null filtering and the DocUnmapped counter.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Concept,
        [Parameter(Mandatory)][string]$DocId,
        [Parameter(Mandatory)][hashtable]$UnmappedAgg,
        [switch]$OncePerDoc
    )
    Set-StrictMode -Version Latest

    $ConceptText = Get-SummaryConceptProp -Concept $Concept -Name 'concept' -Default "$Concept"
    $NormKey = ($ConceptText -replace '\s+', ' ').Trim().ToLower()
    if (-not $NormKey) { return }
    if ($OncePerDoc -and $UnmappedAgg.ContainsKey($NormKey) -and $DocId -in $UnmappedAgg[$NormKey].ContributingDocs) { return }

    if (-not $UnmappedAgg.ContainsKey($NormKey)) {
        $UnmappedAgg[$NormKey] = @{
            Concept           = $ConceptText
            NormalizedKey     = $NormKey
            Frequency         = 0
            SuggestedPov      = Get-SummaryConceptProp -Concept $Concept -Name 'suggested_pov' -Default $null
            SuggestedCategory = Get-SummaryConceptProp -Concept $Concept -Name 'suggested_category' -Default $null
            ContributingDocs  = [System.Collections.Generic.List[string]]::new()
            Reasons           = [System.Collections.Generic.List[string]]::new()
        }
    }
    $UnmappedAgg[$NormKey].Frequency++
    if ($DocId -notin $UnmappedAgg[$NormKey].ContributingDocs) {
        $UnmappedAgg[$NormKey].ContributingDocs.Add($DocId)
    }
    $ReasonText = Get-SummaryConceptProp -Concept $Concept -Name 'reason' -Default $null
    if ($ReasonText -and $ReasonText -notin $UnmappedAgg[$NormKey].Reasons) {
        $UnmappedAgg[$NormKey].Reasons.Add($ReasonText)
    }
}

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
        Add-NormalizedUnmappedConcept -Concept $Concept -DocId $DocId -UnmappedAgg $UnmappedAgg -OncePerDoc:$OncePerDoc
    }

    return $DocUnmapped
}
