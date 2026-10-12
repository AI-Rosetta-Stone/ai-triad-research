# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Steps of Invoke-HierarchyProposal (t/3910 complexity refactor). Behaviour is pinned by
# tests/Invoke-HierarchyProposal.Characterization.Tests.ps1. These helpers run under the caller's
# Set-StrictMode -Version Latest and $ErrorActionPreference = 'Stop' (dynamic scope), so any
# dereference of a model-supplied field must be presence-guarded or it throws (t/4071).
# Collections that must keep their exact shape (empty, or a single element) are returned with
# the unary comma so the pipeline doesn't unroll them.

# Bucket size (exclusive upper bound) -> MaxClusters; larger buckets get the last value.
$script:HierarchyMaxClusterSteps = @(
    @{ Below = 10; Clusters = 2 }
    @{ Below = 20; Clusters = 4 }
    @{ Below = 40; Clusters = 6 }
)
$script:HierarchyMaxClustersCap = 8

# Resolves the output directory path only. It is created by Initialize-HierarchyOutputDir right
# before a write, so -DryRun and runs that produce no proposal create nothing (t/4071).
function Resolve-HierarchyOutputDir {
    param([string]$OutputDir)
    if ([string]::IsNullOrWhiteSpace($OutputDir)) {
        $OutputDir = Join-Path (Join-Path (Get-DataRoot) 'taxonomy') 'hierarchy-proposals'
    }
    $OutputDir
}

function Initialize-HierarchyOutputDir {
    param([string]$OutputDir)
    if (-not (Test-Path $OutputDir)) {
        $null = New-Item -Path $OutputDir -ItemType Directory -Force
    }
}


function Import-HierarchyTaxonomy {
    param([string]$TaxDir, [hashtable]$PovFileMap)
    $AllTaxData = @{}
    foreach ($PovKey in $PovFileMap.Keys) {
        $FilePath = Join-Path $TaxDir $PovFileMap[$PovKey]
        if (Test-Path $FilePath) {
            $AllTaxData[$PovKey] = Get-Content -Raw -Path $FilePath -Encoding UTF8 | ConvertFrom-Json
            Write-OK "$PovKey`: $($AllTaxData[$PovKey].nodes.Count) nodes"
        }
    }
    $AllTaxData
}

function Import-HierarchyEmbeddingTable {
    param([string]$TaxDir)
    $Embeddings = @{}
    $EmbeddingsPath = Join-Path $TaxDir 'embeddings.json'
    if (-not (Test-Path $EmbeddingsPath)) {
        Write-Warn 'embeddings.json not found — clustering will be skipped'
        return $Embeddings
    }
    try {
        $EmbJson = Get-Content -Raw -Path $EmbeddingsPath | ConvertFrom-Json
        foreach ($Prop in $EmbJson.nodes.PSObject.Properties) {
            $Embeddings[$Prop.Name] = [double[]]@($Prop.Value.vector)
        }
        Write-OK "Loaded embeddings for $($Embeddings.Count) nodes"
    }
    catch {
        Write-Warn "Could not load embeddings: $($_.Exception.Message)"
    }
    $Embeddings
}

function Import-HierarchyApprovedEdgeList {
    param([string]$TaxDir)
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    $AllEdges  = @()
    if (Test-Path $EdgesPath) {
        try {
            $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json
            $AllEdges  = @($EdgesData.edges | Where-Object { $_.status -eq 'approved' })
            Write-OK "Loaded $($AllEdges.Count) approved edges"
        }
        catch {
            Write-Warn "Could not load edges: $($_.Exception.Message)"
        }
    }
    , $AllEdges
}

