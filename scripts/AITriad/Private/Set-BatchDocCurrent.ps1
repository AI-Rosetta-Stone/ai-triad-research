# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-BatchDocCurrent {
    <#
    .SYNOPSIS
        Invoke-BatchSummary STEP 4 (t/3910): stamp docs that need no reprocessing as
        current for this taxonomy version, without any API call.
    .DESCRIPTION
        Sets summary_version, summary_status = 'current' and summary_updated in each
        doc's metadata.json. A failed write only WARNs; the batch continues.
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()][System.Collections.Generic.List[hashtable]]$Doc,
        [Parameter(Mandatory)][string]$TaxonomyVersion,
        [Parameter(Mandatory)][string]$Now
    )

    foreach ($Item in $Doc) {
        try {
            $MetaRaw     = Get-Content $Item.MetaFile -Raw
            # Shape-preserving read (t/4366): a bare -AsHashtable read coerces ISO strings such as
            # import_time to [datetime], which this whole-object rewrite re-emits in the local offset.
            $MetaUpdated = ConvertFrom-JsonPreserveShape -Json $MetaRaw -AsOrderedHashtable
            $MetaUpdated['summary_version'] = $TaxonomyVersion
            $MetaUpdated['summary_status']  = 'current'
            $MetaUpdated['summary_updated'] = $Now
            Write-Utf8NoBom -Path $Item.MetaFile -Value ($MetaUpdated | ConvertTo-Json -Depth 10)
            Write-Info "  Marked current: $($Item.DocId)"
        } catch {
            Write-Warn "  Could not update metadata for $($Item.DocId): $_"
        }
    }
}
