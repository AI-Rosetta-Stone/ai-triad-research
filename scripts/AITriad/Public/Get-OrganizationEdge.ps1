# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-OrganizationEdge {
    <#
    .SYNOPSIS
        Look up organization actor-relationship edges.
    .DESCRIPTION
        Reads organization_edges.json and returns matching [OrganizationEdge] records.
        With no filters, returns all edges. Uses the module-scope cache — first call
        reads from disk, subsequent calls return cached results until mtime changes.
    .PARAMETER OrgId
        An org-* id. By default matches edges where OrgId is the source; use -Direction
        to control (Out matches source, In matches target, Either matches either).
    .PARAMETER Type
        Filter by canonical edge type (validated by Resolve-OrganizationEdgeType — any
        casing accepted, normalized to upper-case).
    .PARAMETER Direction
        Out (default): OrgId is the source. In: OrgId is the target. Either: both.
        Ignored if -OrgId is not supplied.
    .PARAMETER Target
        Filter by exact target id (org-* / sit-* / pol-* / src-* / BDI node).
    .OUTPUTS
        [OrganizationEdge]
    .EXAMPLE
        Get-OrganizationEdge -OrgId org-001
    .EXAMPLE
        Get-OrganizationEdge -OrgId org-001 -Direction Either -Type COMPETES_WITH
    .EXAMPLE
        Get-OrganizationEdge -Type FUNDS
    .LINK
        Show-AITriadHelp
    .LINK
        Import-OrganizationEdge
    .LINK
        Get-Organization
    #>
    [CmdletBinding()]
    [OutputType('OrganizationEdge')]
    param(
        [ValidatePattern('^org-\d{3,}$')]
        [string]$OrgId,

        [string]$Type,

        [ValidateSet('Out','In','Either')]
        [string]$Direction = 'Out',

        [string]$Target
    )

    Set-StrictMode -Version Latest

    $store = Get-OrganizationEdgesStore
    $raw = @()
    if ($store.PSObject.Properties['edges']) { $raw = @($store.edges) }

    # Normalize -Type once (any-case in, canonical out)
    $normType = ''
    if ($Type) {
        $res = Resolve-OrganizationEdgeType -Type $Type
        if ($res.Action -ne 'accept') {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Filter organization edges by type' `
                -Problem "-Type '$Type' is not in the organization edge registry: $($res.Reason)" `
                -Location 'Get-OrganizationEdge' `
                -NextSteps @(
                    'List valid types with: Get-OrganizationEdgeType',
                    'Registry lives in scripts/AITriad/Private/Resolve-OrganizationEdgeType.ps1'
                ))
        }
        $normType = $res.Type
    }

    $filtered = foreach ($e in $raw) {
        $s = if ($e.PSObject.Properties['source']) { [string]$e.source } else { '' }
        $t = if ($e.PSObject.Properties['target']) { [string]$e.target } else { '' }
        $y = if ($e.PSObject.Properties['type'])   { [string]$e.type }   else { '' }

        # NOTE: PowerShell `continue` inside a `switch` skips to the next switch case,
        # NOT to the next foreach iteration. Explicit if/elseif so `continue` breaks
        # to the outer foreach as intended.
        if ($OrgId) {
            if ($Direction -eq 'Out'    -and $s -ne $OrgId) { continue }
            if ($Direction -eq 'In'     -and $t -ne $OrgId) { continue }
            if ($Direction -eq 'Either' -and $s -ne $OrgId -and $t -ne $OrgId) { continue }
        }
        if ($normType -and $y.ToUpperInvariant() -ne $normType) { continue }
        if ($Target -and $t -ne $Target) { continue }

        ConvertTo-OrganizationEdgeObject -Raw $e
    }

    return @($filtered)
}
