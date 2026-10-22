# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-UnmappedConcepts {
    <#
    .SYNOPSIS
        Cleans up unmapped concepts that already have matching taxonomy nodes.
    .DESCRIPTION
        When AI summaries are generated, concepts the AI couldn't map to existing
        taxonomy nodes are stored in the summary's unmapped_concepts array.
        As new nodes are added to the taxonomy, some of these "unmapped" concepts
        now have matching nodes.

        This cmdlet scans every summary's unmapped_concepts, fuzzy-matches each
        concept label against all taxonomy nodes (cross-POV), and removes concepts
        that match an existing node above the similarity threshold.

        The result: unmapped_concepts lists are cleaned up to only contain concepts
        that genuinely don't exist in the taxonomy yet.
    .PARAMETER DocId
        Wildcard pattern to limit which summaries to process.
        Default: '*' (all summaries).
    .PARAMETER Threshold
        Minimum Jaccard similarity to consider a match (default 0.40).
    .PARAMETER WhatIf
        Show what would be changed without writing files.
    .EXAMPLE
        Repair-UnmappedConcepts
        # Process all summaries.
    .EXAMPLE
        Repair-UnmappedConcepts -DocId '*constitution*'
        # Process only matching summaries.
    .EXAMPLE
        Repair-UnmappedConcepts -WhatIf
        # Preview changes without modifying files.
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-POVSummary
    .LINK
        Invoke-BatchSummary
    .LINK
        Get-Summary
    .LINK
        Repair-AITSummaryMappings
    .LINK
        Test-ExtractionQuality
    .LINK
        Repair-PovAttributes
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$DocId = '*',

        [double]$Threshold = 0.50
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SummariesDir = Get-SummariesDir

    if (-not (Test-Path $SummariesDir)) {
        Write-Fail "Summaries directory not found: $SummariesDir"
        return
    }

    $SummaryFiles = @(Get-ChildItem -Path $SummariesDir -Filter '*.json' -File |
        Where-Object { $_.BaseName -like $DocId })

    if ($SummaryFiles.Count -eq 0) {
        Write-Warn "No summary files matched pattern '$DocId'"
        return
    }

    Write-Step "Scanning $($SummaryFiles.Count) summary file(s) for unmapped concepts"
    Write-Info "Action: For each unmapped concept, fuzzy-match its label against all taxonomy nodes."
    Write-Info "        If a match scores above $Threshold, remove the concept from unmapped_concepts"
    Write-Info "        (it already exists in the taxonomy and doesn't need to be added)."
    Write-Info ""

    $TotalResolved  = 0
    $TotalRemaining = 0
    $FilesModified  = 0
    $AllResolutions = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = ConvertFrom-JsonPreserveShape -Json (Get-Content -Raw -Path $File.FullName)   # whole-file rewrite (t/4425)
        }
        catch {
            Write-Warn "Failed to parse $($File.Name): $_"
            continue
        }

        $HasUnmapped = $Summary.PSObject.Properties['unmapped_concepts']
        if (-not $HasUnmapped -or -not $HasUnmapped.Value) { continue }
        $Unmapped = @($HasUnmapped.Value)
        if ($Unmapped.Count -eq 0) { continue }

        try {
            $Resolution = Resolve-UnmappedConcepts -UnmappedConcepts $Unmapped -Threshold $Threshold
        }
        catch {
            Write-Warn "Failed to resolve concepts in $($File.Name): $_"
            continue
        }

        if (-not $Resolution) { continue }
        $ResolvedList  = @($Resolution.Resolved)
        $RemainingList = @($Resolution.Remaining)

        if ($ResolvedList.Count -eq 0) { continue }

        $DocName = $File.BaseName
        Write-Info "→ $DocName — $($Unmapped.Count) unmapped, $($ResolvedList.Count) matched existing nodes, $($RemainingList.Count) still unmapped"

        foreach ($R in $ResolvedList) {
            Write-OK "   Removing '$($R.ConceptLabel)' — already exists as $($R.MatchedNodeId) '$($R.MatchedNodeLabel)' [$($R.MatchedPOV)] (similarity $($R.Score))"
            $null = $AllResolutions.Add([PSCustomObject]@{
                DocId            = $DocName
                ConceptLabel     = $R.ConceptLabel
                MatchedNodeId    = $R.MatchedNodeId
                MatchedNodeLabel = $R.MatchedNodeLabel
                MatchedPOV       = $R.MatchedPOV
                Score            = $R.Score
            })
        }

        $TotalResolved  += $ResolvedList.Count
        $TotalRemaining += $RemainingList.Count

        if ($PSCmdlet.ShouldProcess($File.Name, "Remove $($ResolvedList.Count) matched concept(s) from unmapped_concepts array")) {
            $Summary.unmapped_concepts = $RemainingList
            $Json = $Summary | ConvertTo-Json -Depth 20
            Write-Utf8NoBom -Path $File.FullName -Value $Json 
            $FilesModified++
        }
    }

    Write-Step "Repair complete"
    Write-OK   "$TotalResolved concept(s) removed from unmapped lists across $FilesModified summary file(s)"
    if ($TotalRemaining -gt 0) {
        Write-Info "$TotalRemaining concept(s) remain unmapped — no taxonomy node matched above threshold $Threshold."
        Write-Info "These may need new taxonomy nodes. Review them in the Summary Viewer's Key Points pane."
    }

    if ($AllResolutions.Count -gt 0) {
        return $AllResolutions
    }
}
