# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-EntityExtractionCandidates {
    <#
    .SYNOPSIS
        Lists the advisory existing-entity candidates Invoke-EntityExtraction recorded, for a human
        to review (t/4075). Read-only.
    .DESCRIPTION
        Reads existing_entity_candidates[] from entity_extraction_log.json (schema 1.3.0+). Each row
        pairs a newly minted entity (CandidateId) with an existing entity (EntityId) whose name it
        resembles, with the cosine Similarity, its Rank among that proposal's candidates, and
        VersionSibling.

        These rows are ADVISORY. Name-only similarity cannot tell a duplicate from a distinct sibling
        (Claude 3.5 Sonnet vs 3.7 Sonnet scores 0.987), so Invoke-EntityExtraction never links on it
        (TL ruling p/360#571). VersionSibling = $true means the two names differ only by a version
        token: treat them as different entities. VersionSibling = $false means only that no version
        difference was detected; tier and variant siblings (Claude Sonnet 4 vs Claude Opus 4,
        gpt-4o vs gpt-4o-mini) are NOT detected, so false is not "safe to merge" (SO e/280#2).

        A confirmed match is recorded via the entity-merge path, Import-Entity with merged_into:
            Import-Entity -Proposal @{ id = '<CandidateId>'; merged_into = '<EntityId>' }
        This log is advisory and never records a decision (TL e/280#3).
    .PARAMETER NodeId
        Only rows for these taxonomy node ids.
    .PARAMETER EntityId
        Only rows whose existing entity (EntityId) or new entity (CandidateId) is one of these ids.
    .PARAMETER Path
        Override the entity_extraction_log.json path. Default: the taxonomy directory's sidecar.
    .EXAMPLE
        Get-EntityExtractionCandidates | Where-Object { -not $_.VersionSibling } | Sort-Object Similarity -Descending
    .EXAMPLE
        Get-EntityExtractionCandidates -EntityId ent-186
    .LINK
        Invoke-EntityExtraction
    .LINK
        Import-Entity
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [string[]]$NodeId,
        [string[]]$EntityId,
        [string]$Path
    )

    if (-not $Path) { $Path = Join-Path (Get-TaxonomyDir) 'entity_extraction_log.json' }
    $log = Read-EntityCandidateLog -Path $Path

    $schema = if ($log.PSObject.Properties['_schema_version']) { [string]$log._schema_version } else { '' }
    $nodes = if ($log.PSObject.Properties['nodes']) { @($log.nodes) } else { @() }
    $rows = foreach ($n in $nodes) {
        if ($null -eq $n) { continue }
        $nid = if ($n.PSObject.Properties['node_id']) { [string]$n.node_id } else { '' }
        if ($NodeId -and $nid -notin $NodeId) { continue }
        ConvertTo-EntityExtractionCandidateRow -Node $n
    }
    $rows = @($rows | Where-Object { -not $EntityId -or $_.EntityId -in $EntityId -or $_.CandidateId -in $EntityId })
    $schemaVersion = $null
    if ($rows.Count -eq 0 -and [version]::TryParse($schema, [ref]$schemaVersion) -and $schemaVersion -lt [version]'1.3.0') {
        Write-Warning "Get-EntityExtractionCandidates: $Path is schema $schema, which predates existing_entity_candidates (1.3.0); re-run Invoke-EntityExtraction to record candidates."
    }
    $rows | Sort-Object -Property NodeId, CandidateId, Rank -CaseSensitive
}
