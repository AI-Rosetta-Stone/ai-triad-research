# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-PolarityGatePass {
    <#
    .SYNOPSIS
        Polarity/contradiction gate for the summary finalize stage (t/2739 P1).
    .DESCRIPTION
        Runs AFTER Invoke-RetrievalConfidencePass. For each key_point whose claimed
        stance is aligned-family, whose assigned taxonomy_node_id is non-null, and
        whose topical match is in the HIGH band (NOT retrieval_low_confidence), it
        asks the shared directional-agreement engine whether the claim OPPOSES the
        ASSIGNED node's proposition — the residual that similarity + the LLM prompt
        cannot catch (t/2737/t/2738; run-B acc-074 mismap, CL t/2739#1).

        BINDINGS (TL design review t/2739#3):
        1. Consumes the shared Private wrapper Test-DirectionalAgreement (PS2 #1175)
           over the merged engine scripts/nli_classify.py (#1180). This pass does NOT
           frame, call NLI, or threshold — framing is single-sourced in the engine
           (t/2744#3). node_prop is built label + Core with Encompasses:/Excludes:
           tails stripped, IDENTICAL to V1 (Invoke-OrgClaimMatching) per condition #3.
        2. Opposition-only contract (t/2751#2): the engine reliably recovers
           contradiction but rates genuine agreement 'unrelated', not 'entailment'.
           So this fires ONLY on 'opposes'. 'agrees' / 'unrelated' / 'unresolved' all
           KEEP the LLM's mapping. FAIL-SAFE: 'unresolved' KEEPS (never demote) — a
           missed inversion beats a false demote that nukes recall and flakes a
           blocking gate.
        3. Emits per-run counts {opposes, agrees, unrelated, unresolved} over the
           gated key_points — also the silent-degradation detector (all-'unresolved'
           = engine down).

        On 'opposes': sets stance = 'strongly_opposed' (opposed-family) and
        stance_polarity_flag = $true on the key_point — surfaced, never silent. The
        node mapping is preserved (the source disputes THAT node's proposition);
        this is the opposed-family branch of the spec disposition (opposed-family OR
        unmap), chosen over unmap to preserve the node association and avoid
        synthesizing an unmapped_concept post-hoc.
    .PARAMETER KeyPoints
        Array of items shaped @{ KeyPoint = <kp object>; POV = <camp> } (mirrors the
        Mechanism-5 pass collection). Empty is a no-op.
    .PARAMETER DirectionalTauContra
        Contradiction margin floor forwarded to the engine. Default 1.0 (FINAL, the
        engine's τ; CL t/2751#3). Introduces NO new threshold of its own.
    .PARAMETER SkipDirectionalGate
        Bypass the gate entirely (returns zeroed counts, mutates nothing).
        OPPOSES-IF-ANY (t/2757): for each gated key_point the gate runs over EVERY
        available claim representation {verbatim, canonical_proposition,
        attribution_text} and flips if ANY returns 'opposes'. The stored verbatim /
        canonical carry the case_1 contrast that attribution_text false-ENTAILS; the
        engine is unchanged (one-pair→one-verdict) and the OR is aggregated here.
    .OUTPUTS
        [hashtable] per-run counts { opposes; agrees; unrelated; unresolved; gated;
        reps } — opposes/agrees/unrelated/unresolved tally PER claim-rep pair; gated
        counts key_points; reps counts total claim-rep pairs sent to the engine.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$KeyPoints,

        [Parameter()]
        [ValidateRange(0.0, 1000.0)]
        [double]$DirectionalTauContra = 1.0,

        [Parameter()]
        [switch]$SkipDirectionalGate,

        # t/2900 — stage-2 LLM-judge (deberta proposes → judge disposes). The judge
        # confirms deberta's 'opposes' candidates before any flip; unanimous 'opposes'
        # required, fail-safe KEEP. See Invoke-DirectionalJudge.
        [Parameter()]
        [string]$JudgeModel = (Get-AITierModel -Tier advanced),

        [Parameter()]
        [ValidateRange(0.0, 2.0)]
        [double]$JudgeTemperature = 0.3,

        [Parameter()]
        [ValidateRange(1, 9)]
        [int]$JudgeDraws = 3,

        # Bypass the LLM judge and treat every deberta 'opposes' as confirmed (stage-1
        # only). For deterministic unit tests that mock the judge's disposition; NOT
        # for production (would reintroduce the false-demote the judge exists to stop).
        [Parameter()]
        [switch]$SkipJudge
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # judge_flipped/judge_kept = the judge's disposition of deberta's opposes candidates
    # (judge_kept measures the false-positive rate the judge catches — t/2900 telemetry).
    # self_healed = prior false-flips reverted on this pass.
    $counts = @{ opposes = 0; agrees = 0; unrelated = 0; unresolved = 0; gated = 0; reps = 0
                 judge_flipped = 0; judge_kept = 0; self_healed = 0 }
    $items = @($KeyPoints)
    if ($items.Count -eq 0) { return $counts }
    # t/4572 write-freeze (SO C3): this gate WRITES stance_polarity_flag into every
    # summary's key_points on every finalize. Treated identically to the existing
    # -SkipDirectionalGate (mutates nothing) until this consumer is recalibrated
    # against the corrected label mapping -- see Test-NliDirectionalGateFrozen.
    if ($SkipDirectionalGate -or (Test-NliDirectionalGateFrozen -Consumer 'PolarityGatePass')) {
        if (-not $SkipDirectionalGate) {
            Write-Warning "Invoke-PolarityGatePass: directional gate frozen pending recalibration (t/4572) -- stance mapping unchanged this pass."
        }
        return $counts
    }

    # ── node_prop lookup: label + Core, Encompasses:/Excludes: tails stripped ──
    # IDENTICAL construction to V1 (Invoke-OrgClaimMatching) — TL GV condition #3.
    $povByPrefix  = @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }
    $nodeTextById = @{}
    foreach ($pov in $script:TaxonomyData.Values) {
        if (-not $pov.PSObject.Properties['nodes']) { continue }
        foreach ($n in @($pov.nodes)) {
            if (-not $n.PSObject.Properties['id']) { continue }
            # Single-sourced via Get-NodePropText (t/2900) so the gate and the
            # acceptance harness build byte-identical node_prop.
            $nodeTextById[[string]$n.id] = Get-NodePropText -Node $n
        }
    }

    # ── Select gated key_points ────────────────────────────────────────────────
    # aligned-family stance + non-null assigned node + HIGH topical band. ALSO
    # re-gate rows a PRIOR pass flipped (stance is now 'strongly_opposed' but
    # stance_pre_gate records an aligned-family original) so the judge can re-evaluate
    # and SELF-HEAL a stale false-flip (t/2900#7) — a flipped row is no longer
    # aligned-family, so without this it would be invisible to the gate forever.
    $alignedFamily = @('aligned', 'strongly_aligned')
    $gated = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($item in $items) {
        $kp = & { if ($item -is [System.Collections.IDictionary]) { $item['KeyPoint'] } else { $item.KeyPoint } }
        $pov = & { if ($item -is [System.Collections.IDictionary]) { $item['POV'] } else { $item.POV } }
        if ($null -eq $kp) { continue }

        $nodeId = if ($kp.PSObject.Properties['taxonomy_node_id']) { $kp.taxonomy_node_id } else { $null }
        if ([string]::IsNullOrWhiteSpace([string]$nodeId)) { continue }

        $stance = if ($kp.PSObject.Properties['stance']) { [string]$kp.stance } else { '' }
        $preGate = if ($kp.PSObject.Properties['stance_pre_gate']) { [string]$kp.stance_pre_gate } else { $null }
        $wasFlipped = ($null -ne $preGate) -and ($preGate -in $alignedFamily)
        if (($stance -notin $alignedFamily) -and (-not $wasFlipped)) { continue }

        # HIGH topical band: reuse the existing retrieval-confidence band — gate only
        # where the assigned node is NOT retrieval_low_confidence (no new threshold).
        $low = if ($kp.PSObject.Properties['retrieval_low_confidence']) { [bool]$kp.retrieval_low_confidence } else { $false }
        if ($low) { continue }

        $gated.Add([PSCustomObject]@{ KeyPoint = $kp; POV = $pov; NodeId = [string]$nodeId })
    }
    $counts.gated = $gated.Count
    if ($gated.Count -eq 0) { return $counts }

    # ── Build directional pairs: one per available claim REP per gated key_point ─
    # opposes-if-any over {verbatim, canonical_proposition, attribution_text}: the
    # stored verbatim (opposes@5.22) / canonical (opposes@1.42) carry the case_1
    # contrast that attribution_text false-ENTAILS on the "rejecting X ensures Y"
    # construction (CL t/2756#1; TL ruling t/2756#2, t/2757). One-pair→one-verdict in
    # the engine; the OR aggregation lives here in the consumer.
    $repNames = @('verbatim', 'canonical_proposition', 'attribution_text')
    $pairs    = [System.Collections.Generic.List[PSObject]]::new()
    $pairMeta = [System.Collections.Generic.List[PSObject]]::new()   # index-aligned with $pairs
    for ($i = 0; $i -lt $gated.Count; $i++) {
        $kp       = $gated[$i].KeyPoint
        $nid      = $gated[$i].NodeId
        $nodeText = if ($nodeTextById.ContainsKey($nid)) { $nodeTextById[$nid] } else { '' }
        $prefix   = if ($nid -match '^(acc|saf|skp)-') { $Matches[1] } else { '' }
        $nodePov  = if ($prefix -and $povByPrefix.ContainsKey($prefix)) { $povByPrefix[$prefix] } else { '' }
        $claimPov = [string]$gated[$i].POV

        foreach ($rep in $repNames) {
            if (-not $kp.PSObject.Properties[$rep]) { continue }
            $raw = $kp.$rep
            if ($null -eq $raw) { continue }
            # verbatim may be a single string OR an array of 2-4 non-contiguous spans.
            $text = if ($raw -is [System.Array]) { (@($raw) -join ' ') } else { [string]$raw }
            if ([string]::IsNullOrWhiteSpace($text)) { continue }

            $pairs.Add([PSCustomObject]@{
                Id = $pairs.Count; ClaimProp = $text; NodeProp = $nodeText; ClaimPov = $claimPov; NodePov = $nodePov
            })
            $pairMeta.Add([PSCustomObject]@{ KpIndex = $i; Rep = $rep })
        }
    }
    $counts.reps = $pairs.Count
    if ($pairs.Count -eq 0) { return $counts }

    # ── Directional verdicts via the shared wrapper ────────────────────────────
    $verdicts = Test-DirectionalAgreement -Pair @($pairs) -TauContra $DirectionalTauContra
    $byId = @{}
    foreach ($v in @($verdicts)) { $byId[[int]$v.Id] = $v }

    # Tally per-rep verdicts into the counts metric; aggregate opposes-if-any per kp.
    $kpOpposes = @{}   # KpIndex -> @{ Conf; Rep } (strongest opposing rep)
    for ($pairIdx = 0; $pairIdx -lt $pairs.Count; $pairIdx++) {
        $v   = if ($byId.ContainsKey($pairIdx)) { $byId[$pairIdx] } else { $null }
        $dir = if ($v) { [string]$v.Direction } else { 'unresolved' }
        if ($counts.ContainsKey($dir)) { $counts[$dir]++ } else { $counts['unresolved']++ }

        if ($dir -eq 'opposes') {
            $kpi  = [int]$pairMeta[$pairIdx].KpIndex
            $conf = if ($v -and $v.PSObject.Properties['Confidence']) { [double]$v.Confidence } else { 0.0 }
            if (-not $kpOpposes.ContainsKey($kpi) -or $conf -gt $kpOpposes[$kpi].Conf) {
                # carry the flagged pair's texts so stage-2 judges the SAME rep deberta flagged.
                $kpOpposes[$kpi] = @{
                    Conf     = $conf
                    Rep      = [string]$pairMeta[$pairIdx].Rep
                    Claim    = [string]$pairs[$pairIdx].ClaimProp
                    NodeProp = [string]$pairs[$pairIdx].NodeProp
                    ClaimPov = [string]$pairs[$pairIdx].ClaimPov
                    NodePov  = [string]$pairs[$pairIdx].NodePov
                }
            }
        }
        # agrees / unrelated / unresolved → no opposition from this rep.
    }

    # ── Stage 2: LLM-judge disposition + flip / self-heal (t/2900) ─────────────
    # deberta (stage 1) proposed 'opposes' for the kps in $kpOpposes. The judge
    # confirms before any destructive flip: a kp flips to opposed-family ONLY if
    # deberta AND the judge both oppose. Otherwise KEEP — and if the row carries a
    # prior flip (stance_pre_gate), SELF-HEAL it to the pristine pre-gate stance.
    for ($kpi = 0; $kpi -lt $gated.Count; $kpi++) {
        $kp         = $gated[$kpi].KeyPoint
        $nodeId     = $gated[$kpi].NodeId
        $hasPreGate = [bool]$kp.PSObject.Properties['stance_pre_gate']
        $isCandidate = $kpOpposes.ContainsKey($kpi)

        $confirmed = $false
        if ($isCandidate) {
            $cand = $kpOpposes[$kpi]
            $camp = if ($cand.ClaimPov) { $cand.ClaimPov } else { $cand.NodePov }
            $judged = if ($SkipJudge) {
                'opposes'   # unit tests bypass the live judge; stage-1 stands in
            } else {
                Invoke-DirectionalJudge -Claim $cand.Claim -NodeProp $cand.NodeProp -Camp $camp `
                    -Model $JudgeModel -Temperature $JudgeTemperature -Draws $JudgeDraws
            }
            $confirmed = ($judged -eq 'opposes')
            if ($confirmed) {
                $counts.judge_flipped++
            } else {
                # false positive the judge caught — the t/2900 FP-rate telemetry (no PS
                # flight-recorder emit API; surfaced via counts + this greppable line).
                $counts.judge_kept++
                Write-Verbose "PolarityGate: judge KEPT deberta opposes-candidate $nodeId → '$judged' (false-positive caught)."
            }
        }

        if ($confirmed) {
            $cand = $kpOpposes[$kpi]
            # write-once: never clobber the pristine pre-gate stance on a repeat pass.
            if (-not $hasPreGate) {
                $orig = if ($kp.PSObject.Properties['stance']) { [string]$kp.stance } else { '' }
                $kp | Add-Member -NotePropertyName 'stance_pre_gate' -NotePropertyValue $orig -Force
            }
            $kp | Add-Member -NotePropertyName 'stance'                     -NotePropertyValue 'strongly_opposed' -Force
            $kp | Add-Member -NotePropertyName 'stance_polarity_flag'       -NotePropertyValue $true              -Force
            $kp | Add-Member -NotePropertyName 'stance_polarity_confidence' -NotePropertyValue $cand.Conf         -Force
            $kp | Add-Member -NotePropertyName 'stance_polarity_source'     -NotePropertyValue $cand.Rep          -Force
        }
        elseif ($hasPreGate) {
            # KEEP over a prior flip → self-heal to pristine (t/2900#7). Restore stance,
            # drop the flip fields AND the pre-gate marker (row is no longer flipped, so
            # stance_pre_gate presence-as-flip-marker stays truthful).
            $restore = [string]$kp.stance_pre_gate
            $kp | Add-Member -NotePropertyName 'stance' -NotePropertyValue $restore -Force
            foreach ($f in @('stance_polarity_flag', 'stance_polarity_confidence', 'stance_polarity_source', 'stance_pre_gate')) {
                if ($kp.PSObject.Properties[$f]) { $kp.PSObject.Properties.Remove($f) }
            }
            $counts.self_healed++
            Write-Verbose "PolarityGate: self-healed $nodeId → restored stance '$restore' (judge KEEP reverted a stale flip)."
        }
        # else: fresh aligned row, judge KEEP or no deberta candidate → no-op.
    }

    return $counts
}
