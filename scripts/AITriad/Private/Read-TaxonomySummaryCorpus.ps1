# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Read-TaxonomySummaryCorpus {
    <#
    .SYNOPSIS
        Scans every summaries/*.json, updating $NodeIndex citations and returning per-doc
        stats + aggregated unmapped concepts (t/3910 extraction from Get-TaxonomyHealthData).
    .DESCRIPTION
        A malformed summary file WARNs and is skipped, never thrown (preserves the existing
        swallow-and-continue behavior). Per file: counts key points (via
        Add-SummaryKeyPointCitations, which also mutates $NodeIndex), aggregates unmapped
        concepts (via Add-SummaryUnmappedConcepts), counts factual claims, and loads the doc
        title from sources/<doc_id>/metadata.json if present.
    .PARAMETER SummariesDir
        Directory of summary JSON files. Throws if it does not exist.
    .PARAMETER SourcesDir
        Directory of source subdirectories, each optionally holding metadata.json.
    .PARAMETER NodeIndex
        The citation-tracking index, mutated in place by Add-SummaryKeyPointCitations.
    .OUTPUTS
        [pscustomobject] { SummaryStats (List[PSObject]); UnmappedAgg (hashtable) }.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$SummariesDir,
        [Parameter(Mandatory)][string]$SourcesDir,
        [Parameter(Mandatory)][hashtable]$NodeIndex
    )

    Set-StrictMode -Version Latest

    if (-not (Test-Path $SummariesDir)) {
        throw "Summaries directory not found: $SummariesDir"
    }

    # duplicate_of (t/4337): a marked copy's summary isn't read as a document of its own (spec 6.3).
    # After the main pass its key points and unmapped concepts are added back under the canonical's
    # id, at most once per node and concept (spec 7.5), so a copy can supply a (node, group) the
    # canonical's run missed but can't inflate a count. SummaryStats stays one row per resolved doc.
    $AllFiles     = @(Get-ChildItem -Path $SummariesDir -Filter '*.json' -File)
    $Resolution   = Get-SourceResolution -SourcesDir $SourcesDir
    $SummaryFiles = @(Select-SelectableSummaryFile -Files $AllFiles -Resolution $Resolution)
    $UnmappedAgg  = @{}
    $SummaryStats = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        }
        catch {
            Write-Warning "Get-TaxonomyHealthData: failed to parse $($File.Name): $_"
            continue
        }

        $DocId = if ($Summary.PSObject.Properties['doc_id']) { $Summary.doc_id } else { $File.BaseName }

        $DocKeyPoints = Add-SummaryKeyPointCitations -Summary $Summary -DocId $DocId -NodeIndex $NodeIndex
        $DocUnmapped  = Add-SummaryUnmappedConcepts -Summary $Summary -DocId $DocId -UnmappedAgg $UnmappedAgg

        $DocClaims = 0
        if ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims) {
            $DocClaims = @($Summary.factual_claims).Count
        }

        $Title = $null
        $MetaPath = Join-Path (Join-Path $SourcesDir $DocId) 'metadata.json'
        if (Test-Path $MetaPath) {
            try {
                $Meta  = Get-Content -Raw -Path $MetaPath | ConvertFrom-Json
                $Title = $Meta.title
            }
            catch { }
        }

        $SummaryStats.Add([PSCustomObject]@{
            DocId         = $DocId
            Title         = $Title
            KeyPoints     = $DocKeyPoints
            FactualClaims = $DocClaims
            UnmappedCount = $DocUnmapped
        })
    }

    foreach ($Copy in @(Get-MarkedCopySummary -Files $AllFiles -Resolution $Resolution -Caller 'Get-TaxonomyHealthData')) {
        [void](Add-SummaryKeyPointCitations -Summary $Copy.Summary -DocId $Copy.CanonicalId -NodeIndex $NodeIndex -OncePerDoc)
        [void](Add-SummaryUnmappedConcepts -Summary $Copy.Summary -DocId $Copy.CanonicalId -UnmappedAgg $UnmappedAgg -OncePerDoc)
    }

    return [PSCustomObject]@{ SummaryStats = $SummaryStats; UnmappedAgg = $UnmappedAgg }
}