function Get-HierarchyBucketList {
    param([hashtable]$AllTaxData, [string]$POV, [string]$Category)
    $Buckets = [System.Collections.Generic.List[PSObject]]::new()
    if ($POV) { $PovList = @($POV) } else { $PovList = @('accelerationist', 'safetyist', 'skeptic', 'situations') }
    foreach ($PovKey in $PovList) {
        if (-not $AllTaxData.ContainsKey($PovKey)) { continue }
        $Nodes = @($AllTaxData[$PovKey].nodes)
        if ($PovKey -eq 'situations') {
            # Cross-cutting has no categories — one bucket
            if (-not $Category) { $Buckets.Add([PSCustomObject]@{ POV = $PovKey; Category = $null; Nodes = $Nodes }) }
            continue
        }
        if ($Category) { $Categories = @($Category) } else { $Categories = @('Beliefs', 'Desires', 'Intentions') }
        foreach ($Cat in $Categories) {
            $CatNodes = @($Nodes | Where-Object { $_.category -eq $Cat })
            if ($CatNodes.Count -ge 2) { $Buckets.Add([PSCustomObject]@{ POV = $PovKey; Category = $Cat; Nodes = $CatNodes }) }
        }
    }
    , $Buckets
}

function Get-HierarchyCategoryLabel {
    param($Bucket)
    if ($Bucket.Category) { return $Bucket.Category }
    '(all)'
}

function Get-HierarchyMaxClusterCount {
    param([int]$NodeCount)
    foreach ($Step in $script:HierarchyMaxClusterSteps) {
        if ($NodeCount -lt $Step.Below) { return $Step.Clusters }
    }
    $script:HierarchyMaxClustersCap
}

# Phase 1.1: embedding clusters, or one cluster per node when fewer than two nodes have embeddings.
function Get-HierarchyBucketClusterSet {
    param($Bucket, [string[]]$NodeIds, [hashtable]$Embeddings, [double]$MinSimilarity)
    $HasEmbeddings = @($NodeIds | Where-Object { $Embeddings.ContainsKey($_) }).Count
    $Clusters = @()
    if ($HasEmbeddings -ge 2) {
        $MaxClusters = Get-HierarchyMaxClusterCount -NodeCount $Bucket.Nodes.Count
        $Clusters = Get-EmbeddingClusters `
            -NodeIds       $NodeIds `
            -Embeddings    $Embeddings `
            -MaxClusters   $MaxClusters `
            -MinSimilarity $MinSimilarity
        Write-OK "Clustering produced $($Clusters.Count) clusters"
    }
    else {
        Write-Warn "Only $HasEmbeddings nodes have embeddings — skipping clustering"
        # Fallback: each node is its own cluster
        $Clusters = @($NodeIds | ForEach-Object { , @($_) })
    }
    , $Clusters
}

# Phase 1.2: intra-cluster edge counts by type, and cohesion_score.
# cohesion_score is a 0-1 ratio (t/4073): the share of the cluster's unordered node pairs that are
# joined by at least one supportive edge (SUPPORTS, ASSUMES or SUPPORTED_BY, either direction).
# Several edges between the same two nodes count once, so the score can't exceed 1.0, which is what
# the hierarchy-proposal prompt's threshold (cohesion_score >= 0.50) assumes. It used to count
# every supportive edge over ordered pairs, an edge density that reached 1.5.
function Get-HierarchyClusterEdgeStat {
    param([string[]]$ClusterIds, $IdSet, $AllEdges)
    $IntraEdges = @{}
    $SupportedPairs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($E in $AllEdges) {
        if ($IdSet.Contains($E.source) -and $IdSet.Contains($E.target)) {
            $Type = $E.type
            if (-not $IntraEdges.ContainsKey($Type)) { $IntraEdges[$Type] = 0 }
            $IntraEdges[$Type]++
            if ($Type -in 'SUPPORTS', 'ASSUMES', 'SUPPORTED_BY' -and $E.source -ne $E.target) {
                $Pair = @([string]$E.source, [string]$E.target) | Sort-Object -CaseSensitive
                [void]$SupportedPairs.Add($Pair -join '|')
            }
        }
    }
    $PossiblePairs = $ClusterIds.Count * ($ClusterIds.Count - 1) / 2
    $Cohesion = 0.0
    if ($PossiblePairs -gt 0) { $Cohesion = [Math]::Round($SupportedPairs.Count / $PossiblePairs, 2) }
    [PSCustomObject]@{ IntraEdges = $IntraEdges; Cohesion = $Cohesion }
}

