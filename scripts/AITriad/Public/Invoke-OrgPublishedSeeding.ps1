# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-OrgPublishedSeeding {
    <#
    .SYNOPSIS
        Stage 0 of t/1553 — proposes PUBLISHED edges (org → source) via URL/domain match.
    .DESCRIPTION
        Walks the ingested source corpus and, for each source, matches its
        canonical url + resolved_url against the org registry's external_links.
        Two match tiers, most precise first:

          1. exact_url  — a source's URL or resolved_url is a member of an
                          org's external_links.url set. High precision:
                          this is a curated link, so the org indexes the
                          document as its own.
          2. domain     — a source's URL host matches the host of any
                          org.external_links.url. Corporate/lab orgs are
                          high precision here; academic / civil-society
                          orgs with broad hosts (e.g. universities) will
                          need CL review.

        Every match becomes a PROPOSED PUBLISHED edge — nothing is
        auto-approved (t/1553 AC #5). Existing edges (any status) for the
        same (org, source) are treated as already-covered and skipped,
        so the cmdlet is idempotent.

        Machine-proposes / human-disposes: reviewer sees the match_basis
        in the edge rationale and decides.

        Author-affiliation matching is a Stage 0b follow-up — not covered
        here (requires the rolodex mapping).
    .PARAMETER SourcesPath
        Source corpus directory. Defaults to Get-SourcesDir.
    .PARAMETER Org
        Restrict to specific org id(s). Useful for CL first-batch review.
    .PARAMETER MaxProposalsPerOrg
        Safety cap per org for this batch. Default: no cap.
    .EXAMPLE
        Invoke-OrgPublishedSeeding -WhatIf
    .EXAMPLE
        Invoke-OrgPublishedSeeding -Org org-001,org-002 -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-OrgClaimMatching
    .LINK
        Invoke-OrgDerivedCampScores
    .LINK
        Invoke-OrgStanceExtraction
    .LINK
        Get-Organization
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()]
        [string]$SourcesPath,

        [Parameter()]
        [string[]]$Org,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$MaxProposalsPerOrg
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $SourcesPath) { $SourcesPath = Get-SourcesDir }
    if (-not (Test-Path $SourcesPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Seed PUBLISHED edges' `
            -Problem "Sources directory not found: $SourcesPath" `
            -Location 'Invoke-OrgPublishedSeeding' `
            -NextSteps @('Verify AI_TRIAD_SOURCES_ROOT or .aitriad.json',
                         'Fall back to -SourcesPath explicit override'))
    }

    # ── Build org indexes (exact URL set + domain set) ───────────────────
    $orgStore = Get-OrganizationsStore
    $orgs = if ($orgStore.PSObject.Properties['organizations']) { @($orgStore.organizations) } else { @() }
    if ($Org -and $Org.Count -gt 0) {
        $wanted = @($Org)
        $orgs = @($orgs | Where-Object { $_.id -in $wanted })
    }

    $orgUrlIndex    = @{}   # url  → @(org-id, ...)
    $orgDomainIndex = @{}   # host → @(org-id, ...)
    foreach ($o in $orgs) {
        if (-not $o.PSObject.Properties['external_links']) { continue }
        $links = @($o.external_links)
        foreach ($link in $links) {
            if (-not $link.PSObject.Properties['url']) { continue }
            $url = [string]$link.url
            if ([string]::IsNullOrWhiteSpace($url)) { continue }

            $u = ConvertTo-EdgeSeedUrl -Url $url
            if ($u.Url) {
                if (-not $orgUrlIndex.ContainsKey($u.Url))    { $orgUrlIndex[$u.Url]    = [System.Collections.Generic.List[string]]::new() }
                if (-not $orgUrlIndex[$u.Url].Contains($o.id)) { $orgUrlIndex[$u.Url].Add([string]$o.id) }
            }
            if ($u.Host) {
                if (-not $orgDomainIndex.ContainsKey($u.Host))    { $orgDomainIndex[$u.Host]    = [System.Collections.Generic.List[string]]::new() }
                if (-not $orgDomainIndex[$u.Host].Contains($o.id)) { $orgDomainIndex[$u.Host].Add([string]$o.id) }
            }
        }
    }

    # ── Existing edges (any status) so we don't double-propose ───────────
    $existingEdges = @{}    # "<src>::<tgt>::PUBLISHED" → status
    try {
        $edgeStore = Get-OrganizationEdgesStore
        if ($edgeStore -and $edgeStore.PSObject.Properties['edges']) {
            foreach ($e in @($edgeStore.edges)) {
                if (-not $e.PSObject.Properties['type']) { continue }
                if ([string]$e.type -ne 'PUBLISHED') { continue }
                $k = "$([string]$e.source)::$([string]$e.target)::PUBLISHED"
                $existingEdges[$k] = if ($e.PSObject.Properties['status']) { [string]$e.status } else { 'approved' }
            }
        }
    } catch {
        Write-Verbose "No existing edges store readable (fresh install?) — proceeding as if empty"
    }

    # ── Walk sources ─────────────────────────────────────────────────────
    $sourceDirs = @(Get-ChildItem -Path $SourcesPath -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notlike '_*' -and $_.Name -notlike '.*' })

    $proposalsPerOrg = @{}
    $proposed = [System.Collections.Generic.List[PSObject]]::new()
    $skippedExisting = 0
    $noMatch = 0

    foreach ($sd in $sourceDirs) {
        $metaPath = Join-Path $sd.FullName 'metadata.json'
        if (-not (Test-Path $metaPath)) { continue }

        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        if (-not $meta.PSObject.Properties['id']) { continue }
        $sourceId = [string]$meta.id

        $matches = New-Object 'System.Collections.Generic.Dictionary[string,string]'  # org-id → match_basis

        foreach ($fld in @('url','resolved_url')) {
            if (-not $meta.PSObject.Properties[$fld]) { continue }
            $raw = [string]$meta.$fld
            if ([string]::IsNullOrWhiteSpace($raw)) { continue }
            $u = ConvertTo-EdgeSeedUrl -Url $raw

            # exact_url wins (records exact_url even if a domain match already noted).
            if ($u.Url -and $orgUrlIndex.ContainsKey($u.Url)) {
                foreach ($oid in $orgUrlIndex[$u.Url]) {
                    $matches[$oid] = 'exact_url'
                }
            }
            if ($u.Host -and $orgDomainIndex.ContainsKey($u.Host)) {
                foreach ($oid in $orgDomainIndex[$u.Host]) {
                    if (-not $matches.ContainsKey($oid)) {
                        $matches[$oid] = 'domain'
                    }
                }
            }
        }

        if ($matches.Count -eq 0) { $noMatch++; continue }

        foreach ($oid in @($matches.Keys)) {
            $basis = $matches[$oid]

            # Idempotence: (org, source, PUBLISHED) exists already → skip.
            $key = "$oid::$sourceId::PUBLISHED"
            if ($existingEdges.ContainsKey($key)) {
                $skippedExisting++
                continue
            }

            if (-not $proposalsPerOrg.ContainsKey($oid)) { $proposalsPerOrg[$oid] = 0 }
            if ($MaxProposalsPerOrg -and $proposalsPerOrg[$oid] -ge $MaxProposalsPerOrg) {
                continue
            }
            $proposalsPerOrg[$oid]++

            $proposed.Add([PSCustomObject]@{
                Source     = $oid
                Target     = $sourceId
                Type       = 'PUBLISHED'
                MatchBasis = $basis
                SourceUrl  = $meta.url
            })
        }
    }

    # ── Emit proposals via Import-OrganizationEdge ───────────────────────
    $written = 0
    $failed  = [System.Collections.Generic.List[string]]::new()
    foreach ($p in $proposed) {
        $rationale = "match_basis=$($p.MatchBasis) (t/1553 Stage 0)"
        $target = "$($p.Source)->$($p.Target) [$($p.MatchBasis)]"
        if ($PSCmdlet.ShouldProcess($target, 'Propose PUBLISHED edge')) {
            try {
                # Import-OrganizationEdge validates -InputObject via PSObject.Properties[key];
                # a hashtable's PSObject reports no keys, so must be a PSCustomObject.
                $null = Import-OrganizationEdge -InputObject ([PSCustomObject]@{
                    source        = $p.Source
                    target        = $p.Target
                    type          = 'PUBLISHED'
                    rationale     = $rationale
                    source_refs   = @($p.Target)
                    status        = 'proposed'
                    discovered_at = (Get-Date).ToString('yyyy-MM-dd')
                }) -Confirm:$false
                $written++
            } catch {
                $failed.Add("$($p.Source)->$($p.Target): $($_.Exception.Message)")
                Write-Warning "Failed to write proposal $($p.Source) -> $($p.Target): $($_.Exception.Message)"
            }
        }
    }

    [PSCustomObject]@{
        Proposed         = $written
        Considered       = $proposed.Count
        SkippedExisting  = $skippedExisting
        SourcesNoMatch   = $noMatch
        SourcesScanned   = $sourceDirs.Count
        Failed           = @($failed)
        PerOrg           = $proposalsPerOrg
    }
}

