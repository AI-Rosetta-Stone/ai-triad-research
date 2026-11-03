# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-OrgDerivedCampScores {
    <#
    .SYNOPSIS
        Stage 5 (R2 rollup) of the t/1553 org→node pipeline — compute per-camp
        derived alignment scores from approved org→POV-BDI edges.
    .DESCRIPTION
        For each organization, counts approved ADVOCATES_FOR and OPPOSES edges
        targeting POV-BDI nodes (acc/saf/skp-{beliefs|desires|intentions}-NNN)
        and produces a per-camp record:

            advocates_C = |{approved ADVOCATES_FOR edges: org → camp-C BDI node}|
            opposes_C   = |{approved OPPOSES edges: org → camp-C BDI node}|
            n_C         = advocates_C + opposes_C
            net_ratio_C = (advocates_C − opposes_C) / n_C     [∈ -1, 1]
                        = $null when n_C == 0                 [three-state]

        Denominator is WITHIN-camp (per CL t/1560#2 — hand scores sum >1
        because camp-spanning orgs are real; an across-camp share would
        silently reinterpret the field). Edge weights are unweighted 1.0
        (org edges deliberately carry no confidence fields).

        Only `status='approved'` edges enter the authoritative field
        (CL t/1560#2, TL t/1560#4). Proposed rows go to the -RunReport
        artifact as a companion `candidate` distribution — never into
        `organizations.json`. This is the honesty rule: the derived label
        must not launder unreviewed matcher output as human-approved data.

        `sit-*` situation-node edges are excluded from R2 v1 (t/1560#2
        Q2 ii-α) — those carry three camp interpretations and need a
        separate rollup instrument. R2 v1 is POV-BDI only.

        Default is dry-run: compute + report distribution, no writes.
        Only -Write actually calls Import-Organization to persist the
        derived block back into organizations.json.

        RECENCY SUPERSESSION (t/4475 7a, org-pov-mapping-design.md amendment):
        for one (org, node) pair with both an ADVOCATES_FOR and an OPPOSES edge
        in a stratum, only the edge whose evidence is newer counts toward that
        camp's advocates_C/opposes_C; the older is counted in Superseded, not
        deleted. An edge's evidence date is the latest date_published among its
        source_refs. When either edge is undated, or both share a date, both
        count (their contributions cancel in the net ratio) and the cmdlet
        WARNs that the pair is unresolved, for a reviewer. Scoped to opposite-
        polarity pairs on the SAME node — same-polarity evidence already merges
        into one edge per (org, node, type) at Stage 3, so this cmdlet never
        sees duplicate same-type edges to collide. Applies to both strata
        (approved and candidate) independently.

    .PARAMETER OrgEdgesPath
        Path to organization_edges.json. Defaults to <taxonomy-dir>/organization_edges.json.
    .PARAMETER OrgsPath
        Path to organizations.json. Defaults to the store's canonical path.
    .PARAMETER OrgId
        Restrict to specific org id(s). Default: all orgs.
    .PARAMETER Write
        Persist the derived block back into organizations.json via
        Import-Organization. Without this, the cmdlet reports what it
        would write but touches nothing.
    .PARAMETER InputEdgesSha
        Data-repo commit SHA the edges were read from. Recorded in provenance.
        Optional; if omitted, provenance carries an empty string.
    .OUTPUTS
        [PSCustomObject] with:
          - Approved          — per-org, per-camp counts (what would land), post-supersession
          - Candidate         — per-org, per-camp counts including proposed rows, post-supersession
          - Superseded        — per-org, per-camp count of approved-stratum edges superseded (t/4475 7a)
          - Distribution      — { acc, saf, skp } histogram of net_ratio buckets (approved-only)
          - Written           — number of orgs whose record was updated (0 if dry-run)
          - InputEdges        — total edges read
          - EdgesAfterFilter  — edges matching approved + POV-BDI target
    .EXAMPLE
        # Dry-run: see what would land, no writes
        Invoke-OrgDerivedCampScores
    .EXAMPLE
        # Persist to organizations.json, tagging provenance with edge-set SHA
        Invoke-OrgDerivedCampScores -Write -InputEdgesSha 62663d3d
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-OrgClaimMatching
    .LINK
        Invoke-OrgPublishedSeeding
    .LINK
        Invoke-OrgStanceExtraction
    .LINK
        Get-Organization
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()]
        [string]$OrgEdgesPath,

        [Parameter()]
        [string]$OrgsPath,

        [Parameter()]
        [string[]]$OrgId,

        [Parameter()]
        [switch]$Write,

        [Parameter()]
        [string]$InputEdgesSha = ''
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Locate data ──────────────────────────────────────────────────────
    $taxDir = Get-TaxonomyDir
    if (-not $OrgEdgesPath) { $OrgEdgesPath = Join-Path $taxDir 'organization_edges.json' }
    if (-not (Test-Path $OrgEdgesPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Compute derived camp scores' `
            -Problem "Organization edges file not found: $OrgEdgesPath" `
            -Location 'Invoke-OrgDerivedCampScores' `
            -NextSteps @('Run Invoke-OrgPublishedSeeding + Invoke-OrgClaimMatching first',
                         'Or pass -OrgEdgesPath explicitly'))
    }

    $edgeStore = Get-Content $OrgEdgesPath -Raw | ConvertFrom-Json
    $edges = if ($edgeStore.PSObject.Properties['edges']) { @($edgeStore.edges) } else { @() }
    $totalEdges = @($edges).Count
    Write-Verbose "Input edges: $totalEdges"

    $orgStore = Get-OrganizationsStore -Force
    $orgs = if ($orgStore.PSObject.Properties['organizations']) { @($orgStore.organizations) } else { @() }
    if ($OrgId -and $OrgId.Count -gt 0) {
        $wanted = @($OrgId)
        $orgs = @($orgs | Where-Object { [string]$_.id -in $wanted })
    }
    if (@($orgs).Count -eq 0) {
        Write-Warning 'No organizations to process (empty store or -OrgId filtered out all).'
        return [PSCustomObject]@{
            Approved = @{}; Candidate = @{}; Distribution = @{}
            Written = 0; InputEdges = $totalEdges; EdgesAfterFilter = 0
        }
    }

    # ── Filter edges ─────────────────────────────────────────────────────
    $povBdiPattern = '^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$'
    $campEdgeTypes = @('ADVOCATES_FOR', 'OPPOSES')

    # If -OrgId was passed, mirror the filter on the edge source so
    # Approved/Candidate output is restricted too — not just orgs iteration.
    $orgFilter = if ($OrgId -and $OrgId.Count -gt 0) { @($OrgId) } else { $null }

    $keep = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($e in $edges) {
        if (-not $e.PSObject.Properties['source'] -or
            -not $e.PSObject.Properties['target'] -or
            -not $e.PSObject.Properties['type']) { continue }
        $type = [string]$e.type
        if ($campEdgeTypes -notcontains $type) { continue }
        $target = [string]$e.target
        if ($target -notmatch $povBdiPattern) { continue }
        if ($orgFilter -and ([string]$e.source -notin $orgFilter)) { continue }
        $keep.Add($e)
    }
    $edgesFiltered = @($keep).Count
    Write-Verbose "Edges after filter (POV-BDI target + camp type): $edgesFiltered"

    # ── Aggregate per (org, camp, provenance-stratum) ─────────────────────
    # Two strata: approved (authoritative) + all (approved + proposed = candidate).
    # Excludes rejected/disputed by design — rejected is telemetry, not signal.
    #
    # t/4475 7a (org-pov-mapping-design.md amendment, 2026-10-26): for one
    # (org, node) pair with both an edge of each type, only the newer edge's
    # evidence counts; the older is reported as superseded, not deleted. Undated
    # or tied evidence counts both (their contributions cancel in the net ratio)
    # and the rollup WARNs — a reviewer call, not the rollup's to make silently.
    # Scoped to opposite-polarity pairs on the SAME node — same-polarity evidence
    # already merged into one edge per (org, node, type) at Stage 3.
    $approvedEdges  = @($keep | Where-Object {
        $s = if ($_.PSObject.Properties['status']) { [string]$_.status } else { 'approved' }
        $s -eq 'approved'
    })
    $candidateEdges = @($keep | Where-Object {
        $s = if ($_.PSObject.Properties['status']) { [string]$_.status } else { 'approved' }
        $s -ne 'rejected' -and $s -ne 'disputed'
    })

    $dateCache = @{}
    $approvedResolution  = _resolveOrgEdgeSupersession -Edges $approvedEdges  -DateCache $dateCache
    $candidateResolution = _resolveOrgEdgeSupersession -Edges $candidateEdges -DateCache $dateCache
    $approvedByOrg  = $approvedResolution.ByOrg
    $candidateByOrg = $candidateResolution.ByOrg
    $supersededByOrg = $approvedResolution.Superseded

    $allWarnings = [System.Collections.Generic.List[string]]::new()
    foreach ($w in @($approvedResolution.Warnings)) { $null = $allWarnings.Add($w) }
    foreach ($w in @($candidateResolution.Warnings)) { if (-not $allWarnings.Contains($w)) { $null = $allWarnings.Add($w) } }
    foreach ($w in @($allWarnings)) { Write-Warning $w }

    # ── Distribution histogram (approved only) ────────────────────────────
    $distribution = @{
        acc = _newBuckets
        saf = _newBuckets
        skp = _newBuckets
    }
    foreach ($org in @($orgs)) {
        $orgIdStr = [string]$org.id
        if ($approvedByOrg.ContainsKey($orgIdStr)) {
            foreach ($camp in 'acc','saf','skp') {
                $rec = $approvedByOrg[$orgIdStr][$camp]
                if ($null -eq $rec.NetRatio) {
                    $distribution[$camp].no_data++
                } elseif ($rec.NetRatio -le -0.5) {
                    $distribution[$camp].strong_neg++
                } elseif ($rec.NetRatio -lt 0) {
                    $distribution[$camp].mild_neg++
                } elseif ($rec.NetRatio -eq 0) {
                    $distribution[$camp].neutral++
                } elseif ($rec.NetRatio -lt 0.5) {
                    $distribution[$camp].mild_pos++
                } else {
                    $distribution[$camp].strong_pos++
                }
            }
        } else {
            $distribution.acc.no_data++
            $distribution.saf.no_data++
            $distribution.skp.no_data++
        }
    }

    # ── Optional write ────────────────────────────────────────────────────
    $written = 0
    $failed  = [System.Collections.Generic.List[string]]::new()
    if ($Write) {
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $mod   = Get-Module -Name AITriad
        $ver   = if ($mod) { $mod.Version.ToString() } else { '0.0.0' }
        $cmdletVersion = "Invoke-OrgDerivedCampScores@v$ver"

        foreach ($org in @($orgs)) {
            $orgIdStr = [string]$org.id
            # Emit even for orgs with 0 approved camp edges — three-state
            # semantics require "computed, no data" (all-null n=0) to be
            # visibly distinct from "never computed" (field absent).
            $approvedRec = if ($approvedByOrg.ContainsKey($orgIdStr)) { $approvedByOrg[$orgIdStr] } else { _newCampCounts }
            # Finalize n_C on the fresh block if no approved edges exist for this org.
            foreach ($camp in 'acc','saf','skp') {
                $r = $approvedRec[$camp]
                $r.N = $r.Advocates + $r.Opposes
            }

            $derivedField = [PSCustomObject]@{
                acc = _toJsonRec $approvedRec['acc']
                saf = _toJsonRec $approvedRec['saf']
                skp = _toJsonRec $approvedRec['skp']
                provenance = [PSCustomObject]@{
                    computed_at            = $today
                    cmdlet_version         = $cmdletVersion
                    input_edges_sha        = $InputEdgesSha
                    included_status_filter = @('approved')
                    edge_count             = ($approvedRec['acc'].N + $approvedRec['saf'].N + $approvedRec['skp'].N)
                }
            }

            # Full-record upsert per Import-Organization's contract.
            $incoming = _cloneOrgPSObject $org
            Add-Member -InputObject $incoming -MemberType NoteProperty `
                -Name 'pov_alignment_derived' -Value $derivedField -Force

            if ($PSCmdlet.ShouldProcess($orgIdStr, "Persist pov_alignment_derived")) {
                try {
                    $null = Import-Organization -InputObject $incoming -Confirm:$false
                    $written++
                } catch {
                    $failed.Add("${orgIdStr}: $($_.Exception.Message)")
                    Write-Warning "Failed to persist $orgIdStr : $($_.Exception.Message)"
                }
            }
        }
    }

    Write-Host ''
    if ($Write) {
        Write-Host "Input edges: $totalEdges | After filter: $edgesFiltered | Orgs updated: $written / $(@($orgs).Count) | Failed: $(@($failed).Count)"
    } else {
        Write-Host "Input edges: $totalEdges | After filter: $edgesFiltered | Orgs with approved data: $($approvedByOrg.Count) | Dry-run (no writes)"
    }

    [PSCustomObject]@{
        Approved         = $approvedByOrg
        Candidate        = $candidateByOrg
        Superseded       = $supersededByOrg
        Distribution     = $distribution
        Written          = $written
        InputEdges       = $totalEdges
        EdgesAfterFilter = $edgesFiltered
        Failed           = @($failed)
    }
}

function _newCampCounts {
    @{
        acc = [PSCustomObject]@{ Advocates = 0; Opposes = 0; N = 0; NetRatio = $null }
        saf = [PSCustomObject]@{ Advocates = 0; Opposes = 0; N = 0; NetRatio = $null }
        skp = [PSCustomObject]@{ Advocates = 0; Opposes = 0; N = 0; NetRatio = $null }
    }
}

function _newSupersededCounts {
    @{ acc = 0; saf = 0; skp = 0 }
}

function _getOrgEdgeEvidenceDate {
    <#
    .SYNOPSIS
        t/4475 7a: an edge's evidence date is the latest date_published among its
        source_refs. $null when no source_ref has a parseable date_published.
    #>
    param([object]$Edge, [hashtable]$DateCache)

    $refs = if ($Edge.PSObject.Properties['source_refs']) { @($Edge.source_refs) } else { @() }
    $dates = [System.Collections.Generic.List[datetime]]::new()
    foreach ($ref in $refs) {
        $refId = [string]$ref
        if ([string]::IsNullOrWhiteSpace($refId)) { continue }
        if (-not $DateCache.ContainsKey($refId)) {
            $DateCache[$refId] = _getSourceDatePublished -DocId $refId
        }
        $dp = $DateCache[$refId]
        if ($null -ne $dp) { $dates.Add($dp) }
    }
    if ($dates.Count -eq 0) { return $null }
    @($dates | Sort-Object -Descending)[0]
}

function _getSourceDatePublished {
    param([string]$DocId)
    try {
        $metaPath = Join-Path (Join-Path (Get-SourcesDir) $DocId) 'metadata.json'
        if (-not (Test-Path -LiteralPath $metaPath)) { return $null }
        $meta = Get-Content -Raw -LiteralPath $metaPath | ConvertFrom-Json
        if (-not $meta.PSObject.Properties['date_published'] -or -not $meta.date_published) { return $null }
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse([string]$meta.date_published, [ref]$parsed)) { return $parsed }
        return $null
    }
    catch {
        Write-Warning "Invoke-OrgDerivedCampScores: could not read date_published for source '$DocId': $($_.Exception.Message)"
        return $null
    }
}

function _resolveOrgEdgeSupersession {
    <#
    .SYNOPSIS
        t/4475 7a: groups edges by (org, node), applies the recency-supersession
        rule to opposite-polarity pairs on the same node, and rolls the result up
        into per-org, per-camp Advocates/Opposes/N/NetRatio counts.
    .DESCRIPTION
        One camp count increments per edge that counts toward the rollup: the
        single winning edge of a resolved pair, or both edges of an unresolved
        pair (undated or tied evidence — their contributions cancel in the net
        ratio), or the lone edge when the node has only one type. Same-polarity
        edges never collide here: Stage 3 already merges them into one edge per
        (org, node, type) before this cmdlet ever sees them.
    .OUTPUTS
        @{ ByOrg = <org -> camp counts>; Superseded = <org -> camp -> int>; Warnings = string[] }
    #>
    param([object[]]$Edges, [hashtable]$DateCache)

    $byOrgNode = @{}
    foreach ($e in $Edges) {
        $src = [string]$e.source
        $target = [string]$e.target
        $type = [string]$e.type
        if (-not $byOrgNode.ContainsKey($src)) { $byOrgNode[$src] = @{} }
        if (-not $byOrgNode[$src].ContainsKey($target)) { $byOrgNode[$src][$target] = @{} }
        $byOrgNode[$src][$target][$type] = $e
    }

    $byOrg = @{}
    $superseded = @{}
    $warnings = [System.Collections.Generic.List[string]]::new()

    foreach ($src in @($byOrgNode.Keys)) {
        $byOrg[$src] = _newCampCounts
        $superseded[$src] = _newSupersededCounts

        foreach ($target in @($byOrgNode[$src].Keys)) {
            $camp = $target.Substring(0, 3)
            $pair = $byOrgNode[$src][$target]
            $adv = if ($pair.ContainsKey('ADVOCATES_FOR')) { $pair['ADVOCATES_FOR'] } else { $null }
            $opp = if ($pair.ContainsKey('OPPOSES')) { $pair['OPPOSES'] } else { $null }

            if ($adv -and $opp) {
                $advDate = _getOrgEdgeEvidenceDate -Edge $adv -DateCache $DateCache
                $oppDate = _getOrgEdgeEvidenceDate -Edge $opp -DateCache $DateCache
                if ($advDate -and $oppDate -and $advDate -ne $oppDate) {
                    if ($advDate -gt $oppDate) { $byOrg[$src][$camp].Advocates++ }
                    else                       { $byOrg[$src][$camp].Opposes++ }
                    $superseded[$src][$camp]++
                }
                else {
                    $byOrg[$src][$camp].Advocates++
                    $byOrg[$src][$camp].Opposes++
                    $warnings.Add("WARN: $src ${target}: opposite-polarity edges unresolved (undated or same date); both counted")
                }
            }
            elseif ($adv) { $byOrg[$src][$camp].Advocates++ }
            elseif ($opp) { $byOrg[$src][$camp].Opposes++ }
        }
    }

    foreach ($src in @($byOrg.Keys)) {
        foreach ($camp in 'acc', 'saf', 'skp') {
            $rec = $byOrg[$src][$camp]
            $rec.N = $rec.Advocates + $rec.Opposes
            if ($rec.N -gt 0) {
                $rec.NetRatio = ($rec.Advocates - $rec.Opposes) / [double]$rec.N
            }
            # else leave NetRatio as $null — three-state semantics.
        }
    }

    @{ ByOrg = $byOrg; Superseded = $superseded; Warnings = @($warnings) }
}

function _newBuckets {
    @{ strong_neg = 0; mild_neg = 0; neutral = 0; mild_pos = 0; strong_pos = 0; no_data = 0 }
}

function _toJsonRec {
    param($Rec)
    [PSCustomObject]@{
        advocates = [int]$Rec.Advocates
        opposes   = [int]$Rec.Opposes
        n         = [int]$Rec.N
        net_ratio = $Rec.NetRatio  # null when n=0; double when n>0
    }
}

function _cloneOrgPSObject {
    # PSCustomObject shallow clone — enough for Import-Organization which
    # replaces the whole record. Deep clone would matter only if we
    # mutated nested collections, which we don't; we only add the sibling
    # pov_alignment_derived field.
    param($Src)
    $dst = [PSCustomObject]@{}
    foreach ($p in $Src.PSObject.Properties) {
        Add-Member -InputObject $dst -MemberType NoteProperty -Name $p.Name -Value $p.Value -Force
    }
    $dst
}