function Get-HierarchyGraphAttributeValue {
    param($Nodes, [string]$Name)
    @($Nodes | ForEach-Object {
            if ($_.graph_attributes.PSObject.Properties[$Name]) { $_.graph_attributes.$Name }
        } | Where-Object { $_ })
}

# Phase 1.3: shared epistemic type (>= 50%), shared rhetorical strategies (>= 40%) and coherence.
function Get-HierarchyClusterAttributeSummary {
    param($ClusterNodes)
    $Result = [PSCustomObject]@{ SharedEpistemicType = $null; SharedRhetorical = @(); AttributeCoherence = 0.0 }
    $NodesWithGA = @($ClusterNodes | Where-Object {
            $_.PSObject.Properties['graph_attributes'] -and $null -ne $_.graph_attributes
        })
    if ($NodesWithGA.Count -lt 2) { return $Result }

    $TypeGroups = @(Get-HierarchyGraphAttributeValue -Nodes $NodesWithGA -Name 'epistemic_type' | Group-Object | Sort-Object Count -Descending)
    if ($TypeGroups.Count -gt 0 -and $TypeGroups[0].Count -ge ($NodesWithGA.Count * 0.5)) {
        $Result.SharedEpistemicType = $TypeGroups[0].Name
    }

    $AllStrategies = @(Get-HierarchyGraphAttributeValue -Nodes $NodesWithGA -Name 'rhetorical_strategy' | ForEach-Object { $_ -split ',\s*' } | Where-Object { $_ })
    $StratGroups = @($AllStrategies | Group-Object | Sort-Object Count -Descending)
    $Result.SharedRhetorical = @($StratGroups |
            Where-Object { $_.Count -ge ($NodesWithGA.Count * 0.4) } |
            ForEach-Object { $_.Name })

    # Attribute coherence: fraction of attributes that match the dominant pattern
    $Matched = 0
    foreach ($N in $NodesWithGA) {
        if ($Result.SharedEpistemicType -and
            $N.graph_attributes.PSObject.Properties['epistemic_type'] -and
            $N.graph_attributes.epistemic_type -eq $Result.SharedEpistemicType) {
            $Matched++
        }
    }
    $Result.AttributeCoherence = [Math]::Round($Matched / $NodesWithGA.Count, 2)
    $Result
}

function ConvertTo-HierarchyClusterData {
    param($Clusters, $Bucket, $AllEdges)
    $ClusterData = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($RawCluster in $Clusters) {
        $ClusterIds = @($RawCluster)  # ensure array even for single-node clusters
        $IdSet = [System.Collections.Generic.HashSet[string]]::new(
            [string[]]$ClusterIds,
            [System.StringComparer]::OrdinalIgnoreCase
        )
        $EdgeStats = Get-HierarchyClusterEdgeStat -ClusterIds $ClusterIds -IdSet $IdSet -AllEdges $AllEdges
        $ClusterNodes = @($Bucket.Nodes | Where-Object { $IdSet.Contains($_.id) })
        $Attrs = Get-HierarchyClusterAttributeSummary -ClusterNodes $ClusterNodes
        $ClusterData.Add([PSCustomObject]@{
                cluster_id              = $ClusterData.Count
                node_ids                = @($ClusterIds)
                size                    = $ClusterIds.Count
                intra_edges             = $EdgeStats.IntraEdges
                cohesion_score          = $EdgeStats.Cohesion
                shared_epistemic_type   = $Attrs.SharedEpistemicType
                shared_rhetorical       = $Attrs.SharedRhetorical
                attribute_coherence     = $Attrs.AttributeCoherence
            })
    }
    , $ClusterData
}

