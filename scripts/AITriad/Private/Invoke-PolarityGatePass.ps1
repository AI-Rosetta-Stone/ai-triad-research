# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# ── Private helpers for Invoke-PolarityGatePass ─────────────────────────────
# All functions below are internal to this dot-sourced Private file (NOT exported).
# They exist solely to decompose Invoke-PolarityGatePass below their McCabe ceiling
# while preserving its behavior exactly. None introduce new thresholds or framing.

# Read a field from a gate item that is either a hashtable/dictionary or an object.
# Mirrors the original inline `& { if ($item -is [IDictionary]) {...} else {...} }`.
function Get-PolarityItemField {
    param($Item, [string]$Key)
    Set-StrictMode -Version Latest
    if ($Item -is [System.Collections.IDictionary]) { $Item[$Key] } else { $Item.$Key }
}

# Read a property off a key_point object, returning $Default when absent.
function Get-PolarityKpProp {
    param($Kp, [string]$Name, $Default = $null)
    Set-StrictMode -Version Latest
    if ($Kp.PSObject.Properties[$Name]) { $Kp.$Name } else { $Default }
}

# node_prop lookup: label + Core, Encompasses:/Excludes: tails stripped.
# IDENTICAL construction to V1 (Invoke-OrgClaimMatching) — TL GV condition #3.
# Single-sourced via Get-NodePropText (t/2900) so the gate and the acceptance
# harness build byte-identical node_prop.
function Get-PolarityNodeTextMap {
    Set-StrictMode -Version Latest
    $nodeTextById = @{}
    foreach ($pov in $script:TaxonomyData.Values) {
        if (-not $pov.PSObject.Properties['nodes']) { continue }
        foreach ($n in @($pov.nodes)) {
            if (-not $n.PSObject.Properties['id']) { continue }
            $nodeTextById[[string]$n.id] = Get-NodePropText -Node $n
        }
    }
    return $nodeTextById
}

# Select gated key_points: aligned-family stance + non-null assigned node + HIGH
# topical band. ALSO re-gate rows a PRIOR pass flipped (stance is now
# 'strongly_opposed' but stance_pre_gate records an aligned-family original) so the
# judge can re-evaluate and SELF-HEAL a stale false-flip (t/2900#7).
function Select-PolarityGatedKeyPoints {
    param([object[]]$Items, [string[]]$AlignedFamily)
    Set-StrictMode -Version Latest
    $gated = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($item in $Items) {
        $kp  = Get-PolarityItemField -Item $item -Key 'KeyPoint'
        $pov = Get-PolarityItemField -Item $item -Key 'POV'
        if ($null -eq $kp) { continue }

        $nodeId = Get-PolarityKpProp -Kp $kp -Name 'taxonomy_node_id'
        if ([string]::IsNullOrWhiteSpace([string]$nodeId)) { continue }

        $stance  = [string](Get-PolarityKpProp -Kp $kp -Name 'stance' -Default '')
        $preGate = if ($kp.PSObject.Properties['stance_pre_gate']) { [string]$kp.stance_pre_gate } else { $null }
        $wasFlipped = ($null -ne $preGate) -and ($preGate -in $AlignedFamily)
        if (($stance -notin $AlignedFamily) -and (-not $wasFlipped)) { continue }

        # HIGH topical band: reuse the existing retrieval-confidence band — gate only
        # where the assigned node is NOT retrieval_low_confidence (no new threshold).
        $low = [bool](Get-PolarityKpProp -Kp $kp -Name 'retrieval_low_confidence' -Default $false)
        if ($low) { continue }

        $gated.Add([PSCustomObject]@{ KeyPoint = $kp; POV = $pov; NodeId = [string]$nodeId })
    }
    return ,$gated   # comma prevents pipeline unrolling of an empty/single-item List
}

