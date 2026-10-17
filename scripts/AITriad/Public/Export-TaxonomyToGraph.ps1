# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Export-TaxonomyToGraph {
    <#
    .SYNOPSIS
        Exports the taxonomy graph to a Neo4j database for visualization and Cypher queries.
    .DESCRIPTION
        Reads all taxonomy JSON files, edges.json, summaries, and conflicts,
        then creates/updates nodes and relationships in a Neo4j instance.

        The Neo4j database is a read-only derived view — all edits happen in
        the JSON files, and the database is rebuilt on each export.

        Requires a running Neo4j instance (see Install-GraphDatabase).
    .PARAMETER Full
        Rebuild the entire graph from scratch (clears existing data first).
    .PARAMETER IncludeEmbeddings
        Include embedding vectors as node properties for graph-native similarity queries.
    .PARAMETER Uri
        Neo4j Bolt URI. Default: bolt://localhost:7687.
    .PARAMETER Credential
        PSCredential for Neo4j authentication. If omitted, uses neo4j/neo4j default.
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Export-TaxonomyToGraph -Full
    .EXAMPLE
        Export-TaxonomyToGraph -Full -IncludeEmbeddings
    .EXAMPLE
        Export-TaxonomyToGraph -Uri "bolt://localhost:7687" -Credential (Get-Credential)
    .LINK
        Show-AITriadHelp
    .LINK
        Find-GraphPath
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
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [switch]$Full,

        [switch]$IncludeEmbeddings,

        [string]$Uri = 'bolt://localhost:7687',

        [PSCredential]$Credential,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Step 1: Check Neo4j connectivity ──
    Write-Step 'Checking Neo4j connection'

    # Derive HTTP API endpoint from bolt URI
    $HttpUri = $Uri -replace 'bolt://', 'http://' -replace ':7687', ':7474'
    $AuthHeader = @{}

    if ($Credential) {
        $Pair = "$($Credential.UserName):$($Credential.GetNetworkCredential().Password)"
    } else {
        if (-not $env:NEO4J_PASSWORD) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Connect to Neo4j' `
                -Problem 'NEO4J_PASSWORD environment variable is not set and no -Credential was provided' `
                -Location 'Export-TaxonomyToGraph' `
                -NextSteps 'Set $env:NEO4J_PASSWORD or pass -Credential (Get-Credential) with the Neo4j password.')
        }
        $Pair = "neo4j:$($env:NEO4J_PASSWORD)"
    }
    $Bytes = [System.Text.Encoding]::ASCII.GetBytes($Pair)
    $AuthHeader['Authorization'] = "Basic $([Convert]::ToBase64String($Bytes))"

    # Helper to run Cypher via HTTP API
    function Invoke-Cypher {
        param([string]$Query, [hashtable]$Parameters = @{})

        $Body = @{
            statements = @(
                @{
                    statement  = $Query
                    parameters = $Parameters
                }
            )
        } | ConvertTo-Json -Depth 10

        $Response = Invoke-RestMethod `
            -Uri "$HttpUri/db/neo4j/tx/commit" `
            -Method POST `
            -ContentType 'application/json' `
            -Headers $AuthHeader `
            -Body $Body `
            -ErrorAction Stop

        if ($Response.errors -and $Response.errors.Count -gt 0) {
            $ErrMsg = ($Response.errors | ForEach-Object { $_.message }) -join '; '
            throw "Cypher error: $ErrMsg"
        }

        return $Response
    }

    try {
        $null = Invoke-Cypher -Query 'RETURN 1 AS test'
        Write-OK "Connected to Neo4j at $Uri"
    } catch {
        # t/3857: this used to Write-Fail + bare `return` -- never rethrow, so a connectivity
        # failure here was indistinguishable from a successful (silent) export. No internal
        # caller relies on this today, but a silent $null on failure is a trap for the next one.
        throw (New-ActionableError -AsErrorRecord `
                -Goal 'Export the taxonomy to Neo4j' `
                -Problem "Cannot connect to Neo4j at ${Uri}: $($_.Exception.Message)" `
                -Location 'Export-TaxonomyToGraph' `
                -NextSteps 'Run Install-GraphDatabase to set up Neo4j, or ensure it is running.')
    }

    # ── Step 2: Clear database if Full ──
    if ($Full) {
        if ($PSCmdlet.ShouldProcess('Neo4j database', 'Clear all nodes and relationships')) {
            Write-Step 'Clearing existing graph data'
            $null = Invoke-Cypher -Query 'MATCH (n) DETACH DELETE n'
            Write-OK 'Database cleared'
        }
    }

    # ── Step 3: Create constraints and indexes ──
    Write-Step 'Creating indexes'
    $IndexQueries = @(
        'CREATE CONSTRAINT IF NOT EXISTS FOR (n:TaxonomyNode) REQUIRE n.id IS UNIQUE'
        'CREATE CONSTRAINT IF NOT EXISTS FOR (c:Conflict) REQUIRE c.claim_id IS UNIQUE'
        'CREATE CONSTRAINT IF NOT EXISTS FOR (s:Source) REQUIRE s.doc_id IS UNIQUE'
        'CREATE INDEX IF NOT EXISTS FOR (n:TaxonomyNode) ON (n.pov)'
        'CREATE INDEX IF NOT EXISTS FOR (n:TaxonomyNode) ON (n.category)'
    )
    foreach ($Q in $IndexQueries) {
        try { $null = Invoke-Cypher -Query $Q } catch { Write-Warn "Index: $_" }
    }
    Write-OK 'Indexes ready'

    # ── Step 4: Load and export taxonomy nodes ──
    Write-Step 'Exporting taxonomy nodes'
    $TaxDir = Get-TaxonomyDir
    $PovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')
    $NodeCount = 0

    foreach ($PovKey in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }

        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        foreach ($Node in $FileData.nodes) {
            $Props = @{
                id          = $Node.id
                pov         = $PovKey
                label       = $Node.label
                description = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
            }
            if ($Node.PSObject.Properties['category']) {
                $Props['category'] = $Node.category
            }

            # Flatten graph_attributes into properties
            if ($Node.PSObject.Properties['graph_attributes']) {
                $Attrs = $Node.graph_attributes
                foreach ($Prop in $Attrs.PSObject.Properties) {
                    $Val = $Prop.Value
                    # Convert arrays to JSON strings for Neo4j compatibility
                    if ($Val -is [System.Array] -or $Val -is [System.Collections.IEnumerable] -and $Val -isnot [string]) {
                        $Val = ($Val | ConvertTo-Json -Compress)
                    }
                    $Props["attr_$($Prop.Name)"] = "$Val"
                }
            }

            $SetClauses = ($Props.Keys | ForEach-Object { "n.$_ = `$$_" }) -join ', '
            $Query = "MERGE (n:TaxonomyNode {id: `$id}) SET $SetClauses"

            # Add POV label
            $PovLabel = switch ($PovKey) {
                'accelerationist' { 'Accelerationist' }
                'safetyist'       { 'Safetyist' }
                'skeptic'         { 'Skeptic' }
                'situations'      { 'Situations' }
            }
            $Query += ", n:$PovLabel"

            $null = Invoke-Cypher -Query $Query -Parameters $Props
            $NodeCount++
        }
    }
    Write-OK "Exported $NodeCount taxonomy nodes"

    # ── Step 5: Export edges ──
    Write-Step 'Exporting edges'
    $EdgesPath = Join-Path $TaxDir 'edges.json'
    $EdgeCount = 0
    $EdgeFailCount = 0

    if (Test-Path $EdgesPath) {
        $EdgesData = Get-Content -Raw -Path $EdgesPath | ConvertFrom-Json

        foreach ($Edge in $EdgesData.edges) {
            $EdgeProps = @{
                source_id   = $Edge.source
                target_id   = $Edge.target
                confidence  = [double]$Edge.confidence
                status      = $Edge.status
            }
            if ($Edge.PSObject.Properties['rationale'] -and $Edge.rationale) {
                $EdgeProps['rationale'] = $Edge.rationale
            }
            if ($Edge.PSObject.Properties['strength'] -and $Edge.strength) {
                $EdgeProps['strength'] = "$($Edge.strength)"
            }
            if ($Edge.PSObject.Properties['bidirectional']) {
                $EdgeProps['bidirectional'] = [bool]$Edge.bidirectional
            }
            if ($Edge.PSObject.Properties['discovered_at']) {
                $EdgeProps['discovered_at'] = $Edge.discovered_at
            }

            $SetParts = ($EdgeProps.Keys | Where-Object { $_ -notin 'source_id', 'target_id' } |
                ForEach-Object { "r.$_ = `$$_" }) -join ', '

            $Query = @"
MATCH (a:TaxonomyNode {id: `$source_id})
MATCH (b:TaxonomyNode {id: `$target_id})
MERGE (a)-[r:$($Edge.type)]->(b)
SET $SetParts
"@
            try {
                $null = Invoke-Cypher -Query $Query -Parameters $EdgeProps
                $EdgeCount++
            } catch {
                $EdgeFailCount++
                Write-Warn "Edge $($Edge.source) → $($Edge.target): $_"
            }
        }
    }
    if ($EdgeFailCount -gt 0) {
        Write-Warn "Exported $EdgeCount edges ($EdgeFailCount failed)"
    } else {
        Write-OK "Exported $EdgeCount edges"
    }

    # ── Step 6: Export conflicts ──
    Write-Step 'Exporting conflicts'
    $ConflictDir = Get-ConflictsDir
    $ConflictCount = 0
    $ConflictFailCount = 0

    if (Test-Path $ConflictDir) {
        foreach ($File in Get-ChildItem -Path $ConflictDir -Filter '*.json' -File) {
            try {
                $Conflict = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json

                $ConflictProps = @{
                    claim_id       = $Conflict.claim_id
                    claim_label    = $Conflict.claim_label
                    description    = if ($Conflict.PSObject.Properties['description']) { $Conflict.description } else { '' }
                    status         = $Conflict.status
                    instance_count = @($Conflict.instances).Count
                }

                $SetClauses = ($ConflictProps.Keys | ForEach-Object { "c.$_ = `$$_" }) -join ', '
                $Query = "MERGE (c:Conflict {claim_id: `$claim_id}) SET $SetClauses"
                $null = Invoke-Cypher -Query $Query -Parameters $ConflictProps

                # Link to taxonomy nodes
                if ($Conflict.PSObject.Properties['linked_taxonomy_nodes']) {
                    foreach ($NId in $Conflict.linked_taxonomy_nodes) {
                        $LinkQuery = @"
MATCH (c:Conflict {claim_id: `$claim_id})
MATCH (n:TaxonomyNode {id: `$node_id})
MERGE (c)-[:LINKED_TO]->(n)
"@
                        $null = Invoke-Cypher -Query $LinkQuery -Parameters @{
                            claim_id = $Conflict.claim_id
                            node_id  = $NId
                        }
                    }
                }

                $ConflictCount++
            } catch {
                $ConflictFailCount++
                Write-Warn "Conflict $($File.Name): $_"
            }
        }
    }
    if ($ConflictFailCount -gt 0) {
        Write-Warn "Exported $ConflictCount conflicts ($ConflictFailCount failed)"
    } else {
        Write-OK "Exported $ConflictCount conflicts"
    }

    # ── Step 7: Export embeddings (optional) ──
    if ($IncludeEmbeddings) {
        Write-Step 'Exporting embeddings'
        $EmbPath = Join-Path $TaxDir 'embeddings.json'
        $EmbCount = 0

        if (Test-Path $EmbPath) {
            $EmbData = Get-Content -Raw -Path $EmbPath | ConvertFrom-Json
            foreach ($Entry in $EmbData.PSObject.Properties) {
                $NodeId = $Entry.Name
                $Vector = @($Entry.Value)
                if ($Vector.Count -gt 0) {
                    $Query = 'MATCH (n:TaxonomyNode {id: $id}) SET n.embedding = $vector'
                    try {
                        $null = Invoke-Cypher -Query $Query -Parameters @{ id = $NodeId; vector = $Vector }
                        $EmbCount++
                    } catch {
                        Write-Warn "Embedding for $NodeId : $_"
                    }
                }
            }
        }
        Write-OK "Exported $EmbCount embeddings"
    }

    # ── Summary ──
    Write-Host ''
    Write-Host '=== Graph Export Complete ===' -ForegroundColor Cyan
    Write-Host "  Taxonomy nodes: $NodeCount" -ForegroundColor Green
    Write-Host "  Edges:          $EdgeCount" -ForegroundColor Green
    Write-Host "  Conflicts:      $ConflictCount" -ForegroundColor Green
    Write-Host "  Neo4j URI:      $Uri" -ForegroundColor Cyan
    Write-Host ''
    Write-Host "Open Neo4j Browser at $($HttpUri -replace ':7474', ':7474/browser/') to explore." -ForegroundColor DarkGray
    Write-Host ''
}