# Node context for the prompt: id, label, description and a subset of graph attributes.
function ConvertTo-HierarchyNodeContextEntry {
    param($Node, [string]$Pov)
    $Entry = [ordered]@{
        id          = $Node.id
        label       = $Node.label
        description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
    }
    if ($Node.PSObject.Properties['graph_attributes'] -and $null -ne $Node.graph_attributes) {
        $GA = $Node.graph_attributes
        foreach ($AttrName in @('epistemic_type', 'rhetorical_strategy',
                                'intellectual_lineage', 'audience', 'emotional_register')) {
            if ($GA.PSObject.Properties[$AttrName] -and $null -ne $GA.$AttrName) {
                $Entry[$AttrName] = $GA.$AttrName
            }
        }
    }
    if ($Pov -eq 'situations' -and $Node.PSObject.Properties['interpretations']) {
        $Entry['interpretations'] = $Node.interpretations
    }
    $Entry
}

function Get-HierarchyBucketPrompt {
    param($Bucket, $ClusterData, [string]$SystemPrompt, [string]$SchemaPrompt)
    $NodeContext = foreach ($Node in $Bucket.Nodes) { ConvertTo-HierarchyNodeContextEntry -Node $Node -Pov $Bucket.POV }
    $ClusterContext = foreach ($C in $ClusterData) {
        [ordered]@{
            cluster_id            = $C.cluster_id
            node_ids              = $C.node_ids
            size                  = $C.size
            cohesion_score        = $C.cohesion_score
            intra_edges           = $C.intra_edges
            shared_epistemic_type = $C.shared_epistemic_type
            attribute_coherence   = $C.attribute_coherence
        }
    }

    $NodeJson    = $NodeContext    | ConvertTo-Json -Depth 10 -Compress:$false
    $ClusterJson = $ClusterContext | ConvertTo-Json -Depth 10 -Compress:$false

    if ($Bucket.Category) { $CatLine = "Category: $($Bucket.Category)" } else { $CatLine = 'Category: (none — situations)' }

    $UserPrompt = @"
POV: $($Bucket.POV)
$CatLine
Node count: $($Bucket.Nodes.Count)

--- NODES ---
$NodeJson

--- PRE-COMPUTED CLUSTERS ---
$ClusterJson

$SchemaPrompt
"@

    "$SystemPrompt`n`n$UserPrompt"
}

function Show-HierarchyDryRunPrompt {
    param([string]$FullPrompt)
    Write-Info 'DryRun — showing prompt for first bucket only'
    Write-Host ''
    Write-Host ($FullPrompt.Substring(0, [Math]::Min(3000, $FullPrompt.Length)))
    Write-Host "`n... (truncated, total $($FullPrompt.Length) chars)"
}

# Parses the model's text: strips a ```json fence, then tries Repair-TruncatedJson once.
# Returns @{ Proposal = ... } (the parse may legitimately yield $null), or $null when it can't parse.
function ConvertFrom-HierarchyResponse {
    param([string]$Text, [string]$BucketLabel)
    $ResponseText = $Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
    try {
        return [PSCustomObject]@{ Proposal = ($ResponseText | ConvertFrom-Json) }
    }
    catch {
        Write-Warn 'JSON parse failed, attempting repair...'
    }
    $Repaired = Repair-TruncatedJson -Text $ResponseText
    try {
        return [PSCustomObject]@{ Proposal = ($Repaired | ConvertFrom-Json) }
    }
    catch {
        Write-Fail "Could not parse response for $BucketLabel"
        return $null
    }
}

# Calls the model for one bucket. Returns the ConvertFrom-HierarchyResponse wrapper, or $null
# (after Write-Fail) when the call or the parse fails.
function Invoke-HierarchyBucketModel {
    param([string]$FullPrompt, [string]$Model, $ResolvedKey, [double]$Temperature, [string]$BucketLabel)
    Write-Info "Calling $Model ..."
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $Result = Invoke-AIApi `
            -Prompt      $FullPrompt `
            -Model       $Model `
            -ApiKey      $ResolvedKey `
            -Temperature $Temperature `
            -MaxTokens   65536 `
            -JsonMode `
            -TimeoutSec  600
    }
    catch {
        Write-Fail "API call failed for $BucketLabel`: $_"
        return $null
    }
    $Stopwatch.Stop()
    Write-OK "Response in $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"
    ConvertFrom-HierarchyResponse -Text $Result.Text -BucketLabel $BucketLabel
}