# Build directional pairs: one per available claim REP per gated key_point —
# opposes-if-any over {verbatim, canonical_proposition, attribution_text}. One
# pair→one verdict in the engine; the OR aggregation lives in the consumer.
# Returns @{ Pairs = <list>; PairMeta = <list> } (index-aligned).
function Build-PolarityDirectionalPairs {
    param([System.Collections.Generic.List[PSObject]]$Gated, [hashtable]$NodeTextById,
          [hashtable]$PovByPrefix, [string[]]$RepNames)
    Set-StrictMode -Version Latest
    $pairs    = [System.Collections.Generic.List[PSObject]]::new()
    $pairMeta = [System.Collections.Generic.List[PSObject]]::new()
    for ($i = 0; $i -lt $Gated.Count; $i++) {
        $kp       = $Gated[$i].KeyPoint
        $nid      = $Gated[$i].NodeId
        $nodeText = if ($NodeTextById.ContainsKey($nid)) { $NodeTextById[$nid] } else { '' }
        $prefix   = if ($nid -match '^(acc|saf|skp)-') { $Matches[1] } else { '' }
        $nodePov  = if ($prefix -and $PovByPrefix.ContainsKey($prefix)) { $PovByPrefix[$prefix] } else { '' }
        $claimPov = [string]$Gated[$i].POV

        foreach ($rep in $RepNames) {
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
    return [PSCustomObject]@{ Pairs = $pairs; PairMeta = $pairMeta }
}

# Tally per-rep verdicts into $Counts (mutated in place) and aggregate opposes-if-any
# per key_point. Returns KpIndex -> @{ Conf; Rep; Claim; NodeProp; ClaimPov; NodePov }
# for the strongest opposing rep.
function Resolve-PolarityVerdicts {
    param([System.Collections.Generic.List[PSObject]]$Pairs,
          [System.Collections.Generic.List[PSObject]]$PairMeta, $Verdicts, [hashtable]$Counts)
    Set-StrictMode -Version Latest
    $byId = @{}
    foreach ($v in @($Verdicts)) { $byId[[int]$v.Id] = $v }

    $kpOpposes = @{}   # KpIndex -> @{ Conf; Rep } (strongest opposing rep)
    for ($pairIdx = 0; $pairIdx -lt $Pairs.Count; $pairIdx++) {
        $v   = if ($byId.ContainsKey($pairIdx)) { $byId[$pairIdx] } else { $null }
        $dir = if ($v) { [string]$v.Direction } else { 'unresolved' }
        if ($Counts.ContainsKey($dir)) { $Counts[$dir]++ } else { $Counts['unresolved']++ }

        if ($dir -eq 'opposes') {
            $kpi  = [int]$PairMeta[$pairIdx].KpIndex
            $conf = if ($v -and $v.PSObject.Properties['Confidence']) { [double]$v.Confidence } else { 0.0 }
            if (-not $kpOpposes.ContainsKey($kpi) -or $conf -gt $kpOpposes[$kpi].Conf) {
                # carry the flagged pair's texts so stage-2 judges the SAME rep deberta flagged.
                $kpOpposes[$kpi] = @{
                    Conf     = $conf
                    Rep      = [string]$PairMeta[$pairIdx].Rep
                    Claim    = [string]$Pairs[$pairIdx].ClaimProp
                    NodeProp = [string]$Pairs[$pairIdx].NodeProp
                    ClaimPov = [string]$Pairs[$pairIdx].ClaimPov
                    NodePov  = [string]$Pairs[$pairIdx].NodePov
                }
            }
        }
        # agrees / unrelated / unresolved → no opposition from this rep.
    }
    return $kpOpposes
}

# Apply a confirmed opposition flip to a key_point. write-once: never clobber the
# pristine pre-gate stance on a repeat pass.
function Set-PolarityKpFlip {
    param($Kp, $Cand, [bool]$HasPreGate)
    Set-StrictMode -Version Latest
    if (-not $HasPreGate) {
        $orig = if ($Kp.PSObject.Properties['stance']) { [string]$Kp.stance } else { '' }
        $Kp | Add-Member -NotePropertyName 'stance_pre_gate' -NotePropertyValue $orig -Force
    }
    $Kp | Add-Member -NotePropertyName 'stance'                     -NotePropertyValue 'strongly_opposed' -Force
    $Kp | Add-Member -NotePropertyName 'stance_polarity_flag'       -NotePropertyValue $true              -Force
    $Kp | Add-Member -NotePropertyName 'stance_polarity_confidence' -NotePropertyValue $Cand.Conf         -Force
    $Kp | Add-Member -NotePropertyName 'stance_polarity_source'     -NotePropertyValue $Cand.Rep          -Force
}

# Self-heal a stale prior flip to the pristine pre-gate stance (t/2900#7). Restore
# stance, drop the flip fields AND the pre-gate marker. Returns the restored stance.
function Reset-PolarityKpSelfHeal {
    param($Kp)
    Set-StrictMode -Version Latest
    $restore = [string]$Kp.stance_pre_gate
    $Kp | Add-Member -NotePropertyName 'stance' -NotePropertyValue $restore -Force
    foreach ($f in @('stance_polarity_flag', 'stance_polarity_confidence', 'stance_polarity_source', 'stance_pre_gate')) {
        if ($Kp.PSObject.Properties[$f]) { $Kp.PSObject.Properties.Remove($f) }
    }
    return $restore
}

# Stage 2: LLM-judge disposition + flip / self-heal (t/2900). deberta (stage 1)
# proposed 'opposes' for the kps in $KpOpposes. The judge confirms before any
# destructive flip: a kp flips to opposed-family ONLY if deberta AND the judge both
# oppose. Otherwise KEEP — and if the row carries a prior flip, SELF-HEAL it. Mutates
# the key_point objects and $Counts in place.
function Update-PolarityStances {
    param([System.Collections.Generic.List[PSObject]]$Gated, [hashtable]$KpOpposes,
          [hashtable]$Counts, [switch]$SkipJudge, [string]$JudgeModel,
          [double]$JudgeTemperature, [int]$JudgeDraws)
    Set-StrictMode -Version Latest
    for ($kpi = 0; $kpi -lt $Gated.Count; $kpi++) {
        $kp         = $Gated[$kpi].KeyPoint
        $nodeId     = $Gated[$kpi].NodeId
        $hasPreGate = [bool]$kp.PSObject.Properties['stance_pre_gate']
        $isCandidate = $KpOpposes.ContainsKey($kpi)

        $confirmed = $false
        if ($isCandidate) {
            $cand = $KpOpposes[$kpi]
            $camp = if ($cand.ClaimPov) { $cand.ClaimPov } else { $cand.NodePov }
            $judged = if ($SkipJudge) {
                'opposes'   # unit tests bypass the live judge; stage-1 stands in
            } else {
                Invoke-DirectionalJudge -Claim $cand.Claim -NodeProp $cand.NodeProp -Camp $camp `
                    -Model $JudgeModel -Temperature $JudgeTemperature -Draws $JudgeDraws
            }
            $confirmed = ($judged -eq 'opposes')
            if ($confirmed) {
                $Counts.judge_flipped++
            } else {
                # false positive the judge caught — the t/2900 FP-rate telemetry (no PS
                # flight-recorder emit API; surfaced via counts + this greppable line).
                $Counts.judge_kept++
                Write-Verbose "PolarityGate: judge KEPT deberta opposes-candidate $nodeId → '$judged' (false-positive caught)."
            }
        }

        if ($confirmed) {
            Set-PolarityKpFlip -Kp $kp -Cand $KpOpposes[$kpi] -HasPreGate $hasPreGate
        }
        elseif ($hasPreGate) {
            # KEEP over a prior flip → self-heal to pristine (t/2900#7).
            $restore = Reset-PolarityKpSelfHeal -Kp $kp
            $Counts.self_healed++
            Write-Verbose "PolarityGate: self-healed $nodeId → restored stance '$restore' (judge KEEP reverted a stale flip)."
        }
        # else: fresh aligned row, judge KEEP or no deberta candidate → no-op.
    }
}

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
        [string]$JudgeModel = 'gemini-3.1-pro-preview',  # research judge, pinned (t/781, Comp-Linguist): same model as Invoke-DirectionalJudge, does not follow the Advanced tier

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
    $povByPrefix  = @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }
    $nodeTextById = Get-PolarityNodeTextMap

    # ── Select gated key_points ────────────────────────────────────────────────
    $alignedFamily = @('aligned', 'strongly_aligned')
    $gated = Select-PolarityGatedKeyPoints -Items $items -AlignedFamily $alignedFamily
    $counts.gated = $gated.Count
    if ($gated.Count -eq 0) { return $counts }

    # ── Build directional pairs: one per available claim REP per gated key_point ─
    $repNames = @('verbatim', 'canonical_proposition', 'attribution_text')
    $built    = Build-PolarityDirectionalPairs -Gated $gated -NodeTextById $nodeTextById `
        -PovByPrefix $povByPrefix -RepNames $repNames
    $pairs    = $built.Pairs
    $pairMeta = $built.PairMeta
    $counts.reps = $pairs.Count
    if ($pairs.Count -eq 0) { return $counts }

    # ── Directional verdicts via the shared wrapper ────────────────────────────
    $verdicts = Test-DirectionalAgreement -Pair @($pairs) -TauContra $DirectionalTauContra
    # Tally per-rep verdicts into the counts metric; aggregate opposes-if-any per kp.
    $kpOpposes = Resolve-PolarityVerdicts -Pairs $pairs -PairMeta $pairMeta -Verdicts $verdicts -Counts $counts

    # ── Stage 2: LLM-judge disposition + flip / self-heal (t/2900) ─────────────
    Update-PolarityStances -Gated $gated -KpOpposes $kpOpposes -Counts $counts `
        -SkipJudge:$SkipJudge -JudgeModel $JudgeModel -JudgeTemperature $JudgeTemperature -JudgeDraws $JudgeDraws

    return $counts
}
