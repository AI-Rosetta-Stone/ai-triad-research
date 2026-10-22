# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-Tax {
    <#
    .SYNOPSIS
        Returns taxonomy nodes filtered by POV, ID, label, description, or
        semantic similarity.
    .DESCRIPTION
        Queries the in-memory taxonomy loaded at module import time.

        Text filtering (default):
        -POV narrows the file scope, then any node whose ID matches
        ANY -Id pattern, OR whose label matches ANY -Label pattern,
        OR whose description matches ANY -Description pattern is returned.

        Semantic search (-Similar):
        Calls the Python embedding script to rank all nodes by cosine
        similarity to the query text. Returns results sorted by score.
        Requires embeddings.json (run Update-TaxEmbeddings first).

        Superseded POV nodes (those with superseded_by) are not returned by
        default (t/4356). An exact, wildcard-free -Id still returns the stored
        node, superseded or not; -IncludeSuperseded returns every node.
    .PARAMETER POV
        Name of the POV file without the .json extension (case-insensitive).
        Supports wildcards. Default: "*" (all POVs).
    .PARAMETER Id
        One or more wildcard patterns matched against node IDs.
    .PARAMETER Label
        One or more wildcard patterns matched against node labels.
    .PARAMETER Description
        One or more wildcard patterns matched against node descriptions.
    .PARAMETER Similar
        A text query for semantic similarity search. Mutually exclusive
        with -Id, -Label, and -Description.
    .PARAMETER IncludeSuperseded
        Also return superseded POV nodes (history and audits). Text filtering only.
    .PARAMETER Top
        Maximum number of results to return (only with -Similar or -Overlaps).
        Default: 20.
    .PARAMETER Overlaps
        Find node pairs with high embedding similarity (potential merge/consolidation
        candidates). Returns pairs sorted by similarity score descending.
    .PARAMETER Threshold
        Minimum cosine similarity to report (only with -Overlaps). Default: 0.80.
    .PARAMETER CrossPOV
        Only report pairs where nodes are from different POVs (only with -Overlaps).
    .EXAMPLE
        Get-Tax
        # Returns all nodes from every loaded POV.
    .EXAMPLE
        Get-Tax -POV skeptic
        # Returns only skeptic nodes.
    .EXAMPLE
        Get-Tax -Label "*bias*","*displacement*"
        # Returns nodes whose label matches either pattern.
    .EXAMPLE
        Get-Tax -Similar "alignment safety"
        # Ranked semantic search across all POVs.
    .EXAMPLE
        Get-Tax -POV safetyist -Similar "labor displacement"
        # Semantic search scoped to safetyist POV.
    .EXAMPLE
        Get-Tax -Similar "governance" -Top 5
        # Top 5 semantically similar nodes.
    .EXAMPLE
        Get-Tax -Overlaps
        # All node pairs with cosine similarity > 0.80.
    .EXAMPLE
        Get-Tax -Overlaps -Threshold 0.90 -Top 10
        # Top 10 most similar pairs above 0.90.
    .EXAMPLE
        Get-Tax -Overlaps -CrossPOV
        # Cross-POV overlaps only (most interesting for consolidation).
    .EXAMPLE
        'acc-desires-001','saf-desires-001' | Get-Tax
        # Pipeline by value — accepts bare ID strings.
    .EXAMPLE
        Get-Tax -Id 'acc-desires-*' | Get-Tax
        # Pipeline by property name — objects with an Id property.
    .EXAMPLE
        Get-Tax -Today
        # Nodes modified today (checks change_history[0].date).
    .EXAMPLE
        Get-Tax -Since '2026-05-25'
        # Nodes modified since May 25.
    .EXAMPLE
        Get-Tax -POV accelerationist -Since (Get-Date).AddDays(-7)
        # Accelerationist nodes changed in the last 7 days.
    .LINK
        Show-AITriadHelp
    .LINK
        Get-GraphNode
    .LINK
        Get-TaxonomyHealth
    .LINK
        Compare-Taxonomy
    .LINK
        Test-TaxonomyIntegrity
    .LINK
        Test-OntologyCompliance
    .LINK
        Get-RelevantTaxonomyNodes
    #>
    [CmdletBinding(DefaultParameterSetName = 'Text')]
    param(
        [Parameter(Position = 0)]
        [ArgumentCompleter({ param($cmd, $param, $word) @('accelerationist','safetyist','skeptic','situations') | Where-Object { $_ -like "$word*" } })]
        [string]$POV = '*',

        [Parameter(ParameterSetName = 'Text', ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [string[]]$Id,

        [Parameter(ParameterSetName = 'Text')]
        [string[]]$Label,

        [Parameter(ParameterSetName = 'Text')]
        [string[]]$Description,

        [Parameter(Mandatory, ParameterSetName = 'Similar')]
        [string]$Similar,

        [Parameter(ParameterSetName = 'Similar')]
        [Parameter(ParameterSetName = 'Overlaps')]
        [ValidateRange(1, 1000)]
        [int]$Top = 20,

        [Parameter(Mandatory, ParameterSetName = 'Overlaps')]
        [switch]$Overlaps,

        [Parameter(ParameterSetName = 'Overlaps')]
        [ValidateRange(0.0, 1.0)]
        [double]$Threshold = 0.80,

        [Parameter(ParameterSetName = 'Overlaps')]
        [switch]$CrossPOV,

        [Parameter(ParameterSetName = 'Text')]
        [switch]$Today,

        [Parameter(ParameterSetName = 'Text')]
        [datetime]$Since,

        [Parameter(ParameterSetName = 'Text')]
        [switch]$IncludeSuperseded
    )

    begin {
        Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
        $CollectedIds = [System.Collections.Generic.List[string]]::new()
    }

    process {
        # Accumulate pipeline-bound -Id values
        if ($Id) {
            foreach ($i in $Id) {
                if (-not [string]::IsNullOrWhiteSpace($i)) {
                    $CollectedIds.Add($i)
                }
            }
        }
    }

    end {

    Assert-TaxonomyCacheFresh

    if ($script:TaxonomyData.Count -eq 0) {
        Write-Verbose "Get-Tax: TaxonomyData is empty after cache check. TaxonomyDir=$(Get-TaxonomyDir), exists=$(Test-Path (Get-TaxonomyDir))"
        if (Test-Path (Get-TaxonomyDir)) {
            $files = Get-ChildItem (Get-TaxonomyDir) -Filter '*.json' -File
            Write-Verbose "Get-Tax: $($files.Count) JSON files in dir: $($files.Name -join ', ')"
        }
    }

    # Merge collected pipeline IDs with any directly specified
    if ($CollectedIds.Count -gt 0) {
        $Id = @($CollectedIds | Select-Object -Unique)
    }

    # -- Overlaps (pairwise similarity) code path ------------------------------
    if ($PSCmdlet.ParameterSetName -eq 'Overlaps') {
        $EmbedScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'embed_taxonomy.py'
        if (-not (Test-Path $EmbedScript)) { $EmbedScript = Join-Path $script:ModuleRoot 'embed_taxonomy.py' }
        if (-not (Test-Path $EmbedScript)) {
            Write-Error "embed_taxonomy.py not found at $EmbedScript"
            return
        }

        $EmbeddingsFile = Get-TaxonomyDir 'embeddings.json'
        if (-not (Test-Path $EmbeddingsFile)) {
            Write-Error "embeddings.json not found. Run Update-TaxEmbeddings first."
            return
        }

        if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }
        $PyArgs = @('find-overlaps', '--threshold', $Threshold)
        if ($POV -ne '*') {
            $PyArgs += @('--pov', $POV)
        }
        if ($CrossPOV) {
            $PyArgs += '--cross-pov'
        }
        if ($Top -and $Top -gt 0) {
            $PyArgs += @('--top', $Top)
        }

        # PS 5.1: native stderr becomes terminating error under $ErrorActionPreference='Stop'
        $PrevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $PyResult = & $PythonCmd $EmbedScript @PyArgs 2>$null } finally { $ErrorActionPreference = $PrevEAP }
        if ($LASTEXITCODE -ne 0) {
            Write-Error "embed_taxonomy.py find-overlaps failed (exit code $LASTEXITCODE)."
            return
        }

        $Results = $PyResult | ConvertFrom-Json

        if (-not $Results -or $Results.Count -eq 0) {
            Write-Host "No overlapping node pairs found above threshold $Threshold." -ForegroundColor Yellow
            return
        }

        # Build lookup for full node data
        $NodeLookup = @{}
        foreach ($Key in $script:TaxonomyData.Keys) {
            $Entry = $script:TaxonomyData[$Key]
            foreach ($Node in $Entry.nodes) {
                $NodeLookup[$Node.id] = @{ POV = $Key; Node = $Node }
            }
        }

        foreach ($Pair in $Results) {
            $InfoA = $NodeLookup[$Pair.node_a]
            $InfoB = $NodeLookup[$Pair.node_b]
            if ($InfoA) { $LabelA = $InfoA.Node.label } else { $LabelA = $Pair.node_a }
            if ($InfoB) { $LabelB = $InfoB.Node.label } else { $LabelB = $Pair.node_b }

            [PSCustomObject]@{
                PSTypeName = 'TaxonomyNode.Overlap'
                Similarity = [math]::Round($Pair.similarity, 4)
                NodeA      = $Pair.node_a
                PovA       = $Pair.pov_a
                LabelA     = $LabelA
                NodeB      = $Pair.node_b
                PovB       = $Pair.pov_b
                LabelB     = $LabelB
            }
        }
        return
    }

    # -- Similar (semantic search) code path ----------------------------------
    if ($PSCmdlet.ParameterSetName -eq 'Similar') {
        $EmbedScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'embed_taxonomy.py'
        if (-not (Test-Path $EmbedScript)) { $EmbedScript = Join-Path $script:ModuleRoot 'embed_taxonomy.py' }
        if (-not (Test-Path $EmbedScript)) {
            Write-Error "embed_taxonomy.py not found at $EmbedScript"
            return
        }

        $EmbeddingsFile = Get-TaxonomyDir 'embeddings.json'
        if (-not (Test-Path $EmbeddingsFile)) {
            Write-Error "embeddings.json not found. Run Update-TaxEmbeddings first."
            return
        }

        # Build Python arguments
        $PyArgs = @('query', $Similar, '--top', $Top)
        if ($POV -ne '*') {
            $PyArgs += @('--pov', $POV)
        }

        if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd2 = 'python' } else { $PythonCmd2 = 'python3' }
        $PyResult = & $PythonCmd2 $EmbedScript @PyArgs 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "embed_taxonomy.py query failed (exit code $LASTEXITCODE). Is sentence-transformers installed?"
            return
        }

        $Results = $PyResult | ConvertFrom-Json

        if (-not $Results -or $Results.Count -eq 0) {
            Write-Warning "No similar nodes found."
            return
        }

        # Build a lookup from in-memory taxonomy for full node data
        $NodeLookup = @{}
        foreach ($Key in $script:TaxonomyData.Keys) {
            $Entry = $script:TaxonomyData[$Key]
            foreach ($Node in $Entry.nodes) {
                $NodeLookup[$Node.id] = @{ POV = $Key; Node = $Node }
            }
        }

        foreach ($Hit in $Results) {
            $Info = $NodeLookup[$Hit.id]
            if (-not $Info) { continue }

            $Obj = ConvertTo-TaxonomyNode -PovKey $Info.POV -Node $Info.Node -Score $Hit.score
            $Obj.PSObject.TypeNames.Insert(0, 'TaxonomyNode.Similar')
            $Obj
        }
        return
    }

    # -- Text filtering (default) code path -----------------------------------
    $MatchingKeys = $script:TaxonomyData.Keys | Where-Object { $_ -like $POV.ToLower() }

    if (-not $MatchingKeys) {
        $Available = ($script:TaxonomyData.Keys | Sort-Object) -join ', '
        Write-Warning "No POV matching '$POV'. Available: $Available"
        return
    }

    $HasId     = ($null -ne $Id) -and ($Id.Length -gt 0)
    $HasLabel  = ($null -ne $Label) -and ($Label.Length -gt 0)
    $HasDesc   = ($null -ne $Description) -and ($Description.Length -gt 0)
    $HasTextFilter = $HasId -or $HasLabel -or $HasDesc
    $HasTemporal = $Today -or $null -ne $Since
    $TodayUtcStr = if ($Today) { (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd') } else { $null }

    # Exact ids reach superseded nodes too: a by-id lookup returns the stored node (t/4356).
    $ExactIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($Pat in @($Id)) { if ($Pat -and -not [System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Pat)) { [void]$ExactIds.Add($Pat) } }

    foreach ($Key in $MatchingKeys | Sort-Object) {
        $Entry = $script:TaxonomyData[$Key]
        $Nodes = if ($script:TaxonomyAllNodesByPov.ContainsKey($Key) -and ($IncludeSuperseded -or $ExactIds.Count -gt 0)) { $script:TaxonomyAllNodesByPov[$Key] } else { $Entry.nodes }
        foreach ($Node in $Nodes) {
            # Only the POV camps take part in supersession; situations are never filtered (TS parity).
            if (-not $IncludeSuperseded -and $Key -in $script:SupersessionPovKeys -and
                (Test-TaxonomyNodeSuperseded $Node) -and -not $ExactIds.Contains([string]$Node.id)) { continue }

            if ($HasTextFilter) {
                $Match = $false
                foreach ($Pat in $Id) {
                    if ($Node.id -like $Pat) { $Match = $true; break }
                }
                if (-not $Match) {
                    foreach ($Pat in $Label) {
                        if ($Node.label -like $Pat) { $Match = $true; break }
                    }
                }
                if (-not $Match) {
                    foreach ($Pat in $Description) {
                        if ($Node.description -like $Pat) { $Match = $true; break }
                    }
                }
                if (-not $Match) { continue }
            }

            # Temporal filters: check most recent change_history entry
            if ($HasTemporal) {
                if (-not $Node.PSObject.Properties['change_history'] -or -not $Node.change_history) { continue }
                $LatestDate = $null
                foreach ($H in $Node.change_history) {
                    if ($H.PSObject.Properties['date'] -and $H.date) { $LatestDate = $H.date; break }
                }
                if (-not $LatestDate) { continue }

                if ($Today) {
                    $DateStr = $LatestDate.Substring(0, 10)  # yyyy-MM-dd from ISO 8601
                    if ($DateStr -ne $TodayUtcStr) { continue }
                }
                if ($null -ne $Since) {
                    $ParsedDate = [datetime]::MinValue
                    if ([datetime]::TryParse($LatestDate, [ref]$ParsedDate)) {
                        if ($ParsedDate -lt $Since) { continue }
                    } else { continue }
                }
            }

            ConvertTo-TaxonomyNode -PovKey $Key -Node $Node
        }
    }

    } # end
}
