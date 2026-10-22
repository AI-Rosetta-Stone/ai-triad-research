# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-GraphQuery {
    <#
    .SYNOPSIS
        Answers natural-language questions by reasoning over the taxonomy graph.
    .DESCRIPTION
        Takes a natural-language question, loads the full taxonomy graph (nodes,
        attributes, edges), and sends it to an LLM that reasons over the graph
        structure to produce a grounded answer.

        The LLM traces paths, follows edge chains, and considers node attributes
        to answer questions about relationships, assumptions, tensions, and gaps
        in the AI policy debate.
    .PARAMETER Question
        The natural-language question to answer.
    .PARAMETER IncludeConflicts
        Include conflict data in the graph context for conflict-aware reasoning.
    .PARAMETER StatusFilter
        Only include edges with this approval status. Default: approved.
        Use 'all' to include all edges regardless of status.
    .PARAMETER Model
        AI model to use. Defaults to 'gemini-3.5-flash-lite'.
    .PARAMETER ApiKey
        AI API key. If omitted, resolved via the backend-specific env var (AI_API_KEY is a fallback for gemini models only).
    .PARAMETER Temperature
        Sampling temperature (0.0-1.0). Default: 0.3.
    .PARAMETER Raw
        Return the raw JSON response instead of formatted output.
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Invoke-GraphQuery "What assumptions does the safetyist position share with the accelerationist position?"
    .EXAMPLE
        Invoke-GraphQuery "Which claims have no empirical support?" -StatusFilter all
    .EXAMPLE
        Invoke-GraphQuery "How does the skeptic position respond to existential risk arguments?" -IncludeConflicts
    .EXAMPLE
        Invoke-GraphQuery "What would change if scaling laws stopped holding?" -Raw
    .LINK
        Show-AITriadHelp
    .LINK
        Find-GraphPath
    .LINK
        Find-Conflict
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
        [string]$Question,

        [switch]$IncludeConflicts,

        [ValidateSet('proposed', 'approved', 'rejected', 'all')]
        [string]$StatusFilter = 'approved',

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model = (Get-AITierModel -Tier basic),

        [string]$ApiKey = '',

        [ValidateRange(0.0, 1.0)]
        [double]$Temperature = 0.3,

        [switch]$Raw,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Step 1: Validate environment ──
    Write-Step 'Validating environment'

    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Fail "No API key found for the $($KeyStatus.Backend) backend. Set $($KeyStatus.EnvHint), or pass -ApiKey."
        throw 'No API key configured'
    }

    $TaxDir = Get-TaxonomyDir

    # ── Step 2: Load full graph ──
    Write-Step 'Loading taxonomy graph'

    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    $GraphNodes = [System.Collections.Generic.List[PSObject]]::new()
    $NodePovMap = @{}

    foreach ($PovKey in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }

        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        Set-TaxonomyDocumentSelectable -Document $FileData -Name $PovKey   # the graph the model sees (t/4356)
        foreach ($Node in $FileData.nodes) {
            $NodeEntry = [ordered]@{
                id          = $Node.id
                pov         = $PovKey
                label       = $Node.label
                description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
            }
            if ($Node.PSObject.Properties['category']) {
                $NodeEntry['category'] = $Node.category
            }
            if ($Node.PSObject.Properties['graph_attributes']) {
                $NodeEntry['graph_attributes'] = $Node.graph_attributes
            }
            if ($PovKey -eq 'situations' -and $Node.PSObject.Properties['interpretations']) {
                $NodeEntry['interpretations'] = $Node.interpretations
            }
            $GraphNodes.Add([PSCustomObject]$NodeEntry)
            $NodePovMap[$Node.id] = $PovKey
        }
    }

    Write-OK "Loaded $($GraphNodes.Count) nodes"

    # ── Step 3: Load edges ──
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    $GraphEdges = @()
    if (Test-Path $EdgesPath) {
        $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json
        if ($StatusFilter -eq 'all') {
            $GraphEdges = @($EdgesData.edges)
        } else {
            $GraphEdges = @($EdgesData.edges | Where-Object { $_.status -eq $StatusFilter })
        }
    }

    # An edge with a superseded endpoint is history, not graph (t/4356).
    $Superseded = Get-SupersededNodeIdSet
    if ($Superseded.Count -gt 0) {
        $GraphEdges = @($GraphEdges | Where-Object { -not $Superseded.Contains([string]$_.source) -and -not $Superseded.Contains([string]$_.target) })
    }

    Write-OK "Loaded $($GraphEdges.Count) edges (filter: $StatusFilter)"

    # ── Step 4: Optionally load conflicts ──
    $ConflictData = @()
    if ($IncludeConflicts) {
        $ConflictDir = Get-ConflictsDir
        if (Test-Path $ConflictDir) {
            foreach ($File in Get-ChildItem -Path $ConflictDir -Filter '*.json' -File) {
                try {
                    $Conflict = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
                    $ConflictData += [ordered]@{
                        claim_id             = $Conflict.claim_id
                        claim_label          = $Conflict.claim_label
                        description          = if ($Conflict.PSObject.Properties['description']) { $Conflict.description } else { '' }
                        status               = $Conflict.status
                        linked_taxonomy_nodes = $Conflict.linked_taxonomy_nodes
                        instance_count       = @($Conflict.instances).Count
                    }
                } catch {
                    Write-Warn "Failed to load conflict $($File.Name): $_"
                }
            }
            Write-OK "Loaded $($ConflictData.Count) conflicts"
        }
    }

    # ── Step 5: Build compact edge list for context ──
    $CompactEdges = foreach ($Edge in $GraphEdges) {
        $Entry = [ordered]@{
            source     = $Edge.source
            target     = $Edge.target
            type       = $Edge.type
            confidence = $Edge.confidence
            status     = $Edge.status
        }
        if ($Edge.PSObject.Properties['rationale'] -and $Edge.rationale) {
            $Entry['rationale'] = $Edge.rationale
        }
        if ($Edge.PSObject.Properties['bidirectional'] -and $Edge.bidirectional) {
            $Entry['bidirectional'] = $true
        }
        $Entry
    }

    # ── Step 6: Build prompt ──
    Write-Step 'Building prompt'

    $SystemPrompt = Get-Prompt -Name 'graph-query'
    $SchemaPrompt = Get-Prompt -Name 'graph-query-schema'

    $NodesJson = $GraphNodes | ConvertTo-Json -Depth 10
    $EdgesJson = $CompactEdges | ConvertTo-Json -Depth 5

    $FullPrompt = @"
