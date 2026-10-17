# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-CypherQuery {
    <#
    .SYNOPSIS
        Runs a Cypher query against the Neo4j graph database and returns results.
    .DESCRIPTION
        Sends a Cypher query to the Neo4j HTTP API and returns structured results.
        Supports parameterized queries for safety and performance.
    .PARAMETER Query
        The Cypher query string.
    .PARAMETER Parameters
        Hashtable of query parameters (referenced as $paramName in Cypher).
    .PARAMETER Uri
        Neo4j Bolt URI. Default: bolt://localhost:7687.
    .PARAMETER Credential
        PSCredential for Neo4j authentication.
    .PARAMETER Raw
        Return raw API response instead of parsed results.
    .EXAMPLE
        Invoke-CypherQuery "MATCH (n:TaxonomyNode) RETURN n.id, n.label LIMIT 10"
    .EXAMPLE
        Invoke-CypherQuery "MATCH (a)-[r:TENSION_WITH]->(b) RETURN a.label, b.label, r.confidence"
    .EXAMPLE
        Invoke-CypherQuery "MATCH (n:TaxonomyNode {pov: `$pov}) RETURN n.id, n.label" -Parameters @{ pov = 'safetyist' }
    .EXAMPLE
        Invoke-CypherQuery "MATCH p=shortestPath((a:TaxonomyNode {id: `$from})-[*]-(b:TaxonomyNode {id: `$to})) RETURN p" -Parameters @{ from = 'acc-desires-001'; to = 'saf-desires-001' }
    .LINK
        Show-AITriadHelp
    .LINK
        Find-GraphPath
    .LINK
        Find-Conflict
    .LINK
        Invoke-GraphQuery
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
        [string]$Query,

        [hashtable]$Parameters = @{},

        [string]$Uri = 'bolt://localhost:7687',

        [PSCredential]$Credential,

        [switch]$Raw
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $HttpUri = $Uri -replace 'bolt://', 'http://' -replace ':7687', ':7474'

    if ($Credential) {
        $Pair = "$($Credential.UserName):$($Credential.GetNetworkCredential().Password)"
    } else {
        if (-not $env:NEO4J_PASSWORD) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Run Cypher query' `
                -Problem 'NEO4J_PASSWORD environment variable is not set and no -Credential was provided' `
                -Location 'Invoke-CypherQuery' `
                -NextSteps 'Set $env:NEO4J_PASSWORD or pass -Credential (Get-Credential) with the Neo4j password.')
        }
        $Pair = "neo4j:$($env:NEO4J_PASSWORD)"
    }
    $Bytes = [System.Text.Encoding]::ASCII.GetBytes($Pair)
    $AuthHeader = @{ Authorization = "Basic $([Convert]::ToBase64String($Bytes))" }

    $Body = @{
        statements = @(
            @{
                statement  = $Query
                parameters = $Parameters
            }
        )
    } | ConvertTo-Json -Depth 10

    try {
        $Response = Invoke-RestMethod `
            -Uri "$HttpUri/db/neo4j/tx/commit" `
            -Method POST `
            -ContentType 'application/json' `
            -Headers $AuthHeader `
            -Body $Body `
            -ErrorAction Stop
    } catch {
        # t/3855: this used to Write-Fail + bare `return` -- never rethrow, so -ErrorAction Stop
        # at every caller's call site was a no-op and a query failure was indistinguishable from a
        # query that legitimately returned zero rows. Distinguish 'unauthorized' (HTTP 401, wrong
        # credential) from 'unreachable' (connection-level) -- opposite remedies, same discriminator
        # as t/3856's Test-Neo4jAuthProbe. StrictMode guard: HttpRequestException (connection-level
        # failures) has no .Response property at all -- check PSObject.Properties before access.
        $Resp = if ($_.Exception.PSObject.Properties['Response']) { $_.Exception.Response } else { $null }
        if ($Resp -and [int]$Resp.StatusCode -eq 401) {
            throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Run Cypher query' `
                    -Problem "Neo4j rejected the credential (HTTP 401) at $HttpUri." `
                    -Location 'Invoke-CypherQuery' `
                    -NextSteps @(
                        'Confirm -Credential or $env:NEO4J_PASSWORD matches the running database.',
                        'Re-run Install-GraphDatabase -Force if the credential was lost or the database was recreated.'))
        }
        throw (New-ActionableError -AsErrorRecord `
                -Goal 'Run Cypher query' `
                -Problem "Could not reach Neo4j at ${HttpUri}: $($_.Exception.Message)" `
                -Location 'Invoke-CypherQuery' `
                -NextSteps @(
                    'Is Neo4j running? Try: Install-GraphDatabase',
                    'Check docker ps / docker logs ai-triad-neo4j if a container should be running.'))
    }

    if ($Response.errors -and $Response.errors.Count -gt 0) {
        # t/3855: a Cypher-level error (bad syntax, missing label/property, constraint violation) is
        # a THIRD failure mode -- Neo4j returns HTTP 200 with an `errors` array, so it never reaches
        # the catch above. Distinct from unauthorized/unreachable: the remedy here is "fix the query."
        $Messages = @($Response.errors | ForEach-Object { $_.message })
        throw (New-ActionableError -AsErrorRecord `
                -Goal 'Run Cypher query' `
                -Problem "Neo4j returned a Cypher error: $($Messages -join '; ')" `
                -Location 'Invoke-CypherQuery' `
                -NextSteps @(
                    'Check the Cypher syntax and that referenced labels/properties exist.',
                    "Query: $Query"))
    }

    if ($Raw) {
        return $Response
    }

    # Parse results into PSCustomObjects
    foreach ($Result in $Response.results) {
        $Columns = $Result.columns
        foreach ($Row in $Result.data) {
            $Obj = [ordered]@{}
            for ($i = 0; $i -lt $Columns.Count; $i++) {
                $Val = $Row.row[$i]
                $Obj[$Columns[$i]] = $Val
            }
            [PSCustomObject]$Obj
        }
    }
}
