# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-SeiEntryDocCount {
    <#
    .SYNOPSIS
        Count the unique (case-insensitive) doc_ids cited by one source_evidence_index.json entry,
        across its 'facts' and 'keyPoints' lists. Extracted from Invoke-BDIWeightAssignment (t/3910).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    # Untyped on purpose: a malformed (non-hashtable / null) entry throws at .ContainsKey exactly as
    # the pre-refactor inline code did, rather than failing differently at parameter binding.
    param($Entry, [pscustomobject]$Resolution)

    # duplicate_of (t/4337 C1): count resolved ids, so a doc and its marked copy are one doc.
    $DocIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($Key in 'facts', 'keyPoints') {
        $Items = if ($Entry.ContainsKey($Key) -and $Entry[$Key]) { @($Entry[$Key]) } else { @() }
        foreach ($Item in $Items) {
            if ($null -ne $Item -and $Item -is [hashtable] -and $Item.ContainsKey('doc_id') -and $Item['doc_id']) {
                $id = [string]$Item['doc_id']
                if ($Resolution) { $id = Resolve-SourceId -Resolution $Resolution -Id $id }
                $null = $DocIds.Add($id)
            }
        }
    }
    return $DocIds.Count
}

function Get-SourceEvidenceDocCounts {
    <#
    .SYNOPSIS
        Load source_evidence_index.json and return a hashtable of nodeId -> count of unique doc_ids.
        Extracted from Invoke-BDIWeightAssignment (t/3910).
    .DESCRIPTION
        A MISSING file is a fallback, not an error: it WARNs (naming the path and the condition) and
        returns an empty map, so every Belief's evidence boost is 0 (Fallback-Path Logging). An
        UNREADABLE file (present but not valid JSON) is not a fallback: it throws (t/3910#42).
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$Path, [pscustomobject]$Resolution)

    $Counts = @{}
    if (-not (Test-Path $Path)) {
        Write-Warning "source_evidence_index.json not found at $Path (missing: the file does not exist) — evidence boost will be 0"
        return $Counts
    }
    $Sei = Get-Content $Path -Raw | ConvertFrom-Json -AsHashtable
    foreach ($NodeId in $Sei.Keys) {
        $Counts[$NodeId] = Get-SeiEntryDocCount -Entry $Sei[$NodeId] -Resolution $Resolution
    }
    Write-Host "  Source evidence: $($Sei.Count) nodes indexed" -ForegroundColor Gray
    return $Counts
}
