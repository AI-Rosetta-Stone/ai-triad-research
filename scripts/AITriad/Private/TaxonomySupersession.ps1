# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# POV node supersession (t/4356, mirrors lib/debate/supersession.ts and taxonomyLoader.ts, t/4354).
#   - Selection skips a POV node that carries a non-empty `superseded_by`.
#   - Lookup by id returns the stored node, superseded or not (historical display).
#   - Resolve follows `superseded_by` chains to the survivor. A cycle or dangling target returns the
#     node itself and WARNs; an unknown id returns $null; nothing throws.
# Only the three POV camps take part; situations are never filtered (the TS loader leaves them whole).
# tests/fixtures/supersession-cases.json pins both implementations to the same cases.

$script:SupersessionPovKeys = @('accelerationist', 'safetyist', 'skeptic')
$script:TaxonomySupersession = $null      # index over the cached POV nodes, set by Update-TaxonomySupersessionCache
$script:TaxonomyAllNodesByPov = @{}       # pov -> every stored node (superseded included), in file order

function Test-TaxonomyNodeSuperseded {
    <#
    .SYNOPSIS
        True when a node carries a non-empty superseded_by (TS `!!n.superseded_by`).
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)][AllowNull()][object]$Node)
    if ($null -eq $Node) { return $false }
    if ($Node -is [System.Collections.IDictionary]) {
        return [bool]($Node.Contains('superseded_by') -and $Node['superseded_by'])
    }
    return [bool]($Node.PSObject.Properties['superseded_by'] -and $Node.superseded_by)
}

