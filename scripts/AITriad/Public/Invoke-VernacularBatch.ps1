# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Batch-generates plain-language descriptions for taxonomy nodes.
.DESCRIPTION
    Reads taxonomy JSON files and generates plain_description for each node
    using an AI model. Skips nodes that already have an up-to-date plain
    description (unless -Force), deprecated nodes, and nodes with empty or
    very short descriptions.
.PARAMETER TaxonomyPath
    Path to the taxonomy directory containing POV JSON files.
    Defaults to Get-TaxonomyDir.
.PARAMETER Model
    AI model to use. Default: gemini-3.5-flash-lite.
.PARAMETER Version
    Version tag written to plain_description_version for staleness detection.
    Default: flash-lite:v1.
.PARAMETER Concurrency
    Number of parallel AI calls. Default: 10.
.PARAMETER CheckpointEvery
    Write results to disk after every N generated nodes (default 100). A run interrupted with
    Ctrl-C keeps everything flushed so far; a re-run skips those nodes (their version tag is
    current) and only regenerates the rest.
.PARAMETER Force
    Regenerate all nodes, even those with up-to-date plain_description.
.PARAMETER Id
    Process only the specified node ID(s). Can be a single ID or a list.
.EXAMPLE
    Invoke-VernacularBatch
.EXAMPLE
    Invoke-VernacularBatch -Force -Concurrency 5
.LINK
    Show-AITriadHelp
.LINK
    Invoke-AIByUsage
.LINK
    Invoke-BDIWeightAssignment
.LINK
    Invoke-EdgeWeightEvaluation
.LINK
    Invoke-AphorismBatch
.LINK
    New-SyntheticCorpus
#>
function Invoke-VernacularBatch {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()][string]$TaxonomyPath,
        [Parameter()][string]$Model = (Get-AITierModel -Tier basic),
        [Parameter()][string]$Version = 'flash-lite:v1',
        [Parameter()][ValidateRange(1, 50)][int]$Concurrency = 10,
        [Parameter()][ValidateRange(1, [int]::MaxValue)][int]$CheckpointEvery = 100,
        [switch]$Force,
        [Parameter()]
        [Alias('NodeId')]
        [string[]]$Id
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $TaxonomyPath) { $TaxonomyPath = Get-TaxonomyDir }

    if (-not (Test-Path $TaxonomyPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Generate plain-language node descriptions' `
            -Problem "Taxonomy directory not found: $TaxonomyPath" `
            -Location 'Invoke-VernacularBatch' `
            -NextSteps @('Check that ai-triad-data is available', 'Set $env:AI_TRIAD_DATA_ROOT or verify .aitriad.json'))
    }

    $TaxFiles = @('accelerationist.json', 'safetyist.json', 'skeptic.json', 'situations.json')

    $SystemPrompt = @'
You rewrite academic ontological descriptions into plain language that a high school student could understand.

