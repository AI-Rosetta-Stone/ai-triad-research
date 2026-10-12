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
    $TotalIter = 0
    $TotalApiCalls = 0

    # ── Phase 1: Initial extraction (same as single-shot) ─────────────────────
    Write-Verbose "FIRE Phase 1: Initial extraction"
    Write-Verbose "  Model: $Model | Temperature: $Temperature | MaxTokens: $MaxTokens"
    Write-Verbose "  Guardrails: max $MaxIterPerClaim iter/claim, $MaxIterPerDoc iter/doc, ${WallClockSeconds}s wall-clock, $MaxApiCalls API calls"
    Write-Verbose "  Confidence threshold: $ConfidenceThreshold"
    $TotalApiCalls++
    Write-Verbose "  API call #$TotalApiCalls — initial extraction starting..."

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

    $CleanedText = $InitialResult.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
    $Summary = $null
    try {
        $Summary = $CleanedText.Trim() | ConvertFrom-Json
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
            }
            catch {
                Write-Verbose "  Phase 1 — repair also failed: $($_.Exception.Message)"
            }
        }
        if ($null -eq $Summary) {
            Write-Verbose "  Phase 1 FAILED — JSON parse error: $ParseErr"
            return @{
                Summary    = $null
                RawText    = $InitialResult.Text
                Backend    = $InitialResult.Backend
                FireStats  = @{
                    mode = 'fire'; phase1_only = $true; parse_failed = $true
                    confidence_threshold = $ConfidenceThreshold
                    total_iterations = 0; total_api_calls = 1
                    elapsed_seconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
                }
            }
        }
    }

    # ── Phase 2-3: Assess confidence and iterate on uncertain claims ────────
    if (-not ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims)) {
        Write-Verbose "  No factual_claims in response — nothing to iterate on"
        # No claims to iterate on — return as-is
        return @{
            Summary   = $Summary
            RawText   = $InitialResult.Text
            Backend   = $InitialResult.Backend
            FireStats = @{
                mode = 'fire'; total_iterations = 0; total_api_calls = 1
                confidence_threshold = $ConfidenceThreshold
                claims_confident = 0; claims_iterated = 0; claims_total = 0
                elapsed_seconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
                termination_reason = 'no_claims'
            }
        }
    }

    $Claims = if ($Summary.PSObject.Properties['factual_claims']) { @($Summary.factual_claims) } else { @() }
    $ClaimsConfident = 0
    $ClaimsIterated = 0
    $ClaimsExhausted = 0
    $TerminationReason = 'all_confident'

    $DriftChecks = [System.Collections.Generic.List[PSObject]]::new()

    Write-Verbose "FIRE Phase 2-3: Assessing $($Claims.Count) claims..."

    # Compute column alignment from the longest claim label
    # Layout: "FIRE: <label>" padded, then confidence + status
    $LabelMaxLen = 0
    foreach ($c in $Claims) {
        if ($c.PSObject.Properties['claim_label']) { $lbl = $c.claim_label } else { $lbl = 'claim-?' }
        if ($lbl.Length -gt $LabelMaxLen) { $LabelMaxLen = $lbl.Length }
    }
    # "FIRE: " (6) + label + padding (2)
    $ConfColumn = 6 + $LabelMaxLen + 2
    $Indent = ' ' * 6   # Align sub-lines under "FIRE: "

    # ── Phase 3: Assess and iterate on uncertain claims ───────────────────────
    for ($i = 0; $i -lt $Claims.Count; $i++) {
        $Claim = $Claims[$i]

        # Check termination guardrails
        if ($Stopwatch.Elapsed.TotalSeconds -ge $WallClockSeconds) {
            $TerminationReason = "wall_clock_exceeded ($WallClockSeconds s)"
            Write-Verbose "FIRE: GUARDRAIL — wall-clock ${WallClockSeconds}s reached ($i/$($Claims.Count) claims processed)"
            break
        }
        if ($TotalIter -ge $MaxIterPerDoc) {
            $TerminationReason = "max_doc_iterations ($MaxIterPerDoc)"
            Write-Verbose "FIRE: GUARDRAIL — doc iteration limit $MaxIterPerDoc reached ($i/$($Claims.Count) claims processed)"
            break
        }
        if ($TotalApiCalls -ge $MaxApiCalls) {
            $TerminationReason = "api_budget_exceeded ($MaxApiCalls)"
            Write-Verbose "FIRE: GUARDRAIL — API call budget $MaxApiCalls reached ($i/$($Claims.Count) claims processed)"
            break
        }

        if ($Claim.PSObject.Properties['claim_label']) { $ClaimLabel = $Claim.claim_label } else { $ClaimLabel = "claim-$i" }
        if ($Claim.PSObject.Properties['claim']) { $ClaimText = $Claim.claim } else { $ClaimText = '' }
        if ($ClaimText.Length -gt 70) { $ClaimShort = $ClaimText.Substring(0, 70) + '...' } else { $ClaimShort = $ClaimText }

        # Extract evidence_criteria if present to estimate confidence
        $Confidence = 0.5  # Default: uncertain
        if ($Claim.PSObject.Properties['evidence_criteria']) {
            $EC = $Claim.evidence_criteria
            $Conf = 0.3
            if ($EC.PSObject.Properties['specificity'] -and $EC.specificity -eq 'precise') { $Conf += 0.2 }
            if ($EC.PSObject.Properties['has_warrant'] -and $EC.has_warrant) { $Conf += 0.2 }
            if ($EC.PSObject.Properties['internally_consistent'] -and $EC.internally_consistent) { $Conf += 0.1 }
            $Confidence = $Conf
        }

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
            $ClaimsConfident++
            Write-Verbose "${LabelPadded}${ConfStr} ✓"
            continue
        }

        # ── Uncertain claim: iterate ──────────────────────────────────────
        Write-Verbose "${LabelPadded}${ConfStr} → iterating"
        Write-Verbose "${Indent}`"$ClaimShort`""
        $ClaimIter = 0
        $OriginalText = $ClaimText

        while ($Confidence -lt $ConfidenceThreshold -and $ClaimIter -lt $MaxIterPerClaim) {
            if ($Stopwatch.Elapsed.TotalSeconds -ge $WallClockSeconds) { $TerminationReason = 'wall_clock_exceeded'; Write-Verbose "${Indent}GUARDRAIL — wall-clock in iteration loop"; break }
            if ($TotalIter -ge $MaxIterPerDoc) { $TerminationReason = 'max_doc_iterations'; Write-Verbose "${Indent}GUARDRAIL — doc iterations in iteration loop"; break }
            if ($TotalApiCalls -ge $MaxApiCalls) { $TerminationReason = 'api_budget_exceeded'; Write-Verbose "${Indent}GUARDRAIL — API budget in iteration loop"; break }

            $ClaimIter++
            $TotalIter++
            $TotalApiCalls++
            $BeforeConf = $Confidence

            $RefinementPrompt = @"
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

            $RefinementSchema = @{
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
                        $Changes = [System.Collections.Generic.List[string]]::new()

                        # Update confidence
                        if ($Refined.PSObject.Properties['confidence']) {
                            $Confidence = $Refined.confidence
                            $Claim.fire_confidence = $Confidence
                        }

                        # Update evidence_criteria if refined
                        if ($Refined.PSObject.Properties['evidence_criteria']) {
                            $NewEC = $Refined.evidence_criteria
                            # Track what changed
                            if ($Claim.PSObject.Properties['evidence_criteria']) {
                                $OldEC = $Claim.evidence_criteria
                                foreach ($P in @('specificity', 'has_warrant', 'internally_consistent')) {
                                    if ($OldEC.PSObject.Properties[$P]) { $OldVal = $OldEC.$P } else { $OldVal = '?' }
                                    if ($NewEC.PSObject.Properties[$P]) { $NewVal = $NewEC.$P } else { $NewVal = '?' }
                                    if ("$OldVal" -ne "$NewVal") { $Changes.Add("${P}: $OldVal→$NewVal") }
                                }
                                $Claim.evidence_criteria = $NewEC
                            }
                            else {
                                $Claim | Add-Member -NotePropertyName 'evidence_criteria' -NotePropertyValue $NewEC -Force
                                $Changes.Add('evidence_criteria added')
                            }
                        }

                        # Update claim text if refined
                        if ($Refined.PSObject.Properties['refined_claim'] -and $Refined.refined_claim -and $Refined.refined_claim -ne $ClaimText) {
                            $Claim.claim = $Refined.refined_claim
                            $ClaimText = $Refined.refined_claim
                            $Changes.Add('refined')
                        }

                        # If verified=false, mark as low confidence and stop
                        if ($Refined.PSObject.Properties['verified'] -and -not $Refined.verified) {
                            $Claim.fire_confidence = 0.1
                            $Confidence = 0.1
                            Write-Verbose "${Indent}iter $ClaimIter/$MaxIterPerClaim`: verified=false → 0.10, stopped"
                            break
                        }

                        # Log iteration result
                        if ($Changes.Count -gt 0) { $ChangeStr = "  ($($Changes -join ', '))" } else { $ChangeStr = '' }
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

        # Log claim text change if it was refined
        if ($ClaimText -ne $OriginalText) {
            if ($ClaimText.Length -gt 70) { $NewShort = $ClaimText.Substring(0, 70) + '...' } else { $NewShort = $ClaimText }
            Write-Verbose "${Indent}→ `"$NewShort`""

            # Queue drift check if claim has a taxonomy mapping (gap 4.1)
            if ($Claim.PSObject.Properties['taxonomy_node_id'] -and $Claim.taxonomy_node_id) {
                $null = $DriftChecks.Add([PSCustomObject]@{
                    Index          = $i
                    ClaimLabel     = $ClaimLabel
                    RefinedText    = $ClaimText
                    TaxonomyNodeId = $Claim.taxonomy_node_id
                })
            }
        }

        # Warn if claim exhausted iterations without reaching threshold
        if ($Confidence -lt $ConfidenceThreshold -and $ClaimIter -ge $MaxIterPerClaim) {
            $ClaimsExhausted++
            Write-Warning "FIRE: $ClaimLabel exhausted $MaxIterPerClaim iterations (final=$([Math]::Round($Confidence, 2)), threshold=$ConfidenceThreshold)"
        }

        $ClaimsIterated++
    }

    $Stopwatch.Stop()

    # ── Post-pass: semantic drift detection for refined claims (gap 4.1) ─────
    $DriftCount = 0
    if ($DriftChecks.Count -gt 0) {
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
                $ClaimVec = $ClaimEmbeddings[$di.ToString()]
                $NodeVec = $NodeEmbeddings[$DC.TaxonomyNodeId]
                if ($ClaimVec.Count -eq $NodeVec.Count) {
                    $Dot = 0.0; $NA = 0.0; $NB = 0.0
                    for ($j = 0; $j -lt $ClaimVec.Count; $j++) {
                        $Dot += $ClaimVec[$j] * $NodeVec[$j]
                        $NA  += $ClaimVec[$j] * $ClaimVec[$j]
                        $NB  += $NodeVec[$j] * $NodeVec[$j]
                    }
                    $Denom = [Math]::Sqrt($NA) * [Math]::Sqrt($NB)
                    $Sim = if ($Denom -gt 0) { $Dot / $Denom } else { 0.0 }
                }
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
    }

    # ── Final summary log ─────────────────────────────────────────────────────
    Write-Verbose "FIRE complete: $($Claims.Count) claims | $ClaimsConfident confident | $ClaimsIterated iterated | $TotalIter total iterations | $TotalApiCalls API calls | $([Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1))s"
    Write-Verbose "  Termination: $TerminationReason"
    Write-Verbose "  Guardrails: max_iter_per_claim=$MaxIterPerClaim, max_iter_per_doc=$MaxIterPerDoc, wall_clock=${WallClockSeconds}s, max_api_calls=$MaxApiCalls"
    if ($ClaimsExhausted -gt 0) {
        Write-Verbose "  WARNING: $ClaimsExhausted claim(s) exhausted iteration budget without reaching threshold"
    }
    if ($DriftCount -gt 0) {
        Write-Verbose "  WARNING: $DriftCount claim(s) flagged for semantic drift after refinement"
    }

    # ── Return enriched summary ───────────────────────────────────────────────
    return @{
        Summary   = $Summary
        RawText   = $InitialResult.Text
        Backend   = $InitialResult.Backend
        FireStats = @{
            mode                = 'fire'
            confidence_threshold = $ConfidenceThreshold
            total_iterations    = $TotalIter
            total_api_calls     = $TotalApiCalls
            claims_total        = $Claims.Count
            claims_confident    = $ClaimsConfident
            claims_iterated     = $ClaimsIterated
            claims_drifted      = $DriftCount
            elapsed_seconds     = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
            termination_reason  = $TerminationReason
            guardrails          = [ordered]@{
                max_iter_per_claim = $MaxIterPerClaim
                max_iter_per_doc   = $MaxIterPerDoc
                wall_clock_seconds = $WallClockSeconds
                max_api_calls      = $MaxApiCalls
            }
        }
    }
}