$SystemPrompt

--- USER QUESTION ---
$Question

--- TAXONOMY NODES ($($GraphNodes.Count) nodes) ---
$NodesJson

--- GRAPH EDGES ($($GraphEdges.Count) edges, status filter: $StatusFilter) ---
$EdgesJson
"@

    if ($IncludeConflicts -and $ConflictData.Count -gt 0) {
        $ConflictJson = $ConflictData | ConvertTo-Json -Depth 5
        $FullPrompt += @"

--- CONFLICTS ($($ConflictData.Count) conflicts) ---
$ConflictJson
"@
    }

    $FullPrompt += @"

$SchemaPrompt
"@

    $PromptTokens = [Math]::Round($FullPrompt.Length / 4)
    Write-Info "Prompt: ~$PromptTokens tokens est."

    # ── Step 7: Call AI API ──
    Write-Step 'Querying graph'

    $GraphQuerySchema = @{
        type       = 'object'
        properties = @{
            answer           = @{ type = 'string'; description = 'Natural language answer to the question' }
            confidence       = @{ type = 'number' }
            referenced_nodes = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        id        = @{ type = 'string' }
                        pov       = @{ type = 'string' }
                        label     = @{ type = 'string' }
                        relevance = @{ type = 'string' }
                    }
                    required   = @('id', 'relevance')
                }
            }
            paths_traced     = @{
                type  = 'array'
                items = @{
                    type       = 'object'
                    properties = @{
                        description = @{ type = 'string' }
                        nodes       = @{ type = 'array'; items = @{ type = 'string' } }
                        edge_types  = @{ type = 'array'; items = @{ type = 'string' } }
                    }
                    required   = @('description', 'nodes')
                }
            }
            limitations      = @{ type = 'string' }
        }
        required   = @('answer', 'confidence', 'referenced_nodes')
    }

    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $Result = Invoke-AIApi `
            -Prompt $FullPrompt `
            -Model $Model `
            -ApiKey $ApiKey `
            -Temperature $Temperature `
            -MaxTokens 8192 `
            -ResponseSchema $GraphQuerySchema
    } catch {
        Write-Fail "API call failed: $_"
        throw
    }
    $Stopwatch.Stop()
    Write-OK "Response in $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"

    # ── Step 8: Parse response ──
    $ResponseText = $Result.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
    try {
        $Response = $ResponseText | ConvertFrom-Json
    } catch {
        Write-Warn 'JSON parse failed, attempting repair...'
        $Repaired = Repair-TruncatedJson -Text $ResponseText
        try {
            $Response = $Repaired | ConvertFrom-Json
        } catch {
            # t/3857: this used to Write-Fail + bare `return` -- never rethrow, so a response the
            # AI returned that couldn't be parsed even after repair was indistinguishable from a
            # successful query. No internal caller relies on this today, but a silent $null on
            # failure is a trap for the next one.
            throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Answer the graph query' `
                    -Problem "The AI response could not be parsed as JSON, even after repair: $($_.Exception.Message)" `
                    -Location 'Invoke-GraphQuery' `
                    -NextSteps @(
                        'Re-run the query -- this is usually a transient malformed-response issue.',
                        "Raw response: $ResponseText"))
        }
    }

    # ── Step 8b: Validate cited node IDs (gap 8.1) ──
    $UnverifiedCount = 0

    if ($Response.PSObject.Properties['referenced_nodes'] -and $Response.referenced_nodes) {
        foreach ($Ref in @($Response.referenced_nodes)) {
            if ($Ref.PSObject.Properties['id'] -and $Ref.id) {
                $IsValid = $NodePovMap.ContainsKey($Ref.id)
                $Ref | Add-Member -NotePropertyName 'verified' -NotePropertyValue $IsValid -Force
                if (-not $IsValid) { $UnverifiedCount++ }
            }
        }
    }

    # t/1449: per-hop edge validation. Node-ID validation catches obvious
    # hallucinations, but a model can still assert a plausible-looking path
    # through REAL node IDs that has no actual edges connecting them.
    # Build a direction-agnostic edge index once, then walk each traced path.
    $EdgeIndex = @{}
    foreach ($E in $GraphEdges) {
        if (-not ($E.PSObject.Properties['source'] -and $E.PSObject.Properties['target'])) { continue }
        $Src = [string]$E.source
        $Tgt = [string]$E.target
        if (-not $Src -or -not $Tgt) { continue }
        $EdgeIndex["$Src|$Tgt"] = $true
        $EdgeIndex["$Tgt|$Src"] = $true   # any-direction hop
    }
    $UnverifiedHopCount = 0

    if ($Response.PSObject.Properties['paths_traced'] -and $Response.paths_traced) {
        foreach ($Path in @($Response.paths_traced)) {
            if ($Path.PSObject.Properties['nodes'] -and $Path.nodes) {
                $InvalidInPath = @($Path.nodes | Where-Object { $_ -and -not $NodePovMap.ContainsKey($_) })
                if ($InvalidInPath.Count -gt 0) {
                    $Path | Add-Member -NotePropertyName 'unverified_nodes' -NotePropertyValue $InvalidInPath -Force
                    $UnverifiedCount += $InvalidInPath.Count
                }

                # t/1449: walk consecutive node pairs, verify each hop against the loaded edge set.
                $PathNodes = @($Path.nodes)
                $Hops = @()
                $PathUnverifiedHops = 0
                for ($i = 0; $i -lt $PathNodes.Count - 1; $i++) {
                    $Src = [string]$PathNodes[$i]
                    $Tgt = [string]$PathNodes[$i + 1]
                    $HopVerified = $EdgeIndex.ContainsKey("$Src|$Tgt")
                    if (-not $HopVerified) { $PathUnverifiedHops++; $UnverifiedHopCount++ }
                    $Hops += [PSCustomObject]@{
                        source   = $Src
                        target   = $Tgt
                        verified = $HopVerified
                    }
                }
                $Path | Add-Member -NotePropertyName 'hops' -NotePropertyValue $Hops -Force
                $Path | Add-Member -NotePropertyName 'unverified_hop_count' -NotePropertyValue $PathUnverifiedHops -Force
                $Path | Add-Member -NotePropertyName 'fully_verified' -NotePropertyValue ($PathUnverifiedHops -eq 0 -and $InvalidInPath.Count -eq 0) -Force
            }
        }
    }

    $UnverifiedInAnswer = @()
    if ($Response.PSObject.Properties['answer'] -and $Response.answer) {
        $IdPattern = '[a-z]{2,3}-[a-z]+-\d{3}'
        $Matches = [regex]::Matches($Response.answer, $IdPattern)
        foreach ($M in $Matches) {
            if (-not $NodePovMap.ContainsKey($M.Value)) {
                $UnverifiedInAnswer += $M.Value
                $UnverifiedCount++
            }
        }
    }

    if ($UnverifiedCount -gt 0) {
        Write-Warning "Graph query: $UnverifiedCount cited node ID(s) could not be verified against the taxonomy"
    }
    # t/1449: surface unverified-hop count next to node UnverifiedCount so the
    # caller can see edge hallucinations distinctly from node hallucinations.
    if ($UnverifiedHopCount -gt 0) {
        Write-Warning "Graph query: $UnverifiedHopCount traced hop(s) reference edges that do not exist in the taxonomy"
    }

    # ── Step 9: Output ──
    if ($Raw) {
        return $Response
    }

    # Formatted output
    Write-Host ''
    Write-Host '══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host "  Q: $Question" -ForegroundColor White
    Write-Host '══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host ''

    # Answer
    if ($Response.PSObject.Properties['answer']) {
        Write-Host $Response.answer -ForegroundColor White
        Write-Host ''
    }

    # Confidence
    if ($Response.PSObject.Properties['confidence']) {
        $ConfPct = [Math]::Round($Response.confidence * 100)
        if ($ConfPct -ge 80) { $ConfColor = 'Green' } elseif ($ConfPct -ge 50) { $ConfColor = 'Yellow' } else { $ConfColor = 'Red' }
        Write-Host "  Confidence: $ConfPct%" -ForegroundColor $ConfColor
    }

    # Referenced nodes
    if ($Response.PSObject.Properties['referenced_nodes'] -and $Response.referenced_nodes) {
        Write-Host ''
        Write-Host '  Referenced Nodes:' -ForegroundColor Cyan
        foreach ($Ref in @($Response.referenced_nodes)) {
            # Guard against missing properties (LLM response format varies)
            if ($Ref.PSObject.Properties['pov'])   { $RefPov   = $Ref.pov }   else { $RefPov   = '' }
            if ($Ref.PSObject.Properties['id'])    { $RefId    = $Ref.id }    else { $RefId    = '?' }
            if ($Ref.PSObject.Properties['label']) { $RefLabel = $Ref.label } else { $RefLabel = '' }

            $PovColor = switch ($RefPov) {
                'accelerationist' { 'Blue' }
                'safetyist'       { 'Green' }
                'skeptic'         { 'Yellow' }
                'situations'      { 'Magenta' }
                default           { 'Gray' }
            }
            Write-Host "    [$RefPov]" -NoNewline -ForegroundColor $PovColor
            Write-Host " $RefId" -NoNewline -ForegroundColor White
            Write-Host " — $RefLabel" -ForegroundColor DarkGray
            if ($Ref.PSObject.Properties['relevance'] -and $Ref.relevance) {
                Write-Host "      $($Ref.relevance)" -ForegroundColor Gray
            }
        }
    }

    # Paths traced
    if ($Response.PSObject.Properties['paths_traced'] -and $Response.paths_traced) {
        $Paths = @($Response.paths_traced)
        if ($Paths.Count -gt 0) {
            Write-Host ''
            Write-Host '  Paths Traced:' -ForegroundColor Cyan
            foreach ($Path in $Paths) {
                if ($Path.PSObject.Properties['description']) { $PathDesc = $Path.description } else { $PathDesc = '' }
                Write-Host "    $PathDesc" -ForegroundColor White
                if ($Path.PSObject.Properties['nodes'] -and $Path.nodes) {
                    $NodeIds = @($Path.nodes)
                    if ($Path.PSObject.Properties['edge_types']) { $EdgeTypes = @($Path.edge_types) } else { $EdgeTypes = @() }
                    $PathStr = ''
                    for ($i = 0; $i -lt $NodeIds.Count; $i++) {
                        $PathStr += $NodeIds[$i]
                        if ($i -lt $NodeIds.Count - 1) {
                            if ($i -lt $EdgeTypes.Count) { $EdgeLabel = $EdgeTypes[$i] } else { $EdgeLabel = '?' }
                            $PathStr += " --[$EdgeLabel]--> "
                        }
                    }
                    Write-Host "    $PathStr" -ForegroundColor DarkGray
                }
            }
        }
    }

    # Limitations
    if ($Response.PSObject.Properties['limitations'] -and $Response.limitations) {
        Write-Host ''
        Write-Host '  Limitations:' -ForegroundColor Yellow
        Write-Host "    $($Response.limitations)" -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host '══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host ''

    return $Response
}
