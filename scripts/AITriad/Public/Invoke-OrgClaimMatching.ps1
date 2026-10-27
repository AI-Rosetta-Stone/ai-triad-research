# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-OrgClaimMatching {
    <#
    .SYNOPSIS
        Stages 2+3 of t/1553 — match Stage 1 org stance claims to taxonomy nodes
        via embedding cosine, then aggregate to proposed ADVOCATES_FOR / OPPOSES
        edges.
    .DESCRIPTION
        Reads organization_stance_claims.json (Stage 1 output), computes
        canonical_proposition embeddings via embed_taxonomy.py batch-encode,
        and does top-K cosine search against the taxonomy-node embedding set.
        Aggregates matches per (org, node, polarity) and emits a proposed edge
        when either:

          - MinAgreement or more INDEPENDENT claims agree
            (independence: distinct doc-families — see -FamilyKey rule below),
                                                                   OR
          - one claim's cosine ≥ MatchThreshold.

        polarity=asserts → ADVOCATES_FOR; polarity=opposes → OPPOSES.

        Every proposal lands with status='proposed' via Import-OrganizationEdge.
        Zero auto-approval (t/1553 AC #5). Existing (org, node, type) tuples in
        any status are treated as covered and skipped, unless -Force.

        The 0.67/0.33 embedding variant (t/524 grid-search optimum) is the
        expected input. Generate with:

          python scripts/embed_taxonomy.py generate \
              --field-weights 0.67,0.33,0,0,0 \
              --output <path-to-embeddings-orgstance-6733.json>

        Confidence NOT used in gating (CL decision, t/1553#14): the 0.9-1.0
        extraction_confidence band is non-discriminating, so it's dropped
        from Stage 3.

        Per CL's calibration note (t/1553#12): document-family variants (RMF
        playbook, CAISI variants, etc.) are ONE independence unit for the
        MinAgreement rule. Family key: strip trailing '-YYYY(-N)?' from source_id.

        Per t/1553#18: the return object carries a .NegationSlice list with the
        top-K matches for every claim whose proposition contains a
        negated deontic — embeddings are weak at negation, so these are the
        highest-risk slice for landing on directional-opposite nodes.

        ENDORSEMENT-CONFIRMATION GATE (t/4475 7b / t/4523): the directional gate
        above only detects opposition — it rates a genuine agreement 'unrelated',
        so it cannot reject a topical-only match. By default, after directional
        reconciliation, an LLM judges EACH available claim rep (same RepReps as
        the directional gate) against the matched node's proposition via the
        org-endorsement-gate prompt, returning endorses/partial/topic_only.
        Each proposal is tagged .Endorsement = best verdict over its reps
        (endorses > partial > unknown > none); 'none' means every rep resolved
        to topic_only, 'unknown' means the gate backend failed (WARN, not throw
        — never written as 'none'). TAGS AND REORDERS, NEVER DROPS: the tag
        only changes which proposals the existing per-org cap keeps when it has
        to cut (a 'none' proposal sorts after everything else); every proposal
        is still written as 'proposed'. Off only under -SkipEndorsementGate.

        FORENSIC/ADDITIVE, PROVENANCE STIPULATED (CL t/4523#5; dev-check 10/13 Y/P,
        14/16 N — t/4523#4; register `metric-provenance-register.md` §22): a
        consumer may SORT on .Endorsement, but must not filter, hide, or
        auto-reject on it until the t/4545 held-out set validates it. The
        exemption lapses the moment a consumer does either — see
        lib/ai-client/types.ts for the model of this note.

        .DirectionConflict (CL t/4523#5 condition 2) is set when .Endorsement is
        'endorses' or 'partial' but the directional-reconciled .EdgeType is
        'OPPOSES' — the two gates disagree about which way the org's position
        points. NEVER AUTO-RESOLVED: surfaced in .Rationale for a human reviewer.
        Feeds t/4546 (the directional gate's own type-flip-stability finding).
    .PARAMETER ClaimsPath
        Stage 1 claims JSON. Defaults to <taxonomy-dir>/organization_stance_claims.json.
    .PARAMETER EmbeddingsPath
        0.67/0.33 field-weight embedding set (the t/524 variant). Required.
    .PARAMETER MatchThreshold
        Single-claim cosine floor for high-precision proposal. Default: 0.60
        (t/1553 stipulated).
    .PARAMETER MinAgreement
        Minimum independent claims agreeing on (node, polarity) to propose
        without meeting -MatchThreshold. Default: 2 (t/1553 stipulated).
    .PARAMETER PerOrgCap
        Maximum proposed edges written per organization per run. Default: 20.
    .PARAMETER TopK
        Top matches to keep per claim. Default: 5.
    .PARAMETER Org
        Restrict to specific org id(s).
    .PARAMETER WriteProposals
        Write proposed edges via Import-OrganizationEdge. Without this switch,
        the cmdlet reports what it would emit but does not touch the edge
        store — always default to dry-run for review.
    .PARAMETER Force
        Emit proposals even when a (org, node, type) tuple already exists in
        the edge store. Never touches approved/disputed rows unless combined
        with a manual delete — this only overrides the has-any-status skip.
    .PARAMETER SkipDirectionalGate
        Disable the directional-agreement gate (t/2745, shared engine t/2751). By
        default every surviving proposal is checked against the matched node via
        the POV-framed NLI engine over EACH available claim representation
        (verbatim + canonical, t/2744#10) — opposes-if-ANY: on `opposes` (a rep
        asserts ¬node) the edge type is FLIPPED ADVOCATES_FOR↔OPPOSES; otherwise
        the edge is kept unchanged. Use this switch only where the NLI engine is
        unavailable, or to isolate the aggregation logic in tests — it restores
        the pre-gate polarity-only behavior and can persist polarity-inverted edges.
    .PARAMETER DirectionalTauContra
        Contradiction margin floor forwarded to the shared engine to emit
        `opposes`. Default 1.0 (FINAL, CL t/2751#3; provenance in the
        metric-provenance-register). Raising it makes the gate flip only on
        stronger contradictions; do not exceed ~1.4 (the real contradiction margin).
    .PARAMETER SkipEndorsementGate
        Disable the endorsement-confirmation gate (t/4475 7b). Use only to
        isolate the aggregation/directional logic in tests, or where the AI
        backend is unavailable — the gate already fails safe to `unknown` on a
        backend error, so this switch is rarely needed for that case.
    .PARAMETER EndorsementModel
        AI model for the endorsement gate. Default: Get-AITierModel -Tier basic.
    .PARAMETER ApiKey
        API key forwarded to the endorsement gate's Invoke-AIApi calls. Empty
        string lets Invoke-AIApi resolve the registry key itself (t/4087).
    .EXAMPLE
        Invoke-OrgClaimMatching -EmbeddingsPath ../ai-triad-data/taxonomy/Origin/embeddings-orgstance-6733.json
    .EXAMPLE
        Invoke-OrgClaimMatching -EmbeddingsPath ...-6733.json -WriteProposals -Org org-014
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-OrgDerivedCampScores
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
        [string]$ClaimsPath,

        [Parameter(Mandatory)]
        [string]$EmbeddingsPath,

        [Parameter()]
        [ValidateRange(0.0, 1.0)]
        [double]$MatchThreshold = 0.60,

        [Parameter()]
        [ValidateRange(1, 20)]
        [int]$MinAgreement = 2,

        [Parameter()]
        [ValidateRange(1, 100)]
        [int]$PerOrgCap = 20,

        [Parameter()]
        [ValidateRange(1, 20)]
        [int]$TopK = 5,

        [Parameter()]
        [string[]]$Org,

        [Parameter()]
        [switch]$WriteProposals,

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [switch]$SkipDirectionalGate,

        [Parameter()]
        [ValidateRange(0.0, 1000.0)]
        [double]$DirectionalTauContra = 1.0,

        [Parameter()]
        [switch]$SkipEndorsementGate,

        [Parameter()]
        [string]$EndorsementModel = (Get-AITierModel -Tier basic),

        [Parameter()]
        [string]$ApiKey = ''
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Load claims ──────────────────────────────────────────────────────
    if (-not $ClaimsPath) {
        $ClaimsPath = Join-Path (Get-TaxonomyDir) 'organization_stance_claims.json'
    }
    if (-not (Test-Path $ClaimsPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Match org claims to nodes' `
            -Problem "Claims file not found: $ClaimsPath" `
            -Location 'Invoke-OrgClaimMatching' `
            -NextSteps @('Run Invoke-OrgStanceExtraction first',
                         'Or pass -ClaimsPath explicitly'))
    }
    $claimStore = Get-Content $ClaimsPath -Raw | ConvertFrom-Json
    $claims = if ($claimStore.PSObject.Properties['claims']) { @($claimStore.claims) } else { @() }

    if ($Org -and $Org.Count -gt 0) {
        $wanted = @($Org)
        $claims = @($claims | Where-Object { [string]$_.org_id -in $wanted })
    }
    $totalClaims = @($claims).Count
    Write-Verbose "Claims after -Org filter: $totalClaims"
    if ($totalClaims -eq 0) {
        Write-Host 'No claims match the filter — nothing to do.'
        return [PSCustomObject]@{ Proposed = 0; ProposalsWouldEmit = 0; ClaimsProcessed = 0 }
    }

    # ── Load embeddings (nodes only — skip policies/conflicts) ───────────
    if (-not (Test-Path $EmbeddingsPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Load embeddings' `
            -Problem "Embeddings file not found: $EmbeddingsPath" `
            -Location 'Invoke-OrgClaimMatching' `
            -NextSteps @('Regenerate with python scripts/embed_taxonomy.py generate --field-weights 0.67,0.33,0,0,0 --output <path>'))
    }
    $embStore = Get-Content $EmbeddingsPath -Raw | ConvertFrom-Json
    if (-not $embStore.PSObject.Properties['nodes']) {
        throw "Embeddings file has no 'nodes' property: $EmbeddingsPath"
    }

    # Filter to pov nodes (acc/saf/skp-BDI-NNN). Skip policies (pol-*),
    # conflicts (conflict-*), and cross-cutting sit/cc rows.
    $nodeIds = [System.Collections.Generic.List[string]]::new()
    $nodeVecs = [System.Collections.Generic.List[double[]]]::new()
    foreach ($p in $embStore.nodes.PSObject.Properties) {
        $id = [string]$p.Name
        if ($id -notmatch '^(acc|saf|skp)-(beliefs|desires|intentions)-\d+$') { continue }
        $node = $p.Value
        # Node values are structured records with .vector (weighted composite).
        if (-not $node.PSObject.Properties['vector']) { continue }
        $vec = @($node.vector | ForEach-Object { [double]$_ })
        $nodeIds.Add($id)
        $nodeVecs.Add([double[]]$vec)
    }
    Write-Verbose "Node embeddings loaded: $($nodeIds.Count)"

    # ── Batch-encode claim propositions via embed_taxonomy.py ────────────
    $repoRoot   = $script:RepoRoot
    $embScript  = Join-Path $repoRoot 'scripts' 'embed_taxonomy.py'
    $encodeInput = [System.Collections.Generic.List[PSObject]]::new()
    for ($ei = 0; $ei -lt $totalClaims; $ei++) {
        $c = $claims[$ei]
        $key = "$($c.org_id)::$($c.source_id)::$ei"
        $encodeInput.Add([PSCustomObject]@{ id = $key; text = [string]$c.canonical_proposition })
    }
    $stdin = ($encodeInput | ConvertTo-Json -Compress -Depth 4)
    Write-Verbose "Batch-encoding $($encodeInput.Count) claim propositions..."
    $global:LASTEXITCODE = 0
    $encoded = $stdin | & python $embScript batch-encode 2>$null
    $exit = if (Test-Path variable:LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    if ($exit -ne 0 -or -not $encoded) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Batch-encode claim propositions' `
            -Problem 'embed_taxonomy.py batch-encode failed' `
            -Location 'Invoke-OrgClaimMatching' `
            -NextSteps @('Verify python + sentence-transformers install',
                         "Try: python $embScript encode 'test string'"))
    }
    $claimVecs = ($encoded | Out-String | ConvertFrom-Json)

    # ── Top-K cosine per claim ───────────────────────────────────────────
    $matchPerClaim = [System.Collections.Generic.List[PSObject]]::new()
    $doubleMarkPattern = '(?i)(\b(oppose|reject|resist|against|least promising)\b|\b(ought|should|must|need|shall|may)\s+not\b)'
    $negationSlice = [System.Collections.Generic.List[PSObject]]::new()

    $familyKeyPattern = '-(?<year>\d{4})(-\d+)?$'

    for ($i = 0; $i -lt $totalClaims; $i++) {
        $claim = $claims[$i]
        $key   = "$($claim.org_id)::$($claim.source_id)::$i"
        if (-not $claimVecs.PSObject.Properties[$key]) {
            Write-Warning "Missing embedding for $key — skipping"
            continue
        }
        $qv = @($claimVecs.$key | ForEach-Object { [double]$_ })
        $qvArr = [double[]]$qv

        # Cosine — vectors from batch-encode are L2-normalized, node vectors
        # from generate are also normalized. So dot product = cosine.
        $scores = [System.Collections.Generic.List[PSObject]]::new()
        for ($j = 0; $j -lt $nodeIds.Count; $j++) {
            $nv = $nodeVecs[$j]
            $s = 0.0
            for ($k = 0; $k -lt $qvArr.Length; $k++) { $s += $qvArr[$k] * $nv[$k] }
            $scores.Add([PSCustomObject]@{ NodeId = $nodeIds[$j]; Score = $s })
        }
        $top = @($scores | Sort-Object -Property Score -Descending | Select-Object -First $TopK)

        $sourceId = [string]$claim.source_id
        $family = $sourceId -replace $familyKeyPattern, ''
        # Verbatim = the raw org sentence. The directional gate feeds this (not the
        # canonical_proposition) as claimProp per CL's contract amendment t/2744#9:
        # canonical over-abstracts and neutralizes the polarity signal the gate
        # exists to detect (origin inversion reads unrelated on canonical vs opposes
        # on the verbatim phrasing). Org claims carry no attribution_text, so `text`
        # is the verbatim fallback. Embedding/node-selection still use canonical.
        $verbatim = if ($claim.PSObject.Properties['text']) { [string]$claim.text } else { '' }
        $matchPerClaim.Add([PSCustomObject]@{
            OrgId       = [string]$claim.org_id
            SourceId    = $sourceId
            Family      = $family
            Polarity    = [string]$claim.polarity
            Proposition = [string]$claim.canonical_proposition
            Verbatim    = $verbatim
            Top         = @($top)
            Best        = $top[0]
        })

        # Negation slice (t/1553#18): flag any claim whose proposition matches
        # the double-mark pattern, regardless of polarity. Embeddings are weak
        # at negation so these are the top-K rows CL wants to eyeball.
        if ([string]$claim.canonical_proposition -match $doubleMarkPattern) {
            $negationSlice.Add([PSCustomObject]@{
                OrgId       = [string]$claim.org_id
                SourceId    = $sourceId
                Polarity    = [string]$claim.polarity
                Proposition = [string]$claim.canonical_proposition
                Top         = @($top)
            })
        }
    }

    # ── Existing edges to skip ───────────────────────────────────────────
    $existingKeys = @{}
    try {
        $edgeStore = Get-OrganizationEdgesStore
        if ($edgeStore -and $edgeStore.PSObject.Properties['edges']) {
            foreach ($e in @($edgeStore.edges)) {
                if (-not $e.PSObject.Properties['source'] -or
                    -not $e.PSObject.Properties['target'] -or
                    -not $e.PSObject.Properties['type']) { continue }
                $k = "$([string]$e.source)::$([string]$e.target)::$([string]$e.type)"
                $existingKeys[$k] = $true
            }
        }
    } catch {
        Write-Verbose "No edge store readable (fresh install?) — treating all tuples as new"
    }

    # ── Aggregate to proposals ───────────────────────────────────────────
    # Bucket key: (org, node, polarity). For each bucket, dedup by family,
    # then apply MinAgreement / MatchThreshold rules.
    $buckets = @{}
    foreach ($m in $matchPerClaim) {
        # Only the BEST node per claim participates in aggregation
        # (top-K rows are retained for reporting; aggregation uses the argmax).
        $bkey = "$($m.OrgId)::$($m.Best.NodeId)::$($m.Polarity)"
        if (-not $buckets.ContainsKey($bkey)) {
            $buckets[$bkey] = [System.Collections.Generic.List[PSObject]]::new()
        }
        $buckets[$bkey].Add($m)
    }

    $proposals = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($bkey in $buckets.Keys) {
        $items = $buckets[$bkey]
        $orgId    = ($items[0]).OrgId
        $nodeId   = ($items[0]).Best.NodeId
        $polarity = ($items[0]).Polarity
        # PROVISIONAL edge type from the org's own polarity only. The directional
        # gate below (t/2745) reconciles it against the matched node's proposition
        # before any edge is kept — a claim that asserts ¬(node) flips
        # ADVOCATES_FOR→OPPOSES; anything else (incl. unresolved) KEEPS the edge
        # (opposition-only gate — unresolved is never a false demote).
        $edgeType = if ($polarity -eq 'asserts') { 'ADVOCATES_FOR' } else { 'OPPOSES' }

        # Independence: family-dedup
        $families = @($items | ForEach-Object { $_.Family } | Sort-Object -Unique)
        $independence = $families.Count

        # Gate:
        # (a) independent-claims rule: >= MinAgreement DISTINCT families,
        # (b) single-claim threshold: any item's Best.Score >= MatchThreshold.
        $bestScore = ($items | Measure-Object -Property { $_.Best.Score } -Maximum).Maximum
        $meetsA = $independence -ge $MinAgreement
        $meetsB = $bestScore -ge $MatchThreshold
        if (-not ($meetsA -or $meetsB)) { continue }

        # (existing-edge skip is deferred to after directional reconciliation,
        #  because a flip changes the (org, node, type) tuple it keys on.)

        # Representative claim proposition = the highest-cosine item in the
        # bucket (the pair the directional gate judges for this proposal). Use its
        # VERBATIM text (t/2744#9), falling back to the canonical proposition only
        # when verbatim is empty.
        $repItem = @($items | Sort-Object -Property { $_.Best.Score } -Descending)[0]
        $repProp = if ([string]::IsNullOrWhiteSpace($repItem.Verbatim)) { $repItem.Proposition } else { $repItem.Verbatim }

        # Claim REPRESENTATIONS for the directional gate (CL t/2744#10 / TL t/2756#2):
        # no single claim field wins across cases, so gate EVERY available rep and
        # take opposes-if-ANY. Org claims carry two reps — verbatim (text) + canonical.
        # Verbatim first so the primary rep leads; dedup identical texts to avoid a
        # redundant NLI call. Recall-safe under opposes-only (a rep that reads
        # neutral/entailment simply doesn't fire; each opposes is still τ_contra-gated).
        $repSeen = @{}
        $repReps = [System.Collections.Generic.List[PSObject]]::new()
        foreach ($cand in @(
                @{ Kind = 'verbatim';  Text = [string]$repItem.Verbatim },
                @{ Kind = 'canonical'; Text = [string]$repItem.Proposition })) {
            if ([string]::IsNullOrWhiteSpace($cand.Text)) { continue }
            if ($repSeen.ContainsKey($cand.Text)) { continue }
            $repSeen[$cand.Text] = $true
            $repReps.Add([PSCustomObject]@{ Kind = $cand.Kind; Text = $cand.Text })
        }

        # Rationale + source_refs bundle
        $reason = if ($meetsA -and $meetsB) { 'multi-claim-agreement+high-cosine' }
                  elseif ($meetsA) { 'multi-claim-agreement' }
                  else { 'high-cosine' }
        $summary = "match_basis=$reason families=$independence best_cosine={0:N3} (t/1553 Stage 3)" -f $bestScore

        $srcRefs = @($items | ForEach-Object { $_.SourceId } | Sort-Object -Unique)

        $proposals.Add([PSCustomObject]@{
            OrgId       = $orgId
            NodeId      = $nodeId
            EdgeType    = $edgeType
            Polarity    = $polarity
            RepProp     = [string]$repProp
            RepReps     = @($repReps)
            Direction   = 'skipped'
            DirConfidence = $null
            DirMethod   = 'skipped'
            Endorsement = 'skipped'
            EndorsementReason = ''
            DirectionConflict = $false
            Reason      = $reason
            BestCosine  = $bestScore
            Independent = $independence
            ClaimCount  = $items.Count
            SourceRefs  = @($srcRefs)
            Rationale   = $summary
            Items       = @($items)
        })
    }

    # ── Directional reconciliation (t/2745 V1, shared gate t/2751) ───────
    # Embedding cosine picked the matched node by TOPIC; it cannot tell "asserts
    # P" from "asserts ¬P". The shared engine (POV-framed NLI) supplies that
    # signal. Per CL ruling (t/2751#3) the gate is an asymmetric OPPOSITION
    # detector: only 'opposes' is actionable. On 'opposes' the claim asserts
    # ¬(node), so the provisional edge type (derived from the org's OWN polarity)
    # is FLIPPED (ADVOCATES_FOR<->OPPOSES). 'agrees'/'unrelated'/'unresolved' all
    # mean "no opposition detected" → the provisional edge stands (no drop —
    # the gate rates a genuine agreement 'unrelated', not 'agrees', so dropping on
    # anything but 'opposes' would nuke recall). Off only under -SkipDirectionalGate.
    $directionalFlipped = 0

    # Node proposition text (label + Core description) from loaded taxonomy — shared
    # by the directional gate and the endorsement gate (t/4523: "reuse the shared
    # node_prop construction"). Built whenever either gate needs it.
    $povByPrefix = @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }
    $nodeTextById = @{}
    if (($proposals.Count -gt 0) -and (-not $SkipDirectionalGate -or -not $SkipEndorsementGate)) {
        foreach ($pov in $script:TaxonomyData.Values) {
            if (-not $pov.PSObject.Properties['nodes']) { continue }
            foreach ($n in @($pov.nodes)) {
                if (-not $n.PSObject.Properties['id']) { continue }
                $lbl = if ($n.PSObject.Properties['label']) { [string]$n.label } else { '' }
                $dsc = if ($n.PSObject.Properties['description'] -and $n.description) { [string]$n.description } else { '' }
                # Core proposition only: strip Encompasses:/Excludes: tails (they name
                # sibling topics, not the asserted proposition). Consistent node_prop
                # construction across V-surfaces is a TL GV condition (t/2751#4 #3).
                $dsc = $dsc -replace '(?s)\s*(Encompasses|Excludes)\s*:.*$', ''
                $nodeTextById[[string]$n.id] = if ($dsc) { "$lbl — $($dsc.Trim())" } else { $lbl }
            }
        }
    }

    if (-not $SkipDirectionalGate -and $proposals.Count -gt 0) {
        # One gate pair per claim REP (verbatim, canonical) — id "propIdx:repIdx".
        $gatePairs = [System.Collections.Generic.List[PSObject]]::new()
        for ($pi = 0; $pi -lt $proposals.Count; $pi++) {
            $prop = $proposals[$pi]
            $nid = [string]$prop.NodeId
            $nodeText = if ($nodeTextById.ContainsKey($nid)) { $nodeTextById[$nid] } else { '' }
            $prefix = if ($nid -match '^(acc|saf|skp)-') { $Matches[1] } else { '' }
            $nodePov = if ($prefix -and $povByPrefix.ContainsKey($prefix)) { $povByPrefix[$prefix] } else { '' }
            $reps = @($prop.RepReps)
            for ($ri = 0; $ri -lt $reps.Count; $ri++) {
                $gatePairs.Add([PSCustomObject]@{ Id = "$($pi):$($ri)"; ClaimProp = [string]$reps[$ri].Text; NodeProp = $nodeText; NodePov = $nodePov })
            }
        }

        $verdicts = Test-DirectionalAgreement -Pair @($gatePairs) -TauContra $DirectionalTauContra
        # Group each proposal's per-rep verdicts by the proposal index.
        $verdictsByProp = @{}
        foreach ($v in @($verdicts)) {
            $pidx = [int]((([string]$v.Id) -split ':')[0])
            if (-not $verdictsByProp.ContainsKey($pidx)) { $verdictsByProp[$pidx] = [System.Collections.Generic.List[PSObject]]::new() }
            $verdictsByProp[$pidx].Add($v)
        }

        for ($pi = 0; $pi -lt $proposals.Count; $pi++) {
            $prop = $proposals[$pi]
            $repVerdicts = if ($verdictsByProp.ContainsKey($pi)) { @($verdictsByProp[$pi]) } else { @() }

            # opposes-if-ANY (CL t/2744#10 / TL t/2756#2): the proposal opposes iff
            # any claim rep contradicts the node. Otherwise summarize the survivors
            # (agrees > unrelated > unresolved) for the counts metric. Recall-safe:
            # each 'opposes' is still τ_contra-gated, so extra reps never false-demote.
            $opp = @($repVerdicts | Where-Object { $_.Direction -eq 'opposes' })
            if ($opp.Count -gt 0) {
                $direction = 'opposes'
                $decV = @($opp | Sort-Object -Property Confidence -Descending)[0]
            } elseif (@($repVerdicts | Where-Object { $_.Direction -eq 'agrees' }).Count -gt 0) {
                $direction = 'agrees';    $decV = @($repVerdicts | Where-Object { $_.Direction -eq 'agrees' })[0]
            } elseif (@($repVerdicts | Where-Object { $_.Direction -eq 'unrelated' }).Count -gt 0) {
                $direction = 'unrelated'; $decV = @($repVerdicts | Where-Object { $_.Direction -eq 'unrelated' })[0]
            } else {
                $direction = 'unresolved'; $decV = if ($repVerdicts.Count -gt 0) { $repVerdicts[0] } else { $null }
            }
            $prop.Direction     = $direction
            $prop.DirConfidence = if ($decV) { $decV.Confidence } else { 0.0 }
            $prop.DirMethod     = if ($decV) { [string]$decV.Method } else { 'none' }

            if ($direction -eq 'opposes') {
                # Claim asserts ¬(node) → flip the provisional polarity-derived edge.
                $finalType = if ($prop.EdgeType -eq 'ADVOCATES_FOR') { 'OPPOSES' } else { 'ADVOCATES_FOR' }
                $directionalFlipped++
                $prop.Rationale = "$($prop.Rationale) directional_flip=$($prop.EdgeType)->$finalType nli_dir=opposes reps=$($repVerdicts.Count)"
                $prop.EdgeType = $finalType
            } else {
                $prop.Rationale = "$($prop.Rationale) directional_ok nli_dir=$direction reps=$($repVerdicts.Count)"
            }
        }
    }

    # ── Endorsement-confirmation gate (t/4475 7b / t/4523) ───────────────
    # The directional gate only detects opposition; it cannot reject a
    # topical-only match. An LLM judges, per claim rep, whether the org's
    # position ENDORSES the node's proposition (entails/restates it) or only
    # shares its topic. TAGS AND REORDERS, NEVER DROPS: every proposal is
    # still written as 'proposed'. Endorsement = best verdict over the
    # proposal's reps (endorses > partial > unknown > topic_only/none), so a
    # single confirming rep is enough; 'unknown' means the gate didn't reach
    # a verdict (backend failure), never "the gate said no" (AC: WARN, not
    # throw, on backend failure — proposals are written with endorsement:
    # unknown). Off only under -SkipEndorsementGate.
    if (-not $SkipEndorsementGate -and $proposals.Count -gt 0) {
        $endorsePairs = [System.Collections.Generic.List[PSObject]]::new()
        for ($pi = 0; $pi -lt $proposals.Count; $pi++) {
            $prop = $proposals[$pi]
            $nid = [string]$prop.NodeId
            $nodeText = if ($nodeTextById.ContainsKey($nid)) { $nodeTextById[$nid] } else { '' }
            $prefix = if ($nid -match '^(acc|saf|skp)-') { $Matches[1] } else { '' }
            $nodePov = if ($prefix -and $povByPrefix.ContainsKey($prefix)) { $povByPrefix[$prefix] } else { '' }
            $reps = @($prop.RepReps)
            for ($ri = 0; $ri -lt $reps.Count; $ri++) {
                $endorsePairs.Add([PSCustomObject]@{ Id = "$($pi):$($ri)"; ClaimProp = [string]$reps[$ri].Text; NodeProp = $nodeText; NodePov = $nodePov })
            }
        }

        $endorseVerdicts = Test-OrgEndorsement -Pair @($endorsePairs) -Model $EndorsementModel -ApiKey $ApiKey
        $endorseByProp = @{}
        foreach ($v in @($endorseVerdicts)) {
            $pidx = [int]((([string]$v.Id) -split ':')[0])
            if (-not $endorseByProp.ContainsKey($pidx)) { $endorseByProp[$pidx] = [System.Collections.Generic.List[PSObject]]::new() }
            $endorseByProp[$pidx].Add($v)
        }

        for ($pi = 0; $pi -lt $proposals.Count; $pi++) {
            $prop = $proposals[$pi]
            $repVerdicts = if ($endorseByProp.ContainsKey($pi)) { @($endorseByProp[$pi]) } else { @() }

            $endorses = @($repVerdicts | Where-Object { $_.Verdict -eq 'endorses' })
            $partial = @($repVerdicts | Where-Object { $_.Verdict -eq 'partial' })
            $unk = @($repVerdicts | Where-Object { $_.Verdict -eq 'unknown' })
            if ($endorses.Count -gt 0) { $winningVerdict = $endorses[0] }
            elseif ($partial.Count -gt 0) { $winningVerdict = $partial[0] }
            elseif ($unk.Count -gt 0) { $winningVerdict = $unk[0] }
            elseif ($repVerdicts.Count -gt 0) { $winningVerdict = $repVerdicts[0] }   # every rep topic_only
            else { $winningVerdict = $null }   # no reps
            $tag = if ($winningVerdict) { [string]$winningVerdict.Verdict } else { 'none' }
            if ($tag -eq 'topic_only') { $tag = 'none' }

            $prop.Endorsement = $tag
            $prop.EndorsementReason = if ($winningVerdict) { [string]$winningVerdict.Reason } else { '' }

            # direction_conflict (CL t/4523#5, condition 2): the endorsement gate's own
            # direction step says this org favours the node, but the directional gate
            # (t/2751) flipped the edge to OPPOSES. Never auto-resolved — a reviewer must
            # see it. Fires on 7/29 in the dev check, feeding t/4546 (the directional
            # gate's own type-flip-stability finding).
            $prop.DirectionConflict = ($tag -in @('endorses', 'partial')) -and ($prop.EdgeType -eq 'OPPOSES')

            $flagNote = if ($prop.DirectionConflict) { ' direction_conflict=true' } else { '' }
            $prop.Rationale = "$($prop.Rationale) endorsement=$tag reps=$($repVerdicts.Count)$flagNote"
        }
    }

    # ── Existing-edge skip (keyed on the FINAL, reconciled edge type) ─────
    if (-not $Force) {
        $kept = [System.Collections.Generic.List[PSObject]]::new()
        foreach ($prop in $proposals) {
            $existingCheckKey = "$($prop.OrgId)::$($prop.NodeId)::$($prop.EdgeType)"
            if ($existingKeys.ContainsKey($existingCheckKey)) { continue }
            $kept.Add($prop)
        }
        $proposals = $kept
    }

    # ── Per-org cap (top by endorsement, then best cosine) ───────────────
    # t/4523: the endorsement gate REORDERS the review queue — a 'none'-tagged
    # proposal sorts after every other proposal, regardless of cosine. This is
    # the per-org cap's existing drop mechanism, not the gate itself dropping
    # anything: every proposal is still produced and still eligible, 'none' is
    # simply first in line when the cap has to cut somewhere.
    $endorsementRank = @{ endorses = 0; partial = 1; unknown = 2; skipped = 2; none = 3 }
    $capped = [System.Collections.Generic.List[PSObject]]::new()
    $dropped = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($grp in ($proposals | Group-Object -Property OrgId)) {
        $ordered = @($grp.Group | Sort-Object -Property `
            @{ Expression = { if ($endorsementRank.ContainsKey([string]$_.Endorsement)) { $endorsementRank[[string]$_.Endorsement] } else { 2 } } }, `
            @{ Expression = 'BestCosine'; Descending = $true })
        $keep = $ordered | Select-Object -First $PerOrgCap
        $skip = $ordered | Select-Object -Skip $PerOrgCap
        foreach ($p in $keep) { $capped.Add($p) }
        foreach ($p in $skip) { $dropped.Add($p) }
    }

    # ── Emit or dry-run report ──────────────────────────────────────────
    $written = 0
    $failed  = [System.Collections.Generic.List[string]]::new()
    if ($WriteProposals) {
        foreach ($p in $capped) {
            $target = "$($p.OrgId)->$($p.NodeId) [$($p.EdgeType)]"
            if ($PSCmdlet.ShouldProcess($target, 'Propose org→node edge')) {
                try {
                    $null = Import-OrganizationEdge -InputObject ([PSCustomObject]@{
                        source        = $p.OrgId
                        target        = $p.NodeId
                        type          = $p.EdgeType
                        rationale     = $p.Rationale
                        source_refs   = @($p.SourceRefs)
                        status        = 'proposed'
                        discovered_at = (Get-Date).ToString('yyyy-MM-dd')
                    }) -Confirm:$false
                    $written++
                } catch {
                    $failed.Add("$($p.OrgId)->$($p.NodeId): $($_.Exception.Message)")
                    Write-Warning "Failed to write proposal $($p.OrgId)->$($p.NodeId): $($_.Exception.Message)"
                }
            }
        }
    }

    # Per-run directional verdict counts (TL GV condition t/2751#4 #1): mandatory
    # metric AND the detector for a silently-degraded engine — an all-`unresolved`
    # run over a non-empty gated set means the engine is down (stderr is swallowed).
    $directionalCounts = [ordered]@{ opposes = 0; agrees = 0; unrelated = 0; unresolved = 0 }
    if (-not $SkipDirectionalGate) {
        foreach ($p in $capped) {
            $d = [string]$p.Direction
            if ($directionalCounts.Contains($d)) { $directionalCounts[$d]++ }
        }
    }
    $countsNote = ($directionalCounts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
    $gateNote = if ($SkipDirectionalGate) { 'gate=OFF' } else { "gate: flipped=$directionalFlipped [$countsNote]" }

    # Per-run endorsement tag counts (t/4523) — same rationale as the directional
    # counts above: a mandatory metric, and the detector for a silently-degraded
    # gate (an all-'unknown' run over a non-empty tagged set means the backend is
    # down, since 'unknown' only comes from a caught failure, never a verdict).
    $endorsementCounts = [ordered]@{ endorses = 0; partial = 0; none = 0; unknown = 0 }
    if (-not $SkipEndorsementGate) {
        foreach ($p in $capped) {
            $e = [string]$p.Endorsement
            if ($endorsementCounts.Contains($e)) { $endorsementCounts[$e]++ }
        }
    }
    $endorseCountsNote = ($endorsementCounts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
    $endorseNote = if ($SkipEndorsementGate) { 'endorsement=OFF' } else { "endorsement: [$endorseCountsNote]" }

    Write-Host ""
    if ($WriteProposals) {
        Write-Host "Claims: $totalClaims | Proposals: $($capped.Count) (wrote $written) | Dropped by cap: $($dropped.Count) | Negation-slice: $($negationSlice.Count) | $gateNote | $endorseNote"
    } else {
        Write-Host "Claims: $totalClaims | Proposals (dry-run): $($capped.Count) | Dropped by cap: $($dropped.Count) | Negation-slice: $($negationSlice.Count) | $gateNote | $endorseNote"
    }

    [PSCustomObject]@{
        ClaimsProcessed     = $totalClaims
        ProposalsWouldEmit  = $capped.Count
        Proposed            = $written
        DroppedByCap        = @($dropped)
        Proposals           = @($capped)
        NegationSlice       = @($negationSlice)
        DirectionalFlipped  = $directionalFlipped
        DirectionalCounts   = $directionalCounts
        DirectionalGate     = (-not $SkipDirectionalGate)
        EndorsementCounts   = $endorsementCounts
        EndorsementGate     = (-not $SkipEndorsementGate)
        DirectionConflicts  = @($capped | Where-Object { $_.DirectionConflict }).Count
        Failed              = @($failed)
        EmbeddingsPath      = $EmbeddingsPath
    }
}
