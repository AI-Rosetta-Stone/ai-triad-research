# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Validates a POV node ID format and category consistency.
.DESCRIPTION
    PowerShell equivalent of lib/debate/validateNodeId.ts.
    POV node IDs must match: {acc|saf|skp}-{beliefs|desires|intentions}-{NNN}
    Also validates that the category segment matches the node's actual category.
.PARAMETER Id
    The node ID to validate.
.PARAMETER Category
    The node's BDI category (Beliefs, Desires, Intentions). If provided,
    checks that the ID's category segment matches.
.OUTPUTS
    Returns $true if valid, throws ActionableError if invalid.
#>
function Test-PovNodeId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Id,

        [string]$Category
    )

    # Valid patterns
    $PovPattern  = '^(acc|saf|skp)-(beliefs|desires|intentions)-(\d{3,})$'
    $SitPattern  = '^sit-(\d{3,})$'
    $CcPattern   = '^cc-(\d{3,})$'
    $PolPattern  = '^pol-(\d{3,})$'

    $CategoryMap = @{
        beliefs    = 'Beliefs'
        desires    = 'Desires'
        intentions = 'Intentions'
    }

    if ($Id -match $PovPattern) {
        $IdCategory = $CategoryMap[$Matches[2]]
        if ($Category -and $IdCategory -ne $Category) {
            $ExpectedSegment = ($CategoryMap.GetEnumerator() | Where-Object { $_.Value -eq $Category }).Key
            throw (New-ActionableError `
                -Goal "Create taxonomy node with valid BDI ID" `
                -Problem "Category mismatch: node ID '$Id' has category '$IdCategory' but node.category is '$Category'. Expected ID to contain '-${ExpectedSegment}-'" `
                -Location 'Test-PovNodeId' `
                -NextSteps @("Fix the suggested_id to use '-${ExpectedSegment}-' instead of '-$($Matches[2])-'") `
                -AsErrorRecord)
        }
        return $true
    }

    if ($Id -match $SitPattern -or $Id -match $CcPattern -or $Id -match $PolPattern) {
        return $true
    }

    throw (New-ActionableError `
        -Goal "Create taxonomy node with valid ID" `
        -Problem "Invalid node ID '$Id'. Expected format: {acc|saf|skp}-{beliefs|desires|intentions}-{NNN}, sit-{NNN}, cc-{NNN}, or pol-{NNN}" `
        -Location 'Test-PovNodeId' `
        -NextSteps @(
            'Check that the POV prefix is acc, saf, or skp'
            'Check that the category is beliefs, desires, or intentions'
            'Check that the number is 3+ digits, zero-padded'
        ) `
        -AsErrorRecord)
}
