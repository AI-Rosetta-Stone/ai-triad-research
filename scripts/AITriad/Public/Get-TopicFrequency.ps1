# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TopicFrequency {
    <#
    .SYNOPSIS
        Discovers the most common topics per POV camp by clustering taxonomy node citations.
    .DESCRIPTION
        Scans all summary JSONs, counts how often each taxonomy node is cited per POV camp,
        clusters cited nodes by embedding similarity (agglomerative, average-linkage), then
        ranks clusters by total citation count. Optionally calls an LLM to generate topic
        labels and summaries for each cluster.
    .PARAMETER TopN
        Number of top topics to show per POV camp (1-20, default 5).
    .PARAMETER POV
        Filter to a single POV camp or 'all' (default).
    .PARAMETER OutputFile
        Optional path to write the full results as JSON.
    .PARAMETER NoAI
        Skip LLM labeling; use highest-cited node label as the cluster label.
    .PARAMETER IncludeFactualClaims
        Also count taxonomy node references in factual_claims.
    .PARAMETER ClusterThreshold
        Cosine similarity threshold for agglomerative clustering (0.3-0.9, default 0.55).
    .PARAMETER Model
        AI model override (default from $env:AI_MODEL or gemini-3.5-flash-lite).
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Get-TopicFrequency -NoAI
    .EXAMPLE
        Get-TopicFrequency -TopN 3 -POV safetyist -OutputFile topics.json
    .EXAMPLE
        Get-TopicFrequency -IncludeFactualClaims -NoAI
    .LINK
        Show-AITriadHelp
    .LINK
        Show-DebateDiagnostics
    .LINK
        Show-DebateHarvest
    .LINK
        Convert-DebateToAudio
    .LINK
        Get-AITClaim
    .LINK
        Get-CriticalInteraction
    .LINK
        Test-CriticalInteractions
    #>
    [CmdletBinding()]
    param(
        [ValidateRange(1, 20)]
        [int]$TopN = 5,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic', 'all')]
        [string]$POV = 'all',

        [Alias('OutputPath')]
        [string]$OutputFile,

        [switch]$NoAI,

        [switch]$IncludeFactualClaims,

        [ValidateRange(0.3, 0.9)]
        [double]$ClusterThreshold = 0.55,

        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model,

        [string]$ApiKey,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $Model) {
        if ($env:AI_MODEL) { $Model = $env:AI_MODEL } else { $Model = (Get-AITierModel -Tier basic) }
    }

    # ── Validate environment ─────────────────────────────────────────────────
    if (-not (Test-Path $RepoRoot)) {
        Write-Fail "Repository root not found: $RepoRoot"
        throw "Repository root not found: $RepoRoot"
    }

    $SummariesDir = Get-SummariesDir
    if (-not (Test-Path $SummariesDir)) {
        Write-Fail "Summaries directory not found: $SummariesDir"
        Write-Info "Run Invoke-POVSummary to generate summaries first."
        throw "Summaries directory not found: $SummariesDir"
    }

    # ── Build node index ─────────────────────────────────────────────────────
    Write-Step "Building node index"
    $NodeIndex = @{}
    $PovNames  = @('accelerationist', 'safetyist', 'skeptic', 'situations')

    foreach ($PovKey in $PovNames) {
        $Entry = $script:TaxonomyData[$PovKey]
        if (-not $Entry) { continue }
        foreach ($Node in $Entry.nodes) {
            if ($Node.PSObject.Properties['description']) { $Desc = $Node.description } else { $Desc = '' }
            $NodeIndex[$Node.id] = @{
                Label       = $Node.label
                Description = $Desc
                POV         = $PovKey
            }
        }
    }
    Write-OK "Indexed $($NodeIndex.Count) taxonomy nodes"

    # ── Step 1: Scan summaries and build citation counts ─────────────────────
    Write-Step "Scanning summaries for citations"

    # duplicate_of (t/4337): a marked copy's summary isn't counted as a document of its own; its
    # citations are added back under the canonical after the scan, at most once per node (spec 7.5).
    $AllSummaryFiles = @(Get-ChildItem -Path $SummariesDir -Filter '*.json' -File)
    $Resolution      = Get-DefaultSourceResolution -Caller 'Get-TopicFrequency'
    $SummaryFiles    = @(Select-SelectableSummaryFile -Files $AllSummaryFiles -Resolution $Resolution)
    $SummaryCount = $SummaryFiles.Count

    if ($SummaryCount -lt 3) {
        Write-Warn "Only $SummaryCount summaries found — results will be limited"
    }

    # Citations[camp][nodeId] = @{ Count = N; DocIds = List }
    $CampKeys  = @('accelerationist', 'safetyist', 'skeptic')
    $Citations = @{}
    foreach ($Camp in $CampKeys) {
        $Citations[$Camp] = @{}
    }
    $TotalKeyPoints = 0

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        }
        catch {
            Write-Warning "Failed to parse $($File.Name): $_"
            continue
        }

        # Every summary/key-point/claim field read below is guarded via PSObject.Properties (t/4010):
        # a bare dot-access on an absent property throws under StrictMode instead of yielding $null,
        # which made the "skip if missing" checks (and the BaseName fallback) unreachable.
        $SummaryProps = $Summary.PSObject.Properties
        $DocId = if ($SummaryProps['doc_id']) { $Summary.doc_id } else { $null }
        if (-not $DocId) { $DocId = $File.BaseName }

        # Count key_points per camp
        $PovSummaries = if ($SummaryProps['pov_summaries']) { $Summary.pov_summaries } else { $null }
        foreach ($Camp in $CampKeys) {
            $CampData = if ($PovSummaries -and $PovSummaries.PSObject.Properties[$Camp]) { $PovSummaries.$Camp } else { $null }
            if (-not $CampData -or -not $CampData.PSObject.Properties['key_points'] -or -not $CampData.key_points) { continue }

            foreach ($KP in @($CampData.key_points)) {
                $TotalKeyPoints++
                $NodeId = if ($KP.PSObject.Properties['taxonomy_node_id']) { $KP.taxonomy_node_id } else { $null }
                if (-not $NodeId) { continue }

                if (-not $Citations[$Camp].ContainsKey($NodeId)) {
                    $Citations[$Camp][$NodeId] = @{
                        Count  = 0
                        DocIds = [System.Collections.Generic.List[string]]::new()
                    }
                }
                $Citations[$Camp][$NodeId].Count++
                if ($DocId -notin $Citations[$Camp][$NodeId].DocIds) {
                    $Citations[$Camp][$NodeId].DocIds.Add($DocId)
                }
            }
        }

        # Optionally count factual_claims (attributed equally to all camps)
        if ($IncludeFactualClaims -and $SummaryProps['factual_claims'] -and $Summary.factual_claims) {
            foreach ($Claim in @($Summary.factual_claims)) {
                # Unmapped claims carry potential_taxonomy_nodes instead (live in the corpus, t/4010).
                if (-not ($Claim.PSObject.Properties['linked_taxonomy_nodes'] -and $Claim.linked_taxonomy_nodes)) { continue }
                foreach ($NodeId in @($Claim.linked_taxonomy_nodes)) {
                    if (-not $NodeId) { continue }
                    foreach ($Camp in $CampKeys) {
                        if (-not $Citations[$Camp].ContainsKey($NodeId)) {
                            $Citations[$Camp][$NodeId] = @{
                                Count  = 0
                                DocIds = [System.Collections.Generic.List[string]]::new()
                            }
                        }
                        $Citations[$Camp][$NodeId].Count++
                        if ($DocId -notin $Citations[$Camp][$NodeId].DocIds) {
                            $Citations[$Camp][$NodeId].DocIds.Add($DocId)
                        }
                    }
                }
            }
        }
    }

    # Duplicate-group union (spec 7.5, t/4337): a copy's model run may cite a node its canonical's
    # run missed. Count that node for the canonical once; never add to a node it already counts,
    # so a doc and its copies can't make a topic look more frequent.
    $AddOncePerDoc = {
        param([string]$Camp, [string]$NodeId, [string]$Canonical)
        if (-not $Citations[$Camp].ContainsKey($NodeId)) {
            $Citations[$Camp][$NodeId] = @{ Count = 0; DocIds = [System.Collections.Generic.List[string]]::new() }
        }
        if ($Canonical -notin $Citations[$Camp][$NodeId].DocIds) {
            $Citations[$Camp][$NodeId].Count++
            $Citations[$Camp][$NodeId].DocIds.Add($Canonical)
        }
    }
    foreach ($Copy in @(Get-MarkedCopySummary -Files $AllSummaryFiles -Resolution $Resolution -Caller 'Get-TopicFrequency')) {
        $CopyProps = $Copy.Summary.PSObject.Properties
        $PovSummaries = if ($CopyProps['pov_summaries']) { $Copy.Summary.pov_summaries } else { $null }
        foreach ($Camp in $CampKeys) {
            $CampData = if ($PovSummaries -and $PovSummaries.PSObject.Properties[$Camp]) { $PovSummaries.$Camp } else { $null }
            if (-not $CampData -or -not $CampData.PSObject.Properties['key_points'] -or -not $CampData.key_points) { continue }
            foreach ($KP in @($CampData.key_points)) {
                $NodeId = if ($KP.PSObject.Properties['taxonomy_node_id']) { $KP.taxonomy_node_id } else { $null }
                if ($NodeId) { & $AddOncePerDoc $Camp $NodeId $Copy.CanonicalId }
            }
        }
        if ($IncludeFactualClaims -and $CopyProps['factual_claims'] -and $Copy.Summary.factual_claims) {
            foreach ($Claim in @($Copy.Summary.factual_claims)) {
                if (-not ($Claim.PSObject.Properties['linked_taxonomy_nodes'] -and $Claim.linked_taxonomy_nodes)) { continue }
                foreach ($NodeId in @($Claim.linked_taxonomy_nodes)) {
                    if ($NodeId) { foreach ($Camp in $CampKeys) { & $AddOncePerDoc $Camp $NodeId $Copy.CanonicalId } }
                }
            }
        }
    }

    Write-OK "Scanned $SummaryCount summaries, $TotalKeyPoints key points"

    # ── Step 2: Load embeddings ──────────────────────────────────────────────
    Write-Step "Loading embeddings"
    $EmbeddingsFile = Get-TaxonomyDir 'embeddings.json'
    $Embeddings     = @{}

    if (Test-Path $EmbeddingsFile) {
        try {
            $EmbData = Get-Content -Raw -Path $EmbeddingsFile | ConvertFrom-Json
            if ($EmbData.PSObject.Properties['nodes']) { $EmbNodes = $EmbData.nodes } else { $EmbNodes = $EmbData }
            foreach ($Prop in $EmbNodes.PSObject.Properties) {
                $Val = $Prop.Value
                # Handle both flat arrays and {pov, vector} objects
                if ($Val -is [array]) {
                    $Embeddings[$Prop.Name] = [double[]]$Val
                }
                elseif ($Val.PSObject.Properties['vector']) {
                    $Embeddings[$Prop.Name] = [double[]]$Val.vector
                }
            }
            Write-OK "Loaded $($Embeddings.Count) embeddings"
        }
        catch {
            Write-Warn "Failed to load embeddings: $_ — clustering will be limited"
        }
    }
    else {
        Write-Warn "embeddings.json not found — each node will be its own cluster"
    }

    # ── Step 3: Cluster per POV ──────────────────────────────────────────────
    Write-Step "Clustering cited nodes per POV"

    if ($POV -eq 'all') { $TargetCamps = $CampKeys } else { $TargetCamps = @($POV) }
    $AllTopics   = @{}

    foreach ($Camp in $TargetCamps) {
        $CampCitations = $Citations[$Camp]
        $CitedNodes    = @($CampCitations.Keys | Where-Object { $CampCitations[$_].Count -gt 0 })

        if ($CitedNodes.Count -eq 0) {
            Write-Info "$Camp — no cited nodes"
            $AllTopics[$Camp] = @()
            continue
        }

        # Separate nodes with/without embeddings
        $WithEmb    = @($CitedNodes | Where-Object { $Embeddings.ContainsKey($_) })
        $WithoutEmb = @($CitedNodes | Where-Object { -not $Embeddings.ContainsKey($_) })

        # Cluster nodes with embeddings
        $MaxClusters = $TopN * 2
        $ClusterArrays = @()
        if ($WithEmb.Count -gt 0) {
            $ClusterArrays = @(Get-EmbeddingClusters `
                -NodeIds      $WithEmb `
                -Embeddings   $Embeddings `
                -MaxClusters  $MaxClusters `
                -MinSimilarity $ClusterThreshold)
        }

        # Add singleton clusters for nodes without embeddings
        foreach ($NodeId in $WithoutEmb) {
            $ClusterArrays += ,@($NodeId)
        }

        # Score each cluster by summing citation counts, rank descending
        $ScoredClusters = @($ClusterArrays | ForEach-Object {
            $Members = $_
            $TotalCit = 0
            $AllDocs  = [System.Collections.Generic.List[string]]::new()
            foreach ($NId in $Members) {
                if ($CampCitations.ContainsKey($NId)) {
                    $TotalCit += $CampCitations[$NId].Count
                    foreach ($D in $CampCitations[$NId].DocIds) {
                        if ($D -notin $AllDocs) { $AllDocs.Add($D) }
                    }
                }
            }
            [PSCustomObject]@{
                Members        = $Members
                TotalCitations = $TotalCit
                DocIds         = $AllDocs.ToArray()
            }
        } | Sort-Object -Property TotalCitations -Descending)

        # Take top N
        $TopClusters = @($ScoredClusters | Select-Object -First $TopN)
        $AllTopics[$Camp] = $TopClusters

        Write-Info "$Camp — $($CitedNodes.Count) cited nodes, $($ClusterArrays.Count) clusters, top $($TopClusters.Count) selected"
    }

    # ── Step 4: Label clusters ───────────────────────────────────────────────
    $AILabeled = $false
    $Labels    = $null

    if (-not $NoAI) {
        Write-Step "Labeling clusters with AI"

        try {
            # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
            $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
            if (-not $KeyStatus.HasKey) {
                Write-Warn "No API key found for $($KeyStatus.Backend) — falling back to -NoAI labeling"
                $NoAI = $true
            }
            else {
                # Build cluster descriptions for the prompt
                $ClusterDescs = [System.Text.StringBuilder]::new()
                foreach ($Camp in $TargetCamps) {
                    for ($i = 0; $i -lt $AllTopics[$Camp].Count; $i++) {
                        $Cluster = $AllTopics[$Camp][$i]
                        [void]$ClusterDescs.AppendLine("--- $($Camp)_$i ---")
                        [void]$ClusterDescs.AppendLine("POV: $Camp | Citations: $($Cluster.TotalCitations)")
                        [void]$ClusterDescs.AppendLine("Member nodes:")
                        foreach ($NId in $Cluster.Members) {
                            if ($NodeIndex.ContainsKey($NId)) { $Lbl = $NodeIndex[$NId].Label } else { $Lbl = $NId }
                            if ($NodeIndex.ContainsKey($NId)) { $Desc = $NodeIndex[$NId].Description } else { $Desc = '' }
                            if ($Citations[$Camp].ContainsKey($NId)) { $Cit = $Citations[$Camp][$NId].Count } else { $Cit = 0 }
                            [void]$ClusterDescs.AppendLine("  - $NId ($Cit citations): $Lbl — $Desc")
                        }
                        [void]$ClusterDescs.AppendLine()
                    }
                }

                $PromptBody  = Get-Prompt -Name 'topic-frequency-label' -Replacements @{ CLUSTERS = $ClusterDescs.ToString() }
                $SchemaBody  = Get-Prompt -Name 'topic-frequency-label-schema'
                $FullPrompt  = "$PromptBody`n`n$SchemaBody"

                $AIResult = Invoke-AIApi `
                    -Prompt     $FullPrompt `
                    -Model      $Model `
                    -ApiKey     $ApiKey `
                    -Temperature 0.1 `
                    -MaxTokens  4096 `
                    -JsonMode `
                    -MaxRetries 3 `
                    -RetryDelays @(5, 15, 45)

                if ($AIResult -and $AIResult.Text) {
                    $LabelText = $AIResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
                    $Labels = $LabelText | ConvertFrom-Json
                    $AILabeled = $true
                    Write-OK "AI labeling complete ($($AIResult.Backend))"
                }
                else {
                    Write-Warn "AI returned no result — falling back to -NoAI labeling"
                    $NoAI = $true
                }
            }
        }
        catch {
            Write-Warn "AI labeling failed: $_ — falling back to -NoAI labeling"
            $NoAI = $true
        }
    }

    # ── Build output structure ───────────────────────────────────────────────
    Write-Step "Building results"

    $TopicsByPov = [ordered]@{}
    foreach ($Camp in $TargetCamps) {
        $CampTopics = [System.Collections.Generic.List[PSObject]]::new()

        for ($i = 0; $i -lt $AllTopics[$Camp].Count; $i++) {
            $Cluster = $AllTopics[$Camp][$i]
            $Key     = "$($Camp)_$i"

            # Determine label and summary
            if ($AILabeled -and $null -ne $Labels -and $Labels.PSObject.Properties[$Key]) {
                $TopicLabel   = $Labels.$Key.topic_label
                $TopicSummary = $Labels.$Key.topic_summary
            }
            else {
                # NoAI fallback: use highest-cited member's label
                $BestNode = $Cluster.Members |
                    Sort-Object { if ($Citations[$Camp].ContainsKey($_)) { $Citations[$Camp][$_].Count } else { 0 } } -Descending |
                    Select-Object -First 1
                if ($NodeIndex.ContainsKey($BestNode)) { $TopicLabel = $NodeIndex[$BestNode].Label } else { $TopicLabel = $BestNode }
                $TopicSummary = ($Cluster.Members | ForEach-Object {
                    if ($NodeIndex.ContainsKey($_)) { $NodeIndex[$_].Label } else { $_ }
                }) -join ', '
            }

            # Build member details
            $MemberDetails = @($Cluster.Members | ForEach-Object {
                $NId = $_
                [ordered]@{
                    id        = $NId
                    label     = if ($NodeIndex.ContainsKey($NId)) { $NodeIndex[$NId].Label } else { $NId }
                    citations = if ($Citations[$Camp].ContainsKey($NId)) { $Citations[$Camp][$NId].Count } else { 0 }
                }
            } | Sort-Object { $_.citations } -Descending)

            $CampTopics.Add([PSCustomObject][ordered]@{
                rank                = $i + 1
                topic_label         = $TopicLabel
                topic_summary       = $TopicSummary
                total_citations     = $Cluster.TotalCitations
                member_nodes        = $MemberDetails
                contributing_doc_ids = $Cluster.DocIds
            })
        }

        $TopicsByPov[$Camp] = @($CampTopics)
    }

    $Result = [ordered]@{
        generated_at      = (Get-Date -Format 'o')
        summary_count     = $SummaryCount
        total_key_points  = $TotalKeyPoints
        cluster_threshold = $ClusterThreshold
        ai_labeled        = $AILabeled
        topics_by_pov     = $TopicsByPov
    }

    # ── Step 5: Console output ───────────────────────────────────────────────
    Write-Host "`n$('═' * 60)" -ForegroundColor Cyan
    Write-Host "  TOPIC FREQUENCY — $SummaryCount summaries, ~$TotalKeyPoints key points" -ForegroundColor White
    Write-Host "$('═' * 60)" -ForegroundColor Cyan

    foreach ($Camp in $TargetCamps) {
        $CampUpper = $Camp.ToUpper()
        Write-Host "`n  $CampUpper — Top $($TopicsByPov[$Camp].Count) Topics" -ForegroundColor White
        Write-Host "  $('─' * 45)" -ForegroundColor DarkGray

        foreach ($Topic in $TopicsByPov[$Camp]) {
            $NodeCount = $Topic.member_nodes.Count
            Write-Host "   $($Topic.rank). $($Topic.topic_label)  " -ForegroundColor White -NoNewline
            Write-Host "($($Topic.total_citations) citations, $NodeCount nodes)" -ForegroundColor Gray
            Write-Host "      $($Topic.topic_summary)" -ForegroundColor DarkGray
            $NodeIds = ($Topic.member_nodes | ForEach-Object { $_.id }) -join ', '
            Write-Host "      Nodes: $NodeIds" -ForegroundColor DarkGray
        }
    }

    Write-Host "`n$('═' * 60)" -ForegroundColor Cyan

    # ── JSON export ──────────────────────────────────────────────────────────
    if ($OutputFile) {
        try {
            $Json = $Result | ConvertTo-Json -Depth 20
            Write-Utf8NoBom -Path $OutputFile -Value $Json 
            Write-OK "Exported to $OutputFile"
        }
        catch {
            Write-Warn "Failed to write $OutputFile — $($_.Exception.Message)"
            Write-Info "Results are still returned to the pipeline."
        }
    }

    return $Result
}