function Get-HierarchyParentChildList {
    param($Parent)
    if ($Parent.PSObject.Properties['children'] -and $null -ne $Parent.children) { return , @($Parent.children) }
    , @()
}

# Counts parents/children/outliers, collects every assigned id and warns on duplicates.
function Measure-HierarchyAssignment {
    param($Proposal)
    $Stats = [PSCustomObject]@{
        AssignedIds  = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        ParentCount  = 0
        ChildCount   = 0
        OutlierCount = 0
    }
    if ($Proposal.PSObject.Properties['parents']) {
        foreach ($Parent in @($Proposal.parents)) {
            $Stats.ParentCount++
            # Track promoted nodes
            if ($Parent.PSObject.Properties['promoted_from'] -and $Parent.promoted_from) {
                [void]$Stats.AssignedIds.Add($Parent.promoted_from)
            }
            foreach ($Child in (Get-HierarchyParentChildList -Parent $Parent)) {
                if (-not $Child -or -not $Child.PSObject.Properties['node_id'] -or -not $Child.node_id) { continue }
                if ($Stats.AssignedIds.Contains($Child.node_id)) {
                    Write-Warn "Duplicate assignment: $($Child.node_id)"
                }
                [void]$Stats.AssignedIds.Add($Child.node_id)
                $Stats.ChildCount++
            }
        }
    }
    if ($Proposal.PSObject.Properties['outliers']) {
        foreach ($Outlier in @($Proposal.outliers)) {
            [void]$Stats.AssignedIds.Add($Outlier.node_id)
            $Stats.OutlierCount++
        }
    }
    $Stats
}

function Get-HierarchyParentId {
    param($Parent)
    foreach ($Name in 'id', 'parent_id', 'promoted_from') {
        if ($Parent.PSObject.Properties[$Name]) { return $Parent.$Name }
    }
    $null
}

# parent id -> list of child ids (parents with no usable id are skipped).
function Get-HierarchyAdjacency {
    param($Proposal)
    $AdjList = @{}
    if (-not $Proposal.PSObject.Properties['parents']) { return $AdjList }
    foreach ($Parent in @($Proposal.parents)) {
        $ParentId = Get-HierarchyParentId -Parent $Parent
        if (-not $ParentId) { continue }
        $Kids = [System.Collections.Generic.List[string]]::new()
        foreach ($Child in (Get-HierarchyParentChildList -Parent $Parent)) {
            if ($Child -and $Child.PSObject.Properties['node_id'] -and $Child.node_id) { $Kids.Add($Child.node_id) }
        }
        $AdjList[$ParentId] = $Kids
    }
    $AdjList
}

# Iterative DFS from each unvisited root; reports every back edge as "parent -> child".
# Roots are walked in ordinal order: a plain hashtable's key order is randomized per process, so
# walking $AdjList.Keys directly made which back edge got reported vary run to run (t/4071).
function Find-HierarchyCycleEdge {
    param([hashtable]$AdjList)
    $CycleEdges = [System.Collections.Generic.List[string]]::new()
    $Visited = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $InStack  = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $Stack    = [System.Collections.Generic.Stack[object]]::new()
    [string[]]$Roots = @($AdjList.Keys)
    [Array]::Sort($Roots, [System.StringComparer]::Ordinal)
    foreach ($Root in $Roots) {
        if ($Visited.Contains($Root)) { continue }
        $Stack.Push(@{ Node = $Root; Index = 0 })
        [void]$Visited.Add($Root)
        [void]$InStack.Add($Root)
        while ($Stack.Count -gt 0) {
            $Frame = $Stack.Peek()
            if ($AdjList.ContainsKey($Frame.Node)) { $Neighbors = [string[]]@($AdjList[$Frame.Node]) } else { $Neighbors = [string[]]@() }
            if ($Frame.Index -ge $Neighbors.Length) {
                [void]$Stack.Pop()
                [void]$InStack.Remove($Frame.Node)
                continue
            }
            $Neighbor = $Neighbors[$Frame.Index]
            $Frame.Index++
            if ($InStack.Contains($Neighbor)) {
                $CycleEdges.Add("$($Frame.Node) -> $Neighbor")
            }
            elseif (-not $Visited.Contains($Neighbor)) {
                [void]$Visited.Add($Neighbor)
                [void]$InStack.Add($Neighbor)
                $Stack.Push(@{ Node = $Neighbor; Index = 0 })
            }
        }
    }
    , $CycleEdges
}

