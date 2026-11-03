# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-Summary {
    <#
    .SYNOPSIS
        Lists and filters POV summaries in the repository.
    .DESCRIPTION
        Reads all summary JSON files in summaries/ and produces a concise
        overview of each document's POV analysis. Cross-references
        sources/<doc-id>/metadata.json for the document title.

        By default returns one object per summary with point counts per POV.
        Use -Detailed to include the full key_points array.
    .PARAMETER DocId
        Wildcard pattern matched against the summary doc_id.
    .PARAMETER Pov
        Only include key_points from this POV (accelerationist, safetyist, skeptic).
    .PARAMETER Stance
        Only include key_points with this stance value (e.g. aligned, opposed).
    .PARAMETER Detailed
        When set, includes the KeyPoints array in output.
    .PARAMETER IncludeDuplicates
        Also list summaries of documents marked duplicate_of another document. A listing leaves
        them out by default; an exact -DocId (no wildcard) always finds the summary.
    .EXAMPLE
        Get-Summary
        # Lists all summaries with point counts.
    .EXAMPLE
        Get-Summary '*safety*'
        # Summaries whose doc_id matches *safety*.
    .EXAMPLE
        Get-Summary -Pov skeptic -Detailed
        # Shows skeptic key_points for all summaries.
    .EXAMPLE
        Get-Summary -Pov accelerationist -Stance opposed -Detailed
        # Accelerationist points with opposed stance.
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-POVSummary
    .LINK
        Invoke-BatchSummary
    .LINK
        Repair-AITSummaryMappings
    .LINK
        Test-ExtractionQuality
    .LINK
        Repair-UnmappedConcepts
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$DocId,

        [ValidateSet('accelerationist', 'safetyist', 'skeptic')]
        [string]$Pov,

        [string]$Stance,

        [switch]$Detailed,

        [switch]$IncludeDuplicates
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SummariesDir = Get-SummariesDir
    $SourcesDir   = Get-SourcesDir

    if (-not (Test-Path $SummariesDir)) {
        Write-Warning "Summaries directory not found: $SummariesDir"
        return
    }

    # @(): a bare Get-ChildItem gives $null or one FileInfo for 0/1 files, and .Count then throws
    # under StrictMode. duplicate_of (t/4337 C1): a listing skips marked copies' summaries.
    $SummaryFiles = @(Get-ListedSummaryFile -SummariesDir $SummariesDir -DocId $DocId -IncludeDuplicates:$IncludeDuplicates -Caller 'Get-Summary')
    if ($SummaryFiles.Count -eq 0) {
        Write-Warning "No summary files found in $SummariesDir"
        return
    }

    $Results = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        }
        catch {
            Write-Warning "Failed to parse $($File.Name): $_"
            continue
        }

        if ($DocId -and $Summary.doc_id -notlike $DocId) { continue }

        # Load title from source metadata
        $Title = $null
        $MetaPath = Join-Path (Join-Path $SourcesDir $Summary.doc_id) 'metadata.json'
        if (Test-Path $MetaPath) {
            try {
                $Meta  = Get-Content -Raw -Path $MetaPath | ConvertFrom-Json
                $Title = $Meta.title
            }
            catch {
                Write-Verbose "Could not load title from $MetaPath — $($_.Exception.Message)"
            }
        }

        # Collect key_points and build counts
        $PovNames    = @('accelerationist', 'safetyist', 'skeptic')
        $PointCounts = @{}
        $MatchedPoints = [System.Collections.Generic.List[PSObject]]::new()

        foreach ($PovName in $PovNames) {
            $PovData = Get-SummaryField $Summary.pov_summaries $PovName
            if (-not $PovData) {
                $PointCounts[$PovName] = 0
                continue
            }

            # @(...) around the whole if: an if-expression whose branch yields an empty array assigns
            # $null, and .Count on it throws under StrictMode for a POV with empty key_points.
            $Points = @(if ($PovData.PSObject.Properties['key_points'] -and $PovData.key_points) { $PovData.key_points })
            $PointCounts[$PovName] = $Points.Count

            # Apply POV/Stance filters for -Detailed output
            if ($Pov -and $PovName -ne $Pov) { continue }

            foreach ($Point in $Points) {
                if ($Stance -and $Point.stance -ne $Stance) { continue }
                $MatchedPoints.Add([PSCustomObject]@{
                    POV      = $PovName
                    Stance   = $Point.stance
                    Category = $Point.category
                    NodeId   = $Point.taxonomy_node_id
                    Point    = $Point.point
                })
            }
        }

        # If Pov or Stance filters are active and nothing matched, skip
        if (($Pov -or $Stance) -and $MatchedPoints.Count -eq 0) { continue }

        $Obj = [PSCustomObject]@{
            PSTypeName  = 'AITriad.SummaryInfo'
            DocId       = $Summary.doc_id
            Title       = $Title
            GeneratedAt = $Summary.generated_at
            Model       = if ($Summary.PSObject.Properties['model_info']) { $Summary.model_info.model } elseif ($Summary.PSObject.Properties['ai_model']) { $Summary.ai_model } else { $null }
            PointCounts = $PointCounts
        }

        if ($Detailed) {
            $Obj | Add-Member -NotePropertyName 'KeyPoints' -NotePropertyValue $MatchedPoints.ToArray()
        }

        $Results.Add($Obj)
    }

    if ($Results.Count -eq 0) {
        Write-Warning 'No summaries matched the specified filters.'
        return
    }

    $Results | Sort-Object GeneratedAt -Descending
}
