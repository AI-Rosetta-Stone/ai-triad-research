# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Add-AITSourceClaimPovCounts {
    <#
    .SYNOPSIS
        Tallies each factual claim's linked_taxonomy_nodes into the ClaimsByPov counts by
        node-id prefix (t/3910 summary-fallback helper, no behavior change).
    .DESCRIPTION
        Extracted from Resolve-AITSourceStats so the prefix-classification loop is its own
        unit. Mutates the passed-in $ClaimsPov object in place (same semantics as the inline
        loop it replaces) and returns nothing.
    .PARAMETER FactualClaims
        The array of parsed factual_claims objects.
    .PARAMETER ClaimsPov
        The ClaimsByPov PSCustomObject to increment in place.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$FactualClaims,
        [Parameter(Mandatory)][PSObject]$ClaimsPov
    )
    Set-StrictMode -Version Latest

    foreach ($Claim in $FactualClaims) {
        if (-not $Claim.PSObject.Properties['linked_taxonomy_nodes']) { continue }
        $Nodes = @($Claim.linked_taxonomy_nodes)
        if ($Nodes.Count -eq 0) { continue }
        foreach ($NodeId in $Nodes) {
            if     ($NodeId -like 'acc-*') { $ClaimsPov.Accelerationist++ }
            elseif ($NodeId -like 'saf-*') { $ClaimsPov.Safetyist++ }
            elseif ($NodeId -like 'skp-*') { $ClaimsPov.Skeptic++ }
            elseif ($NodeId -like 'sit-*') { $ClaimsPov.Situations++ }
        }
    }
}

function Get-AITSourceSummaryTotalFacts {
    <#
    .SYNOPSIS
        Sums key_points across the accelerationist/safetyist/skeptic pov_summaries
        (t/3910 summary-fallback helper, no behavior change).
    .DESCRIPTION
        Each POV and its key_points are presence-guarded, so a summary lacking pov_summaries,
        a POV, or a POV's key_points yields 0 rather than a StrictMode PropertyNotFoundException
        (t/4008). Extracted verbatim from Resolve-AITSourceStats.
    .PARAMETER Summary
        The parsed summary JSON object.
    .PARAMETER SummaryProps
        The summary's PSObject.Properties collection.
    .OUTPUTS
        [int] total facts.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][PSObject]$Summary,
        [Parameter(Mandatory)][PSObject]$SummaryProps
    )
    Set-StrictMode -Version Latest

    $TotalFacts   = 0
    $PovSummaries = if ($SummaryProps['pov_summaries']) { $Summary.pov_summaries } else { $null }
    foreach ($Pov_ in @('accelerationist', 'safetyist', 'skeptic')) {
        $PovData = if ($PovSummaries -and $PovSummaries.PSObject.Properties[$Pov_]) { $PovSummaries.$Pov_ } else { $null }
        if ($PovData -and $PovData.PSObject.Properties['key_points'] -and $PovData.key_points) {
            $TotalFacts += @($PovData.key_points).Count
        }
    }
    return $TotalFacts
}

function Resolve-AITSourceStatsFromMeta {
    <#
    .SYNOPSIS
        Builds the stats object from stats cached in metadata (written by Invoke-POVSummary)
        (t/3910 helper, no behavior change). Used when metadata has total_claims.
    .PARAMETER Meta
        The parsed metadata.json object.
    .PARAMETER Props
        The metadata's PSObject.Properties collection.
    .OUTPUTS
        [PSCustomObject] { TotalClaims; ClaimsByPov; TotalFacts; UnmappedConcepts }
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)][PSObject]$Meta,
        [Parameter(Mandatory)][PSObject]$Props
    )
    Set-StrictMode -Version Latest

    if ($Props['unmapped_concepts'] -and $Meta.unmapped_concepts -is [int]) {
        $UnmappedConcepts = [int]$Meta.unmapped_concepts
    } else {
        $UnmappedConcepts = 0
    }

    return [PSCustomObject]@{
        TotalClaims      = [int]$Meta.total_claims
        ClaimsByPov      = ConvertTo-AITSourceClaimsByPov -Meta $Meta
        TotalFacts       = [int](Get-AITSourcePropValue -Object $Meta -Name 'total_facts' -Default 0)
        UnmappedConcepts = $UnmappedConcepts
    }
}

