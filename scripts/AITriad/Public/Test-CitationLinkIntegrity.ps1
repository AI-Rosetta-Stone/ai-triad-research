# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Blocking state, reported as the result's `.blocking` field (t/3598). $true since the LEG-A
# promotion (t/4042: SO e/266, TL Gate-Verification, data PR #29 -> ceffc431). Blocking is LEG-A
# ONLY: ai-triad-data's citation-link-integrity.yml fails the run on a leg-a offender (or on leg-a
# absent / below its coverage floor); legs b and c stay advisory there. This flag is informational:
# NO consumer branches on it, and the cmdlet itself never throws on offenders either way.
$script:CitationIntegrityBlocking = $true

# Leg-b accepted-baseline allowlist (t/3743, CL disposition t/3598#8). These 3 source_ids are
# genuine cross-repo orphans — the summary exists with real content, but the source dir is
# absent with no source_url/git history, so a restore is infeasible and deletion would be
# irreversible loss of real content. CL ruled accept-baseline, not delete. A dangle NOT in
# this list is still an offender — this is a closed, explicit exception list, not a pattern.
$script:CitationIntegrityAcceptedBaseline = @(
    [pscustomobject]@{
        source_id = 'adversarialaithreatmodelingframework-aatmfv3-kaiaizen-2026'
        reason    = 'pre-existing cross-repo orphan; summary exists, no source dir / no source_url / no git history; accepted-baseline CL t/3598#8'
    }
    [pscustomobject]@{
        source_id = 'adversarialaithreatmodelingframework-aatmfv3-kaiaizen-2026-1'
        reason    = 'pre-existing cross-repo orphan; summary exists, no source dir / no source_url / no git history; accepted-baseline CL t/3598#8'
    }
    [pscustomobject]@{
        source_id = 'practical-tech-leader-2026'
        reason    = 'pre-existing cross-repo orphan; summary exists, no source dir / no source_url / no git history; accepted-baseline CL t/3598#8'
    }
)

