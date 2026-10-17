# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Find-OrganizationByPOV {
    <#
    .SYNOPSIS
        Filter organizations by their POV alignment score.
    .DESCRIPTION
        Returns organizations whose pov_alignment[Pov].score falls in the
        [-MinScore, MaxScore] window (inclusive). Sorted descending by score
        for the requested POV.

        Common patterns:
          -Pov safetyist -MinScore 0.5              # strong safetyist backers
          -Pov accelerationist -MaxScore -0.5       # strong accelerationist opponents
          -Pov skeptic -MinScore 0.3 -MaxScore 1.0  # skeptic-aligned only
    .PARAMETER Pov
        Which POV camp to score against (accelerationist, safetyist, skeptic).
    .PARAMETER MinScore
        Minimum acceptable score. Default: -1.0 (no lower bound).
    .PARAMETER MaxScore
        Maximum acceptable score. Default: 1.0 (no upper bound).
    .OUTPUTS
        [Organization[]] sorted by pov_alignment[Pov].score descending
    .EXAMPLE
        Find-OrganizationByPOV -Pov safetyist -MinScore 0.5
    .EXAMPLE
        Find-OrganizationByPOV -Pov accelerationist -MinScore -1.0 -MaxScore -0.5
    .LINK
        Show-AITriadHelp
    .LINK
        Get-Organization
    .LINK
        Find-OrganizationByTopic
    .LINK
        Get-OrganizationStakeholders
    .LINK
        Import-Organization
    .LINK
        Compare-OrganizationPositions
    #>
    [CmdletBinding()]
    [OutputType('Organization[]')]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('accelerationist','safetyist','skeptic')]
        [string]$Pov,

        [double]$MinScore = -1.0,
        [double]$MaxScore =  1.0
    )

    Set-StrictMode -Version Latest

    if ($MinScore -gt $MaxScore) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Filter organizations by POV alignment' `
            -Problem "-MinScore ($MinScore) exceeds -MaxScore ($MaxScore)" `
            -Location 'Find-OrganizationByPOV' `
            -NextSteps @('Swap -MinScore and -MaxScore', 'Or widen one bound'))
    }

    $store = Get-OrganizationsStore
    $orgs = @()
    if ($store.PSObject.Properties['organizations']) { $orgs = @($store.organizations) }

    $matches = foreach ($raw in $orgs) {
        if (-not $raw.PSObject.Properties['pov_alignment']) { continue }
        if (-not $raw.pov_alignment.PSObject.Properties[$Pov]) { continue }
        $entry = $raw.pov_alignment.$Pov
        # Post-t/1583: entries carry .tier (enum) instead of .score (numeric).
        # Map tier → representative midpoint so the -MinScore/-MaxScore
        # calling convention stays stable for backward compat.
        $score = if ($entry.PSObject.Properties['score']) {
            [double]$entry.score
        } elseif ($entry.PSObject.Properties['tier']) {
            ConvertFrom-PovTier -Tier ([string]$entry.tier)
        } else {
            continue
        }
        if ($score -lt $MinScore -or $score -gt $MaxScore) { continue }
        [PSCustomObject]@{ Raw = $raw; Score = $score }
    }

    $ordered = @($matches) | Sort-Object -Property Score -Descending
    return @($ordered | ForEach-Object { ConvertTo-OrganizationObject -Raw $_.Raw })
}