Rules:
1. Write at a 10th-grade reading level (Flesch-Kincaid grade ~10).
2. Use as many sentences as needed to faithfully convey the full meaning. Aim for 40-150 words — shorter for simple ideas, longer for complex multi-part claims. Never pad, but never truncate a meaningful distinction either.
3. Drop the "A Belief/Desire/Intention within X discourse that..." opener — start directly with the idea.
4. Convert "Encompasses:" items into natural prose — weave them into the explanation rather than dropping them. These sub-concepts are important.
5. Drop the "Excludes:" clause — it's an ontological boundary marker, not part of the idea itself.
6. Replace jargon with everyday words (e.g., "telemetry" → "monitoring", "post-scarcity" → "a world without shortages").
7. Preserve the core claim and its important nuances — do not add, soften, or editorialize.
8. Use active voice when possible.
9. Return ONLY the rewritten text — no labels, no explanation.
'@

    $NodesToProcess = [System.Collections.Generic.List[PSCustomObject]]::new()
    $SkippedExisting = 0
    $SkippedDeprecated = 0
    $SkippedEmpty = 0
    $SkippedByIdFilter = 0 # New counter

    foreach ($FileName in $TaxFiles) {
        $FilePath = Join-Path $TaxonomyPath $FileName
        if (-not (Test-Path $FilePath)) {
            Write-Warning "Taxonomy file not found, skipping: $FileName"
            continue
        }

        Write-Verbose "Processing taxonomy file: $FileName" # Added verbose

        $TaxData = Get-Content $FilePath -Raw | ConvertFrom-Json
        $NodeIndex = 0
        foreach ($Node in @($TaxData.nodes)) {

            # New: Filter by Id
            if ($null -ne $Id -and @($Id).Count -gt 0 -and ($Node.id -notin $Id)) {
                $SkippedByIdFilter++
                $NodeIndex++
                continue
            }

            $Desc = $null
            if ($Node.PSObject.Properties['description']) { $Desc = $Node.description }

            if ([string]::IsNullOrWhiteSpace($Desc)) {
                $SkippedEmpty++
                Write-Verbose "Skipping $($Node.id): Description is empty or whitespace." # Added verbose
                $NodeIndex++
                continue
            }
            if ($Desc.Length -lt 20) {
                $SkippedEmpty++
                Write-Verbose "Skipping $($Node.id): Description is too short." # Added verbose
                $NodeIndex++
                continue
            }
            if ($Desc.StartsWith('[DEPRECATED]')) {
                $SkippedDeprecated++
                Write-Verbose "Skipping $($Node.id): Node is deprecated." # Added verbose
                $NodeIndex++
                continue
            }

            if (-not $Force) {
                $HasPlain = $Node.PSObject.Properties['plain_description'] -and
                            -not [string]::IsNullOrWhiteSpace($Node.plain_description)
                $VersionMatch = $Node.PSObject.Properties['plain_description_version'] -and
                                $Node.plain_description_version -eq $Version
                if ($HasPlain -and $VersionMatch) {
                    $SkippedExisting++
                    Write-Verbose "Skipping $($Node.id): Plain description is up-to-date." # Added verbose
                    $NodeIndex++
                    continue
                }
            }

            $NodesToProcess.Add([PSCustomObject]@{
                File      = $FileName
                FilePath  = $FilePath
                NodeId    = $Node.id
                NodeIndex = $NodeIndex
                Desc      = $Desc
            })
            $NodeIndex++
        }
    }

    $Total = $NodesToProcess.Count
    Write-Verbose "Nodes to process after filtering: $Total" # Changed to verbose
    Write-Verbose "Skipped (up-to-date): $SkippedExisting" # Changed to verbose
    Write-Verbose "Skipped (deprecated): $SkippedDeprecated" # Changed to verbose
    Write-Verbose "Skipped (empty/short): $SkippedEmpty" # Changed to verbose
    Write-Verbose "Skipped (by ID filter): $SkippedByIdFilter" # New verbose output
    Write-Verbose "" # Changed to verbose

    if ($Total -eq 0) {
        Write-Host 'Nothing to generate — all nodes are up-to-date or filtered out.' # Updated message
        return [PSCustomObject]@{ Generated = 0; Skipped = $SkippedExisting + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter; Failed = 0 }
    }

    $Generated = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $Failed    = [System.Collections.Concurrent.ConcurrentBag[string]]::new()

    $ModulePath   = Join-Path $script:ModuleRoot 'AITriad.psm1'
    $EnrichPath   = Join-Path $script:ModuleRoot '..' 'AIEnrich.psm1'
    if (-not (Test-Path $EnrichPath)) {
        $EnrichPath = Join-Path $script:ModuleRoot 'AIEnrich.psm1'
    }
    $ProgressId = 1
    $Completed  = [ref]0

    Write-Progress -Id $ProgressId -Activity 'Generating plain descriptions' -Status "0 / $Total" -PercentComplete 0

    # Generate + flush in checkpoint-sized batches (mirrors Invoke-DebateGroundingBatch, t/3457).
    # Results used to be held in memory until every AI call finished and then written in one long,
    # silent pass, so a Ctrl-C during that pass lost the whole run. Now each batch is written as
    # soon as it completes; Save-JsonNodeFieldEdits re-reads each file FRESH, so per-batch writes
    # to the same file accumulate.
    $WrittenTotal = 0
    for ($BatchStart = 0; $BatchStart -lt $Total; $BatchStart += $CheckpointEvery) {
        $BatchEnd = [math]::Min($BatchStart + $CheckpointEvery, $Total) - 1
        $Batch = @($NodesToProcess[$BatchStart..$BatchEnd])

        # Per-batch results: FilePath -> (NodeId -> plain text). Fresh each batch.
        $Results = [System.Collections.Concurrent.ConcurrentDictionary[string, System.Collections.Concurrent.ConcurrentDictionary[string, string]]]::new()

        $Batch | ForEach-Object -Parallel {
            Import-Module $using:ModulePath -Force -WarningAction SilentlyContinue
            Import-Module $using:EnrichPath -Force -WarningAction SilentlyContinue
            $Item        = $_
            $SysPrompt   = $using:SystemPrompt
            $ModelName   = $using:Model
            $GenBag      = $using:Generated
            $FailBag     = $using:Failed
            $ResultsDict = $using:Results
            $CompRef     = $using:Completed
            $TotalCount  = $using:Total
            $ProgId      = $using:ProgressId

            $UserPrompt = "Rewrite this node description:`n`n$($Item.Desc)"

            Write-Verbose "Processing node $($Item.NodeId)"

            try {
                $AIResult = Invoke-AIApi -Prompt $UserPrompt -SystemInstruction $SysPrompt `
                    -Model $ModelName -Temperature 0.2 -MaxTokens 400

                if ($null -ne $AIResult -and -not [string]::IsNullOrWhiteSpace($AIResult.Text)) {
                    $FileDict = $ResultsDict.GetOrAdd($Item.FilePath,
                        [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new())
                    [void]$FileDict.TryAdd($Item.NodeId, $AIResult.Text.Trim())
                    [void]$GenBag.Add($Item.NodeId)
                    Write-Verbose "Generated plain description for $($Item.NodeId)"
                } else {
                    Write-Warning "$($Item.NodeId): AI returned empty response"
                    [void]$FailBag.Add($Item.NodeId)
                }
            } catch {
                Write-Warning "$($Item.NodeId): $($_.Exception.Message)"
                [void]$FailBag.Add($Item.NodeId)
            }

            $Done = [System.Threading.Interlocked]::Increment($CompRef)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $TotalCount) * 100))
            Write-Progress -Id $ProgId -Activity 'Generating plain descriptions' -Status "$Done / $TotalCount" -PercentComplete $Pct

        } -ThrottleLimit $Concurrency

        # ── Flush this batch via the field-surgical writer (t/2926) ──────────────
        # One Save-JsonNodeFieldEdits per file the batch touched: each edit is an explicit
        # scalar-field splice that preserves every untouched byte. plain_description and
        # plain_description_version are depth-1 scalars; absent-key INSERT is supported (t/2916).
        foreach ($FilePath in $Results.Keys) {
            $FileResults = $Results[$FilePath]
            if ($FileResults.Count -eq 0) { continue }

            $Edits = [System.Collections.Generic.List[hashtable]]::new()
            foreach ($NodeId in $FileResults.Keys) {
                $Edits.Add(@{ NodeId = $NodeId; Field = 'plain_description';         Value = $FileResults[$NodeId] })
                $Edits.Add(@{ NodeId = $NodeId; Field = 'plain_description_version'; Value = $Version })
            }

            $SurgResult = Save-JsonNodeFieldEdits -Path $FilePath -Edits $Edits.ToArray()
            $WrittenTotal += [Math]::Floor($SurgResult.Applied / 2)
            $FileName = Split-Path $FilePath -Leaf
            Write-Verbose "Updated $([Math]::Floor($SurgResult.Applied / 2)) nodes in $FileName"
            if (@($SurgResult.NotFound).Count -gt 0) {
                Write-Warning "Invoke-VernacularBatch: nodes not found in ${FileName} (removed since the run started?) — not written: $(@($SurgResult.NotFound | Select-Object -Unique) -join ', ')"
            }
        }

        # Checkpoint line survives stdout capture — shows how far an interrupted run got.
        Write-Host "Checkpoint: wrote $WrittenTotal / $Total node(s) to disk."
    }

    Write-Progress -Id $ProgressId -Activity 'Generating plain descriptions' -Completed

    $GenCount  = @($Generated).Count
    $FailCount = @($Failed).Count
    $SkipCount = $SkippedExisting + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter # Updated skip count

    Write-Host ""
    Write-Host "Done. Generated: $GenCount | Skipped: $SkipCount | Failed: $FailCount | Written: $WrittenTotal"

    [PSCustomObject]@{
        Generated = $GenCount
        Skipped   = $SkipCount
        Failed    = $FailCount
        Written   = $WrittenTotal
    }
}
