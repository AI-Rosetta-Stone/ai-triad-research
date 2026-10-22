# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Read-BatchSummaryTaxonomy {
    <#
    .SYNOPSIS
        Invoke-BatchSummary STEP 1 (t/3910): load each POV taxonomy file into an
        ordered map keyed by file name, refusing a missing or oversized (>10 MB,
        likely corrupted) file.
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)][string]$TaxonomyDir,
        [Parameter(Mandatory)][string[]]$FileName
    )

    $TaxonomyContext = [ordered]@{}
    foreach ($Name in $FileName) {
        $FilePath = Join-Path $TaxonomyDir $Name
        if (-not (Test-Path $FilePath)) {
            Write-Fail "Taxonomy file missing: $FilePath"
            throw "Taxonomy file missing: $Name"
        }
        $FileInfo = Get-Item $FilePath
        if ($FileInfo.Length -gt 10MB) {
            Write-Fail "  $Name is $([math]::Round($FileInfo.Length / 1MB, 1)) MB — likely corrupted (max 10 MB). Restore with: git -C `"$TaxonomyDir`" checkout -- $Name"
            throw "Taxonomy file too large (corrupted): $Name"
        }
        $TaxonomyContext[$Name] = Get-Content -Path $FilePath -Raw | ConvertFrom-Json
        Set-TaxonomyDocumentSelectable -Document $TaxonomyContext[$Name] -Name $Name   # prompt only, never written (t/4356)
        $NodeCount = $TaxonomyContext[$Name].nodes.Count
        Write-OK "  $Name ($NodeCount nodes)"
    }
    return $TaxonomyContext
}
