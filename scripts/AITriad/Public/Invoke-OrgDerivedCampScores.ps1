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
          - Approved          — per-org, per-camp counts (what would land)
          - Candidate         — per-org, per-camp counts including proposed rows
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
    $approvedByOrg  = @{}
    $candidateByOrg = @{}
    foreach ($e in $keep) {
        $src    = [string]$e.source
        $type   = [string]$e.type
        $target = [string]$e.target
        $status = if ($e.PSObject.Properties['status']) { [string]$e.status } else { 'approved' }
        if ($status -eq 'rejected' -or $status -eq 'disputed') { continue }
        $camp   = $target.Substring(0, 3)  # acc/saf/skp

        if (-not $candidateByOrg.ContainsKey($src)) { $candidateByOrg[$src] = _newCampCounts }
        if ($type -eq 'ADVOCATES_FOR') { $candidateByOrg[$src][$camp].Advocates++ }
        else                            { $candidateByOrg[$src][$camp].Opposes++ }

        if ($status -eq 'approved') {
            if (-not $approvedByOrg.ContainsKey($src)) { $approvedByOrg[$src] = _newCampCounts }
            if ($type -eq 'ADVOCATES_FOR') { $approvedByOrg[$src][$camp].Advocates++ }
            else                            { $approvedByOrg[$src][$camp].Opposes++ }
        }
    }

    foreach ($map in @($approvedByOrg, $candidateByOrg)) {
        foreach ($org in @($map.Keys)) {
            foreach ($camp in 'acc','saf','skp') {
                $rec = $map[$org][$camp]
                $rec.N = $rec.Advocates + $rec.Opposes
                if ($rec.N -gt 0) {
                    $rec.NetRatio = ($rec.Advocates - $rec.Opposes) / [double]$rec.N
                }
                # else leave NetRatio as $null — three-state semantics.
            }
        }
    }

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
