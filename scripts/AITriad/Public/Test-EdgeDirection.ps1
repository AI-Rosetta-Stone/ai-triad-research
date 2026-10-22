# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-EdgeDirection {
    <#
    .SYNOPSIS
        AI-powered check for edges whose source/target may be swapped.
    .DESCRIPTION
        Sends batches of directional edges to an LLM to determine whether
        the rationale text matches the stated source→target direction.
        Edges flagged as suspect get direction_flag='suspect' in edges.json.
    .PARAMETER Model
        AI model to use. Default: gemini-3.5-flash-lite.
    .PARAMETER BatchSize
        Number of edges per API call. Default: 20.
    .PARAMETER Status
        Only check edges with this status. Default: proposed.
    .PARAMETER MaxBatches
        Stop after this many batches (0 = unlimited). Default: 0.
    .PARAMETER ApiKey
        API key override.
    .PARAMETER RepoRoot
        Path to the repository root.
    .EXAMPLE
        Test-EdgeDirection
        # Check all proposed directional edges.
    .EXAMPLE
        Test-EdgeDirection -MaxBatches 5
        # Check first 100 edges (5 batches × 20).
    .LINK
        Show-AITriadHelp
    .LINK
        Approve-Edge
    .LINK
        Get-Edge
    .LINK
        Set-Edge
    .LINK
        Invoke-EdgeDiscovery
    .LINK
        Invoke-EdgeWeightEvaluation
    #>
    [CmdletBinding()]
    param(
        [string]$Model = (Get-AITierModel -Tier basic),

        [int]$BatchSize = 20,

        [ValidateSet('proposed', 'approved', 'rejected', '')]
        [string]$Status = 'proposed',

        [int]$MaxBatches = 0,

        [string]$ApiKey = '',

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir    = Get-TaxonomyDir
    $EdgesPath = Join-Path $TaxDir 'edges.json'

    if (-not (Test-Path $EdgesPath)) {
        Write-Fail 'No edges.json found.'
        return
    }

    # ── Load data ──
    $EdgesData = Read-EdgesFile -Path $EdgesPath   # t/2974: coercion-free read (preserve discovered_at strings)
    $AllEdges  = $EdgesData.edges

    # ── Build label lookup ──
    $Labels = @{}
    foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }
        $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
        foreach ($Node in $FileData.nodes) {
            $Labels[$Node.id] = $Node.label
        }
    }

    # ── Filter to directional edges ──
    $Candidates = [System.Collections.Generic.List[PSObject]]::new()
    $Superseded = Get-SupersededNodeIdSet   # no AI call for an edge with a retired endpoint; the file keeps it (t/4356)
    for ($i = 0; $i -lt $AllEdges.Count; $i++) {
        $E = $AllEdges[$i]
        if ($Superseded.Contains([string]$E.source) -or $Superseded.Contains([string]$E.target)) { continue }
        if ($E.bidirectional) { continue }
        if ($Status -and $E.status -ne $Status) { continue }
        # Skip already-checked edges
        if ($E.PSObject.Properties['direction_flag'] -and $E.direction_flag) { continue }
        $Candidates.Add([PSCustomObject]@{ Index = $i; Edge = $E })
    }

    $TotalCandidates = $Candidates.Count
    Write-Info "Found $TotalCandidates unchecked directional edges (status=$Status)"

    if ($TotalCandidates -eq 0) {
        Write-Info 'Nothing to check.'
        return
    }

    # ── Resolve API key ──
    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Fail "No API key found for $($KeyStatus.Backend). Set `$env:$($KeyStatus.EnvHint)."
        return
    }

    # ── Load prompt template ──
    $PromptTemplate = Get-Prompt -Name 'direction-check' -AllowUnresolved

    # ── Batch processing ──
    $TotalBatches  = [Math]::Ceiling($TotalCandidates / $BatchSize)
    if ($MaxBatches -gt 0) { $TotalBatches = [Math]::Min($TotalBatches, $MaxBatches) }
    $SuspectCount  = 0
    $CheckedCount  = 0
    $ErrorCount    = 0

    for ($b = 0; $b -lt $TotalBatches; $b++) {
        $Start = $b * $BatchSize
        $End   = [Math]::Min($Start + $BatchSize, $TotalCandidates) - 1
        $Batch = $Candidates[$Start..$End]

        # Build edge descriptions
        $EdgeLines = [System.Collections.Generic.List[string]]::new()
        foreach ($Item in $Batch) {
            $E = $Item.Edge
            $SrcLabel = if ($Labels.ContainsKey($E.source)) { $Labels[$E.source] } else { $E.source }
            $TgtLabel = if ($Labels.ContainsKey($E.target)) { $Labels[$E.target] } else { $E.target }
            $EdgeLines.Add("  index=$($Item.Index) | $($E.type) | `"$SrcLabel`" ($($E.source)) → `"$TgtLabel`" ($($E.target)) | Rationale: $($E.rationale)")
        }

        $FullPrompt = $PromptTemplate -replace '\{\{EDGES\}\}', ($EdgeLines -join "`n")

        Write-Progress -Activity 'Checking edge directions' `
            -Status "Batch $($b + 1) / $TotalBatches — $SuspectCount suspect so far" `
            -PercentComplete ([int](($b / $TotalBatches) * 100))

        try {
            $Response = Invoke-AIApi `
                -Prompt     $FullPrompt `
                -Model      $Model `
                -ApiKey     $ApiKey `
                -Temperature 0.1 `
                -MaxTokens  4096

            if ($null -eq $Response) {
                Write-Warning "Batch $($b + 1): API returned null"
                $ErrorCount++
                continue
            }

            $Text = $Response.Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
            $Results = $null
            try {
                $Results = $Text | ConvertFrom-Json
            } catch {
                $Repaired = Repair-TruncatedJson -Text $Text
                if ($Repaired) {
                    $Results = $Repaired | ConvertFrom-Json
                } else {
                    Write-Warning "Batch $($b + 1): Failed to parse response"
                    $ErrorCount++
                    continue
                }
            }

            # Mark checked edges as 'ok'
            foreach ($Item in $Batch) {
                $AllEdges[$Item.Index] | Add-Member -NotePropertyName 'direction_flag' -NotePropertyValue 'ok' -Force
            }

            # Override suspects
            if ($Results -and $Results.Count -gt 0) {
                foreach ($R in $Results) {
                    if ($R.suspect) {
                        $Idx = [int]$R.index
                        $AllEdges[$Idx] | Add-Member -NotePropertyName 'direction_flag' -NotePropertyValue 'suspect' -Force
                        $SuspectCount++
                        $SrcLabel = if ($Labels.ContainsKey($AllEdges[$Idx].source)) { $Labels[$AllEdges[$Idx].source] } else { $AllEdges[$Idx].source }
                        $TgtLabel = if ($Labels.ContainsKey($AllEdges[$Idx].target)) { $Labels[$AllEdges[$Idx].target] } else { $AllEdges[$Idx].target }
                        Write-Warning "  SUSPECT edg-$($Idx + 1): $SrcLabel → $TgtLabel ($($AllEdges[$Idx].type)) — $($R.reason)"
                    }
                }
            }

            $CheckedCount += $Batch.Count

        } catch {
            Write-Warning "Batch $($b + 1): Exception — $_"
            $ErrorCount++
        }

        # Checkpoint every 10 batches
        if (($b + 1) % 10 -eq 0) {
            $EdgesData.edges = $AllEdges
            Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath
            Write-Info "Checkpoint at batch $($b + 1): $CheckedCount checked, $SuspectCount suspect"
        }
    }

    Write-Progress -Activity 'Checking edge directions' -Completed

    # ── Final save ──
    $EdgesData.edges = $AllEdges
    Write-EdgesFile -EdgesData $EdgesData -Path $EdgesPath

    Write-Info "Done: $CheckedCount edges checked, $SuspectCount flagged as suspect, $ErrorCount errors"
}