# Validates a parsed proposal (duplicates, cycles, coverage), reports it and attaches _metadata.
# Throws on an off-schema shape; the caller warns and skips the bucket.
function Complete-HierarchyProposal {
    param($Proposal, [string[]]$NodeIds, [string]$Model, [double]$Temperature, [double]$MinSimilarity,
          [int]$NodeCount, [int]$ClusterCount)
    $Stats = Measure-HierarchyAssignment -Proposal $Proposal

    $CycleEdges = Find-HierarchyCycleEdge -AdjList (Get-HierarchyAdjacency -Proposal $Proposal)
    if ($CycleEdges.Count -gt 0) {
        Write-Warn "Cycle detected in hierarchy: $($CycleEdges -join '; ')"
    }

    # Check coverage
    $Missing = @($NodeIds | Where-Object { -not $Stats.AssignedIds.Contains($_) })
    if ($Missing.Count -gt 0) {
        Write-Warn "$($Missing.Count) nodes not assigned: $($Missing[0..([Math]::Min(4, $Missing.Count - 1))] -join ', ')"
    }

    Write-OK "Proposed $($Stats.ParentCount) parents, $($Stats.ChildCount) children, $($Stats.OutlierCount) outliers"

    # Attach metadata
    $Proposal | Add-Member -NotePropertyName '_metadata' -NotePropertyValue ([ordered]@{
            generated_at  = (Get-Date).ToString('o')
            model         = $Model
            temperature   = $Temperature
            min_similarity = $MinSimilarity
            node_count    = $NodeCount
            cluster_count = $ClusterCount
            missing_nodes = $Missing
        }) -Force
}

# One bucket end to end. Returns the completed proposal, or $null when the bucket is skipped.
function Invoke-HierarchyBucket {
    param($Bucket, [string[]]$NodeIds, [string]$FullPrompt, [int]$ClusterCount, [string]$Model,
          $ResolvedKey, [double]$Temperature, [double]$MinSimilarity)
    $BucketLabel = "$($Bucket.POV)/$(Get-HierarchyCategoryLabel -Bucket $Bucket)"
    $Parsed = Invoke-HierarchyBucketModel -FullPrompt $FullPrompt -Model $Model -ResolvedKey $ResolvedKey `
        -Temperature $Temperature -BucketLabel $BucketLabel
    if ($null -eq $Parsed) { return $null }
    $Proposal = $Parsed.Proposal
    try {
        Complete-HierarchyProposal -Proposal $Proposal -NodeIds $NodeIds -Model $Model -Temperature $Temperature `
            -MinSimilarity $MinSimilarity -NodeCount $Bucket.Nodes.Count -ClusterCount $ClusterCount
        return , $Proposal
    } catch {
        Write-Warn "Validation failed for $BucketLabel`: $($_.Exception.Message) at $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber) — skipping bucket"
        return $null
    }
}

