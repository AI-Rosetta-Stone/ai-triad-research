# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-Edge {
    <#
    .SYNOPSIS
        Lists and filters edges in the taxonomy graph.
    .DESCRIPTION
        Reads edges.json and returns edges matching the specified criteria.
        All string filters support wildcards. Multiple filters are AND-combined.
        With no parameters, returns all edges sorted by confidence descending.
    .PARAMETER Source
        Wildcard pattern matched against the source node ID.
    .PARAMETER Target
        Wildcard pattern matched against the target node ID.
    .PARAMETER NodeId
        Wildcard pattern matched against either source or target node ID.
        Useful for finding all edges connected to a node regardless of direction.
    .PARAMETER Type
        Wildcard pattern matched against the edge type (e.g., SUPPORTS, 'TENS*').
    .PARAMETER Status
        Edge approval status: proposed, approved, or rejected.
    .PARAMETER MinConfidence
        Minimum confidence threshold (0.0-1.0). Default: 0.0.
    .PARAMETER MaxConfidence
        Maximum confidence threshold (0.0-1.0). Default: 1.0.
    .PARAMETER Bidirectional
        When specified, returns only bidirectional ($true) or directional ($false) edges.
    .PARAMETER CrossPov
        When specified, returns only cross-POV ($true) or same-POV ($false) edges.
    .PARAMETER Strength
        Wildcard pattern matched against the edge strength (strong, moderate, weak).
    .PARAMETER Model
        Wildcard pattern matched against the model that discovered the edge.
    .PARAMETER Rationale
        Wildcard pattern matched against the edge rationale text.
    .PARAMETER DiscoveredAfter
        Returns only edges discovered on or after this date (yyyy-MM-dd).
    .PARAMETER DiscoveredBefore
        Returns only edges discovered on or before this date (yyyy-MM-dd).
    .PARAMETER SourcePov
        Filter to edges whose source node belongs to this POV.
    .PARAMETER TargetPov
        Filter to edges whose target node belongs to this POV.
    .PARAMETER Id
        Return a specific edge by its display ID (e.g., edg-00042).
    .PARAMETER Index
        Return a specific edge by its zero-based index in edges.json.
    .PARAMETER First
        Return only the first N matching edges.
    .PARAMETER IncludeSuperseded
        Also return edges with a superseded endpoint (history, QBAF). By default
        they are left out (t/4356); -Id and -Index return any edge.
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Get-Edge
        # Returns all edges.
    .EXAMPLE
        Get-Edge -Source 'acc-desires-*'
        # All edges from accelerationist goal nodes.
    .EXAMPLE
        Get-Edge -NodeId 'saf-desires-001'
        # All edges connected to saf-desires-001 (source or target).
    .EXAMPLE
        Get-Edge -Type CONTRADICTS -Status approved
        # Approved contradictions.
    .EXAMPLE
        Get-Edge -CrossPov -MinConfidence 0.9
        # High-confidence cross-POV edges.
    .EXAMPLE
        Get-Edge -Rationale '*existential*' -Type 'TENS*'
        # Tension edges mentioning existential risk.
    .EXAMPLE
        Get-Edge -SourcePov safetyist -TargetPov accelerationist -Status approved
        # Approved edges from safetyist to accelerationist nodes.
    .EXAMPLE
        Get-Edge -Id edg-00042
        # Return edge by its display ID.
    .EXAMPLE
        Get-Edge -Index 42
        # Return edge at index 42.
    .EXAMPLE
        Get-Edge -Type SUPPORTS -First 10
        # First 10 SUPPORTS edges by confidence.
    .LINK
        Show-AITriadHelp
    .LINK
        Approve-Edge
    .LINK
        Set-Edge
    .LINK
        Test-EdgeDirection
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Invoke-EdgeWeightEvaluation
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Source,

        [string]$Target,

        [string]$NodeId,

        [string]$Type,

        [ValidateSet('proposed', 'approved', 'rejected', '')]
        [string]$Status,

        [ValidateRange(0.0, 1.0)]
        [double]$MinConfidence = 0.0,

        [ValidateRange(0.0, 1.0)]
        [double]$MaxConfidence = 1.0,

        [Nullable[bool]]$Bidirectional,

        [Nullable[bool]]$CrossPov,

        [string]$Strength,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model,

        [string]$Rationale,

        [string]$DiscoveredAfter,

        [string]$DiscoveredBefore,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations', '')]
        [string]$SourcePov,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations', '')]
        [string]$TargetPov,

        [ValidatePattern('^edg-\d{5}$')]
        [string]$Id,

        [int]$Index = -1,

        [int]$First = 0,

        [switch]$IncludeSuperseded,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir    = Get-TaxonomyDir
    $EdgesPath = Join-Path $TaxDir 'edges.json'

    if (-not (Test-Path $EdgesPath)) {
        Write-Fail 'No edges.json found. Run Invoke-EdgeDiscovery first.'
        return
    }

    $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json

    # ------------------------------------------------------------------
    # Id mode — convert edg-NNNNN to zero-based index
    # ------------------------------------------------------------------
    if ($Id) {
        $Index = [int]$Id.Substring(4) - 1
    }

    # ------------------------------------------------------------------
    # Index mode — fast return of a single edge
    # ------------------------------------------------------------------
    if ($Index -ge 0) {
        if ($Index -ge $EdgesData.edges.Count) {
            Write-Fail "Edge index $Index out of range (0-$($EdgesData.edges.Count - 1))."
            return
        }
        $E = $EdgesData.edges[$Index]
        return [PSCustomObject]@{
            PSTypeName    = 'AITriad.Edge'
            Id            = 'edg-{0:D5}' -f ($Index + 1)
            Index         = $Index
            Source        = $E.source
            Target        = $E.target
            Type          = $E.type
            Bidirectional = [bool]$E.bidirectional
            Confidence    = $E.confidence
            Weight        = if ($E.PSObject.Properties['weight']) { $E.weight } else { $null }
            Status        = $E.status
            Strength      = if ($E.PSObject.Properties['strength']) { $E.strength } else { $null }
            Rationale     = $E.rationale
            Notes         = if ($E.PSObject.Properties['notes']) { $E.notes } else { $null }
            DirectionFlag = if ($E.PSObject.Properties['direction_flag']) { $E.direction_flag } else { $null }
            DiscoveredAt  = $E.discovered_at
            Model         = $E.model
        }
    }

    # ------------------------------------------------------------------
    # Build node→POV map (only when POV-based filters are active)
    # ------------------------------------------------------------------
    $NodePovMap = $null
    if ($SourcePov -or $TargetPov -or $CrossPov -ne $null) {
        $NodePovMap = @{}
        foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
            $FilePath = Join-Path $TaxDir "$PovKey.json"
            if (-not (Test-Path $FilePath)) { continue }
            $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
            foreach ($Node in $FileData.nodes) {
                $NodePovMap[$Node.id] = $PovKey
            }
        }
    }

    # ------------------------------------------------------------------
    # Filter edges
    # ------------------------------------------------------------------
    $Results = [System.Collections.Generic.List[PSObject]]::new()
    $EdgeCount = $EdgesData.edges.Count
    # Edges touching a superseded node are history (t/4356); -Id / -Index still return any edge.
    $Superseded = $null   # assigned directly: an if-expression would unroll the HashSet
    if (-not $IncludeSuperseded) { $Superseded = Get-SupersededNodeIdSet }

    for ($i = 0; $i -lt $EdgeCount; $i++) {
        $E = $EdgesData.edges[$i]
        if ($null -ne $Superseded -and ($Superseded.Contains([string]$E.source) -or $Superseded.Contains([string]$E.target))) { continue }

        # Source/Target/NodeId wildcard filters
        if ($Source -and $E.source -notlike $Source) { continue }
        if ($Target -and $E.target -notlike $Target) { continue }
        if ($NodeId -and ($E.source -notlike $NodeId) -and ($E.target -notlike $NodeId)) { continue }

        # Type wildcard
        if ($Type -and $E.type -notlike $Type) { continue }

        # Status exact (guard for sparse legacy edges that omit status)
        if ($Status) {
            $EdgeStatus = if ($E.PSObject.Properties['status']) { $E.status } else { $null }
            if ($EdgeStatus -ne $Status) { continue }
        }

        # Confidence range (guard for legacy edges that omit confidence — treat as 0
        # so they fall out of any positive MinConfidence filter; pass when default 0..1)
        $EdgeConfidence = if ($E.PSObject.Properties['confidence']) { [double]$E.confidence } else { 0.0 }
        if ($EdgeConfidence -lt $MinConfidence) { continue }
        if ($EdgeConfidence -gt $MaxConfidence) { continue }

        # Bidirectional filter
        if ($null -ne $Bidirectional) {
            $IsBidir = if ($E.PSObject.Properties['bidirectional']) { [bool]$E.bidirectional } else { $false }
            if ($IsBidir -ne $Bidirectional) { continue }
        }

        # Strength wildcard
        if ($Strength) {
            if ($E.PSObject.Properties['strength']) { $EStrength = $E.strength } else { $EStrength = '' }
            if ($EStrength -notlike $Strength) { continue }
        }

        # Model wildcard (3,782 legacy edges lack `model`; treat absent as empty
        # so the filter excludes them when the user asks for a specific pattern)
        if ($Model) {
            $EModel = if ($E.PSObject.Properties['model']) { $E.model } else { '' }
            if ($EModel -notlike $Model) { continue }
        }

        # Rationale wildcard (defensive — currently 100% present, but the field
        # is optional in the TS Edge interface)
        if ($Rationale) {
            $ERationale = if ($E.PSObject.Properties['rationale']) { $E.rationale } else { '' }
            if ($ERationale -notlike $Rationale) { continue }
        }

        # Date range filters (defensive guard for discovered_at)
        if ($DiscoveredAfter -or $DiscoveredBefore) {
            $EDiscoveredAt = if ($E.PSObject.Properties['discovered_at']) { $E.discovered_at } else { $null }
            if ($DiscoveredAfter -and ($null -eq $EDiscoveredAt -or $EDiscoveredAt -lt $DiscoveredAfter)) { continue }
            if ($DiscoveredBefore -and ($null -ne $EDiscoveredAt -and $EDiscoveredAt -gt $DiscoveredBefore)) { continue }
        }

        # POV-based filters
        if ($NodePovMap) {
            if ($NodePovMap.ContainsKey($E.source)) { $SPov = $NodePovMap[$E.source] } else { $SPov = 'unknown' }
            if ($NodePovMap.ContainsKey($E.target)) { $TPov = $NodePovMap[$E.target] } else { $TPov = 'unknown' }

            if ($SourcePov -and $SPov -ne $SourcePov) { continue }
            if ($TargetPov -and $TPov -ne $TargetPov) { continue }

            if ($null -ne $CrossPov) {
                $IsCross = $SPov -ne $TPov
                if ($IsCross -ne $CrossPov) { continue }
            }
        }

        # t/1197: every optional field gets a PSObject.Properties guard. The TS Edge
        # interface (taxonomy-editor/src/renderer/types/taxonomy.ts:320-334) has more
        # optional fields than the legacy data actually carries — guarding consistently
        # here prevents PropertyNotFoundException under StrictMode when older edges
        # (e.g. 3,782 pre-model-tracking entries) are read.
        $Results.Add([PSCustomObject]@{
            PSTypeName    = 'AITriad.Edge'
            Id            = 'edg-{0:D5}' -f ($i + 1)
            Index         = $i
            Source        = $E.source
            Target        = $E.target
            Type          = $E.type
            Bidirectional = if ($E.PSObject.Properties['bidirectional']) { [bool]$E.bidirectional } else { $false }
            Confidence    = if ($E.PSObject.Properties['confidence']) { $E.confidence } else { $null }
            Weight        = if ($E.PSObject.Properties['weight']) { $E.weight } else { $null }
            Status        = if ($E.PSObject.Properties['status']) { $E.status } else { $null }
            Strength      = if ($E.PSObject.Properties['strength']) { $E.strength } else { $null }
            Rationale     = if ($E.PSObject.Properties['rationale']) { $E.rationale } else { $null }
            Notes         = if ($E.PSObject.Properties['notes']) { $E.notes } else { $null }
            DirectionFlag = if ($E.PSObject.Properties['direction_flag']) { $E.direction_flag } else { $null }
            DiscoveredAt  = if ($E.PSObject.Properties['discovered_at']) { $E.discovered_at } else { $null }
            Model         = if ($E.PSObject.Properties['model']) { $E.model } else { $null }
        })

        if ($First -gt 0 -and $Results.Count -ge $First) { break }
    }

    if ($Results.Count -eq 0) {
        Write-Warning 'No edges matched the specified filters.'
        return
    }

    $Results | Sort-Object Confidence -Descending
}
