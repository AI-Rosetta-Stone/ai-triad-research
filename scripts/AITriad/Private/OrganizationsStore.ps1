# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Organizations loader + module-scope cache (t/1224).
# Dot-sourced by AITriad.psm1 — do NOT export.

$script:OrganizationsCache = $null
$script:OrganizationsCacheTimestamp = $null
$script:OrganizationsCachePath = $null

function Get-OrganizationsFilePath {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $tax = Get-TaxonomyDir
    return Join-Path $tax 'organizations.json'
}

function Get-OrganizationsStore {
    <#
    .SYNOPSIS
        Loads (or returns cached) organizations.json content.
    .DESCRIPTION
        Reads ../ai-triad-data/taxonomy/Origin/organizations.json, caches
        the parsed structure in $script:OrganizationsCache, and invalidates
        on file mtime change. Returns the raw parsed object with fields:
        _schema_version, _doc, org_count, last_modified, organizations[].
    .PARAMETER Force
        Bypass the cache and re-read from disk.
    .PARAMETER Path
        Override the source file path. Defaults to Get-OrganizationsFilePath.
        Used by Test-OrganizationIntegrity so callers can validate a snapshot
        or fixture file without touching the live registry.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [string]$Path
    )

    Set-StrictMode -Version Latest

    if ($Path) {
        $path = $Path
    } else {
        $path = Get-OrganizationsFilePath
    }
    if (-not (Test-Path $path)) {
        throw (New-ActionableError `
            -Goal 'Load organizations registry' `
            -Problem "organizations.json not found at $path" `
            -Location 'Get-OrganizationsStore' `
            -NextSteps @(
                'Verify the data repo is present at ../ai-triad-data/',
                'Check .aitriad.json or $env:AI_TRIAD_DATA_ROOT for override',
                'Confirm taxonomy/Origin/organizations.json exists in the data repo'
            ) `
            -AsErrorRecord)
    }

    $mtime = (Get-Item $path).LastWriteTimeUtc
    if (-not $Force -and $script:OrganizationsCache -and $script:OrganizationsCacheTimestamp -eq $mtime -and $script:OrganizationsCachePath -eq $path) {
        return $script:OrganizationsCache
    }

    try {
        $raw = Get-Content -Raw -Path $path -Encoding utf8
        $parsed = $raw | ConvertFrom-Json
    } catch {
        throw (New-ActionableError `
            -Goal 'Parse organizations registry' `
            -Problem "Failed to parse organizations.json: $($_.Exception.Message)" `
            -Location 'Get-OrganizationsStore' `
            -NextSteps @(
                'Validate JSON with: Get-Content organizations.json | ConvertFrom-Json',
                'Check for trailing commas or unbalanced brackets',
                'Restore from git history if the file was recently modified'
            ) `
            -AsErrorRecord)
    }

    $script:OrganizationsCache = $parsed
    $script:OrganizationsCacheTimestamp = $mtime
    $script:OrganizationsCachePath = $path
    return $parsed
}