function Test-CitationLinkIntegrity {
    <#
    .SYNOPSIS
        Referential-integrity gate on summary→node citation links + the source_index sidecar
        (t/3598 — prevents stale-link recurrence, the 184-dead-id class). Advisory (warn-only)
        until the SO + TL-GV blocking flip.
    .DESCRIPTION
        Pure, deterministic check over committed data files — three legs, each independently
        pass/fail with its offender list (CL owns the predicate, t/3598#1/#2/#3):

          (a) Link resolution — every taxonomy id referenced by summaries/*.json
              (pov_summaries.{pov}.key_points[].taxonomy_node_id non-null +
               factual_claims[].linked_taxonomy_nodes[]) resolves to a LIVE node OF ITS CLASS:
                 ^(acc|saf|skp)-  → the POV live-node set (accelerationist/safetyist/skeptic.json)
                 ^sit-            → the live situation registry (situations.json .nodes[].id)
              sit- is resolved, NOT blanket-excluded (t/3598#2), else situation dangles pass.
          (b) Source resolution — every distinct source_id in source_index.json resolves to
              <SourcesRoot>/<id>/metadata.json. CANONICAL RULE (CL-ratified, t/3598#4 /
              p/23#440), stated verbatim so it is never re-derived: "resolve as-is; else strip
              a trailing '-N' ONLY when it follows a '-YYYY' year" (resolve-full-first, then
              instance-suffix-only-after-year). A naive '-\d+$' strip is WRONG — it eats the
              year off bare 'author-YYYY' ids and mis-resolves (that was the original shorthand).
              A dangle whose source_id is in $script:CitationIntegrityAcceptedBaseline (t/3743,
              CL disposition t/3598#8 — 3 genuine cross-repo orphans, restore infeasible, accept
              not delete) PASSES and is reported separately as `accepted`, not an offender. Any
              dangle NOT on that closed, explicit list is still an offender.
          (c) Staleness — source_index.json header inputHash == Get-SummariesInputHash over the
              current summaries, AND the index key SET == the live-node SET (t/3896 — a count-only
              comparison misses a swap: dead keys reported as `dead-key`, missing keys as
              `missing-key`).

        Advisory: failing legs emit a WARN with offender detail and set the returned .pass to
        $false, but the cmdlet NEVER throws on offenders. $script:CitationIntegrityBlocking is
        $true since the leg-a promotion (t/4042): the data CI workflow treats a leg-a .pass -eq
        $false as a gate failure. Legs b and c remain advisory.
    .PARAMETER SummariesDir
        Summary JSON directory. Default: Get-SummariesDir.
    .PARAMETER TaxonomyDir
        POV + situations registry directory. Default: Get-TaxonomyDir.
    .PARAMETER SourceIndexPath
        The source_index.json sidecar. Default: <TaxonomyDir>/source_index.json.
    .PARAMETER SourcesRoot
        Root of the sources repo (holds <id>/metadata.json). Default: Get-SourcesRoot else
        <data_root>/../ai-triad-sources. Ignored when -SkipSourceResolution is set.
    .PARAMETER SkipSourceResolution
        Run legs a+c only; leg-b is reported `skipped` (pass, zero offenders, zero accepted) instead
        of being evaluated. For CI environments with no ai-triad-sources checkout available (t/3745
        a+c-now split — leg-b waits on a provisioned sources-read token). Without this switch, running
        legs a+c with no sources checkout either throws resolving the SourcesRoot default or false-fails
        leg-b on every source_id — both unacceptable for a warn-only stability window. Also skips the
        SourcesRoot default-resolution call entirely, so it cannot throw when no sources checkout exists.
    .OUTPUTS
        [pscustomobject] { pass; results = @({leg; pass; offenders[]}) ; blocking }
        leg 'a' additionally carries `summariesScanned` (summary files read) and `refsChecked`
        (non-blank refs resolved) — statistic-provenance for the t/4042 floor (SO e/266#10).
        leg 'b' additionally carries `checked` (N distinct source_ids), `accepted[]` (t/3743
        accepted-baseline hits — {source_id; reason} — PASS, not counted as offenders), and
        `skipped` ($true when -SkipSourceResolution was used — pass is $true, not a real check).
        leg 'c' additionally carries `liveKeysChecked` (the live-node key-set size its staleness/
        key-set comparison runs against) — statistic-provenance for a t/4444 coverage floor, the
        same role leg 'a's summariesScanned/refsChecked play for its own floor.
    .EXAMPLE
        (Test-CitationLinkIntegrity).results | Format-Table leg, pass, @{n='n';e={$_.offenders.Count}}
    .EXAMPLE
        Test-CitationLinkIntegrity -SkipSourceResolution   # legs a+c only, no ai-triad-sources checkout needed
    .LINK
        Build-NodeSourceIndex
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()] [string]$SummariesDir,
        [Parameter()] [string]$TaxonomyDir,
        [Parameter()] [string]$SourceIndexPath,
        [Parameter()] [string]$SourcesRoot,
        [Parameter()] [switch]$SkipSourceResolution
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $SummariesDir)    { $SummariesDir = Get-SummariesDir }
    if (-not $TaxonomyDir)     { $TaxonomyDir  = Get-TaxonomyDir }
    if (-not $SourceIndexPath) { $SourceIndexPath = Join-Path $TaxonomyDir 'source_index.json' }
    # Skip the default-resolve entirely when -SkipSourceResolution — Get-SourcesDir can throw when
    # no ai-triad-sources checkout exists (t/3745), and it is never used in that mode regardless.
    if (-not $SourcesRoot -and -not $SkipSourceResolution) { $SourcesRoot = Get-SourcesDir }

    # ── Live id sets ────────────────────────────────────────────────────────────
    # The one shared function the builder also uses (t/4441, SO C4). Leg (a) checks refs against every stored
    # id (a summary citing a since-superseded node still cites a known node); leg (c) compares the index's keys
    # with the resolved live set. A missing POV file throws: the gate fails closed.
    $beliefIds = Get-LiveBeliefNodeIds -TaxonomyDir $TaxonomyDir -Caller 'Test-CitationLinkIntegrity'
    $beliefLive = $beliefIds.All
    $beliefIndexKeys = $beliefIds.Live
    $sitLive = [System.Collections.Generic.HashSet[string]]::new()
    $sitPath = Join-Path $TaxonomyDir 'situations.json'
    if (Test-Path -LiteralPath $sitPath) {
        $sitDoc = Get-Content -Raw -LiteralPath $sitPath | ConvertFrom-Json
        if ($sitDoc.PSObject.Properties['nodes']) {
            foreach ($n in @($sitDoc.nodes)) {
                if ($n.PSObject.Properties['id'] -and $n.id) { [void]$sitLive.Add([string]$n.id) }
            }
        }
    }

    # ── Leg (a): summary→node link resolution, by declared class ────────────────
    $aOff = [System.Collections.Generic.List[object]]::new()
    function script:Resolve-Ref([string]$ref, [string]$docId, $bl, $sl, $out) {
        if ([string]::IsNullOrWhiteSpace($ref)) { return }
        if ($ref -match '^(acc|saf|skp)-') {
            if (-not $bl.Contains($ref)) { $out.Add([pscustomobject]@{ docId = $docId; ref = $ref; class = 'belief' }) }
        }
        elseif ($ref -match '^sit-') {
            if (-not $sl.Contains($ref)) { $out.Add([pscustomobject]@{ docId = $docId; ref = $ref; class = 'situation' }) }
        }
        else {
            $out.Add([pscustomobject]@{ docId = $docId; ref = $ref; class = 'unknown-prefix' })
        }
    }
    # Statistic-provenance for leg-a, mirroring leg-b's `checked` (t/4042, SO e/266#10): DevOps sets a
    # floor on these and fails closed when they are absent, so a leg-a that scanned nothing can never
    # pass as clean. refsChecked counts exactly the refs Resolve-Ref evaluates (non-blank).
    $aSummaries = 0
    $aRefs = 0
    foreach ($file in (Get-ChildItem -LiteralPath $SummariesDir -Filter '*.json' -File | Sort-Object Name)) {
        $aSummaries++
        $s = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
        $docId = if ($s.PSObject.Properties['doc_id']) { [string]$s.doc_id } else { $file.BaseName }
        if ($s.PSObject.Properties['pov_summaries'] -and $s.pov_summaries) {
            foreach ($pov in $s.pov_summaries.PSObject.Properties.Name) {
                $block = $s.pov_summaries.$pov
                if (-not ($block.PSObject.Properties['key_points'])) { continue }
                foreach ($kp in @($block.key_points)) {
                    if ($kp.PSObject.Properties['taxonomy_node_id'] -and $null -ne $kp.taxonomy_node_id) {
                        if (-not [string]::IsNullOrWhiteSpace([string]$kp.taxonomy_node_id)) { $aRefs++ }
                        script:Resolve-Ref ([string]$kp.taxonomy_node_id) $docId $beliefLive $sitLive $aOff
                    }
                }
            }
        }
        if ($s.PSObject.Properties['factual_claims'] -and $s.factual_claims) {
            foreach ($fc in @($s.factual_claims)) {
                if (-not $fc.PSObject.Properties['linked_taxonomy_nodes']) { continue }
                foreach ($ref in @($fc.linked_taxonomy_nodes)) {
                    if (-not [string]::IsNullOrWhiteSpace([string]$ref)) { $aRefs++ }
                    script:Resolve-Ref ([string]$ref) $docId $beliefLive $sitLive $aOff
                }
            }
        }
    }

    # ── Leg (b): source_index source_id → metadata.json (strip -<digits> chunk) ─
    $bOff = [System.Collections.Generic.List[object]]::new()
    $bAccepted = [System.Collections.Generic.List[object]]::new()   # accepted-baseline hits (t/3743) — not offenders
    $bAllowlist = @{}
    foreach ($a in $script:CitationIntegrityAcceptedBaseline) { $bAllowlist[$a.source_id] = $a.reason }
    $bChecked = 0   # N distinct source_ids checked (statistic-provenance, t/3598 CL ask)
    $bSkipped = $SkipSourceResolution.IsPresent
    $indexExists = Test-Path -LiteralPath $SourceIndexPath
    $ix = $null
    if ($indexExists) {
        # $ix is loaded regardless of -SkipSourceResolution — leg (c) needs it for the
        # staleness/key-count checks even when leg-b's per-source_id resolution is skipped.
        $ix = Get-Content -Raw -LiteralPath $SourceIndexPath | ConvertFrom-Json
        if (-not $bSkipped) {
            $seen = [System.Collections.Generic.HashSet[string]]::new()
            foreach ($nodeProp in $ix.index.PSObject.Properties) {
                foreach ($e in @($nodeProp.Value)) {
                    if (-not ($e.PSObject.Properties['source_id']) -or -not $e.source_id) { continue }
                    $sid = [string]$e.source_id
                    if (-not $seen.Add($sid)) { continue }   # distinct only
                    # Resolve as-is first (chunk dirs often exist on their own), else strip a chunk
                    # '-N' suffix ONLY when it follows a '-YYYY' year — a naive '-\d+$' would eat the
                    # year off every non-chunked id (t/3598#3 chunk→base convention, year-aware).
                    $okAsIs = Test-Path -LiteralPath (Join-Path (Join-Path $SourcesRoot $sid) 'metadata.json')
                    $base   = $sid -replace '^(.*-\d{4})-\d+$', '$1'
                    $okBase = ($base -ne $sid) -and (Test-Path -LiteralPath (Join-Path (Join-Path $SourcesRoot $base) 'metadata.json'))
                    if (-not ($okAsIs -or $okBase)) {
                        if ($bAllowlist.ContainsKey($sid)) {
                            $bAccepted.Add([pscustomobject]@{ source_id = $sid; reason = $bAllowlist[$sid] })
                        } else {
                            $bOff.Add([pscustomobject]@{ source_id = $sid; base = $base })
                        }
                    }
                }
            }
            $bChecked = $seen.Count
        }
    }

    # ── Leg (c): staleness — header hash + key SET vs live-node SET (t/3896) ──────────────
    $cOff = [System.Collections.Generic.List[object]]::new()
    if ($indexExists) {
        $stored = if ($ix.PSObject.Properties['inputHash']) { [string]$ix.inputHash } else { '' }
        $recomputed = Get-SummariesInputHash -SummariesDir $SummariesDir
        if ($stored -ne $recomputed) {
            $cOff.Add([pscustomobject]@{ kind = 'stale-hash'; stored = $stored; recomputed = $recomputed })
        }
        # duplicate_of mark set (t/4337 C1): a new, removed or re-pointed mark changes the correct
        # index without touching summaries. Checked only when sources resolve; an index built before
        # marksHash existed (no field) is current exactly when the mark set is empty.
        if ($SourcesRoot) {
            $marksNow = Get-SourceMarksHash -Resolution (Get-SourceResolution -SourcesDir $SourcesRoot)
            $emptyMarks = Get-SourceMarksHash -Resolution (New-IdentitySourceResolution)
            $marksStored = if ($ix.PSObject.Properties['marksHash']) { [string]$ix.marksHash } else { $emptyMarks }
            if ($marksStored -ne $marksNow) {
                $cOff.Add([pscustomobject]@{ kind = 'stale-marks'; stored = $marksStored; recomputed = $marksNow })
            }
        }
        # t/3896 (CL predicate correction): compare the index key SET to the live-node SET, not
        # just the count -- a swap (remove one POV node, add another) keeps counts equal while
        # the index carries a dead key and is missing the new node's key. A count-only check
        # passes exactly where leg (c) is meant to catch a regen that didn't happen or went wrong.
        foreach ($off in (Compare-NodeSourceIndexKeySet -IndexObject $ix.index -LiveNodeIds $beliefIndexKeys)) {
            $cOff.Add($off)
        }
    }
    else {
        $cOff.Add([pscustomobject]@{ kind = 'index-missing'; path = $SourceIndexPath })
        $bOff.Add([pscustomobject]@{ source_id = '(index-missing)'; base = $SourceIndexPath })
    }

    $results = @(
        [pscustomobject]@{ leg = 'a'; name = 'link-resolution';   pass = ($aOff.Count -eq 0); offenders = @($aOff); summariesScanned = $aSummaries; refsChecked = $aRefs }
        [pscustomobject]@{ leg = 'b'; name = 'source-resolution'; pass = ($bOff.Count -eq 0); offenders = @($bOff); checked = $bChecked; accepted = @($bAccepted); skipped = $bSkipped }
        [pscustomobject]@{ leg = 'c'; name = 'staleness';         pass = ($cOff.Count -eq 0); offenders = @($cOff); liveKeysChecked = @($beliefIndexKeys).Count }
    )
    $overall = @($results | Where-Object { -not $_.pass }).Count -eq 0

    # Statistic-provenance (t/3598 CL ask): always log leg-b's N distinct source_ids + the
    # dangle ids, pass or fail — so the advisory run records "checked N, D dangles: <ids>". Now
    # also logs the accepted-baseline count (t/3743) so a green leg-b that is silently absorbing
    # 3 known orphans is never confused with a leg-b that found zero dangles at all.
    if ($bSkipped) {
        # Fallback-path logging (root AGENTS.md): a plain "0 checked; 0 dangles" line would read
        # identically to a genuine clean pass — this must say explicitly that leg-b was NOT run.
        Write-Host "Citation-integrity leg (b): SKIPPED (-SkipSourceResolution — no ai-triad-sources checkout available, t/3745); not evaluated, does not count toward pass/fail"
    } else {
        $bDangles = @($bOff | ForEach-Object { $_.source_id }) -join ', '
        $bAcceptedIds = @($bAccepted | ForEach-Object { $_.source_id }) -join ', '
        Write-Host "Citation-integrity leg (b): $bChecked distinct source_id(s) checked; $($bOff.Count) dangle(s)$(if ($bOff.Count) { ": $bDangles" }); $($bAccepted.Count) accepted-baseline$(if ($bAccepted.Count) { ": $bAcceptedIds" })"
    }

    foreach ($r in $results) {
        if (-not $r.pass) {
            $sample = @($r.offenders | Select-Object -First 5 | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 4 }) -join '; '
            Write-Warning "Citation-integrity leg ($($r.leg)) $($r.name): $(@($r.offenders).Count) offender(s) — $sample"
        }
    }

    [pscustomobject]@{
        pass     = $overall
        blocking = $script:CitationIntegrityBlocking
        results  = $results
    }
}
