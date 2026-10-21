# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-BatchSourceMetaFile {
    <#
    .SYNOPSIS
        Invoke-BatchSummary STEP 3 collection (t/3910): every sources/*/metadata.json
        outside _inbox, narrowed by -ImportedToday and/or -ImportedSince.
    .PARAMETER ImportedSince
        $null when -ImportedSince was not bound. A doc with no date_ingested, or one that
        is not yyyy-MM-dd, is dropped.
    #>
    [CmdletBinding()]
    [OutputType([System.IO.FileInfo[]])]
    param(
        [Parameter(Mandatory)][string]$SourcesDir,
        [switch]$ImportedToday,
        [Nullable[datetime]]$ImportedSince
    )

    $AllMetaFiles = @(Get-ChildItem -Path $SourcesDir -Filter 'metadata.json' -Recurse |
                    Where-Object { $_.FullName -notmatch '_inbox' })
    # duplicate_of (t/4337 C1): a marked copy is never batch-summarized, so no AI spend on copies.
    $Resolution = Get-SourceResolution -SourcesDir $SourcesDir
    if ($Resolution.Marked.Count -gt 0) {
        $Before = $AllMetaFiles.Count
        $AllMetaFiles = @($AllMetaFiles | Where-Object { Test-SourceSelectable -Resolution $Resolution -Id $_.Directory.Name })
        Write-Info "duplicate_of: skipped $($Before - $AllMetaFiles.Count) marked duplicate document(s)"
    }

    if ($ImportedToday) {
        $TodayDate = Get-Date -Format 'yyyy-MM-dd'
        $AllMetaFiles = @($AllMetaFiles | Where-Object {
            $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
            $m.date_ingested -eq $TodayDate
        })
        Write-Info "ImportedToday filter: $($AllMetaFiles.Count) documents ingested on $TodayDate"
    }

    if ($null -ne $ImportedSince) {
        $SinceDate = $ImportedSince.Date
        $AllMetaFiles = @($AllMetaFiles | Where-Object {
            $m = Get-Content $_.FullName -Raw | ConvertFrom-Json
            if ($null -ne $m.PSObject.Properties['date_ingested'] -and $m.date_ingested) {
                try { [datetime]::ParseExact($m.date_ingested, 'yyyy-MM-dd', $null) -ge $SinceDate }
                catch { $false }
            } else { $false }
        })
        Write-Info "ImportedSince filter: $($AllMetaFiles.Count) documents ingested on or after $($SinceDate.ToString('yyyy-MM-dd'))"
    }

    return $AllMetaFiles
}