function ConvertTo-OrganizationObject {
    <#
    .SYNOPSIS
        Converts a raw PSObject from organizations.json into a typed [Organization].
    .DESCRIPTION
        Guards all optional-field access with PSObject.Properties['x'] per the
        project's strict-mode + ConvertFrom-Json convention. Handles missing
        pov_alignment sub-fields gracefully.
    #>
    [CmdletBinding()]
    [OutputType([Organization])]
    param(
        [Parameter(Mandatory)]
        [object]$Raw
    )
    Set-StrictMode -Version Latest

    $o = [Organization]::new()
    $o.Id           = if ($Raw.PSObject.Properties['id']) { [string]$Raw.id } else { '' }
    $o.Name         = if ($Raw.PSObject.Properties['name']) { [string]$Raw.name } else { '' }
    $o.ShortName    = if ($Raw.PSObject.Properties['short_name']) { [string]$Raw.short_name } else { '' }
    $o.Type         = if ($Raw.PSObject.Properties['type']) { [string]$Raw.type } else { '' }
    $o.Description  = if ($Raw.PSObject.Properties['description']) { [string]$Raw.description } else { '' }
    $o.Url          = if ($Raw.PSObject.Properties['url']) { [string]$Raw.url } else { '' }
    $o.Headquarters = if ($Raw.PSObject.Properties['headquarters']) { [string]$Raw.headquarters } else { '' }
    $o.Founded      = if ($Raw.PSObject.Properties['founded']) { [int]$Raw.founded } else { 0 }
    $o.Status       = if ($Raw.PSObject.Properties['status']) { [string]$Raw.status } else { 'active' }
    $o.CreatedAt    = if ($Raw.PSObject.Properties['created_at']) { [string]$Raw.created_at } else { '' }
    $o.LastModified = if ($Raw.PSObject.Properties['last_modified']) { [string]$Raw.last_modified } else { '' }
    $o.Tags         = if ($Raw.PSObject.Properties['tags']) { @($Raw.tags | ForEach-Object { [string]$_ }) } else { @() }
    $o.SourceRefs   = if ($Raw.PSObject.Properties['source_refs']) { @($Raw.source_refs | ForEach-Object { [string]$_ }) } else { @() }

    # POV alignment: hashtable of pov → OrganizationPovAlignment
    $povAlign = @{}
    if ($Raw.PSObject.Properties['pov_alignment']) {
        foreach ($povProp in $Raw.pov_alignment.PSObject.Properties) {
            $entry = [OrganizationPovAlignment]::new()
            $val = $povProp.Value
            # t/1583: post-migration entries carry .tier (enum) not .score
            # (numeric). Map through ConvertFrom-PovTier to a representative
            # midpoint so the typed [OrganizationPovAlignment].Score contract
            # (numeric) stays populated for consumers like
            # Compare-OrganizationPositions and Find-OrganizationByPOV.
            $entry.Score = if ($val.PSObject.Properties['score']) {
                [double]$val.score
            } elseif ($val.PSObject.Properties['tier']) {
                ConvertFrom-PovTier -Tier ([string]$val.tier)
            } else {
                0.0
            }
            $entry.Rationale = if ($val.PSObject.Properties['rationale']) { [string]$val.rationale } else { '' }
            $povAlign[$povProp.Name] = $entry
        }
    }
    $o.PovAlignment = $povAlign

    # Topic engagement
    $topics = @()
    if ($Raw.PSObject.Properties['topic_engagement']) {
        foreach ($t in @($Raw.topic_engagement)) {
            $te = [OrganizationTopicEngagement]::new()
            $te.TopicRef    = if ($t.PSObject.Properties['topic_ref']) { [string]$t.topic_ref } else { '' }
            $te.Stance      = if ($t.PSObject.Properties['stance']) { [string]$t.stance } else { '' }
            $te.Description = if ($t.PSObject.Properties['description']) { [string]$t.description } else { '' }
            $topics += $te
        }
    }
    $o.TopicEngagement = $topics

    # Policy engagement (t/1224 TL addition)
    $policies = @()
    if ($Raw.PSObject.Properties['policy_engagement']) {
        foreach ($p in @($Raw.policy_engagement)) {
            $pe = [OrganizationPolicyEngagement]::new()
            $pe.PolicyRef = if ($p.PSObject.Properties['policy_ref']) { [string]$p.policy_ref } else { '' }
            $pe.Stance    = if ($p.PSObject.Properties['stance']) { [string]$p.stance } else { '' }
            $policies += $pe
        }
    }
    $o.PolicyEngagement = $policies

    # Key figures
    $figures = @()
    if ($Raw.PSObject.Properties['key_figures']) {
        foreach ($f in @($Raw.key_figures)) {
            $kf = [OrganizationKeyFigure]::new()
            $kf.Name      = if ($f.PSObject.Properties['name']) { [string]$f.name } else { '' }
            $kf.Role      = if ($f.PSObject.Properties['role']) { [string]$f.role } else { '' }
            $kf.Relevance = if ($f.PSObject.Properties['relevance']) { [string]$f.relevance } else { '' }
            $figures += $kf
        }
    }
    $o.KeyFigures = $figures

    # External links
    $links = @()
    if ($Raw.PSObject.Properties['external_links']) {
        foreach ($l in @($Raw.external_links)) {
            $el = [OrganizationExternalLink]::new()
            $el.Type  = if ($l.PSObject.Properties['type']) { [string]$l.type } else { '' }
            $el.Url   = if ($l.PSObject.Properties['url']) { [string]$l.url } else { '' }
            $el.Title = if ($l.PSObject.Properties['title']) { [string]$l.title } else { '' }
            $links += $el
        }
    }
    $o.ExternalLinks = $links

    # t/1560 — POV alignment derived (optional). Absent → stays $null on the
    # typed object (meaningful: "never computed"). Present → populated with
    # per-camp counts + provenance.
    if ($Raw.PSObject.Properties['pov_alignment_derived'] -and $null -ne $Raw.pov_alignment_derived) {
        $rawDer = $Raw.pov_alignment_derived
        $der = [OrganizationPovAlignmentDerived]::new()
        foreach ($camp in 'acc','saf','skp') {
            if ($rawDer.PSObject.Properties[$camp] -and $null -ne $rawDer.$camp) {
                $rc = $rawDer.$camp
                $perCamp = [OrganizationPovAlignmentDerivedPerCamp]::new()
                $perCamp.Advocates = if ($rc.PSObject.Properties['advocates']) { [int]$rc.advocates } else { 0 }
                $perCamp.Opposes   = if ($rc.PSObject.Properties['opposes'])   { [int]$rc.opposes }   else { 0 }
                $perCamp.N         = if ($rc.PSObject.Properties['n'])         { [int]$rc.n }         else { 0 }
                # NetRatio is [Nullable[double]] — preserve null as null, do
                # not collapse to 0.0 (three-state semantics, TL t/1560#4).
                if ($rc.PSObject.Properties['net_ratio'] -and $null -ne $rc.net_ratio) {
                    $perCamp.NetRatio = [double]$rc.net_ratio
                }
                $der.$($camp.Substring(0,1).ToUpper() + $camp.Substring(1)) = $perCamp
            }
        }
        if ($rawDer.PSObject.Properties['provenance'] -and $null -ne $rawDer.provenance) {
            $rp = $rawDer.provenance
            $prov = [OrganizationPovAlignmentDerivedProvenance]::new()
            $prov.ComputedAt           = if ($rp.PSObject.Properties['computed_at'])            { [string]$rp.computed_at }            else { '' }
            $prov.CmdletVersion        = if ($rp.PSObject.Properties['cmdlet_version'])         { [string]$rp.cmdlet_version }         else { '' }
            $prov.InputEdgesSha        = if ($rp.PSObject.Properties['input_edges_sha'])        { [string]$rp.input_edges_sha }        else { '' }
            $prov.IncludedStatusFilter = if ($rp.PSObject.Properties['included_status_filter']) { @($rp.included_status_filter | ForEach-Object { [string]$_ }) } else { @() }
            $prov.EdgeCount            = if ($rp.PSObject.Properties['edge_count'])             { [int]$rp.edge_count }                else { 0 }
            $der.Provenance = $prov
        }
        $o.PovAlignmentDerived = $der
    }

    return $o
}

function Clear-OrganizationsCache {
    <#
    .SYNOPSIS
        Invalidates the organizations cache. Called by Import-Organization after writes.
    #>
    [CmdletBinding()]
    param()
    $script:OrganizationsCache = $null
    $script:OrganizationsCacheTimestamp = $null
    $script:OrganizationsCachePath = $null
}
