# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# FIRE — Confidence-gated iterative claim extraction.
# Dot-sourced by AITriad.psm1 — do NOT export.

function Invoke-IterativeExtraction {
    <#
    .SYNOPSIS
        FIRE iterative claim extraction with confidence gating and termination guardrails.
    .DESCRIPTION
        Replaces single-shot summarization with a per-claim confidence-gated loop.
        Each claim is assessed for confidence; uncertain claims trigger targeted
        follow-up queries to accumulate evidence. Early termination via Sentence-BERT
        similarity or hard caps.

        Mandatory termination guardrails (SRE e/16#4):
        - Max 5 iterations per claim
        - Max 20 iterations per document
        - Max wall-clock 5 minutes per document
        - Total API call budget per invocation

        FIRE confidence != QBAF base_strength (Risk Assessor e/16#5).
        These are separate fields: extraction reliability vs argument quality.
    .PARAMETER Prompt
        The full extraction prompt (system + taxonomy + document).
    .PARAMETER Model
        AI model identifier.
    .PARAMETER ApiKey
        AI API key.
    .PARAMETER Temperature
        Sampling temperature.
    .PARAMETER MaxIterPerClaim
        Maximum iterations per uncertain claim. Default: 5.
    .PARAMETER MaxIterPerDoc
        Maximum total iterations per document. Default: 20.
    .PARAMETER WallClockSeconds
        Maximum wall-clock time per document. Default: 300 (5 minutes).
    .PARAMETER MaxApiCalls
        Maximum total API calls per invocation. Default: 25.
    .PARAMETER ConfidenceThreshold
        Minimum confidence to accept a claim without iteration. Default: 0.7. Reported back as
        FireStats.confidence_threshold, which Finalize-Summary records (t/4079).
    .PARAMETER MaxTokens
        Output budget for the initial extraction call. Default: 32768.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Prompt,

        [string]$SystemInstruction = '',

        [Parameter(Mandatory)]
        [string]$Model,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$ApiKey,

        [double]$Temperature = 0.1,

        [int]$MaxIterPerClaim = 5,

        [int]$MaxIterPerDoc = 20,

        [int]$WallClockSeconds = 60,

        [int]$MaxApiCalls = 25,

        [double]$ConfidenceThreshold = 0.7,

        [int]$MaxTokens = 32768
    )

    Set-StrictMode -Version Latest

    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    # Mutable orchestration state shared with the per-claim helpers (hashtable = passed by
    # reference, so helper increments persist without ref-params / return-value plumbing).
    $Ctx = @{
        TotalIter                 = 0
        TotalApiCalls             = 0
        ClaimsConfident           = 0
        ClaimsIterated            = 0
        ClaimsExhausted           = 0
        ClaimsDroppedVerification = 0
        TerminationReason         = 'all_confident'
    }

    # ── Phase 1: Initial extraction (same as single-shot) ─────────────────────
    Write-Verbose "FIRE Phase 1: Initial extraction"
    Write-Verbose "  Model: $Model | Temperature: $Temperature | MaxTokens: $MaxTokens"
    Write-Verbose "  Guardrails: max $MaxIterPerClaim iter/claim, $MaxIterPerDoc iter/doc, ${WallClockSeconds}s wall-clock, $MaxApiCalls API calls"
    Write-Verbose "  Confidence threshold: $ConfidenceThreshold"
    $Ctx.TotalApiCalls++
    Write-Verbose "  API call #$($Ctx.TotalApiCalls) — initial extraction starting..."

    $InitialResult = Invoke-AIApi `
        -Prompt      $Prompt `
        -SystemInstruction $SystemInstruction `
        -Model       $Model `
        -ApiKey      $ApiKey `
        -Temperature $Temperature `
        -MaxTokens   $MaxTokens `
        -JsonMode `
        -TimeoutSec  600

    if ($null -eq $InitialResult) {
        New-ActionableError -Goal 'FIRE initial extraction' `
            -Problem 'AI API returned null' `
            -Location 'Invoke-IterativeExtraction' `
            -NextSteps @('Check API key', 'Verify model availability') -Throw
    }

    Write-Verbose "  Phase 1 complete — $($InitialResult.Backend) responded in $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"

    $Parse = ConvertFrom-FireExtractionJson -InitialResult $InitialResult

    if ($Parse.ParseFailed) {
        # The full stats shape (t/4172): no claim was parsed, so every claim count is 0.
        $FailedStats = New-FireStats -ConfidenceThreshold $ConfidenceThreshold -TotalApiCalls 1 `
            -ElapsedSeconds $Stopwatch.Elapsed.TotalSeconds -TerminationReason 'parse_failed' `
            -MaxIterPerClaim $MaxIterPerClaim -MaxIterPerDoc $MaxIterPerDoc -WallClockSeconds $WallClockSeconds -MaxApiCalls $MaxApiCalls
        $FailedStats['phase1_only'] = $true
        $FailedStats['parse_failed'] = $true
        return @{
            Summary    = $null
            RawText    = $InitialResult.Text
            Backend    = $InitialResult.Backend
            FireStats  = $FailedStats
        }
    }
    # Not a parse failure: carry the parsed value through exactly as the inline code did. An empty
    # array ([]) stays an empty array -> no_claims; a text that parsed to $null ('null', '') reaches
    # the strict-mode factual_claims check and throws there, as before (t/3849 refactor).
    $Summary = $Parse.Summary

    # ── Phase 2-3: Assess confidence and iterate on uncertain claims ────────
    if (-not ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims)) {
        Write-Verbose "  No factual_claims in response — nothing to iterate on"
        # No claims to iterate on — return as-is
        return @{
            Summary   = $Summary
            RawText   = $InitialResult.Text
            Backend   = $InitialResult.Backend
            FireStats = New-FireStats -ConfidenceThreshold $ConfidenceThreshold -TotalApiCalls 1 `
                -ElapsedSeconds $Stopwatch.Elapsed.TotalSeconds -TerminationReason 'no_claims' `
                -MaxIterPerClaim $MaxIterPerClaim -MaxIterPerDoc $MaxIterPerDoc -WallClockSeconds $WallClockSeconds -MaxApiCalls $MaxApiCalls
        }
    }

    $Claims = if ($Summary.PSObject.Properties['factual_claims']) { @($Summary.factual_claims) } else { @() }

    $DriftChecks = [System.Collections.Generic.List[PSObject]]::new()
    # t/4509: a claim whose own verification step says "verified: false" is a statement that the
    # source does NOT contain the claim — not a factual claim at all. Index tracked here (not
    # removed mid-loop, since DriftChecks below also indexes into $Claims); the set is filtered out
    # of $Summary.factual_claims right before return.
    $DroppedIndices = [System.Collections.Generic.HashSet[int]]::new()

    Write-Verbose "FIRE Phase 2-3: Assessing $($Claims.Count) claims..."

    # Compute column alignment from the longest claim label
    # Layout: "FIRE: <label>" padded, then confidence + status
    $ConfColumn = Measure-FireLabelColumn -Claims $Claims
    $Indent = ' ' * 6   # Align sub-lines under "FIRE: "

    $OuterReasonMap = @{
        wall_clock = "wall_clock_exceeded ($WallClockSeconds s)"
        doc_iter   = "max_doc_iterations ($MaxIterPerDoc)"
        api_budget = "api_budget_exceeded ($MaxApiCalls)"
    }

    # ── Phase 3: Assess and iterate on uncertain claims ───────────────────────
    for ($i = 0; $i -lt $Claims.Count; $i++) {
        # Check termination guardrails
        $Trip = Test-FireGuardrailTrip -Stopwatch $Stopwatch -WallClockSeconds $WallClockSeconds `
            -TotalIter $Ctx.TotalIter -MaxIterPerDoc $MaxIterPerDoc -TotalApiCalls $Ctx.TotalApiCalls -MaxApiCalls $MaxApiCalls
        if ($Trip) {
            $Ctx.TerminationReason = $OuterReasonMap[$Trip]
            Write-Verbose (Get-FireOuterGuardrailMessage -Trip $Trip -Index $i -ClaimCount $Claims.Count `
                -WallClockSeconds $WallClockSeconds -MaxIterPerDoc $MaxIterPerDoc -MaxApiCalls $MaxApiCalls)
            break
        }

        Invoke-FireClaimProcessing -Claim $Claims[$i] -Index $i `
            -ConfidenceThreshold $ConfidenceThreshold -ConfColumn $ConfColumn -Indent $Indent `
            -MaxIterPerClaim $MaxIterPerClaim -Stopwatch $Stopwatch -WallClockSeconds $WallClockSeconds `
            -MaxIterPerDoc $MaxIterPerDoc -MaxApiCalls $MaxApiCalls `
            -Model $Model -ApiKey $ApiKey -SystemInstruction $SystemInstruction -Temperature $Temperature `
            -Ctx $Ctx -DriftChecks $DriftChecks -DroppedIndices $DroppedIndices
    }

    $Stopwatch.Stop()

    # ── Post-pass: semantic drift detection for refined claims (gap 4.1) ─────
    $DriftCount = 0
    if ($DriftChecks.Count -gt 0) {
        $DriftCount = Invoke-FireDriftDetection -Claims $Claims -DriftChecks $DriftChecks
    }

    # ── Drop candidates that failed verification (t/4509) ────────────────────
    # claims_total (below) still counts every candidate the loop considered, so the drop is visible
    # alongside claims_dropped_verification rather than silently shrinking the total.
    $OriginalClaimsCount = $Claims.Count
    if ($DroppedIndices.Count -gt 0) {
        $Claims = Remove-FireDroppedClaims -Claims $Claims -DroppedIndices $DroppedIndices
        $Summary.factual_claims = $Claims
    }

    # ── Final summary log ─────────────────────────────────────────────────────
    Write-Verbose "FIRE complete: $OriginalClaimsCount claims | $($Ctx.ClaimsConfident) confident | $($Ctx.ClaimsIterated) iterated | $($Ctx.ClaimsDroppedVerification) dropped (failed verification) | $($Ctx.TotalIter) total iterations | $($Ctx.TotalApiCalls) API calls | $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"
    Write-Verbose "  Termination: $($Ctx.TerminationReason)"
    Write-Verbose "  Guardrails: max_iter_per_claim=$MaxIterPerClaim, max_iter_per_doc=$MaxIterPerDoc, wall_clock=${WallClockSeconds}s, max_api_calls=$MaxApiCalls"
    if ($Ctx.ClaimsExhausted -gt 0) {
        Write-Verbose "  WARNING: $($Ctx.ClaimsExhausted) claim(s) exhausted iteration budget without reaching threshold"
    }
    if ($DriftCount -gt 0) {
        Write-Verbose "  WARNING: $DriftCount claim(s) flagged for semantic drift after refinement"
    }

    # ── Return enriched summary ───────────────────────────────────────────────
    return @{
        Summary   = $Summary
        RawText   = $InitialResult.Text
        Backend   = $InitialResult.Backend
        FireStats = New-FireStats -ConfidenceThreshold $ConfidenceThreshold -TotalIterations $Ctx.TotalIter `
            -TotalApiCalls $Ctx.TotalApiCalls -ClaimsTotal $OriginalClaimsCount -ClaimsConfident $Ctx.ClaimsConfident `
            -ClaimsIterated $Ctx.ClaimsIterated -ClaimsDrifted $DriftCount -ClaimsDroppedVerification $Ctx.ClaimsDroppedVerification `
            -ElapsedSeconds $Stopwatch.Elapsed.TotalSeconds `
            -TerminationReason $Ctx.TerminationReason `
            -MaxIterPerClaim $MaxIterPerClaim -MaxIterPerDoc $MaxIterPerDoc -WallClockSeconds $WallClockSeconds -MaxApiCalls $MaxApiCalls
    }
}

function ConvertFrom-FireExtractionJson {
    <#
    .SYNOPSIS
        Phase-1 JSON parse with the exact repair fallback the inline code used (t/4172).
    .DESCRIPTION
        Strips a ```json fence, parses, and on failure attempts Repair-TruncatedJson.
        Returns [PSCustomObject]@{ ParseFailed; Summary }. ParseFailed is $true ONLY when
        ConvertFrom-Json threw and Repair-TruncatedJson could not recover it -- the exact
        parse_failed path of the old inline code's catch block. Text that PARSES to $null
        ('null', '') or to an empty array ('[]') is NOT a parse failure: Summary carries the
        parsed value (the property preserves an empty array), and the caller's factual_claims
        check handles it as before -- no_claims for [], a strict-mode throw for $null.
    #>
    param($InitialResult)

    $CleanedText = $InitialResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
    try {
        $Summary = $CleanedText.Trim() | ConvertFrom-Json
        return [PSCustomObject]@{ ParseFailed = $false; Summary = $Summary }
    }
    catch {
        $ParseErr = $_.Exception.Message
        Write-Verbose "  Phase 1 — initial parse failed: $ParseErr"
        # Attempt repair via Repair-TruncatedJson (handles truncation, unclosed brackets, trailing commas)
        $Repaired = Repair-TruncatedJson -Text $InitialResult.Text
        if ($Repaired) {
            try {
                $Summary = $Repaired | ConvertFrom-Json
                Write-Verbose "  Phase 1 — repaired JSON successfully"
                return [PSCustomObject]@{ ParseFailed = $false; Summary = $Summary }
            }
            catch {
                Write-Verbose "  Phase 1 — repair also failed: $($_.Exception.Message)"
            }
        }
        Write-Verbose "  Phase 1 FAILED — JSON parse error: $ParseErr"
        return [PSCustomObject]@{ ParseFailed = $true; Summary = $null }
    }
}

function Measure-FireLabelColumn {
    <#
    .SYNOPSIS
        Column at which confidence/status is printed: 6 ("FIRE: ") + longest label + 2 padding.
    #>
    param($Claims)

    $LabelMaxLen = 0
    foreach ($c in $Claims) {
        if ($c.PSObject.Properties['claim_label']) { $lbl = $c.claim_label } else { $lbl = 'claim-?' }
        if ($lbl.Length -gt $LabelMaxLen) { $LabelMaxLen = $lbl.Length }
    }
    # "FIRE: " (6) + label + padding (2)
    return (6 + $LabelMaxLen + 2)
}

function Test-FireGuardrailTrip {
    <#
    .SYNOPSIS
        Returns which termination guardrail tripped: 'wall_clock', 'doc_iter', 'api_budget' or '' (none).
    #>
    param($Stopwatch, $WallClockSeconds, $TotalIter, $MaxIterPerDoc, $TotalApiCalls, $MaxApiCalls)

    if ($Stopwatch.Elapsed.TotalSeconds -ge $WallClockSeconds) { return 'wall_clock' }
    if ($TotalIter -ge $MaxIterPerDoc) { return 'doc_iter' }
    if ($TotalApiCalls -ge $MaxApiCalls) { return 'api_budget' }
    return ''
}

function Get-FireOuterGuardrailMessage {
    <#
    .SYNOPSIS
        The per-document (outer-loop) GUARDRAIL verbose line for a tripped guardrail.
    #>
    param($Trip, $Index, $ClaimCount, $WallClockSeconds, $MaxIterPerDoc, $MaxApiCalls)

    $map = @{
        wall_clock = "FIRE: GUARDRAIL — wall-clock ${WallClockSeconds}s reached ($Index/$ClaimCount claims processed)"
        doc_iter   = "FIRE: GUARDRAIL — doc iteration limit $MaxIterPerDoc reached ($Index/$ClaimCount claims processed)"
        api_budget = "FIRE: GUARDRAIL — API call budget $MaxApiCalls reached ($Index/$ClaimCount claims processed)"
    }
    return $map[$Trip]
}

function Resolve-FireClaimConfidence {
    <#
    .SYNOPSIS
        Estimates a claim's initial FIRE confidence from its evidence_criteria (default 0.5).
    #>
    param($Claim)

    $Confidence = 0.5  # Default: uncertain
    if ($Claim.PSObject.Properties['evidence_criteria']) {
        $EC = $Claim.evidence_criteria
        $Conf = 0.3
        if ($EC.PSObject.Properties['specificity'] -and $EC.specificity -eq 'precise') { $Conf += 0.2 }
        if ($EC.PSObject.Properties['has_warrant'] -and $EC.has_warrant) { $Conf += 0.2 }
        if ($EC.PSObject.Properties['internally_consistent'] -and $EC.internally_consistent) { $Conf += 0.1 }
        $Confidence = $Conf
    }
    return $Confidence
}

function Invoke-FireClaimProcessing {
    <#
    .SYNOPSIS
        Assesses one claim: sets fire_confidence, accepts it when confident, otherwise iterates.
    .DESCRIPTION
        Mutates the shared $Ctx counters, appends refined claims to $DriftChecks, and records
        failed-verification indices in $DroppedIndices — all by reference. Behavior-preserving
        extraction of the per-claim body of the Phase-3 loop.
    #>
    param(
        $Claim, $Index, $ConfidenceThreshold, $ConfColumn, $Indent, $MaxIterPerClaim,
        $Stopwatch, $WallClockSeconds, $MaxIterPerDoc, $MaxApiCalls,
        $Model, $ApiKey, $SystemInstruction, $Temperature,
        $Ctx, $DriftChecks, $DroppedIndices
    )

    if ($Claim.PSObject.Properties['claim_label']) { $ClaimLabel = $Claim.claim_label } else { $ClaimLabel = "claim-$Index" }
    if ($Claim.PSObject.Properties['claim']) { $ClaimText = $Claim.claim } else { $ClaimText = '' }
    if ($ClaimText.Length -gt 70) { $ClaimShort = $ClaimText.Substring(0, 70) + '...' } else { $ClaimShort = $ClaimText }

    $Confidence = Resolve-FireClaimConfidence -Claim $Claim

    # Set fire_confidence
    if (-not $Claim.PSObject.Properties['fire_confidence']) {
        $Claim | Add-Member -NotePropertyName 'fire_confidence' -NotePropertyValue $Confidence -Force
    }
    else {
        $Claim.fire_confidence = $Confidence
    }

    # Main claim line: "FIRE: <label>          <conf> <status>"
    $LabelPadded = "FIRE: $ClaimLabel".PadRight($ConfColumn)
    $ConfStr = "$([Math]::Round($Confidence, 2))".PadLeft(4)

    if ($Confidence -ge $ConfidenceThreshold) {
        $Ctx.ClaimsConfident++
        Write-Verbose "${LabelPadded}${ConfStr} ✓"
        return
    }

    # ── Uncertain claim: iterate ──────────────────────────────────────
    Write-Verbose "${LabelPadded}${ConfStr} → iterating"
    Write-Verbose "${Indent}`"$ClaimShort`""
    $OriginalText = $ClaimText

    $Ref = Invoke-FireClaimRefinementLoop -Claim $Claim -ClaimLabel $ClaimLabel -ClaimText $ClaimText `
        -Confidence $Confidence -ConfidenceThreshold $ConfidenceThreshold -MaxIterPerClaim $MaxIterPerClaim `
        -Stopwatch $Stopwatch -WallClockSeconds $WallClockSeconds -MaxIterPerDoc $MaxIterPerDoc -MaxApiCalls $MaxApiCalls `
        -Model $Model -ApiKey $ApiKey -SystemInstruction $SystemInstruction -Temperature $Temperature `
        -Index $Index -Indent $Indent -Ctx $Ctx -DroppedIndices $DroppedIndices
    $Confidence = $Ref.Confidence
    $ClaimText = $Ref.ClaimText
    $ClaimIter = $Ref.ClaimIter

    # Log claim text change if it was refined
    if ($ClaimText -ne $OriginalText) {
        if ($ClaimText.Length -gt 70) { $NewShort = $ClaimText.Substring(0, 70) + '...' } else { $NewShort = $ClaimText }
        Write-Verbose "${Indent}→ `"$NewShort`""

        # Queue drift check if claim has a taxonomy mapping (gap 4.1)
        if ($Claim.PSObject.Properties['taxonomy_node_id'] -and $Claim.taxonomy_node_id) {
            $null = $DriftChecks.Add([PSCustomObject]@{
                Index          = $Index
                ClaimLabel     = $ClaimLabel
                RefinedText    = $ClaimText
                TaxonomyNodeId = $Claim.taxonomy_node_id
            })
        }
    }

    # Warn if claim exhausted iterations without reaching threshold
    if ($Confidence -lt $ConfidenceThreshold -and $ClaimIter -ge $MaxIterPerClaim) {
        $Ctx.ClaimsExhausted++
        Write-Warning "FIRE: $ClaimLabel exhausted $MaxIterPerClaim iterations (final=$([Math]::Round($Confidence, 2)), threshold=$ConfidenceThreshold)"
    }

    $Ctx.ClaimsIterated++
}

function Invoke-FireClaimRefinementLoop {
    <#
    .SYNOPSIS
        Runs the refinement while-loop for a single uncertain claim.
    .DESCRIPTION
        Issues follow-up API calls until the claim reaches the confidence threshold, exhausts
        its per-claim budget, trips a guardrail, or is dropped on failed verification. Mutates
        $Ctx (iteration/API counters, termination reason, drop count), $Claim (by reference) and
        $DroppedIndices. Returns the final Confidence, ClaimText and ClaimIter.
    #>
    param(
        $Claim, $ClaimLabel, $ClaimText, $Confidence, $ConfidenceThreshold, $MaxIterPerClaim,
        $Stopwatch, $WallClockSeconds, $MaxIterPerDoc, $MaxApiCalls,
        $Model, $ApiKey, $SystemInstruction, $Temperature,
        $Index, $Indent, $Ctx, $DroppedIndices
    )

    $ReasonMap = @{ wall_clock = 'wall_clock_exceeded'; doc_iter = 'max_doc_iterations'; api_budget = 'api_budget_exceeded' }
    $MsgMap = @{
        wall_clock = "${Indent}GUARDRAIL — wall-clock in iteration loop"
        doc_iter   = "${Indent}GUARDRAIL — doc iterations in iteration loop"
        api_budget = "${Indent}GUARDRAIL — API budget in iteration loop"
    }

    $ClaimIter = 0
    $RefinementSchema = Get-FireRefinementSchema

    while ($Confidence -lt $ConfidenceThreshold -and $ClaimIter -lt $MaxIterPerClaim) {
        $Trip = Test-FireGuardrailTrip -Stopwatch $Stopwatch -WallClockSeconds $WallClockSeconds `
            -TotalIter $Ctx.TotalIter -MaxIterPerDoc $MaxIterPerDoc -TotalApiCalls $Ctx.TotalApiCalls -MaxApiCalls $MaxApiCalls
        if ($Trip) { $Ctx.TerminationReason = $ReasonMap[$Trip]; Write-Verbose $MsgMap[$Trip]; break }

        $ClaimIter++
        $Ctx.TotalIter++
        $Ctx.TotalApiCalls++
        $BeforeConf = $Confidence

        $RefinementPrompt = Get-FireRefinementPrompt -Confidence $Confidence -ClaimText $ClaimText -ClaimLabel $ClaimLabel

        try {
            $RefResult = Invoke-AIApi `
                -Prompt      $RefinementPrompt `
                -SystemInstruction $SystemInstruction `
                -Model       $Model `
                -ApiKey      $ApiKey `
                -Temperature $Temperature `
                -MaxTokens   2048 `
                -ResponseSchema $RefinementSchema `
                -TimeoutSec  30

            if ($RefResult -and $RefResult.Text) {
                $RefText = $RefResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
                try {
                    $Refined = $RefText.Trim() | ConvertFrom-Json
                    $Upd = Update-FireClaimFromRefinement -Claim $Claim -Refined $Refined -ClaimText $ClaimText `
                        -Confidence $Confidence -Index $Index -ClaimLabel $ClaimLabel -ClaimIter $ClaimIter `
                        -MaxIterPerClaim $MaxIterPerClaim -Indent $Indent -Ctx $Ctx -DroppedIndices $DroppedIndices
                    $Confidence = $Upd.Confidence
                    $ClaimText = $Upd.ClaimText

                    if ($Upd.Dropped) { break }

                    # Log iteration result
                    if ($Upd.Changes.Count -gt 0) { $ChangeStr = "  ($($Upd.Changes -join ', '))" } else { $ChangeStr = '' }
                    if ($Confidence -ge $ConfidenceThreshold) {
                        Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: $([Math]::Round($BeforeConf, 2)) → $([Math]::Round($Confidence, 2)) ✓$ChangeStr"
                    }
                    else {
                        Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: $([Math]::Round($BeforeConf, 2)) → $([Math]::Round($Confidence, 2))$ChangeStr"
                    }
                }
                catch {
                    Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: parse failed — $($_.Exception.Message)"
                }
            }
            else {
                Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: empty API response"
            }
        }
        catch {
            Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: API error — $($_.Exception.Message)"
        }
    }

    return [PSCustomObject]@{ Confidence = $Confidence; ClaimText = $ClaimText; ClaimIter = $ClaimIter }
}

function Update-FireClaimFromRefinement {
    <#
    .SYNOPSIS
        Applies one refinement response to a claim: confidence, evidence_criteria, verification drop, text.
    .DESCRIPTION
        Mutates $Claim by reference and, on failed verification, $Ctx.ClaimsDroppedVerification and
        $DroppedIndices. Returns the updated Confidence/ClaimText, the list of change tags, and a
        Dropped flag. Preserves the t/4509 ordering: verified=false drops the candidate BEFORE any
        refined_claim text is applied.
    #>
    param(
        $Claim, $Refined, $ClaimText, $Confidence, $Index, $ClaimLabel, $ClaimIter,
        $MaxIterPerClaim, $Indent, $Ctx, $DroppedIndices
    )

    $Changes = [System.Collections.Generic.List[string]]::new()

    # Update confidence FIRST, in this scope, so no later statement can lose it. The original inline
    # loop assigned $Confidence (and $Claim.fire_confidence) before any of the evidence / verification
    # / refined_claim steps -- all of which can throw under Set-StrictMode on a malformed refinement
    # (e.g. evidence_criteria:null, or a refined_claim for a claim with no 'claim' property) -- and let
    # that throw land in the per-iteration catch, the confidence already applied. The whole point of
    # FIRE's loop is to STOP once confidence reaches threshold; losing it burns the full iteration
    # budget on paid API calls (t/3849 refactor).
    if ($Refined.PSObject.Properties['confidence']) {
        $Confidence = $Refined.confidence
        $Claim.fire_confidence = $Confidence
    }

    try {
        # Update evidence_criteria if refined
        if ($Refined.PSObject.Properties['evidence_criteria']) {
            $NewEC = $Refined.evidence_criteria
            # Track what changed
            if ($Claim.PSObject.Properties['evidence_criteria']) {
                Add-FireEvidenceChanges -OldEC $Claim.evidence_criteria -NewEC $NewEC -Changes $Changes
                $Claim.evidence_criteria = $NewEC
            }
            else {
                $Claim | Add-Member -NotePropertyName 'evidence_criteria' -NotePropertyValue $NewEC -Force
                $Changes.Add('evidence_criteria added')
            }
        }

        # t/4509: verified=false means the claim is NOT in the source — drop the
        # candidate entirely, before applying $Refined.refined_claim. The model's
        # "refined_claim" on a failed verification is typically its explanation of
        # the absence ("The source document does not contain...") rather than a
        # corrected claim, and writing that into $Claim.claim is exactly the bug:
        # a statement of absence persisted to the corpus as if it were a claim.
        if ($Refined.PSObject.Properties['verified'] -and -not $Refined.verified) {
            $Claim.fire_confidence = 0.1
            $Confidence = 0.1
            [void]$DroppedIndices.Add($Index)
            $Ctx.ClaimsDroppedVerification++
            Write-Warning "FIRE: $ClaimLabel failed verification against the source — dropped, not written as a factual claim."
            Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: verified=false → dropped"
            return [PSCustomObject]@{ Confidence = $Confidence; ClaimText = $ClaimText; Changes = $Changes; Dropped = $true }
        }

        # Update claim text if refined
        if ($Refined.PSObject.Properties['refined_claim'] -and $Refined.refined_claim -and $Refined.refined_claim -ne $ClaimText) {
            $Claim.claim = $Refined.refined_claim
            $ClaimText = $Refined.refined_claim
            $Changes.Add('refined')
        }
    }
    catch {
        # Any step above threw (malformed refinement). The inline loop absorbed exactly this in its
        # per-iteration catch with the confidence already applied; return it so the loop can exit on
        # it rather than re-spending the API budget (t/3849 refactor).
        Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: refinement partially applied -- $($_.Exception.Message)"
    }

    return [PSCustomObject]@{ Confidence = $Confidence; ClaimText = $ClaimText; Changes = $Changes; Dropped = $false }
}

function Add-FireEvidenceChanges {
    <#
    .SYNOPSIS
        Appends "field: old→new" change tags to $Changes for each evidence_criteria field that moved.
    #>
    param($OldEC, $NewEC, $Changes)

    foreach ($P in @('specificity', 'has_warrant', 'internally_consistent')) {
        if ($OldEC.PSObject.Properties[$P]) { $OldVal = $OldEC.$P } else { $OldVal = '?' }
        if ($NewEC.PSObject.Properties[$P]) { $NewVal = $NewEC.$P } else { $NewVal = '?' }
        if ("$OldVal" -ne "$NewVal") { $Changes.Add("${P}: $OldVal→$NewVal") }
    }
}

function Get-FireRefinementPrompt {
    <#
    .SYNOPSIS
        The low-confidence refinement prompt for one claim.
    #>
    param($Confidence, $ClaimText, $ClaimLabel)

    return @"
The following factual claim was extracted but has low confidence ($([Math]::Round($Confidence, 2))).
Please provide additional evidence assessment:

Claim: "$ClaimText"
Label: $ClaimLabel

Assess:
1. Is this claim actually stated in the source document, or was it inferred?
2. What specific text in the document supports this claim?
3. Re-evaluate the evidence_criteria: specificity (vague/qualified/precise), has_warrant (true/false), internally_consistent (true/false)

Return JSON: {"claim_label": "$ClaimLabel", "verified": true/false, "refined_claim": "...", "evidence_criteria": {...}, "confidence": 0.0-1.0}
"@
}

function Get-FireRefinementSchema {
    <#
    .SYNOPSIS
        The response schema for a refinement API call.
    #>
    return @{
        type       = 'object'
        properties = @{
            claim_label       = @{ type = 'string' }
            verified          = @{ type = 'boolean' }
            refined_claim     = @{ type = 'string' }
            evidence_criteria = @{
                type       = 'object'
                properties = @{
                    specificity           = @{ type = 'string'; enum = @('precise', 'qualified', 'vague') }
                    has_warrant           = @{ type = 'boolean' }
                    internally_consistent = @{ type = 'boolean' }
                }
                required   = @('specificity', 'has_warrant', 'internally_consistent')
            }
            confidence        = @{ type = 'number' }
        }
        required   = @('claim_label', 'verified', 'refined_claim', 'evidence_criteria', 'confidence')
    }
}

function Get-FireNodeDescriptions {
    <#
    .SYNOPSIS
        Builds { node id -> "label. description" } from $script:TaxonomyData for the Jaccard fallback.
    #>
    $NodeDescriptions = @{}
    if ($script:TaxonomyData -and $script:TaxonomyData.Count -gt 0) {
        foreach ($PovKey in $script:TaxonomyData.Keys) {
            $Entry = $script:TaxonomyData[$PovKey]
            if ($Entry -and $Entry.PSObject.Properties['nodes'] -and $Entry.nodes) {
                foreach ($Node in $Entry.nodes) {
                    $NodeDescriptions[$Node.id] = "$($Node.label). $(if ($Node.PSObject.Properties['description']) { $Node.description } else { '' })"
                }
            }
        }
    }
    return $NodeDescriptions
}

function Get-FireCosineSimilarity {
    <#
    .SYNOPSIS
        Cosine similarity of two equal-length numeric vectors; -1.0 when lengths differ.
    #>
    param($ClaimVec, $NodeVec)

    if ($ClaimVec.Count -ne $NodeVec.Count) { return -1.0 }
    $Dot = 0.0; $NA = 0.0; $NB = 0.0
    for ($j = 0; $j -lt $ClaimVec.Count; $j++) {
        $Dot += $ClaimVec[$j] * $NodeVec[$j]
        $NA  += $ClaimVec[$j] * $ClaimVec[$j]
        $NB  += $NodeVec[$j] * $NodeVec[$j]
    }
    $Denom = [Math]::Sqrt($NA) * [Math]::Sqrt($NB)
    $Sim = if ($Denom -gt 0) { $Dot / $Denom } else { 0.0 }
    return $Sim
}

function Invoke-FireDriftDetection {
    <#
    .SYNOPSIS
        Flags refined claims that drifted from their taxonomy node (similarity < 0.5).
    .DESCRIPTION
        Prefers Sentence-BERT embedding cosine similarity ($script:CachedEmbeddings +
        Get-TextEmbedding); falls back to Jaccard word overlap. Adds drift_warning to drifted
        claims by reference and returns the drift count. Behavior-preserving extraction of the
        gap-4.1 post-pass.
    #>
    param($Claims, $DriftChecks)

    $DriftCount = 0
    $NodeDescriptions = Get-FireNodeDescriptions

    $NodeEmbeddings = $script:CachedEmbeddings
    $UseEmbeddings = $false
    $ClaimEmbeddings = $null

    if ($NodeEmbeddings -and $NodeEmbeddings.Count -gt 0) {
        $Texts = @($DriftChecks | ForEach-Object { $_.RefinedText })
        $EmbIds = @(0..($DriftChecks.Count - 1) | ForEach-Object { $_.ToString() })
        $ClaimEmbeddings = Get-TextEmbedding -Texts $Texts -Ids $EmbIds
        if ($ClaimEmbeddings -and $ClaimEmbeddings.Count -gt 0) {
            $UseEmbeddings = $true
            Write-Verbose "FIRE drift check: using embedding similarity for $($DriftChecks.Count) refined claim(s)"
        }
    }

    if (-not $UseEmbeddings) {
        Write-Verbose "FIRE drift check: embeddings unavailable, using Jaccard word-overlap fallback"
    }

    for ($di = 0; $di -lt $DriftChecks.Count; $di++) {
        $DC = $DriftChecks[$di]
        $Sim = -1.0

        if ($UseEmbeddings -and $ClaimEmbeddings.ContainsKey($di.ToString()) -and $NodeEmbeddings.ContainsKey($DC.TaxonomyNodeId)) {
            $Sim = Get-FireCosineSimilarity -ClaimVec $ClaimEmbeddings[$di.ToString()] -NodeVec $NodeEmbeddings[$DC.TaxonomyNodeId]
        }
        elseif ($NodeDescriptions.ContainsKey($DC.TaxonomyNodeId)) {
            $ClaimTokens = Get-WordTokens $DC.RefinedText
            $NodeTokens = Get-WordTokens $NodeDescriptions[$DC.TaxonomyNodeId]
            $Sim = Get-JaccardSimilarity $ClaimTokens $NodeTokens
        }

        if ($Sim -ge 0 -and $Sim -lt 0.5) {
            $DriftCount++
            $Claims[$DC.Index] | Add-Member -NotePropertyName 'drift_warning' -NotePropertyValue $true -Force
            Write-Warning "FIRE: $($DC.ClaimLabel) may have drifted from $($DC.TaxonomyNodeId) after refinement (similarity=$([Math]::Round($Sim, 3)))"
        }
    }

    return $DriftCount
}

function Remove-FireDroppedClaims {
    <#
    .SYNOPSIS
        Returns the claims array with the failed-verification indices (t/4509) removed.
    #>
    param($Claims, $DroppedIndices)

    $KeptClaims = [System.Collections.Generic.List[object]]::new()
    for ($k = 0; $k -lt $Claims.Count; $k++) {
        if (-not $DroppedIndices.Contains($k)) { $KeptClaims.Add($Claims[$k]) }
    }
    return , $KeptClaims.ToArray()
}

function New-FireStats {
    <#
    .SYNOPSIS
        Invoke-IterativeExtraction's FireStats hashtable, in the one shape every return path shares.
    .DESCRIPTION
        New-SummaryModelInfo and Get-POVSummaryModelInfo read claims_total, claims_confident,
        claims_iterated and termination_reason, which throws under StrictMode on a hashtable without
        the key. The parse-failure path used to omit them, and the no-claims path omitted
        claims_drifted and guardrails (t/4172). The claim counts default to 0: a path that parsed no
        claims processed none.
    #>
    param(
        [double]$ConfidenceThreshold, [int]$TotalIterations = 0, [int]$TotalApiCalls = 0,
        [int]$ClaimsTotal = 0, [int]$ClaimsConfident = 0, [int]$ClaimsIterated = 0, [int]$ClaimsDrifted = 0,
        [int]$ClaimsDroppedVerification = 0,
        [double]$ElapsedSeconds = 0, [string]$TerminationReason,
        [int]$MaxIterPerClaim, [int]$MaxIterPerDoc, [int]$WallClockSeconds, [int]$MaxApiCalls
    )
    @{
        mode                        = 'fire'
        confidence_threshold        = $ConfidenceThreshold
        total_iterations            = $TotalIterations
        total_api_calls             = $TotalApiCalls
        claims_total                = $ClaimsTotal
        claims_confident             = $ClaimsConfident
        claims_iterated             = $ClaimsIterated
        claims_drifted              = $ClaimsDrifted
        claims_dropped_verification = $ClaimsDroppedVerification
        elapsed_seconds             = [Math]::Round($ElapsedSeconds, 1)
        termination_reason          = $TerminationReason
        guardrails                  = [ordered]@{
            max_iter_per_claim = $MaxIterPerClaim
            max_iter_per_doc   = $MaxIterPerDoc
            wall_clock_seconds = $WallClockSeconds
            max_api_calls      = $MaxApiCalls
        }
    }
}
