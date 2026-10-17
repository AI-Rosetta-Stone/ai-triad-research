# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Compare-OrganizationPositions {
    <#
    .SYNOPSIS
        Side-by-side POV alignment comparison across two or more organizations.
    .DESCRIPTION
        Returns a table (array of PSCustomObject) where each row is a POV camp
        and each column is one of the requested organizations. Cell values are
        the pov_alignment[pov].score for that org.

        Useful for quickly answering "who agrees with whom" or building coalition
        visualizations. Pipe to Format-Table for a readable printout.
    .PARAMETER Id
        Two or more organization ids to compare.
    .OUTPUTS
        [PSCustomObject[]] — one row per POV camp
    .EXAMPLE
        Compare-OrganizationPositions -Id org-001,org-002,org-007
    .LINK
        Show-AITriadHelp
    .LINK
        Get-Organization
    .LINK
        Find-OrganizationByPOV
    .LINK
        Find-OrganizationByTopic
    .LINK
        Get-OrganizationStakeholders
    .LINK
        Import-Organization
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject[]])]
    param(
        [Parameter(Mandatory)]
        [ValidateCount(2, 20)]
        [string[]]$Id
    )

    Set-StrictMode -Version Latest

    $orgs = @()
    foreach ($i in $Id) {
        $o = Get-Organization -Id $i
        if (-not $o -or @($o).Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Compare organization positions' `
                -Problem "Organization id '$i' not found in the registry" `
                -Location 'Compare-OrganizationPositions' `
                -NextSteps @(
                    "Verify the id with: Get-Organization -Id $i",
                    'List all orgs with: Get-Organization'
                ))
        }
        $orgs += @($o)[0]
    }

    $povs = @('accelerationist','safetyist','skeptic')
    $rows = foreach ($pov in $povs) {
        $row = [ordered]@{ POV = $pov }
        foreach ($o in $orgs) {
            $label = if ($o.ShortName) { $o.ShortName } else { $o.Name }
            $score = if ($o.PovAlignment -and $o.PovAlignment.ContainsKey($pov)) {
                [double]$o.PovAlignment[$pov].Score
            } else { $null }
            $row[$label] = $score
        }
        [PSCustomObject]$row
    }
    return @($rows)
}
