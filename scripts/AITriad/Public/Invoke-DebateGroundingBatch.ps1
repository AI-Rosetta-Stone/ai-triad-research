# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Batch-generates first-person debate-grounding statements for POV taxonomy nodes (t/3366/t/3438).
.DESCRIPTION
    For each POV node (accelerationist / safetyist / skeptic), generates ONE first-person, camp-voice
    grounding statement from the node's label + description using the CL-authored prompt
    (Prompts/debate-grounding.prompt) and writes it to graph_attributes.debate_grounding — the field the
    debate engine consumes (lib/debate/taxonomyTypes.ts; loader falls back to description when absent).

    Skips nodes that already have a non-empty debate_grounding (unless -Force), deprecated nodes, and
    nodes with an empty/very-short description. Generation is parallel; the write is surgical
    (Save-JsonNodeFieldEdits with an Upsert Path edit — one write per file, sweep-proof, creates the
    graph_attributes container if absent). Mirrors Invoke-VernacularBatch.

    CHECKPOINTING (t/3457): generation + write proceed in batches of -CheckpointEvery nodes. After each
    batch the completed nodes are flushed to disk immediately (one surgical write per file the batch
    touched), so a mid-run kill loses at most one in-flight batch instead of the entire run. Because
    Save-JsonNodeFieldEdits re-reads each file FRESH before splicing, repeated per-batch writes to the same
    file accumulate correctly. A re-run resumes cheaply: already-flushed nodes are skip-if-present (the
    -Force gate reads existing debate_grounding), so only the unfinished tail is regenerated. Each checkpoint
    emits a Write-Host line (surviving stdout capture) reporting cumulative written-count — the earlier
    end-of-run-only write left a killed run with no summary and no partial progress (t/3366 incident).

    This populates the field; the ~900-node corpus write is OWNER-executed under /data-mutation after a
    CL output spot-check (CL owns the prompt + quality bar).
.PARAMETER TaxonomyPath
    Path to the taxonomy directory containing POV JSON files. Defaults to Get-TaxonomyDir.
