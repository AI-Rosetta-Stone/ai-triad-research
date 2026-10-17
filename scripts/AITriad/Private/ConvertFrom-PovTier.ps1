# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function ConvertFrom-PovTier {
    <#
    .SYNOPSIS
        Maps a PovAlignmentTier enum value to a representative numeric
        midpoint on the [-1, +1] scale.
    .DESCRIPTION
        t/1583 replaced numeric pov_alignment.<camp>.score with a 5-point
        tier enum. Public cmdlets that still accept -MinScore/-MaxScore
        (Find-OrganizationByPOV) or emit a Score property
        (Compare-OrganizationPositions) call this helper to preserve their
        calling convention on the new schema.

        Midpoints intentionally straddle the bucket boundaries so
        MinScore=0.5 (a common "strong backers" filter) matches
        champions but not leans_toward — reproducing the old numeric
        semantics with a stable string domain.
    #>
    [CmdletBinding()]
    [OutputType([double])]
    param(
        [Parameter(Mandatory)]
        [string]$Tier
    )
    Set-StrictMode -Version Latest

    switch ($Tier) {
        'opposes'         { return -0.75 }
        'leans_against'   { return -0.325 }
        'mixed_or_silent' { return  0.0 }
        'leans_toward'    { return  0.35 }
        'champions'       { return  0.775 }
        default {
            throw (New-ActionableError `
                -Goal 'Convert PovAlignmentTier to representative numeric' `
                -Problem "Unknown tier '$Tier' — expected opposes / leans_against / mixed_or_silent / leans_toward / champions" `
                -Location 'ConvertFrom-PovTier' `
                -NextSteps @('Verify the pov_alignment.<camp>.tier value on the source org',
                             'Re-run migrate-t1583-tier-conversion.ps1 to normalize') `
                -AsErrorRecord)
        }
    }
}