# First node with this id, searching the POV files in $PovFileMap key order; $null when none has it.
function Find-HierarchyTaxonomyNode {
    param([string]$Id, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    foreach ($PovKey in $PovFileMap.Keys) {
        if (-not $AllTaxData.ContainsKey($PovKey)) { continue }
        $Found = $AllTaxData[$PovKey].nodes |
            Where-Object { $_.id -eq $Id } |
            Select-Object -First 1
        if ($Found) { return $Found }
    }
    $null
}

function Get-HierarchyNodeLabelOrId {
    param([string]$Id, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    $Found = Find-HierarchyTaxonomyNode -Id $Id -AllTaxData $AllTaxData -PovFileMap $PovFileMap
    if ($Found) { return $Found.label }
    $Id
}

function ConvertTo-HierarchyMarkdownCell {
    param($Text)
    ($Text -replace '\|', '/') -replace '\n', ' '
}

function Add-HierarchyReviewChildTable {
    param([System.Text.StringBuilder]$Md, $Parent, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    [void]$Md.AppendLine('| Child ID | Label | Relationship | Rationale |')
    [void]$Md.AppendLine('|----------|-------|-------------|-----------|')
    foreach ($Child in (Get-HierarchyParentChildList -Parent $Parent)) {
        if (-not $Child -or -not $Child.PSObject.Properties['node_id']) { continue }
        # Look up child label
        $ChildLabel = Get-HierarchyNodeLabelOrId -Id $Child.node_id -AllTaxData $AllTaxData -PovFileMap $PovFileMap
        $RawRationale = if ($Child.PSObject.Properties['rationale']) { $Child.rationale } else { '' }
        $Rationale = ConvertTo-HierarchyMarkdownCell -Text $RawRationale
        $Rel = if ($Child.PSObject.Properties['relationship']) { $Child.relationship } else { '' }
        [void]$Md.AppendLine("| $($Child.node_id) | $ChildLabel | $Rel | $Rationale |")
    }
}

# Value of an optional field on a model-supplied object, or $null when the field is absent.
# The proposal JSON is already written when the review Markdown is built, so an off-schema
# response must degrade here, not throw: warn what is missing and why, and render without it (t/4071).
function Get-HierarchyReviewField {
    param($Object, [string]$Name, [string]$Context)
    if ($Object.PSObject.Properties[$Name]) { return $Object.$Name }
    Write-Warn "Review Markdown: $Context has no '$Name' field (off-schema model response); rendering it without one"
    $null
}

# Every line of a multi-line description gets the blockquote marker, not just the first (t/4071).
function ConvertTo-HierarchyBlockquote {
    param([string]$Text)
    '> ' + ($Text -replace '\r?\n', "`n> ")
}

function Get-HierarchyReviewParentLabel {
    param($PromotedFrom, $Parent, [string]$Context, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    if (-not $PromotedFrom) { return (Get-HierarchyReviewField -Object $Parent -Name 'label' -Context $Context) }
    $PromotedNode = Find-HierarchyTaxonomyNode -Id $PromotedFrom -AllTaxData $AllTaxData -PovFileMap $PovFileMap
    if ($PromotedNode) { return "$($PromotedNode.label) ($PromotedFrom)" }
    $PromotedFrom
}

function Add-HierarchyReviewParent {
    param([System.Text.StringBuilder]$Md, $Parent, [int]$ParentIdx, [string]$BucketLabel,
          [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    $Context = "parent $ParentIdx in $BucketLabel"
    $PromotedFrom = Get-HierarchyReviewField -Object $Parent -Name 'promoted_from' -Context $Context
    $ParentLabel = Get-HierarchyReviewParentLabel -PromotedFrom $PromotedFrom -Parent $Parent -Context $Context `
        -AllTaxData $AllTaxData -PovFileMap $PovFileMap
    if ($PromotedFrom) { $StatusTag = 'PROMOTED' } else { $StatusTag = 'NEW' }

    [void]$Md.AppendLine("### Parent $ParentIdx`: $ParentLabel [$StatusTag]")
    [void]$Md.AppendLine('')
    $Description = Get-HierarchyReviewField -Object $Parent -Name 'description' -Context $Context
    if ($Description) {
        [void]$Md.AppendLine((ConvertTo-HierarchyBlockquote -Text $Description))
        [void]$Md.AppendLine('')
    }
    Add-HierarchyReviewChildTable -Md $Md -Parent $Parent -AllTaxData $AllTaxData -PovFileMap $PovFileMap
    [void]$Md.AppendLine('')
    [void]$Md.AppendLine('**Verdict:** [ ] Accept  [ ] Modify  [ ] Reject')
    [void]$Md.AppendLine('')
}

function Add-HierarchyReviewOutlierTable {
    param([System.Text.StringBuilder]$Md, $Proposal, [string]$BucketLabel, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    if (-not ($Proposal.PSObject.Properties['outliers'] -and @($Proposal.outliers).Count -gt 0)) { return }
    [void]$Md.AppendLine('### Outliers (no parent assigned)')
    [void]$Md.AppendLine('')
    [void]$Md.AppendLine('| Node ID | Label | Reason |')
    [void]$Md.AppendLine('|---------|-------|--------|')
    foreach ($Outlier in @($Proposal.outliers)) {
        # node_id is guaranteed here: validation dereferences it and skips the bucket when it's absent.
        $OLabel = Get-HierarchyNodeLabelOrId -Id $Outlier.node_id -AllTaxData $AllTaxData -PovFileMap $PovFileMap
        $RawReason = Get-HierarchyReviewField -Object $Outlier -Name 'reason' -Context "outlier $($Outlier.node_id) in $BucketLabel"
        $Reason = ConvertTo-HierarchyMarkdownCell -Text $RawReason
        [void]$Md.AppendLine("| $($Outlier.node_id) | $OLabel | $Reason |")
    }
    [void]$Md.AppendLine('')
}

function Add-HierarchyReviewBucket {
    param([System.Text.StringBuilder]$Md, $Proposal, [int]$BucketIdx, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    $PovLabel = Get-HierarchyReviewField -Object $Proposal -Name 'pov' -Context "bucket $BucketIdx"
    if ($Proposal.PSObject.Properties['category'] -and $Proposal.category) {
        $CatLabel = $Proposal.category
    } else { $CatLabel = '(situations)' }
    $BucketLabel = "$PovLabel / $CatLabel"

    [void]$Md.AppendLine("---")
    [void]$Md.AppendLine('')
    [void]$Md.AppendLine("## $BucketLabel")
    [void]$Md.AppendLine('')

    if ($Proposal.PSObject.Properties['parents']) {
        $ParentIdx = 0
        foreach ($Parent in @($Proposal.parents)) {
            $ParentIdx++
            Add-HierarchyReviewParent -Md $Md -Parent $Parent -ParentIdx $ParentIdx -BucketLabel $BucketLabel `
                -AllTaxData $AllTaxData -PovFileMap $PovFileMap
        }
    }

    Add-HierarchyReviewOutlierTable -Md $Md -Proposal $Proposal -BucketLabel $BucketLabel -AllTaxData $AllTaxData -PovFileMap $PovFileMap

    if (@($Proposal._metadata.missing_nodes).Count -gt 0) {
        [void]$Md.AppendLine("**Warning:** $(@($Proposal._metadata.missing_nodes).Count) nodes not assigned by AI: ``$($Proposal._metadata.missing_nodes -join '``, ``')``")
        [void]$Md.AppendLine('')
    }
}

function ConvertTo-HierarchyReviewMarkdown {
    param($AllProposals, [string]$Model, [string]$Timestamp, [hashtable]$AllTaxData, [hashtable]$PovFileMap)
    $Md = [System.Text.StringBuilder]::new()
    [void]$Md.AppendLine("# Hierarchy Proposal Review — $Timestamp")
    [void]$Md.AppendLine('')
    [void]$Md.AppendLine("**Model:** $Model | **Generated:** $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
    [void]$Md.AppendLine('')
    $BucketIdx = 0
    foreach ($Proposal in $AllProposals) {
        $BucketIdx++
        Add-HierarchyReviewBucket -Md $Md -Proposal $Proposal -BucketIdx $BucketIdx -AllTaxData $AllTaxData -PovFileMap $PovFileMap
    }
    $Md.ToString()
}

function Get-HierarchyTotalParentCount {
    param($AllProposals)
    ($AllProposals | ForEach-Object {
            if ($_.PSObject.Properties['parents']) { @($_.parents).Count } else { 0 }
        } | Measure-Object -Sum).Sum
}
