# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Post-processes AI-generated unmapped concepts by matching them against
# all taxonomy nodes (cross-POV). Uses embedding similarity (primary) with
# Jaccard word-overlap fallback when embeddings are unavailable.

function Get-WordTokens {
    param([string]$Text)
    $StopWords = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]@('a','an','the','in','of','and','or','for','to','is','that','with','as','by','on','at','from','its','this','it'),
        [System.StringComparer]::OrdinalIgnoreCase
    )
    # @(): zero tokens must emit nothing, not an explicit $null that a caller's @() turns into one
    # empty-string token (which would Jaccard-match any other empty label at 1.0) (t/4144).
    $Tokens = @(($Text.ToLower() -replace '[^a-z0-9\s]', '' -split '\s+') | Where-Object { $_ -and -not $StopWords.Contains($_) })
    return [string[]]$Tokens
}

function Get-JaccardSimilarity {
    param([string[]]$A, [string[]]$B)
    if ($A.Count -eq 0 -or $B.Count -eq 0) { return 0.0 }
    $SetA = [System.Collections.Generic.HashSet[string]]::new([string[]]$A, [System.StringComparer]::OrdinalIgnoreCase)
    $SetB = [System.Collections.Generic.HashSet[string]]::new([string[]]$B, [System.StringComparer]::OrdinalIgnoreCase)
    $Intersection = [System.Collections.Generic.HashSet[string]]::new($SetA, [System.StringComparer]::OrdinalIgnoreCase)
    $Intersection.IntersectWith($SetB)
    $Union = [System.Collections.Generic.HashSet[string]]::new($SetA, [System.StringComparer]::OrdinalIgnoreCase)
    $Union.UnionWith($SetB)
    if ($Union.Count -eq 0) { return 0.0 }
    return [double]$Intersection.Count / [double]$Union.Count
}