function ConvertTo-EdgeSeedUrl {
    <#
    .SYNOPSIS
        Canonicalizes a URL for exact/domain matching (t/1553 Stage 0).
    .DESCRIPTION
        Returns {Url, Host} where Url is trimmed and lower-cased, and Host is
        the effective 2LD-plus-TLD (drops leading www.). No protocol
        normalization — https vs http kept as-is so that http-only orgs
        don't spuriously match https sources; the domain fallback covers
        that case.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Url
    )

    Set-StrictMode -Version Latest

    $trimmed = $Url.Trim()
    $lower   = $trimmed.ToLowerInvariant()
    # Strip trailing slash and #fragment for exact-match consistency.
    $stripped = $lower -replace '#.*$', '' -replace '/+$', ''

    $extractedHost = ''
    try {
        $u = [System.Uri]$trimmed
        $extractedHost = $u.Host.ToLowerInvariant()
        if ($extractedHost.StartsWith('www.')) {
            $extractedHost = $extractedHost.Substring(4)
        }
    } catch {
        # Best-effort extraction: split on '/' after protocol.
        $m = [regex]::Match($lower, '^(?:https?:)?//([^/]+)')
        if ($m.Success) {
            $extractedHost = $m.Groups[1].Value
            if ($extractedHost.StartsWith('www.')) {
                $extractedHost = $extractedHost.Substring(4)
            }
        }
    }

    [PSCustomObject]@{
        Url  = $stripped
        Host = $extractedHost
    }
}