function New-TaxonomySupersessionIndex {
    <#
    .SYNOPSIS
        Builds the supersession index over a flat list of POV nodes (all camps, superseded included).
    .DESCRIPTION
        Port of buildSupersessionIndex (lib/debate/supersession.ts). Resolution maps each superseded id
        to its survivor's id, or to $null for a cycle member or a dangling chain; Resolve-TaxonomyNode
        reads it. Warnings go through -Warn (default Write-Warning) and never throw.
    .OUTPUTS
        [pscustomobject] @{ AllNodesById; Resolution; SupersededIds }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Nodes,
        [scriptblock]$Warn = { param([string]$Message) Write-Warning $Message }
    )
    $all = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($n in $Nodes) { if ($null -ne $n -and $n.id) { $all[[string]$n.id] = $n } }   # last wins, as Map does
    $resolution = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $depth = [System.Collections.Generic.Dictionary[string, int]]::new([StringComparer]::Ordinal)
    $superseded = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($n in $Nodes) { if ($null -ne $n -and $n.id -and (Test-TaxonomyNodeSuperseded $n)) { [void]$superseded.Add([string]$n.id) } }

    foreach ($start in $Nodes) {
        if ($null -eq $start -or -not $start.id -or -not (Test-TaxonomyNodeSuperseded $start)) { continue }
        if ($resolution.ContainsKey([string]$start.id)) { continue }

        # Walk until a survivor, an already-settled node, a cycle or a dangling target.
        $chain = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $cur = [string]$start.id
        $end = 'cached'; $missing = $null
        while (-not $resolution.ContainsKey($cur)) {
            if ($seen.Contains($cur)) { $end = 'cycle'; break }
            $chain.Add($cur); [void]$seen.Add($cur)
            $node = $all[$cur]
            $next = if (Test-TaxonomyNodeSuperseded $node) { [string]$node.superseded_by } else { $null }
            if (-not $next) { $end = 'survivor'; break }
            if (-not $all.ContainsKey($next)) { $end = 'dangling'; $missing = $next; break }
            $cur = $next
        }

        switch ($end) {
            'cycle' {
                $members = @($chain.GetRange($chain.IndexOf($cur), $chain.Count - $chain.IndexOf($cur))) + $cur
                & $Warn "loadTaxonomy: supersession cycle: $($members -join ' → ') — members excluded from selection"
                foreach ($id in $chain) { $resolution[$id] = $null }
            }
            'dangling' {
                & $Warn "loadTaxonomy: node $cur superseded_by `"$missing`" not found in taxonomy — treating as no survivor"
                foreach ($id in $chain) { $resolution[$id] = $null }
            }
            'survivor' {
                for ($i = 0; $i -lt $chain.Count; $i++) {
                    if ($chain[$i] -ceq $cur) { continue }
                    $resolution[$chain[$i]] = $cur
                    $depth[$chain[$i]] = $chain.Count - 1 - $i
                }
                if ($chain.Count - 1 -gt 1) { & $Warn "loadTaxonomy: supersession chain $($chain -join ' → ') — resolves to $cur" }
            }
            default {
                # Reached a node settled by an earlier walk: inherit its result.
                $existing = $resolution[$cur]
                $cachedDepth = if ($depth.ContainsKey($cur)) { $depth[$cur] } else { 0 }
                if ($null -ne $existing -and $chain.Count + $cachedDepth -gt 1) {
                    & $Warn "loadTaxonomy: supersession chain $((@($chain) + $cur) -join ' → ') — resolves to $existing"
                }
                for ($i = 0; $i -lt $chain.Count; $i++) {
                    if ($resolution.ContainsKey($chain[$i])) { continue }
                    $resolution[$chain[$i]] = $existing
                    if ($null -ne $existing) { $depth[$chain[$i]] = $chain.Count - $i + $cachedDepth }
                }
            }
        }
    }
    [pscustomobject]@{ AllNodesById = $all; Resolution = $resolution; SupersededIds = $superseded }
}

function Resolve-TaxonomyNode {
    <#
    .SYNOPSIS
        Resolves an id through the supersession index: the survivor for a superseded node, the node
        itself for a live node, a cycle member or a dangling chain, and $null for an unknown id.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)][pscustomobject]$Index,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Id
    )
    if (-not $Id -or -not $Index.AllNodesById.ContainsKey($Id)) { return $null }
    $node = $Index.AllNodesById[$Id]
    if (-not (Test-TaxonomyNodeSuperseded $node)) { return $node }
    $survivor = if ($Index.Resolution.ContainsKey($Id)) { $Index.Resolution[$Id] } else { $null }
    if (-not $survivor -or -not $Index.AllNodesById.ContainsKey([string]$survivor)) { return $node }
    return $Index.AllNodesById[[string]$survivor]
}

function Select-SelectableTaxonomyNode {
    <#
    .SYNOPSIS
        Drops superseded nodes, keeping order. Use for any node list an AI model or a selection UI sees.
        Call it as @(Select-SelectableTaxonomyNode ...).
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowNull()][object[]]$Nodes,
        # The camp or file the nodes came from: a situations (or other non-camp) list passes through whole.
        [string]$Pov
    )
    # Emits the nodes one by one (wrap the call in @()): a comma-wrapped array would turn @(...) at the
    # call site into a one-element array holding the real one.
    if ($Pov -and [System.IO.Path]::GetFileNameWithoutExtension($Pov).ToLowerInvariant() -notin $script:SupersessionPovKeys) {
        return $Nodes | Where-Object { $null -ne $_ }
    }
    $Nodes | Where-Object { $null -ne $_ -and -not (Test-TaxonomyNodeSuperseded $_) }
}

function ConvertTo-SurvivorNodeId {
    <#
    .SYNOPSIS
        For a node id cited in NEW AI output: a superseded id becomes its survivor's id, with a WARN.
        Any other id (live, unknown, cycle member, dangling chain) comes back unchanged.
    .DESCRIPTION
        TL t/4356#7 decision 2: new attribution goes to the survivor. Never apply it to ids already in
        stored records; historical display stays exact. Reads the module cache's index; with no index
        loaded it returns the id unchanged.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string]$Id,
        [string]$Context = 'AI output'
    )
    if (-not $Id) { return $Id }
    Assert-TaxonomyCacheFresh   # 30 s cooldown, so per-edge calls stay cheap
    $idx = $script:TaxonomySupersession
    if (-not $idx -or -not $idx.SupersededIds.Contains($Id)) { return $Id }
    $survivor = Resolve-TaxonomyNode -Index $idx -Id $Id
    if ($null -eq $survivor -or [string]$survivor.id -ceq $Id) { return $Id }
    Write-Warning "WARN ${Context}: cited node $Id is superseded; attributing to survivor $($survivor.id) (t/4356)"
    return [string]$survivor.id
}

function Set-TaxonomyDocumentSelectable {
    <#
    .SYNOPSIS
        Narrows a parsed POV file's .nodes to the selectable ones, in place, for a prompt-only copy.
    .DESCRIPTION
        For producers that read a POV file directly to build an AI prompt (t/4356 PR B). Never call it
        on a document that will be written back: the superseded nodes would be dropped from the file.
        A situations file, or a name that isn't a POV camp, is left whole (TS loader parity).
    .PARAMETER Name
        The camp key or file name (accelerationist / accelerationist.json, ...).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Document,
        [Parameter(Mandatory)][string]$Name
    )
    $pov = [System.IO.Path]::GetFileNameWithoutExtension($Name).ToLowerInvariant()
    if ($null -eq $Document -or $pov -notin $script:SupersessionPovKeys) { return }
    if ($Document -is [System.Collections.IDictionary]) {
        if ($Document.Contains('nodes')) { $Document['nodes'] = @(Select-SelectableTaxonomyNode -Nodes @($Document['nodes'])) }
        return
    }
    if ($Document.PSObject.Properties['nodes']) { $Document.nodes = @(Select-SelectableTaxonomyNode -Nodes @($Document.nodes)) }
}

function Update-TaxonomySupersessionCache {
    <#
    .SYNOPSIS
        After a (re)load of $script:TaxonomyData: index every POV node, keep the full per-POV lists in
        $script:TaxonomyAllNodesByPov, and narrow each POV entry's .nodes to the selectable ones.
    .DESCRIPTION
        Safe because no writer serializes $script:TaxonomyData: every POV writer reads its own file
        (t/4356#6). Called from both load sites: the module loader and Assert-TaxonomyCacheFresh.
    #>
    [CmdletBinding()]
    param()
    $script:TaxonomyAllNodesByPov = @{}
    $allPov = [System.Collections.Generic.List[object]]::new()
    foreach ($pov in $script:SupersessionPovKeys) {
        if (-not $script:TaxonomyData.ContainsKey($pov)) { continue }
        $full = [object[]]@($script:TaxonomyData[$pov].nodes)
        $script:TaxonomyAllNodesByPov[$pov] = $full
        foreach ($n in $full) { $allPov.Add($n) }
    }
    $script:TaxonomySupersession = New-TaxonomySupersessionIndex -Nodes $allPov.ToArray()
    if ($script:TaxonomySupersession.SupersededIds.Count -eq 0) { return }
    foreach ($pov in $script:TaxonomyAllNodesByPov.Keys) {
        $script:TaxonomyData[$pov].nodes = @(Select-SelectableTaxonomyNode -Nodes $script:TaxonomyAllNodesByPov[$pov])
    }
    Write-Verbose "Taxonomy: $($script:TaxonomySupersession.SupersededIds.Count) superseded POV node(s) excluded from selection"
}

function Get-SupersededNodeIdSet {
    <#
    .SYNOPSIS
        The superseded POV node ids from the (fresh) module cache, for the default edge views: an edge
        with a superseded endpoint is history, not graph (TS `selectableEdges`). Empty when none.
    #>
    [CmdletBinding()]
    param()
    Assert-TaxonomyCacheFresh
    if ($script:TaxonomySupersession) { return , $script:TaxonomySupersession.SupersededIds }
    return , [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
}

function Get-TaxonomyNodeById {
    <#
    .SYNOPSIS
        Looks a node up by id in the cached taxonomy, superseded nodes included.
    .PARAMETER Resolve
        Follow supersession to the survivor (new attribution). Without it, the exact stored node is
        returned (historical display). A situation or other non-POV id is returned as stored.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)][string]$Id,
        [switch]$Resolve
    )
    Assert-TaxonomyCacheFresh
    $idx = $script:TaxonomySupersession
    if ($idx -and $idx.AllNodesById.ContainsKey($Id)) {
        if ($Resolve) { return Resolve-TaxonomyNode -Index $idx -Id $Id }
        return $idx.AllNodesById[$Id]
    }
    foreach ($key in $script:TaxonomyData.Keys) {
        if ($key -in $script:SupersessionPovKeys) { continue }
        foreach ($n in @($script:TaxonomyData[$key].nodes)) { if ($n.id -ceq $Id) { return $n } }
    }
    return $null
}

function Read-PovTaxonomyNodes {
    <#
    .SYNOPSIS
        Reads one taxonomy file's nodes from disk for producers that don't use the module cache.
    .DESCRIPTION
        Reads with ConvertFrom-JsonPreserveShape, so ISO timestamps stay strings (no PS 7.4 date drift)
        and one-element arrays stay arrays. -Selectable drops superseded POV nodes; a situations file
        is returned whole, matching the TS loader.
    .PARAMETER Pov
        accelerationist, safetyist, skeptic or situations.
    #>
    [CmdletBinding()]
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)][ValidateSet('accelerationist', 'safetyist', 'skeptic', 'situations')][string]$Pov,
        [switch]$Selectable
    )
    $path = Get-TaxonomyDir "$Pov.json"
    if (-not (Test-Path -LiteralPath $path)) {
        New-ActionableError -Goal "read the $Pov taxonomy nodes" -Problem "$path not found" `
            -Location 'Read-PovTaxonomyNodes' -NextSteps @('Check $env:AI_TRIAD_DATA_ROOT or .aitriad.json points at the data repo') -Throw
    }
    $data = ConvertFrom-JsonPreserveShape -Json (Get-Content -Raw -LiteralPath $path)
    $nodes = if ($data.PSObject.Properties['nodes']) { [object[]]@($data.nodes) } else { [object[]]@() }
    if ($Selectable -and $Pov -in $script:SupersessionPovKeys) { return , [object[]]@(Select-SelectableTaxonomyNode -Nodes $nodes) }
    return , $nodes
}
