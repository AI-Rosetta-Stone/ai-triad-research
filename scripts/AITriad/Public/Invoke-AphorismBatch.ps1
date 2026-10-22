# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Batch-generates camp-voiced sober aphorisms for POV taxonomy nodes (t/1550).
.DESCRIPTION
    Reads the three POV taxonomy files (accelerationist/safetyist/skeptic) and
    generates `graph_attributes.aphorism` for each node using the
    `enrichment.pov-aphorism` UsageID. Situations are out of scope v1.

    Presentational field only — never a scoring/relevance/embedding input.

    Skips:
      - Nodes that already have a non-empty aphorism (unless -Force)
      - Nodes whose description begins "A thematic pillar" — pillars get themed
        hooks under a separate owner-review track; leave empty v1
      - Deprecated nodes ([DEPRECATED] prefix)
      - Nodes with empty or very short (< 20 char) descriptions

    Regeneration on modify (label/description edits from the write paths in
    Invoke-ProposalApply and Repair-PovDescriptions) is handled by a separate
    fail-open helper — this cmdlet is the bulk backfill entry point.
.PARAMETER TaxonomyPath
    POV taxonomy directory. Defaults to Get-TaxonomyDir.
.PARAMETER Concurrency
    Parallel AI calls. Default: 10.
.PARAMETER Force
    Regenerate even for nodes that already have an aphorism.
.PARAMETER Id
    Restrict to specific node ID(s). Useful for the CL 20-node sample review.
.EXAMPLE
    Invoke-AphorismBatch
.EXAMPLE
    # Generate the CL-review sample without touching the rest
    Invoke-AphorismBatch -Id acc-desires-001,saf-beliefs-001,skp-intentions-001
.EXAMPLE
    Invoke-AphorismBatch -Force -Concurrency 5
.LINK
    Show-AITriadHelp
.LINK
    Invoke-AIByUsage
.LINK
    Invoke-BDIWeightAssignment
.LINK
    Invoke-EdgeWeightEvaluation
.LINK
    Invoke-VernacularBatch
.LINK
    New-SyntheticCorpus
