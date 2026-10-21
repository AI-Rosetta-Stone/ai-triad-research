# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AITSource {
    <#
    .SYNOPSIS
        Lists and filters source documents in the repository.
    .DESCRIPTION
        Enumerates all source folders under sources/ by reading each
        metadata.json file. Supports filtering by document ID (wildcard),
        POV tag, topic tag, summary status, and source type.

        Default output (no parameters) lists all sources sorted by
        DatePublished descending.
    .PARAMETER DocId
        Wildcard pattern matched against the source document ID.
    .PARAMETER Title
        One or more wildcard patterns matched against the source title.
        A source matches if its title matches any of the supplied patterns.
    .PARAMETER Pov
        Filter to sources whose pov_tags contain this value.
    .PARAMETER Topic
        Filter to sources whose topic_tags contain this value.
    .PARAMETER Status
        Filter to sources with this exact summary_status.
    .PARAMETER SourceType
        Filter to sources with this exact source_type.
    .EXAMPLE
        Get-AITSource
        # Lists all sources sorted by date.
    .EXAMPLE
        Get-AITSource '*china*'
        # Sources whose ID matches *china*.
    .EXAMPLE
        Get-AITSource -Pov safetyist
        # Sources tagged with the safetyist POV.
    .EXAMPLE
        Get-AITSource -Title '*alignment*'
        # Sources whose title matches *alignment*.
    .EXAMPLE
        Get-AITSource -Title '*safety*', '*risk*'
        # Sources whose title matches either pattern.
    .PARAMETER Today
        Return only sources whose date_ingested is today.
    .PARAMETER IncludeDuplicates
        Also list documents marked duplicate_of another document (docs/specs/source-identity.md
        section 6). A listing leaves them out by default. An exact -DocId (no wildcard) is a
        lookup and always finds the document, marked or not.
    .EXAMPLE
        Get-AITSource -Status pending
        # Sources whose summary is pending.
    .EXAMPLE
        Get-AITSource -Today
        # Sources ingested today.
    .LINK
        Show-AITriadHelp
    .LINK
        Import-AITriadDocument
    .LINK
        Save-AITSource
    .LINK
        Find-AITSource
    .LINK
        Update-AITSourceIndex
    .LINK
        Get-IngestionPriority
    .LINK
        Get-ImportReport
    #>
    [CmdletBinding()]
    [OutputType('AITSource')]
    param(
        [Parameter(Position = 0)]
        [string]$DocId,

        [string[]]$Title,

        [string]$Pov,

        [string]$Topic,

        [string]$Status,

        [string]$SourceType,

        [switch]$Today,

        [switch]$IncludeDuplicates
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SourcesDir = Get-SourcesDir

    if (-not (Test-Path $SourcesDir)) {
        Write-Warning "Sources directory not found: $SourcesDir"
        return
    }

    # duplicate_of (t/4337 C1, spec 6.2/6.3): a listing skips marked copies; an exact -DocId is a
    # lookup and finds the document either way.
    $IsLookup = $DocId -and -not [System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($DocId)
    $Resolution = if ($IncludeDuplicates -or $IsLookup) { $null } else { Get-SourceResolution -SourcesDir $SourcesDir }
    $Listed = { param($Id) $null -eq $Resolution -or (Test-SourceSelectable -Resolution $Resolution -Id ([string]$Id)) }

    # ── Fast path: read from _index.json when fresh ──────────────────────────
    $IndexPath = Join-Path $SourcesDir '_index.json'
    $UseIndex  = Test-AITSourceIndexFresh -SourcesDir $SourcesDir -IndexPath $IndexPath

    $Results = [System.Collections.Generic.List[object]]::new()

    if ($UseIndex) {
        # ── Index fast path — single file read ───────────────────────────────
        try {
            $Index = Get-Content -Raw -Path $IndexPath | ConvertFrom-Json
        } catch {
            Write-Verbose "Failed to parse index — falling back to folder scan: $_"
            $UseIndex = $false
        }
    }

    if ($UseIndex) {
        $TodayStr = if ($Today) { Get-Date -Format 'yyyy-MM-dd' } else { $null }

        foreach ($Entry in $Index.sources) {
            if (-not (& $Listed $Entry.id)) { continue }
            if (-not (Test-AITSourceFilterMatch -Meta $Entry -DocId $DocId -Title $Title -Pov $Pov `
                    -Topic $Topic -Status $Status -SourceType $SourceType -Today:$Today -TodayStr $TodayStr)) {
                continue
            }
            $Results.Add((New-AITSourceFromIndexEntry -Entry $Entry -SourcesDir $SourcesDir))
        }
    } else {
        # ── Full scan fallback — reads metadata.json + summary for each source ─
        # @(): Get-ChildItem returns $null for 0 matches and a bare DirectoryInfo for 1, and .Count on
        # either throws under StrictMode — so the "no folders" warning was unreachable (t/4008).
        $Folders = @(Get-ChildItem -Path $SourcesDir -Directory)
        if ($Folders.Count -eq 0) {
            Write-Warning "No source folders found in $SourcesDir"
            return
        }

        $SummariesDir = Get-SummariesDir
        $TodayStr = if ($Today) { Get-Date -Format 'yyyy-MM-dd' } else { $null }

        foreach ($Folder in $Folders) {
            $MetaPath = Join-Path $Folder.FullName 'metadata.json'
            if (-not (Test-Path $MetaPath)) { continue }

            try {
                $Meta = Get-Content -Raw -Path $MetaPath | ConvertFrom-Json
            }
            catch {
                Write-Warning "Failed to parse ${MetaPath}: $_"
                continue
            }

            if (-not (& $Listed $Folder.Name)) { continue }
            if (-not (Test-AITSourceFilterMatch -Meta $Meta -DocId $DocId -Title $Title -Pov $Pov `
                    -Topic $Topic -Status $Status -SourceType $SourceType -Today:$Today -TodayStr $TodayStr)) {
                continue
            }

            $Results.Add((New-AITSourceFromMetadata -Meta $Meta -FolderPath $Folder.FullName -SummariesDir $SummariesDir))
        }
    }

    if ($Results.Count -eq 0) {
        Write-Warning 'No sources matched the specified filters.'
        return
    }

    $Results | Sort-Object { Get-AITSourceSortDate -Source $_ } -Descending
}