function Resolve-UnmappedConcepts {
    <#
    .SYNOPSIS
        Fuzzy-matches unmapped concepts against all taxonomy nodes across all POVs.
    .DESCRIPTION
        For each unmapped concept, uses embedding similarity (cosine) against the
        cached taxonomy embeddings. Falls back to Jaccard word-overlap when embeddings
        are unavailable. Concepts matching above the threshold are resolved to the
        best taxonomy node.
    .PARAMETER UnmappedConcepts
        Array of unmapped concept objects from a summary.
    .PARAMETER Threshold
        Minimum similarity to consider a match. For embeddings: cosine similarity
        (default 0.60). For Jaccard fallback: word overlap (default 0.50).
    .PARAMETER TaxonomyData
        Optional taxonomy hashtable. If omitted, uses the module-scoped data.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$UnmappedConcepts,

        [double]$Threshold = 0.60,

        [hashtable]$TaxonomyData
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $TaxonomyData) {
        $TaxonomyData = $script:TaxonomyData
    }

    if (-not $TaxonomyData -or $TaxonomyData.Count -eq 0) {
        Write-Warning "Resolve-UnmappedConcepts: no taxonomy data available — skipping resolution"
        return [PSCustomObject]@{ Resolved = @(); Remaining = $UnmappedConcepts }
    }

    # Build flat list of all nodes across all POVs
    $AllNodes = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($PovKey in $TaxonomyData.Keys) {
        $Entry = $TaxonomyData[$PovKey]
        if ($Entry -and $Entry.PSObject.Properties['nodes'] -and $Entry.nodes) { $Nodes = $Entry.nodes } else { $Nodes = @() }
        foreach ($Node in $Nodes) {
            if ($Node.PSObject.Properties['category']) { $NodeCat = $Node.category } else { $NodeCat = $null }
            $null = $AllNodes.Add([PSCustomObject]@{
                POV      = $PovKey
                Id       = $Node.id
                Label    = $Node.label
                Category = $NodeCat
                Tokens   = @(Get-WordTokens $Node.label)
            })
        }
    }

    # Try embedding-based resolution (primary strategy)
    $UseEmbeddings = $false
    $ConceptEmbeddings = $null
    $NodeEmbeddings = $script:CachedEmbeddings

    if ($NodeEmbeddings -and $NodeEmbeddings.Count -gt 0) {
        $ConceptTexts = @()
        $ConceptIds = @()
        for ($i = 0; $i -lt $UnmappedConcepts.Count; $i++) {
            $Props = $UnmappedConcepts[$i].PSObject.Properties
            $Label = if ($Props['suggested_label']) { $UnmappedConcepts[$i].suggested_label } else { '' }
            $Desc = if ($Props['suggested_description']) { $UnmappedConcepts[$i].suggested_description } else { '' }
            if ($Label) {
                $ConceptTexts += "$Label. $Desc"
                $ConceptIds += $i.ToString()
            }
        }

        if ($ConceptTexts.Count -gt 0) {
            $ConceptEmbeddings = Get-TextEmbedding -Texts $ConceptTexts -Ids $ConceptIds
            if ($ConceptEmbeddings -and $ConceptEmbeddings.Count -gt 0) {
                $UseEmbeddings = $true
                Write-Verbose "Resolve-UnmappedConcepts: using embedding similarity ($($ConceptTexts.Count) concepts × $($NodeEmbeddings.Count) nodes)"
            }
        }
    }

    if (-not $UseEmbeddings) {
        Write-Verbose "Resolve-UnmappedConcepts: embeddings unavailable, falling back to Jaccard word-overlap"
        $Threshold = [Math]::Min($Threshold, 0.50)
    }

    $Resolved  = [System.Collections.Generic.List[PSObject]]::new()
    $Remaining = [System.Collections.Generic.List[PSObject]]::new()
    $NearMissCount = 0

    for ($ci = 0; $ci -lt $UnmappedConcepts.Count; $ci++) {
        $Concept = $UnmappedConcepts[$ci]
        $Props = $Concept.PSObject.Properties
        if ($Props['suggested_label']) { $ConceptLabel = $Concept.suggested_label } else { $ConceptLabel = '' }
        if (-not $ConceptLabel) {
            $null = $Remaining.Add($Concept)
            continue
        }

        $BestScore = 0.0
        $BestNode  = $null

        if ($UseEmbeddings -and $ConceptEmbeddings.ContainsKey($ci.ToString())) {
            $ConceptVec = $ConceptEmbeddings[$ci.ToString()]

            foreach ($NodeId in $NodeEmbeddings.Keys) {
                $NodeVec = $NodeEmbeddings[$NodeId]
                if ($NodeVec.Count -ne $ConceptVec.Count) { continue }

                $DotProduct = 0.0; $NormA = 0.0; $NormB = 0.0
                for ($j = 0; $j -lt $ConceptVec.Count; $j++) {
                    $DotProduct += $ConceptVec[$j] * $NodeVec[$j]
                    $NormA += $ConceptVec[$j] * $ConceptVec[$j]
                    $NormB += $NodeVec[$j] * $NodeVec[$j]
                }
                $Denom = [Math]::Sqrt($NormA) * [Math]::Sqrt($NormB)
                $Sim = if ($Denom -gt 0) { $DotProduct / $Denom } else { 0.0 }

                if ($Sim -gt $BestScore) {
                    $BestScore = $Sim
                    $MatchedNode = $AllNodes | Where-Object { $_.Id -eq $NodeId } | Select-Object -First 1
                    if ($MatchedNode) { $BestNode = $MatchedNode }
                }
            }
        }
        else {
            # Jaccard fallback
            # @(): an if/else whose branch yields @() (or a Get-WordTokens result of zero tokens) collapses to
            # $null, and .Count on $null throws under StrictMode (t/4144).
            $ConceptTokens = @(Get-WordTokens $ConceptLabel)
            $DescTokens = @(if ($Props['suggested_description']) { Get-WordTokens $Concept.suggested_description })

            foreach ($Node in $AllNodes) {
                $LabelScore = Get-JaccardSimilarity $ConceptTokens $Node.Tokens
                if ($DescTokens.Count -gt 0) {
                    $DescScore = (Get-JaccardSimilarity $DescTokens $Node.Tokens) * 0.3
                } else { $DescScore = 0.0 }
                $Combined = [Math]::Max($LabelScore, $LabelScore * 0.7 + $DescScore)

                if ($Combined -gt $BestScore) {
                    $BestScore = $Combined
                    $BestNode  = $Node
                }
            }
        }

        if ($BestScore -ge $Threshold -and $BestNode) {
            Write-Verbose ("  Resolved: '{0}'  {1} (score {2})" -f $ConceptLabel, $BestNode.Id, [Math]::Round($BestScore, 3))
            $null = $Resolved.Add([PSCustomObject]@{
                ConceptLabel = $ConceptLabel
                MatchedNodeId    = $BestNode.Id
                MatchedNodeLabel = $BestNode.Label
                MatchedPOV       = $BestNode.POV
                MatchedCategory  = $BestNode.Category
                Score            = [Math]::Round($BestScore, 3)
                OriginalConcept  = $Concept
            })
        }
        else {
            $null = $Remaining.Add($Concept)
            if ($BestScore -ge 0.30) { $NearMissCount++ }
        }
    }

    # Context-rot: unmapped resolution metrics
    if (-not (Test-Path variable:script:ContextRotStages)) { $script:ContextRotStages = @() }
    $script:ContextRotStages += @(New-ContextRotStage `
        -Stage 'unmapped_resolution' -InUnits 'concepts' -InCount $UnmappedConcepts.Count `
        -OutUnits 'still_unmapped' -OutCount $Remaining.Count `
        -Flags @{
            resolved_count  = $Resolved.Count
            near_miss_count = $NearMissCount
            threshold       = $Threshold
            used_embeddings = [int]$UseEmbeddings
        })

    return [PSCustomObject]@{
        Resolved  = @($Resolved)
        Remaining = @($Remaining)
    }
}