#>
function Invoke-AphorismBatch {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()][string]$TaxonomyPath,
        [Parameter()][ValidateRange(1, 50)][int]$Concurrency = 10,
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
            -Goal 'Generate POV node aphorisms' `
            -Problem "Taxonomy directory not found: $TaxonomyPath" `
            -Location 'Invoke-AphorismBatch' `
            -NextSteps @('Check that ai-triad-data is available',
                         'Set $env:AI_TRIAD_DATA_ROOT or verify .aitriad.json'))
    }

    # Situations are out of scope v1 — POV files only.
    $TaxFiles = @('accelerationist.json', 'safetyist.json', 'skeptic.json')

    # Prompt lives in the .prompt file (ADR-006). CL-approved text (t/1550#2)
    # embeds NODE data as {{pov}}/{{category}}/{{label}}/{{description}} — we
    # render those per-call via Get-Prompt -Replacements, then pass the fully
    # rendered text to the UsageID as {{prompt}}. Prompt template loaded lazily
    # inside the parallel scriptblock to avoid $using capture of a large string
    # per-node; instead we pass Model + Concurrency and let each worker load.

    $NodesToProcess     = [System.Collections.Generic.List[PSCustomObject]]::new()
    $SkippedExisting    = 0
    $SkippedPillar      = 0
    $SkippedDeprecated  = 0
    $SkippedEmpty       = 0
    $SkippedByIdFilter  = 0

    foreach ($FileName in $TaxFiles) {
        $FilePath = Join-Path $TaxonomyPath $FileName
        if (-not (Test-Path $FilePath)) {
            Write-Warning "Taxonomy file not found, skipping: $FileName"
            continue
        }

        Write-Verbose "Processing taxonomy file: $FileName"

        $TaxData    = Get-Content $FilePath -Raw | ConvertFrom-Json
        $PovName    = if ($TaxData.PSObject.Properties['pov']) { [string]$TaxData.pov } else { '' }
        $NodeIndex  = 0
        foreach ($Node in @($TaxData.nodes)) {

            if ($null -ne $Id -and @($Id).Count -gt 0 -and ($Node.id -notin $Id)) {
                $SkippedByIdFilter++
                $NodeIndex++
                continue
            }
            if (Test-TaxonomyNodeSuperseded $Node) {   # no AI call for a retired node; the file keeps it (t/4356)
                Write-Verbose "Skipping $($Node.id): superseded by $($Node.superseded_by)"
                $NodeIndex++
                continue
            }

            $Desc = $null
            if ($Node.PSObject.Properties['description']) { $Desc = $Node.description }
            $LabelStr = ''
            if ($Node.PSObject.Properties['label']) { $LabelStr = [string]$Node.label }

            if ([string]::IsNullOrWhiteSpace($Desc) -or $Desc.Length -lt 20) {
                $SkippedEmpty++
                $NodeIndex++
                continue
            }
            # Deprecation marker may live on either label or description (CL review t/1550#4).
            if ($Desc.StartsWith('[DEPRECATED]') -or $LabelStr.StartsWith('[DEPRECATED]')) {
                $SkippedDeprecated++
                $NodeIndex++
                continue
            }
            if ($Desc.StartsWith('A thematic pillar')) {
                $SkippedPillar++
                Write-Verbose "Skipping pillar node $($Node.id) (v1 excludes pillars)"
                $NodeIndex++
                continue
            }

            if (-not $Force) {
                $HasAphorism = $false
                if ($Node.PSObject.Properties['graph_attributes'] -and
                    $null -ne $Node.graph_attributes -and
                    $Node.graph_attributes.PSObject.Properties['aphorism']) {
                    $HasAphorism = -not [string]::IsNullOrWhiteSpace($Node.graph_attributes.aphorism)
                }
                if ($HasAphorism) {
                    $SkippedExisting++
                    $NodeIndex++
                    continue
                }
            }

            $Label    = if ($Node.PSObject.Properties['label']) { [string]$Node.label } else { '' }
            $Category = if ($Node.PSObject.Properties['category']) { [string]$Node.category } else { '' }

            # Pre-render prompt in this (outer) runspace — Get-Prompt is a Private
            # module helper and isn't visible inside ForEach-Object -Parallel's
            # per-worker runspaces. Passing the rendered text via the work item
            # sidesteps that entirely.
            $RenderedPrompt = Get-Prompt -Name 'pov-aphorism' -Replacements @{
                pov         = $PovName
                category    = $Category
                label       = $Label
                description = $Desc
            }

            $NodesToProcess.Add([PSCustomObject]@{
                File       = $FileName
                FilePath   = $FilePath
                NodeId     = $Node.id
                NodeIndex  = $NodeIndex
                Pov        = $PovName
                Label      = $Label
                Category   = $Category
                Desc       = $Desc
                Prompt     = $RenderedPrompt
            })
            $NodeIndex++
        }
    }

    $Total = $NodesToProcess.Count
    Write-Verbose "Nodes to process: $Total"
    Write-Verbose "Skipped up-to-date: $SkippedExisting"
    Write-Verbose "Skipped pillars: $SkippedPillar"
    Write-Verbose "Skipped deprecated: $SkippedDeprecated"
    Write-Verbose "Skipped empty/short: $SkippedEmpty"
    Write-Verbose "Skipped by -Id filter: $SkippedByIdFilter"

    if ($Total -eq 0) {
        Write-Host 'Nothing to generate — all nodes already have aphorisms or were filtered out.'
        return [PSCustomObject]@{
            Generated = 0
            Skipped   = $SkippedExisting + $SkippedPillar + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter
            Failed    = 0
        }
    }

    $Generated = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $Failed    = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $Results   = [System.Collections.Concurrent.ConcurrentDictionary[string, System.Collections.Concurrent.ConcurrentDictionary[int, PSCustomObject]]]::new()

    $ModulePath = Join-Path $script:ModuleRoot 'AITriad.psm1'
    $EnrichPath = Join-Path $script:ModuleRoot '..' 'AIEnrich.psm1'
    if (-not (Test-Path $EnrichPath)) {
        $EnrichPath = Join-Path $script:ModuleRoot 'AIEnrich.psm1'
    }
    $ProgressId = 1
    $Completed  = [ref]0

    Write-Progress -Id $ProgressId -Activity 'Generating aphorisms' -Status "0 / $Total" -PercentComplete 0

    if ($Concurrency -eq 1) {
        # Sequential path — same runspace, no parallel-scriptblock isolation.
        # Used for tests (mocks work) and for CL's 20-sample review runs where
        # deterministic ordering matters more than throughput.
        foreach ($Item in $NodesToProcess) {
            try {
                $AIResult = Invoke-AIByUsage -UsageId 'enrichment.pov-aphorism' -Values @{
                    prompt = $Item.Prompt
                }
                if ($null -ne $AIResult -and -not [string]::IsNullOrWhiteSpace($AIResult.Text)) {
                    $Aphorism = $AIResult.Text.Trim().Trim('"').Trim()
                    $FileDict = $Results.GetOrAdd($Item.FilePath,
                        [System.Collections.Concurrent.ConcurrentDictionary[int, PSCustomObject]]::new())
                    [void]$FileDict.TryAdd($Item.NodeIndex, [PSCustomObject]@{
                        Aphorism = $Aphorism
                    })
                    [void]$Generated.Add($Item.NodeId)
                } else {
                    Write-Warning "$($Item.NodeId): AI returned empty response"
                    [void]$Failed.Add($Item.NodeId)
                }
            } catch {
                Write-Warning "$($Item.NodeId): $($_.Exception.Message)"
                [void]$Failed.Add($Item.NodeId)
            }
            $Done = [System.Threading.Interlocked]::Increment($Completed)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $Total) * 100))
            Write-Progress -Id $ProgressId -Activity 'Generating aphorisms' -Status "$Done / $Total" -PercentComplete $Pct
        }
    } else {
    $NodesToProcess | ForEach-Object -Parallel {
        Import-Module $using:ModulePath -Force -WarningAction SilentlyContinue
        Import-Module $using:EnrichPath -Force -WarningAction SilentlyContinue
        $Item        = $_
        $GenBag      = $using:Generated
        $FailBag     = $using:Failed
        $ResultsDict = $using:Results
        $CompRef     = $using:Completed
        $TotalCount  = $using:Total
        $ProgId      = $using:ProgressId

        try {
            # Prompt was rendered in the outer runspace and travels with the work
            # item — Get-Prompt is a Private helper and isn't visible here.
            $AIResult = Invoke-AIByUsage -UsageId 'enrichment.pov-aphorism' -Values @{
                prompt = $Item.Prompt
            }

            if ($null -ne $AIResult -and -not [string]::IsNullOrWhiteSpace($AIResult.Text)) {
                $Aphorism = $AIResult.Text.Trim().Trim('"').Trim()

                $FileDict = $ResultsDict.GetOrAdd($Item.FilePath,
                    [System.Collections.Concurrent.ConcurrentDictionary[int, PSCustomObject]]::new())
                [void]$FileDict.TryAdd($Item.NodeIndex, [PSCustomObject]@{
                    Aphorism = $Aphorism
                })
                [void]$GenBag.Add($Item.NodeId)
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
        Write-Progress -Id $ProgId -Activity 'Generating aphorisms' -Status "$Done / $TotalCount" -PercentComplete $Pct

    } -ThrottleLimit $Concurrency
    }

    Write-Progress -Id $ProgressId -Activity 'Generating aphorisms' -Completed

    # Write-back stage — one file at a time, deep-copies node property tree so
    # additive graph_attributes doesn't collide with strict-mode parsing.
    foreach ($FilePath in $Results.Keys) {
        $FileResults = $Results[$FilePath]
        if ($FileResults.Count -eq 0) { continue }

        $TaxData = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)
        $NodesArray = @($TaxData.nodes)
        foreach ($Idx in $FileResults.Keys) {
            $Entry = $FileResults[$Idx]
            $Node  = $NodesArray[$Idx]

            if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) {
                $Node | Add-Member -NotePropertyName 'graph_attributes' -NotePropertyValue ([PSCustomObject]@{}) -Force
            }
            if ($Node.graph_attributes.PSObject.Properties['aphorism']) {
                $Node.graph_attributes.aphorism = $Entry.Aphorism
            } else {
                $Node.graph_attributes | Add-Member -NotePropertyName 'aphorism' -NotePropertyValue $Entry.Aphorism
            }
        }

        if ($PSCmdlet.ShouldProcess($FilePath, 'Save aphorisms')) {
            Write-PovTaxonomyFile -Path $FilePath -Data $TaxData   # canonical TS format (t/4356)
            $FileName = Split-Path $FilePath -Leaf
            Write-Verbose "Updated $($FileResults.Count) nodes in $FileName"
        }
    }

    $GenCount  = @($Generated).Count
    $FailCount = @($Failed).Count
    $SkipCount = $SkippedExisting + $SkippedPillar + $SkippedDeprecated + $SkippedEmpty + $SkippedByIdFilter

    # ── Exact-dup audit (t/1550#4 CL note 2) ─────────────────────────────
    # Flags aphorisms that came out bit-identical across nodes so CL can
    # audit and re-run those specific IDs with -Force. Logged not
    # regenerated — deterministic-seed retry would just recollide.
    $Duplicates = [System.Collections.Generic.List[PSObject]]::new()
    $bucket = @{}
    foreach ($FilePath in $Results.Keys) {
        $FileResults = $Results[$FilePath]
        foreach ($Idx in $FileResults.Keys) {
            $Entry = $FileResults[$Idx]
            $key = $Entry.Aphorism.Trim().ToLowerInvariant()
            if ($bucket.ContainsKey($key)) {
                $Duplicates.Add([PSCustomObject]@{
                    Aphorism = $Entry.Aphorism
                    Nodes    = @($bucket[$key], "$FilePath::$Idx")
                })
            } else {
                $bucket[$key] = "$FilePath::$Idx"
            }
        }
    }
    if ($Duplicates.Count -gt 0) {
        Write-Warning "$($Duplicates.Count) exact-duplicate aphorism(s) detected — see .Duplicates on the return object; re-run affected IDs with -Force to regenerate"
    }

    Write-Host ""
    Write-Host "Done. Generated: $GenCount | Skipped: $SkipCount | Failed: $FailCount | Duplicates: $($Duplicates.Count)"

    [PSCustomObject]@{
        Generated  = $GenCount
        Skipped    = $SkipCount
        Failed     = $FailCount
        Duplicates = @($Duplicates)
    }
}

function New-NodeAphorism {
    <#
    .SYNOPSIS
        Fail-open aphorism generator for a single node (t/1550 write-path wiring).
    .DESCRIPTION
        Called from Invoke-ProposalApply on node CREATE / label-or-description
        UPDATE, and from Repair-PovDescriptions after a description rewrite.

        Generation failure NEVER blocks the underlying node write — enrichment
        is never a gate on taxonomy operations. On failure this warns and
        returns $null; caller should leave the aphorism field untouched.

        Skips pillar nodes and situations by contract — callers passing a
        pillar node get $null back, matching the batch backfill's exclusion.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Node,

        [Parameter()]
        [string]$Pov,

        [Parameter()]
        [string]$Reason = 'write-path-regen'
    )

    Set-StrictMode -Version Latest

    if (-not $Node -or -not $Node.PSObject.Properties['id']) { return $null }

    $NodeId = [string]$Node.id
    # Situations out of scope v1.
    if ($NodeId -match '^(sit|cc)-') { return $null }

    $Desc = if ($Node.PSObject.Properties['description']) { [string]$Node.description } else { '' }
    if ([string]::IsNullOrWhiteSpace($Desc) -or $Desc.Length -lt 20) { return $null }
    if ($Desc.StartsWith('A thematic pillar')) { return $null }

    $Label    = if ($Node.PSObject.Properties['label']) { [string]$Node.label } else { '' }
    $Category = if ($Node.PSObject.Properties['category']) { [string]$Node.category } else { '' }

    # Deprecation marker may live on either label or description (CL review t/1550#4).
    if ($Desc.StartsWith('[DEPRECATED]') -or $Label.StartsWith('[DEPRECATED]')) { return $null }

    try {
        $Rendered = Get-Prompt -Name 'pov-aphorism' -Replacements @{
            pov         = $Pov
            category    = $Category
            label       = $Label
            description = $Desc
        }
        $AIResult = Invoke-AIByUsage -UsageId 'enrichment.pov-aphorism' -Values @{
            prompt = $Rendered
        }
        if ($null -eq $AIResult -or [string]::IsNullOrWhiteSpace($AIResult.Text)) { return $null }
        return $AIResult.Text.Trim().Trim('"').Trim()
    } catch {
        Write-Warning "New-NodeAphorism failed for $NodeId ($Reason): $($_.Exception.Message)"
        return $null
    }
}

function Set-NodeAphorism {
    <#
    .SYNOPSIS
        Writes an aphorism to node.graph_attributes.aphorism if generation succeeded (t/1550).
    .DESCRIPTION
        Convenience wrapper used by the write-path wiring: calls
        New-NodeAphorism, and only mutates the node if a non-empty aphorism
        came back. Silently leaves the node untouched on failure — matches
        the fail-open contract required by the ticket ("generation failure
        must not block the underlying node write").
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Node,

        [Parameter()]
        [string]$Pov,

        [Parameter()]
        [string]$Reason = 'write-path-regen'
    )

    Set-StrictMode -Version Latest

    $Aphorism = New-NodeAphorism -Node $Node -Pov $Pov -Reason $Reason
    if ([string]::IsNullOrWhiteSpace($Aphorism)) { return }

    if (-not $Node.PSObject.Properties['graph_attributes'] -or $null -eq $Node.graph_attributes) {
        $Node | Add-Member -NotePropertyName 'graph_attributes' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    if ($Node.graph_attributes.PSObject.Properties['aphorism']) {
        $Node.graph_attributes.aphorism = $Aphorism
    } else {
        $Node.graph_attributes | Add-Member -NotePropertyName 'aphorism' -NotePropertyValue $Aphorism
    }
}