function Resolve-AITSourceStatsFromSummary {
    <#
    .SYNOPSIS
        Computes the stats object from the parsed summary file (t/3910 helper, no behavior
        change). Used when metadata has no cached total_claims.
    .DESCRIPTION
        Every top-level key is guarded via PSObject.Properties (t/4008): a parsed summary may
        lack any of them (model_info-only / legacy ai_model-only), and a bare dot-access on an
        absent property throws under StrictMode.
        (Explicit guards, not @(Get-AITSourcePropValue -Default $null): @($null) is a 1-element array.)
        The @() must wrap the whole `if` statement: statement output is enumerated, so
        `$x = if (..) { @(..) } else { @() }` collapses an empty array to $null (and 1 item to a scalar).
    .PARAMETER Summary
        The parsed summary JSON object.
    .OUTPUTS
        [PSCustomObject] { TotalClaims; ClaimsByPov; TotalFacts; UnmappedConcepts }
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param([Parameter(Mandatory)][PSObject]$Summary)
    Set-StrictMode -Version Latest

    $ClaimsPov    = [PSCustomObject]@{ Accelerationist = 0; Safetyist = 0; Skeptic = 0; Situations = 0 }
    $SummaryProps = $Summary.PSObject.Properties
    $FactualClaims = @(if ($SummaryProps['factual_claims'] -and $Summary.factual_claims) { $Summary.factual_claims })

    Add-AITSourceClaimPovCounts -FactualClaims $FactualClaims -ClaimsPov $ClaimsPov

    $UnmappedConcepts = 0
    if ($SummaryProps['unmapped_concepts'] -and $Summary.unmapped_concepts) {
        $UnmappedConcepts = @($Summary.unmapped_concepts).Count
    }

    return [PSCustomObject]@{
        TotalClaims      = $FactualClaims.Count
        ClaimsByPov      = $ClaimsPov
        TotalFacts       = Get-AITSourceSummaryTotalFacts -Summary $Summary -SummaryProps $SummaryProps
        UnmappedConcepts = $UnmappedConcepts
    }
}

function Resolve-AITSourceStats {
    <#
    .SYNOPSIS
        Resolves TotalClaims/ClaimsByPov/TotalFacts/UnmappedConcepts for the full-scan path
        (t/3910 decomposition of Get-AITSource, no behavior change).
    .DESCRIPTION
        Prefers stats cached in metadata (written by Invoke-POVSummary); falls back to
        computing from the parsed summary file when metadata has no cached total_claims.

        Every summary key read in the fallback branch (factual_claims, pov_summaries,
        unmapped_concepts) is guarded, so a summary that parsed successfully but lacks them
        (e.g. a model_info-only or legacy ai_model-only summary) yields zeros rather than a
        StrictMode PropertyNotFoundException (fixed in t/4008; was reproduced bug-for-bug by
        the t/3910 refactor).
    .PARAMETER Meta
        The parsed metadata.json object.
    .PARAMETER Summary
        The parsed summary JSON object, or $null if none exists / failed to parse.
    .OUTPUTS
        [PSCustomObject] { TotalClaims; ClaimsByPov; TotalFacts; UnmappedConcepts }
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)][PSObject]$Meta,
        [AllowNull()][PSObject]$Summary
    )
    Set-StrictMode -Version Latest

    $Props = $Meta.PSObject.Properties

    if ($Props['total_claims']) {
        return Resolve-AITSourceStatsFromMeta -Meta $Meta -Props $Props
    }
    if ($null -ne $Summary) {
        return Resolve-AITSourceStatsFromSummary -Summary $Summary
    }

    return [PSCustomObject]@{
        TotalClaims      = 0
        ClaimsByPov      = [PSCustomObject]@{ Accelerationist = 0; Safetyist = 0; Skeptic = 0; Situations = 0 }
        TotalFacts       = 0
        UnmappedConcepts = 0
    }
}
