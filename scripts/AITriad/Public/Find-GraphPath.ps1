# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Find-GraphPath {
    <#
    .SYNOPSIS
        Finds shortest paths between two nodes in the taxonomy graph.
    .DESCRIPTION
        Uses BFS to find the shortest path from one node to another, traversing
        edges according to directionality rules. Returns all paths of the shortest
        length (there may be multiple).
    .PARAMETER From
        Source node ID.
    .PARAMETER To
        Target node ID.
    .PARAMETER MaxHops
        Maximum path length to search. Default: 4.
    .PARAMETER EdgeType
        Only traverse edges of this type. If omitted, all edge types are used.
    .PARAMETER Status
        Only traverse edges with this approval status. Default: all.
    .PARAMETER IncludeSuperseded
        Also traverse edges with a superseded endpoint (history). By default the
        walk never enters a superseded node (t/4356).
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Find-GraphPath -From "acc-desires-001" -To "saf-desires-001"
    .EXAMPLE
        Find-GraphPath -From "acc-desires-001" -To "skp-intentions-003" -MaxHops 4
    .LINK
        Show-AITriadHelp
    .LINK
        Find-Conflict
    .LINK
        Invoke-GraphQuery
    .LINK
        Invoke-CypherQuery
    .LINK
        Invoke-QbafConflictAnalysis
    .LINK
        Show-GraphOverview
    .LINK
        Export-TaxonomyToGraph
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$From,

        [Parameter(Mandatory, Position = 1)]
        [string]$To,

        [ValidateRange(1, 10)]
        [int]$MaxHops = 4,

        [string]$EdgeType = '',

        [ValidateSet('proposed', 'approved', 'rejected', '')]
        [string]$Status = '',

        [switch]$IncludeSuperseded,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir = Get-TaxonomyDir

    # Load all nodes
    $AllNodes = @{}
    $NodePovMap = @{}
    foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }
        try {
            $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        }
        catch {
            Write-Warn "Failed to load $PovKey.json — $($_.Exception.Message)"
            continue
        }
        foreach ($Node in $FileData.nodes) {
            $AllNodes[$Node.id] = $Node
            $NodePovMap[$Node.id] = $PovKey
        }
    }

    if (-not $AllNodes.ContainsKey($From)) {
        Write-Fail "Source node not found: $From"
        return
    }
    if (-not $AllNodes.ContainsKey($To)) {
        Write-Fail "Target node not found: $To"
        return
    }

    # Load edges
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    if (-not (Test-Path $EdgesPath)) {
        Write-Warn 'No edges.json found. Run Invoke-EdgeDiscovery first.'
        return
    }
    $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json

    # Build adjacency: nodeId → list of (neighbor, edge)
    $Adjacency = @{}
    $Superseded = $null   # assigned directly: an if-expression would unroll the HashSet
    if (-not $IncludeSuperseded) { $Superseded = Get-SupersededNodeIdSet }
    foreach ($Edge in $EdgesData.edges) {
        if ($EdgeType -and $Edge.type -ne $EdgeType) { continue }
        if ($Status -and $Edge.status -ne $Status) { continue }
        if ($null -ne $Superseded -and ($Superseded.Contains([string]$Edge.source) -or $Superseded.Contains([string]$Edge.target))) { continue }

        # Forward direction
        if (-not $Adjacency.ContainsKey($Edge.source)) {
            $Adjacency[$Edge.source] = [System.Collections.Generic.List[PSObject]]::new()
        }
        $Adjacency[$Edge.source].Add([PSCustomObject]@{ Neighbor = $Edge.target; Edge = $Edge })

        # Reverse for bidirectional
        if ($Edge.PSObject.Properties['bidirectional'] -and $Edge.bidirectional) {
            if (-not $Adjacency.ContainsKey($Edge.target)) {
                $Adjacency[$Edge.target] = [System.Collections.Generic.List[PSObject]]::new()
            }
            $Adjacency[$Edge.target].Add([PSCustomObject]@{ Neighbor = $Edge.source; Edge = $Edge })
        }
    }

    # BFS for shortest paths
    # Each queue entry: { NodeId, Path = @(nodeIds), Edges = @(edges) }
    $Queue = [System.Collections.Generic.Queue[PSObject]]::new()
    $Queue.Enqueue([PSCustomObject]@{
        NodeId = $From
        Path   = @($From)
        Edges  = @()
    })

    $FoundPaths = [System.Collections.Generic.List[PSObject]]::new()
    $ShortestLength = [int]::MaxValue
    $Visited = [System.Collections.Generic.HashSet[string]]::new()

    while ($Queue.Count -gt 0) {
        $Current = $Queue.Dequeue()

        if ($Current.Path.Count -gt $MaxHops + 1) { continue }
        if ($Current.Path.Count -gt $ShortestLength) { continue }

        if ($Current.NodeId -eq $To) {
            if ($Current.Path.Count -le $ShortestLength) {
                $ShortestLength = $Current.Path.Count
                $FoundPaths.Add([PSCustomObject]@{
                    path  = $Current.Path
                    edges = $Current.Edges
                    hops  = $Current.Path.Count - 1
                })
            }
            continue
        }

        [void]$Visited.Add($Current.NodeId)

        if ($Adjacency.ContainsKey($Current.NodeId)) {
            foreach ($Adj in $Adjacency[$Current.NodeId]) {
                if ($Current.Path -contains $Adj.Neighbor) { continue }

                $NewPath = @($Current.Path) + $Adj.Neighbor
                $NewEdges = @($Current.Edges) + $Adj.Edge

                $Queue.Enqueue([PSCustomObject]@{
                    NodeId = $Adj.Neighbor
                    Path   = $NewPath
                    Edges  = $NewEdges
                })
            }
        }
    }

    if ($FoundPaths.Count -eq 0) {
        Write-Warn "No path found from $From to $To within $MaxHops hops"
        return [PSCustomObject]@{
            from       = $From
            to         = $To
            paths      = @()
            path_count = 0
        }
    }

    # Enrich paths with node labels
    $EnrichedPaths = foreach ($P in $FoundPaths) {
        $Steps = for ($i = 0; $i -lt $P.path.Count; $i++) {
            $NId = $P.path[$i]
            $N = $AllNodes[$NId]
            $Step = [ordered]@{
                id    = $NId
                pov   = $NodePovMap[$NId]
                label = $N.label
            }
            if ($i -lt $P.edges.Count) {
                $Step['edge_to_next'] = $P.edges[$i].type
            }
            [PSCustomObject]$Step
        }
        [PSCustomObject]@{
            hops  = $P.hops
            steps = $Steps
            edges = $P.edges
        }
    }

    [PSCustomObject]@{
        from       = $From
        to         = $To
        paths      = $EnrichedPaths
        path_count = $EnrichedPaths.Count
    }
}