.PARAMETER Model
    AI model. Default: gemini-3.5-flash-lite. NOTE: do NOT use a thinking model (e.g. gemini-3.5-flash)
    here — it spends the token budget on internal reasoning and truncates the statement mid-word, leaking
    reasoning-trace fragments (t/3438#6). flash-lite emits the full statement.
.PARAMETER Concurrency
    Parallel AI calls. Default: 10.
.PARAMETER CheckpointEvery
    Flush generated statements to disk after every N nodes (default: 50). Bounds the work lost to a mid-run
    kill to at most one batch. Smaller = more durable but more writes; larger = fewer writes but more at risk.
.PARAMETER TimeoutSec
    Per-AI-call HTTP timeout in seconds (default: 60). Bounds how long one node's request can take. Combined
    with the batch's tight retry policy (2 attempts, short delays, no model cascade), this caps aggregate
    per-node time to ~135s so a single stuck / rate-limited node fails fast (counted Failed, retryable via
    skip-if-present) instead of stalling the whole run. The 916-node re-run hung 30+ min on the final node
    because the default Invoke-AIApi retry (5×) + 429 backoff (120s each) + model cascade stack ABOVE the
    per-attempt timeout — checkpointing bounded the data loss but not the hang (t/3457#4).
.PARAMETER Force
    Regenerate even nodes that already have a debate_grounding.
.PARAMETER Id
    Process only the specified node ID(s).
.EXAMPLE
    Invoke-DebateGroundingBatch -Id acc-beliefs-003
.EXAMPLE
    Invoke-DebateGroundingBatch -Concurrency 4
.LINK
    Show-AITriadHelp
.LINK
    Invoke-VernacularBatch
.LINK
    Invoke-AphorismBatch
.LINK
    Save-JsonNodeFieldEdits
#>
function Invoke-DebateGroundingBatch {
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()][string]$TaxonomyPath,
        [Parameter()][string]$Model = (Get-AITierModel -Tier basic),
        [Parameter()][ValidateRange(1, 50)][int]$Concurrency = 10,
        [Parameter()][ValidateRange(1, [int]::MaxValue)][int]$CheckpointEvery = 50,
        [Parameter()][ValidateRange(1, 600)][int]$TimeoutSec = 60,
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
                -Goal 'Generate debate-grounding statements' `
                -Problem "Taxonomy directory not found: $TaxonomyPath" `
                -Location 'Invoke-DebateGroundingBatch' `
                -NextSteps @('Check that ai-triad-data is available', 'Set $env:AI_TRIAD_DATA_ROOT or verify .aitriad.json'))
    }

    # POV camps only (BDI grounding is camp-voiced); situations.json is out of scope.
    $PovFiles = @(
        @{ File = 'accelerationist.json'; Camp = 'accelerationist' }
        @{ File = 'safetyist.json';       Camp = 'safetyist' }
        @{ File = 'skeptic.json';         Camp = 'skeptic' }
    )
    # BDI category from the node id's 2nd segment (acc-beliefs-003 → Belief); anything else passes through
    # capitalized (the prompt's per-category register block covers Belief/Desire/Intention).
    $CatMap = @{ beliefs = 'Belief'; desires = 'Desire'; intentions = 'Intention' }

    $NodesToProcess    = [System.Collections.Generic.List[PSCustomObject]]::new()
    $SkippedExisting   = 0
    $SkippedDeprecated = 0
    $SkippedEmpty      = 0
    $SkippedByIdFilter = 0

    foreach ($Pov in $PovFiles) {
        $FilePath = Join-Path $TaxonomyPath $Pov.File
        if (-not (Test-Path $FilePath)) { Write-Warning "Taxonomy file not found, skipping: $($Pov.File)"; continue }
        $TaxData = Get-Content $FilePath -Raw | ConvertFrom-Json
        foreach ($Node in @($TaxData.nodes)) {
            if ($null -ne $Id -and @($Id).Count -gt 0 -and ($Node.id -notin $Id)) { $SkippedByIdFilter++; continue }

            $Desc = if ($Node.PSObject.Properties['description']) { [string]$Node.description } else { '' }
            if ([string]::IsNullOrWhiteSpace($Desc) -or $Desc.Length -lt 20) { $SkippedEmpty++; continue }
            if ($Desc.StartsWith('[DEPRECATED]')) { $SkippedDeprecated++; continue }

            if (-not $Force) {
                $ga = if ($Node.PSObject.Properties['graph_attributes']) { $Node.graph_attributes } else { $null }
                $existing = if ($ga -and $ga.PSObject.Properties['debate_grounding']) { [string]$ga.debate_grounding } else { '' }
                if (-not [string]::IsNullOrWhiteSpace($existing)) { $SkippedExisting++; continue }
            }

            $Label = if ($Node.PSObject.Properties['label']) { [string]$Node.label } else { '' }
            $seg = ($Node.id -split '-')[1]
            $Category = if ($seg -and $CatMap.ContainsKey($seg)) { $CatMap[$seg] } elseif ($seg) { (Get-Culture).TextInfo.ToTitleCase($seg) } else { 'Belief' }

            # Render the prompt HERE (module scope → Get-Prompt private helper is in scope); the parallel
            # runspace only needs the finished string.
            $Rendered = Get-Prompt -Name 'debate-grounding' -Replacements @{
                CAMP        = $Pov.Camp
                CATEGORY    = $Category
                LABEL       = $Label
                DESCRIPTION = $Desc
            }

            $NodesToProcess.Add([PSCustomObject]@{ FilePath = $FilePath; NodeId = $Node.id; Prompt = $Rendered })
        }
    }

    $Total = $NodesToProcess.Count
    Write-Verbose "Nodes to process: $Total | skipped up-to-date:$SkippedExisting deprecated:$SkippedDeprecated empty:$SkippedEmpty id-filter:$SkippedByIdFilter"
    if ($Total -eq 0) {
        Write-Host 'Nothing to generate — all nodes have debate_grounding or were filtered out.'
        return [PSCustomObject]@{ Generated = 0; Skipped = ($SkippedExisting + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter); Failed = 0; WouldProcess = 0 }
    }

    # Batch-level gate: -WhatIf makes NO paid AI calls and NO writes — it reports what WOULD be generated.
    # (Each surgical write also re-checks via Save-JsonNodeFieldEdits, but the AI spend is gated here.)
    if (-not $PSCmdlet.ShouldProcess("$Total POV node(s)", "Generate + write debate_grounding via $Model")) {
        Write-Host "WhatIf: would generate debate_grounding for $Total node(s) (model=$Model)."
        return [PSCustomObject]@{ Generated = 0; Skipped = ($SkippedExisting + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter); Failed = 0; WhatIf = $true; WouldProcess = $Total }
    }

    $Generated = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $Failed    = [System.Collections.Concurrent.ConcurrentBag[string]]::new()

    $ModulePath = Join-Path $script:ModuleRoot 'AITriad.psm1'
    $EnrichPath = Join-Path $script:ModuleRoot '..' 'AIEnrich.psm1'
    if (-not (Test-Path $EnrichPath)) { $EnrichPath = Join-Path $script:ModuleRoot 'AIEnrich.psm1' }
    $ProgressId = 1
    $Completed  = [ref]0
    Write-Progress -Id $ProgressId -Activity 'Generating debate_grounding' -Status "0 / $Total" -PercentComplete 0

    # Generate + flush in checkpoint-sized batches so a mid-run kill loses at most one batch, not the whole
    # run (t/3366 incident / t/3457). Each batch generates in parallel then writes its completed nodes to
    # disk immediately; Save-JsonNodeFieldEdits re-reads each file FRESH, so per-batch writes to the same file
    # across batches accumulate. Generated/Failed bags and the progress counter stay cumulative across batches.
    $WrittenTotal = 0
    for ($BatchStart = 0; $BatchStart -lt $Total; $BatchStart += $CheckpointEvery) {
        $BatchEnd = [math]::Min($BatchStart + $CheckpointEvery, $Total) - 1
        $Batch = @($NodesToProcess[$BatchStart..$BatchEnd])

        # Per-batch results: FilePath -> (NodeId -> grounding text). Fresh each batch; $using binds this dict.
        $Results = [System.Collections.Concurrent.ConcurrentDictionary[string, System.Collections.Concurrent.ConcurrentDictionary[string, string]]]::new()

        $Batch | ForEach-Object -Parallel {
            Import-Module $using:ModulePath -Force -WarningAction SilentlyContinue
            Import-Module $using:EnrichPath -Force -WarningAction SilentlyContinue
            $Item = $_
            $GenBag = $using:Generated; $FailBag = $using:Failed; $ResultsDict = $using:Results
            $CompRef = $using:Completed; $TotalCount = $using:Total; $ProgId = $using:ProgressId

            try {
                # MaxTokens 512: flash-lite's longest 9-node sample output was ~401 chars (~100 tokens); 512 is
                # safe headroom. The old 256 truncated even clean output (t/3438#6).
                # Bounded per-node time (t/3457#4): tight timeout + 2 attempts / short delays + NO model
                # cascade so a stuck or rate-limited node fails fast (~<=135s, counted Failed, retryable via
                # skip-if-present) instead of stalling the whole batch. The prior default (5 retries, 120s
                # 429-backoffs, cascade) let one tail node hang the 916-run 30+ min.
                $AIResult = Invoke-AIApi -Prompt $Item.Prompt -Model $using:Model -Temperature 0.3 -MaxTokens 512 `
                    -TimeoutSec $using:TimeoutSec -MaxRetries 2 -RetryDelays @(5, 15) -FallbackModels @()
                if ($null -ne $AIResult -and -not [string]::IsNullOrWhiteSpace($AIResult.Text)) {
                    $Text = $AIResult.Text.Trim()
                    $FileDict = $ResultsDict.GetOrAdd($Item.FilePath, [System.Collections.Concurrent.ConcurrentDictionary[string, string]]::new())
                    [void]$FileDict.TryAdd($Item.NodeId, $Text)
                    [void]$GenBag.Add($Item.NodeId)
                }
                else {
                    Write-Warning "$($Item.NodeId): AI returned empty response"
                    [void]$FailBag.Add($Item.NodeId)
                }
            }
            catch {
                Write-Warning "$($Item.NodeId): $($_.Exception.Message)"
                [void]$FailBag.Add($Item.NodeId)
            }

            $Done = [System.Threading.Interlocked]::Increment($CompRef)
            $Pct = [math]::Min(100, [math]::Round(($Done / $TotalCount) * 100))
            Write-Progress -Id $ProgId -Activity 'Generating debate_grounding' -Status "$Done / $TotalCount" -PercentComplete $Pct
        } -ThrottleLimit $Concurrency

        # ── Flush this batch: ONE Save-JsonNodeFieldEdits per file touched, upsert
        # graph_attributes.debate_grounding. Nested + create-if-absent via the Path/Upsert edit (t/3438);
        # sweep-proof, re-parse-verified. Save re-reads FRESH so writes across batches accumulate.
        foreach ($FilePath in $Results.Keys) {
            $FileResults = $Results[$FilePath]
            if ($FileResults.Count -eq 0) { continue }
            $Edits = [System.Collections.Generic.List[hashtable]]::new()
            foreach ($NodeId in $FileResults.Keys) {
                $Edits.Add(@{ NodeId = $NodeId; Path = @('graph_attributes', 'debate_grounding'); Value = $FileResults[$NodeId]; Upsert = $true })
            }
            # Batch already confirmed above; write directly (Save-JsonNodeFieldEdits is the sole allowlisted
            # surgical writer and applies the upsert Path edits, one write per file).
            $SurgResult = Save-JsonNodeFieldEdits -Path $FilePath -Edits $Edits.ToArray()
            $WrittenTotal += $SurgResult.Applied
            Write-Verbose "Updated $($SurgResult.Applied) nodes in $(Split-Path $FilePath -Leaf)"
            if (@($SurgResult.NotFound).Count -gt 0) {
                Write-Warning "Invoke-DebateGroundingBatch: nodes not found in $(Split-Path $FilePath -Leaf): $($SurgResult.NotFound -join ', ')"
            }
        }

        # Checkpoint line survives stdout capture — shows how far a killed run got (t/3457 observability).
        Write-Host "Checkpoint: flushed $WrittenTotal / $Total node(s) to disk."
    }

    Write-Progress -Id $ProgressId -Activity 'Generating debate_grounding' -Completed

    $GenCount = @($Generated).Count
    $FailCount = @($Failed).Count
    $SkipCount = $SkippedExisting + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter
    Write-Host ""
    Write-Host "Done. Generated: $GenCount | Skipped: $SkipCount | Failed: $FailCount | Written: $WrittenTotal"
    [PSCustomObject]@{ Generated = $GenCount; Skipped = $SkipCount; Failed = $FailCount; Written = $WrittenTotal }
}
