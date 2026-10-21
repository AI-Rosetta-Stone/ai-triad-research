# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-AITSourceIndex {
    <#
    .SYNOPSIS
        Rebuilds the sources/_index.json file for fast source enumeration.
    .DESCRIPTION
        Scans all source folders under sources/, reads each metadata.json,
        and writes a lightweight index at sources/_index.json. This turns
        Get-AITSource from O(N×2 file reads) to O(1 file read).

        Called automatically after Import-AITriadDocument and Invoke-POVSummary.
        Can also be invoked manually after editing metadata by hand.
    .PARAMETER Quiet
        Suppress progress output.
    .EXAMPLE
        Update-AITSourceIndex
    .EXAMPLE
        Update-AITSourceIndex -Quiet
    .LINK
        Show-AITriadHelp
    .LINK
        Import-AITriadDocument
    .LINK
        Save-AITSource
    .LINK
        Find-AITSource
    .LINK
        Get-AITSource
    .LINK
        Get-IngestionPriority
    .LINK
        Get-ImportReport
    #>
    [CmdletBinding()]
    param(
        [switch]$Quiet
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SourcesDir = Get-SourcesDir
    if (-not (Test-Path $SourcesDir)) {
        if (-not $Quiet) { Write-Warning "Sources directory not found: $SourcesDir" }
        return
    }

    $SummariesDir = Get-SummariesDir
    $Folders = @(Get-ChildItem -Path $SourcesDir -Directory | Where-Object { $_.Name -ne '_inbox' })

    $Entries = [System.Collections.Generic.List[hashtable]]::new()

    foreach ($Folder in $Folders) {
        $MetaPath = Join-Path $Folder.FullName 'metadata.json'
        if (-not (Test-Path $MetaPath)) { continue }

        try {
            $Meta = Get-Content -Raw -Path $MetaPath | ConvertFrom-Json
        } catch {
            if (-not $Quiet) { Write-Warning "Failed to parse ${MetaPath}: $_" }
            continue
        }

        $Props = $Meta.PSObject.Properties

        # Load summary statistics — prefer cached values in metadata
        $TotalClaims      = 0
        # t/3944: MUST be [ordered] -- a plain @{} serializes via ConvertTo-Json in
        # .NET hash-bucket order, which is randomized per PROCESS (not just different
        # from the committed Python-authored format once), so every rebuild could
        # reorder these keys regardless of whether any data changed ("serializer churn").
        $ClaimsByPov      = [ordered]@{ accelerationist = 0; safetyist = 0; skeptic = 0; situations = 0 }
        $TotalFacts       = 0
        $UnmappedConcepts = 0

        if ($Props['total_claims']) {
            $TotalClaims = [int]$Meta.total_claims
            if ($Props['total_facts']) { $TotalFacts = [int]$Meta.total_facts }
            if ($Props['unmapped_concepts'] -and $Meta.unmapped_concepts -is [int]) { $UnmappedConcepts = [int]$Meta.unmapped_concepts }
            $CbpKey = if ($Props['node_references_by_pov']) { 'node_references_by_pov' } elseif ($Props['claims_by_pov']) { 'claims_by_pov' } else { $null }
            if ($CbpKey -and $Meta.$CbpKey) {
                $Cbp = $Meta.$CbpKey
                $CbpProps = $Cbp.PSObject.Properties
                if ($CbpProps['accelerationist']) { $ClaimsByPov['accelerationist'] = [int]$Cbp.accelerationist }
                if ($CbpProps['safetyist'])       { $ClaimsByPov['safetyist']       = [int]$Cbp.safetyist }
                if ($CbpProps['skeptic'])         { $ClaimsByPov['skeptic']         = [int]$Cbp.skeptic }
                if ($CbpProps['situations'])      { $ClaimsByPov['situations']      = [int]$Cbp.situations }
            }
        } elseif ($null -ne $SummariesDir) {
            # Fall back to computing from summary file (legacy migration path)
            $SummaryPath = Join-Path $SummariesDir "$($Meta.id).json"
            if (Test-Path $SummaryPath) {
                try {
                    $Summary = Get-Content -Raw -Path $SummaryPath | ConvertFrom-Json
                    # Every summary key guarded (t/4010). Unguarded, a summary that PARSED fine but
                    # lacked factual_claims threw here, fell into the catch below ("Could not parse"),
                    # and silently skipped pov_summaries/unmapped_concepts too -> wrong zeros in the index.
                    # @() wraps the whole `if`: `$x = if (..) { @(..) } else { @() }` collapses @() to $null.
                    $SummaryProps  = $Summary.PSObject.Properties
                    $FactualClaims = @(if ($SummaryProps['factual_claims'] -and $Summary.factual_claims) { $Summary.factual_claims })
                    $TotalClaims   = $FactualClaims.Count
                    foreach ($Claim in $FactualClaims) {
                        if (-not $Claim.PSObject.Properties['linked_taxonomy_nodes']) { continue }
                        foreach ($NodeId in @($Claim.linked_taxonomy_nodes)) {
                            if     ($NodeId -like 'acc-*') { $ClaimsByPov['accelerationist']++ }
                            elseif ($NodeId -like 'saf-*') { $ClaimsByPov['safetyist']++ }
                            elseif ($NodeId -like 'skp-*') { $ClaimsByPov['skeptic']++ }
                            elseif ($NodeId -like 'sit-*') { $ClaimsByPov['situations']++ }
                        }
                    }
                    $PovSummaries = if ($SummaryProps['pov_summaries']) { $Summary.pov_summaries } else { $null }
                    foreach ($PovName in @('accelerationist', 'safetyist', 'skeptic')) {
                        $PovData = if ($PovSummaries -and $PovSummaries.PSObject.Properties[$PovName]) { $PovSummaries.$PovName } else { $null }
                        if ($PovData -and $PovData.PSObject.Properties['key_points'] -and $PovData.key_points) {
                            $TotalFacts += @($PovData.key_points).Count
                        }
                    }
                    if ($SummaryProps['unmapped_concepts'] -and $Summary.unmapped_concepts) {
                        $UnmappedConcepts = @($Summary.unmapped_concepts).Count
                    }
                } catch {
                    if (-not $Quiet) { Write-Verbose "Could not parse summary for $($Meta.id): $_" }
                }
            }
        }

        $Entry = [ordered]@{
            id               = $Meta.id
            title            = if ($Props['title'])          { $Meta.title }          else { $null }
            date_published   = if ($Props['date_published']) { $Meta.date_published } else { $null }
            date_ingested    = if ($Props['date_ingested'])  { $Meta.date_ingested }  else { $null }
            source_type      = if ($Props['source_type'])    { $Meta.source_type }    else { $null }
            pov_tags         = if ($Props['pov_tags'])        { @($Meta.pov_tags) }   else { @() }
            topic_tags       = if ($Props['topic_tags'])      { @($Meta.topic_tags) } else { @() }
            summary_status   = if ($Props['summary_status']) { $Meta.summary_status } else { $null }
            total_claims     = $TotalClaims
            claims_by_pov    = $ClaimsByPov
            total_facts      = $TotalFacts
            unmapped_concepts = $UnmappedConcepts
            one_liner        = if ($Props['one_liner'])      { $Meta.one_liner }      else { $null }
            # The raw mark, for readers of _index.json (t/4337). Additive; no reader branches on it in
            # PS: Get-AITSource filters with Get-SourceResolution, which also validates the mark.
            duplicate_of     = if ($Props['duplicate_of'] -and $Meta.duplicate_of) { [string]$Meta.duplicate_of } else { $null }
        }

        $Entries.Add($Entry)
    }

    $Index = [ordered]@{
        generated_at = (Get-Date -Format 'o')
        count        = $Entries.Count
        sources      = @($Entries)
    }

    $IndexPath = Join-Path $SourcesDir '_index.json'
    $Index | ConvertTo-Json -Depth 5 | Write-Utf8NoBom -Path $IndexPath

    if (-not $Quiet) {
        Write-Host "  Index updated: _index.json ($($Entries.Count) sources)" -ForegroundColor Green
    }
}
