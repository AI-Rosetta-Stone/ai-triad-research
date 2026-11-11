# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-OrganizationEdge {
    <#
    .SYNOPSIS
        Look up organization actor-relationship edges.
    .DESCRIPTION
        Reads organization_edges.json and returns matching [OrganizationEdge] records.
        With no filters, returns every edge except rejected ones (t/299): a rejected
        edge is a reviewer's "no", kept in the file only so seeding never re-proposes it.
        Pass -Status to choose statuses explicitly, including rejected. Uses the
        module-scope cache — first call reads from disk, subsequent calls return cached
        results until mtime changes.
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
    .PARAMETER Status
        Return only edges with these statuses (approved, proposed, disputed, rejected).
        An edge with no status field counts as approved. Default: every status except
        rejected. An edge with any other status is always returned, with a warning.
    .OUTPUTS
        [OrganizationEdge]
    .EXAMPLE
        Get-OrganizationEdge -OrgId org-001
    .EXAMPLE
        Get-OrganizationEdge -OrgId org-001 -Direction Either -Type COMPETES_WITH
    .EXAMPLE
        Get-OrganizationEdge -Type FUNDS
    .EXAMPLE
        Get-OrganizationEdge -OrgId org-017 -Status rejected
    .EXAMPLE
        Get-OrganizationEdge -Status approved, proposed, disputed, rejected
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

        [string]$Target,

        [ValidateSet('approved','proposed','disputed','rejected')]
        [string[]]$Status = @('approved','proposed','disputed')
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

    # Kept in step with the -Status ValidateSet. An edge outside it is returned with a WARN rather
    # than hidden, since no -Status value could ever select it.
    $KnownStatuses = @('approved', 'proposed', 'disputed', 'rejected')

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

        $edge = ConvertTo-OrganizationEdgeObject -Raw $e
        if ($KnownStatuses -notcontains $edge.Status) {
            Write-Warning "Get-OrganizationEdge: edge $s -> $t ($y) has unknown status '$($edge.Status)'; returning it regardless of -Status. Fix organization_edges.json or add the status to the cmdlet's -Status set."
            $edge
            continue
        }
        if ($Status -notcontains $edge.Status) { continue }
        $edge
    }

    return @($filtered)
}
