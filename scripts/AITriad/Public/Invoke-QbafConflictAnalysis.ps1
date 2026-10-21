# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-QbafConflictAnalysis {
    <#
    .SYNOPSIS
        Analyzes factual claims across summaries using QBAF argumentation strength.
    .DESCRIPTION
        Reads factual_claims from summaries and detects attack/support relations
        between claims across documents via a two-stage pass (t/1403):

          Stage A (fast, deterministic): claims that share ≥1 linked_taxonomy_nodes
                 and take opposing/aligned doc_position values become edges.
          Stage B (embedding + LLM-confirmed): cross-doc claim pairs whose
                 embeddings have cosine similarity ≥ -Threshold that Stage A
                 did NOT already claim are LLM-confirmed via
                 enrichment.qbaf-pair-confirm; only pairs the confirmer agrees
                 are 'attacks' or 'supports' with confidence ≥ 0.6 add edges.

        Stage B increases recall for claims that address the same underlying
        question but were mapped to different (or no) taxonomy nodes — the
        recall gap that motivated t/1403. Falls back gracefully to
        Stage-A-only when the embedding subsystem (Python + sentence-
        transformers) or the LLM subsystem is unavailable — total edge count
        is monotonic across configurations.

        Computes QBAF acceptability strengths via the DF-QuAD engine and
        outputs QBAF-augmented conflict analysis. Runs parallel to
        Find-Conflict (not a replacement yet). Produces richer output with
        computed_strength, attack_type, and resolution analysis.
    .PARAMETER DocId
        Analyze claims from a single document. If omitted, analyzes all summaries.
    .PARAMETER Threshold
        Cosine similarity threshold for Stage-B embedding clustering. Default: 0.85.
        Only pairs with cosine ≥ Threshold are sent to the LLM confirmer.
    .PARAMETER OutputDir
        Output directory for QBAF conflict files. Default: ai-triad-data/qbaf-conflicts/
    .PARAMETER DryRun
        Report what would be analyzed without writing files.
    .PARAMETER PassThru
        Return the analysis results for piping.
    .PARAMETER SkipDirectionalGate
        Disable the Stage-A directional gate (t/2745, shared engine t/2751). By
        default a shared node + equal doc_position is NOT trusted as a support
        edge — the pair is judged on the actual claim↔claim direction via the
        POV-framed NLI engine (opposition-only, CL t/2751#3): contradict→attacks;
        anything else keeps the support edge. This switch restores the legacy
        polarity-blind behavior (equal doc_position ⇒ supports) and can emit
        false support edges between opposing claims.
    .PARAMETER DirectionalTauContra
        Contradiction margin floor forwarded to the shared engine to flip a
        support candidate to an attack. Default 1.0 (FINAL, CL t/2751#3;
        provenance in the metric-provenance-register).
    .EXAMPLE
        Invoke-QbafConflictAnalysis -DocId 'ai-safety-debate-2026'
    .EXAMPLE
        Invoke-QbafConflictAnalysis -DryRun
    .LINK
        Show-AITriadHelp
    .LINK
        Find-GraphPath
    .LINK
        Find-Conflict
    .LINK
        Invoke-GraphQuery
    .LINK
        Invoke-CypherQuery
    .LINK
        Show-GraphOverview
    .LINK
        Export-TaxonomyToGraph
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$DocId = '',

        [ValidateRange(0.5, 1.0)]
        [double]$Threshold = 0.85,

        [Alias('OutputPath')]
        [string]$OutputDir = '',

        [switch]$DryRun,

        [switch]$PassThru,

        [switch]$SkipDirectionalGate,

        [ValidateRange(0.0, 1000.0)]
        [double]$DirectionalTauContra = 1.0
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SummariesDir = Get-SummariesDir
    $DataRoot     = Get-DataRoot

    if ([string]::IsNullOrWhiteSpace($OutputDir)) {
        $OutputDir = Join-Path $DataRoot 'qbaf-conflicts'
    }
    if (-not (Test-Path $OutputDir) -and -not $DryRun) {
        $null = New-Item -Path $OutputDir -ItemType Directory -Force
    }

    Write-Step 'QBAF Conflict Analysis'

    # ── Step 1: Load claims from summaries ────────────────────────────────────
    Write-Step 'Loading factual claims'

    if ($DocId) {
        $Path = Join-Path $SummariesDir "$DocId.json"
        if (-not (Test-Path $Path)) {
            New-ActionableError -Goal "load summary for $DocId" `
                -Problem "Summary file not found: $Path" `
                -Location 'Invoke-QbafConflictAnalysis' `
                -NextSteps @("Verify doc ID: $DocId", 'Run Invoke-POVSummary first') -Throw
        }
        $SummaryFiles = @(Get-Item $Path)
    }
    $Resolution = $null
    $AllSummaryFiles = @()
    if (-not $DocId) {
        $AllSummaryFiles = @(Get-ChildItem -Path $SummariesDir -Filter '*.json' -File | Sort-Object Name)
        # duplicate_of (t/4337): a marked copy isn't read as a document of its own. Its distinct claims
        # are added after the main pass under the canonical's DocId (spec 7.4), so the same-document
        # skip below also keeps a doc from "conflicting" with its own copy (spec 7.5).
        $Resolution = Get-DefaultSourceResolution -Caller 'Invoke-QbafConflictAnalysis'
        $SummaryFiles = @(Select-SelectableSummaryFile -Files $AllSummaryFiles -Resolution $Resolution)
    }

    $AllClaims = [System.Collections.Generic.List[PSObject]]::new()
    $Counter = @{ N = 0 }   # the claim index; a hashtable so the loader scriptblock can advance it
    $GroupKeys = @{}   # canonical doc id -> de-dup keys of the claims already loaded for its group
    $Canonicals = if ($Resolution) { [System.Collections.Generic.HashSet[string]]::new([string[]]@($Resolution.Resolved.Values), [System.StringComparer]::Ordinal) } else { $null }

    # Loads one summary's factual claims under $ClaimDocId. With $Via (a marked copy's exact id), a
    # claim near-equal to one already loaded for the group is skipped.
    $AddClaims = {
        param($Summary, [string]$ClaimDocId, [string]$Via)
        # Guarded (t/4010): a bare dot-access on an absent key throws under StrictMode.
        if (-not ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims)) { return }
        $Track = $Via -or ($Canonicals -and $Canonicals.Contains($ClaimDocId))
        if ($Track -and -not $GroupKeys.ContainsKey($ClaimDocId)) { $GroupKeys[$ClaimDocId] = [System.Collections.Generic.List[string]]::new() }

        foreach ($Claim in @($Summary.factual_claims)) {
            if ($Claim.PSObject.Properties['claim']) { $ClaimText = $Claim.claim } else { $ClaimText = '' }
            if ($Track) {
                $Key = ConvertTo-EvidenceKey -Quote ([string]$ClaimText)
                if ($Via) {
                    $Dup = $false
                    foreach ($K in $GroupKeys[$ClaimDocId]) { if (Test-EvidenceNearEqual -A $Key -B $K) { $Dup = $true; break } }
                    if ($Dup) { continue }
                }
                $GroupKeys[$ClaimDocId].Add($Key)
            }
            $Counter.N++
            $ClaimIdx = $Counter.N
            if ($Claim.PSObject.Properties['claim_label']) { $Label = $Claim.claim_label } else { $Label = "claim-$ClaimIdx" }
            if ($Claim.PSObject.Properties['linked_taxonomy_nodes']) { $Nodes = @($Claim.linked_taxonomy_nodes) } else { $Nodes = @() }
            if ($Claim.PSObject.Properties['doc_position']) { $Position = $Claim.doc_position } else { $Position = 'neutral' }

            # Determine BDI category from linked nodes
            $Category = 'Beliefs'  # Default for factual claims
            if ($Nodes.Count -gt 0) {
                $First = $Nodes[0]
                if ($First -match '-desires-') { $Category = 'Desires' }
                elseif ($First -match '-intentions-') { $Category = 'Intentions' }
            }

            # Extract evidence_criteria if present (from Q-11 prompt changes)
            if ($Claim.PSObject.Properties['evidence_criteria']) { $EvidenceCriteria = $Claim.evidence_criteria } else { $EvidenceCriteria = $null }

            # Compute base_strength from evidence_criteria or use default
            $BaseStrength = 0.5  # Default (Beliefs placeholder for hybrid scoring)
            if ($EvidenceCriteria -and $Category -ne 'Beliefs') {
                $BaseStrength = Get-BaseStrengthFromCriteria -Criteria $EvidenceCriteria -Category $Category
            }

            $AllClaims.Add([PSCustomObject]@{
                Id            = "qc-$ClaimIdx"
                DocId         = $ClaimDocId
                Via           = if ($Via) { $Via } else { $null }   # provenance only (spec 7.6)
                Label         = $Label
                Text          = $ClaimText
                Category      = $Category
                Position      = $Position
                Nodes         = $Nodes
                BaseStrength  = $BaseStrength
                Criteria      = $EvidenceCriteria
            })
        }
    }

    foreach ($File in $SummaryFiles) {
        try {
            $Summary = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        }
        catch { continue }
        & $AddClaims $Summary $File.BaseName $null
    }
    $UnionCount = $AllClaims.Count
    if ($Resolution) {
        foreach ($Copy in @(Get-MarkedCopySummary -Files $AllSummaryFiles -Resolution $Resolution -Caller 'Invoke-QbafConflictAnalysis')) {
            & $AddClaims $Copy.Summary $Copy.CanonicalId $Copy.CopyId
        }
    }
    $UnionCount = $AllClaims.Count - $UnionCount
    if ($UnionCount -gt 0) { Write-Verbose "Invoke-QbafConflictAnalysis: $UnionCount distinct claim(s) from marked copies added under their canonical (spec 7.4)." }

    Write-OK "Loaded $($AllClaims.Count) claims from $($SummaryFiles.Count) summaries"

    if ($AllClaims.Count -lt 2) {
        Write-Warn 'Need at least 2 claims for conflict analysis'
        return
    }

    # ── Step 1.5: Embed all claim texts for cross-doc similarity clustering (t/1403) ──
    # Populates $ClaimEmbeddings for the embedding-similar pass in Step 2. Empty
    # texts are skipped. If the embedding subsystem is unavailable (no Python,
    # no sentence-transformers), $ClaimEmbeddings stays $null and Step 2 silently
    # falls back to node-overlap-only — no crash, no silent quality degradation
    # beyond what the existing code already had.
    Write-Step 'Embedding claim texts for cross-doc clustering'
    $ClaimEmbeddings = $null
    $EmbedTexts = @($AllClaims | ForEach-Object { $_.Text })
    $EmbedIds   = @($AllClaims | ForEach-Object { $_.Id })
    try {
        $ClaimEmbeddings = Get-TextEmbedding -Texts $EmbedTexts -Ids $EmbedIds
        if ($null -eq $ClaimEmbeddings -or $ClaimEmbeddings.Count -eq 0) {
            Write-Warn 'Embedding subsystem unavailable — falling back to node-overlap-only relation detection'
            $ClaimEmbeddings = $null
        }
        else {
            Write-OK "Embedded $($ClaimEmbeddings.Count) claim texts"
        }
    }
    catch {
        Write-Warn "Embedding step failed: $($_.Exception.Message) — falling back to node-overlap-only"
        $ClaimEmbeddings = $null
    }

    # ── Step 2: Two-stage relation detection ───────────────────────────────────
    # Stage A: node-overlap edges (existing logic, unchanged)
    # Stage B: embedding-similar pairs above $Threshold that Stage A didn't
    #          already claim → LLM-confirm each with enrichment.qbaf-pair-confirm
    #          (t/1403). Adds attacks/supports only when the confirmer agrees
    #          with confidence ≥ ConfidenceFloor.
    # Monotonicity: Stage B's candidate set is disjoint from Stage A's edge
    # set, so total edge count is >= node-overlap-only count.
    Write-Step 'Detecting claim relations (Stage A: node overlap)'

    $Edges = [System.Collections.Generic.List[PSObject]]::new()
    # Track pair keys claimed by Stage A so Stage B can skip them.
    $StageAPairs = [System.Collections.Generic.HashSet[string]]::new()

    # Support candidates deferred to the directional gate (V2, t/2745). A shared
    # taxonomy node plus equal doc_position does NOT establish that two DIFFERENT
    # claim texts agree — doc_position is each doc's stance toward its OWN text and
    # is not commensurable across claims. Collect these and reconcile them below
    # with an actual claim↔claim direction judgment.
    $SupportCandidates = [System.Collections.Generic.List[PSObject]]::new()

    # Claims that share taxonomy nodes but take opposing positions are attacks
    for ($i = 0; $i -lt $AllClaims.Count; $i++) {
        for ($j = $i + 1; $j -lt $AllClaims.Count; $j++) {
            $A = $AllClaims[$i]; $B = $AllClaims[$j]
            if ($A.DocId -eq $B.DocId) { continue }  # Same document — skip

            # Check taxonomy node overlap
            $Overlap = @($A.Nodes | Where-Object { $_ -in $B.Nodes })
            if ($Overlap.Count -eq 0) { continue }

            # Determine relation from doc_position
            $IsConflict = ($A.Position -eq 'supports' -and $B.Position -eq 'disputes') -or
                          ($A.Position -eq 'disputes' -and $B.Position -eq 'supports')
            $IsSupport = ($A.Position -eq $B.Position) -and ($A.Position -in @('supports', 'disputes'))

            if ($IsConflict) {
                # Opposing doc_positions on a shared node — a genuine directional
                # signal (rebuttal), kept as-is.
                $Edges.Add([PSCustomObject]@{
                    Source     = $A.Id
                    Target     = $B.Id
                    Type       = 'attacks'
                    Weight     = 0.7
                    AttackType = 'rebut'
                    Source_    = 'node-overlap'
                })
                [void]$StageAPairs.Add("$($A.Id)|$($B.Id)")
            }
            elseif ($IsSupport) {
                if ($SkipDirectionalGate) {
                    # Legacy polarity-blind behavior (gate disabled).
                    $Edges.Add([PSCustomObject]@{
                        Source     = $A.Id
                        Target     = $B.Id
                        Type       = 'supports'
                        Weight     = 0.5
                        AttackType = $null
                        Source_    = 'node-overlap'
                    })
                    [void]$StageAPairs.Add("$($A.Id)|$($B.Id)")
                }
                else {
                    $SupportCandidates.Add([PSCustomObject]@{ A = $A; B = $B })
                }
            }
        }
    }

    # ── Stage A directional reconciliation (V2, shared gate t/2751) ──────────
    # Opposition-only (CL ruling t/2751#3). Judge each equal-doc_position support
    # candidate on the actual claim↔claim direction via the shared POV-framed NLI
    # engine. Only 'opposes' is actionable — the two claims genuinely contradict,
    # so emit an ATTACK instead of the (bogus) support. Everything else
    # ('agrees'/'unrelated'/'unresolved') keeps the provisional supports edge:
    # the gate rates a true agreement 'unrelated', not 'agrees', and its job is to
    # catch the inversion, not to confirm support.
    $StageADirCounts = [ordered]@{ opposes = 0; agrees = 0; unrelated = 0; unresolved = 0 }
    if (-not $SkipDirectionalGate -and $SupportCandidates.Count -gt 0) {
        $dirPairs = [System.Collections.Generic.List[PSObject]]::new()
        for ($ci = 0; $ci -lt $SupportCandidates.Count; $ci++) {
            $cand = $SupportCandidates[$ci]
            $dirPairs.Add([PSCustomObject]@{ Id = $ci; ClaimProp = [string]$cand.A.Text; NodeProp = [string]$cand.B.Text })
        }
        $dirVerdicts = Test-DirectionalAgreement -Pair @($dirPairs) -TauContra $DirectionalTauContra
        $dirByIdx = @{}
        foreach ($v in @($dirVerdicts)) { $dirByIdx[[int]$v.Id] = $v }

        for ($ci = 0; $ci -lt $SupportCandidates.Count; $ci++) {
            $cand = $SupportCandidates[$ci]
            $A = $cand.A; $B = $cand.B
            $dir = if ($dirByIdx.ContainsKey($ci)) { [string]$dirByIdx[$ci].Direction } else { 'unresolved' }
            if ($StageADirCounts.Contains($dir)) { $StageADirCounts[$dir]++ }
            if ($dir -eq 'opposes') {
                $Edges.Add([PSCustomObject]@{
                    Source = $A.Id; Target = $B.Id; Type = 'attacks'
                    Weight = 0.7; AttackType = 'rebut'; Source_ = 'node-overlap+nli'
                })
            }
            else {
                # No opposition detected → keep the provisional support edge.
                $Edges.Add([PSCustomObject]@{
                    Source = $A.Id; Target = $B.Id; Type = 'supports'
                    Weight = 0.5; AttackType = $null; Source_ = 'node-overlap+nli'
                })
            }
            [void]$StageAPairs.Add("$($A.Id)|$($B.Id)")
        }
        # Per-run verdict counts (TL GV condition t/2751#4 #1) — mandatory metric
        # and the detector for a silently-degraded engine (all-unresolved = down).
        $cnt = ($StageADirCounts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '
        Write-OK "Stage A directional gate: $($SupportCandidates.Count) support candidates → [$cnt] ($($StageADirCounts.opposes) flipped to attacks)"
    }

    $StageAEdgeCount = $Edges.Count
    Write-OK "Stage A: $StageAEdgeCount node-overlap edges"

    # ── Stage B: embedding-similar cross-doc pairs, LLM-confirmed ─────────────
    $ConfidenceFloor = 0.6
    $StageBCandidates = 0
    $StageBConfirmed  = 0
    $StageBRejected   = 0
    $StageBLlmErrors  = 0
    if ($null -ne $ClaimEmbeddings) {
        Write-Step "Detecting claim relations (Stage B: embedding cosine >= $Threshold)"

        for ($i = 0; $i -lt $AllClaims.Count; $i++) {
            for ($j = $i + 1; $j -lt $AllClaims.Count; $j++) {
                $A = $AllClaims[$i]; $B = $AllClaims[$j]
                if ($A.DocId -eq $B.DocId) { continue }
                if ($StageAPairs.Contains("$($A.Id)|$($B.Id)")) { continue }

                # Both sides must have a vector (empty text -> no vector)
                if (-not $ClaimEmbeddings.ContainsKey($A.Id)) { continue }
                if (-not $ClaimEmbeddings.ContainsKey($B.Id)) { continue }
                $VecA = [double[]]@($ClaimEmbeddings[$A.Id])
                $VecB = [double[]]@($ClaimEmbeddings[$B.Id])
                if ($VecA.Count -eq 0 -or $VecB.Count -eq 0) { continue }
                if ($VecA.Count -ne $VecB.Count) { continue }

                # Cosine similarity (both vectors are L2-normalized on emit)
                $Dot = 0.0
                for ($d = 0; $d -lt $VecA.Count; $d++) { $Dot += $VecA[$d] * $VecB[$d] }
                if ($Dot -lt $Threshold) { continue }

                $StageBCandidates++

                # LLM-confirm this specific pair. Failures are non-fatal — a rejected
                # or errored candidate just doesn't add an edge, and Stage A output
                # is preserved. Monotonicity holds.
                try {
                    $Rendered = Get-Prompt -Name 'qbaf-pair-confirm' -Replacements @{
                        a_pov  = $A.DocId
                        a_text = $A.Text
                        b_pov  = $B.DocId
                        b_text = $B.Text
                    }
                    $Response = Invoke-AIByUsage -UsageId 'enrichment.qbaf-pair-confirm' `
                        -Values @{ prompt = $Rendered } -ErrorAction Stop
                    if (-not $Response -or -not $Response.Text) {
                        $StageBLlmErrors++
                        continue
                    }
                    $Parsed = $Response.Text | ConvertFrom-Json -ErrorAction Stop
                    if (-not ($Parsed.PSObject.Properties['relation'] -and $Parsed.PSObject.Properties['confidence'])) {
                        $StageBLlmErrors++
                        continue
                    }
                    $Relation = [string]$Parsed.relation
                    $Conf     = [double]$Parsed.confidence
                    if (($Relation -ne 'attacks' -and $Relation -ne 'supports') -or $Conf -lt $ConfidenceFloor) {
                        $StageBRejected++
                        continue
                    }

                    if ($Relation -eq 'attacks') {
                        $Edges.Add([PSCustomObject]@{
                            Source     = $A.Id
                            Target     = $B.Id
                            Type       = 'attacks'
                            Weight     = [Math]::Round($Conf, 4)
                            AttackType = 'rebut'
                            Source_    = 'embedding+llm'
                        })
                    }
                    else {
                        $Edges.Add([PSCustomObject]@{
                            Source     = $A.Id
                            Target     = $B.Id
                            Type       = 'supports'
                            Weight     = [Math]::Round($Conf, 4)
                            AttackType = $null
                            Source_    = 'embedding+llm'
                        })
                    }
                    $StageBConfirmed++
                }
                catch {
                    Write-Verbose "qbaf-pair-confirm failed for ($($A.Id), $($B.Id)): $($_.Exception.Message)"
                    $StageBLlmErrors++
                }
            }
        }
        Write-OK "Stage B: $StageBCandidates candidates -> $StageBConfirmed confirmed, $StageBRejected rejected, $StageBLlmErrors errors"
    }

    Write-OK "Detected $($Edges.Count) relations ($(@($Edges | Where-Object { $_.Type -eq 'attacks' }).Count) attacks, $(@($Edges | Where-Object { $_.Type -eq 'supports' }).Count) supports)"

    if ($DryRun) {
        Write-Host "  [DRY RUN] Would process $($AllClaims.Count) claims with $($Edges.Count) relations" -ForegroundColor Yellow
        if ($PassThru) {
            return [PSCustomObject]@{
                ClaimCount        = $AllClaims.Count
                EdgeCount         = $Edges.Count
                AttackCount       = @($Edges | Where-Object { $_.Type -eq 'attacks' }).Count
                SupportCount      = @($Edges | Where-Object { $_.Type -eq 'supports' }).Count
                # t/1403 — Stage A/B provenance for AC#3 monotonicity assertions
                NodeOverlapEdges  = @($Edges | Where-Object { $_.Source_ -eq 'node-overlap' }).Count
                EmbeddingEdges    = @($Edges | Where-Object { $_.Source_ -eq 'embedding+llm' }).Count
                EmbeddingEnabled  = ($null -ne $ClaimEmbeddings)
                StageBCandidates  = $StageBCandidates
                StageBConfirmed   = $StageBConfirmed
                StageBRejected    = $StageBRejected
                StageBLlmErrors   = $StageBLlmErrors
                # Directional gate (t/2745 V2) — per-run verdict counts (t/2751#4 #1)
                DirectionalGate   = (-not $SkipDirectionalGate)
                DirectionalCounts = $StageADirCounts
            }
        }
        return
    }

    # ── Step 3: Call QBAF engine via node bridge ──────────────────────────────
    Write-Step 'Computing QBAF strengths'

    $QbafInput = [ordered]@{
        nodes = @($AllClaims | ForEach-Object {
            [ordered]@{ id = $_.Id; base_strength = $_.BaseStrength }
        })
        edges = @($Edges | ForEach-Object {
            $E = [ordered]@{
                source = $_.Source; target = $_.Target
                type = $_.Type; weight = $_.Weight
            }
            if ($_.AttackType) { $E['attack_type'] = $_.AttackType }
            $E
        })
    }

    $InputJson = $QbafInput | ConvertTo-Json -Depth 5 -Compress
    $BridgePath = Join-Path (Join-Path (Get-CodeRoot) 'scripts') 'qbaf-bridge.mjs'

    $QbafResult = $null
    try {
        $NpxCmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
        if (-not $NpxCmd) { $NpxCmd = Get-Command npx -ErrorAction SilentlyContinue }
        if (-not $NpxCmd) { throw 'npx not found — install Node.js to enable QBAF propagation' }
        $Process = New-Object System.Diagnostics.Process
        $Process.StartInfo.FileName = $NpxCmd.Source
        $Process.StartInfo.Arguments = "tsx `"$BridgePath`""
        $Process.StartInfo.UseShellExecute = $false
        $Process.StartInfo.RedirectStandardInput = $true
        $Process.StartInfo.RedirectStandardOutput = $true
        $Process.StartInfo.RedirectStandardError = $true
        $null = $Process.Start()

        $Process.StandardInput.Write($InputJson)
        $Process.StandardInput.Close()

        $StdOut = $Process.StandardOutput.ReadToEnd()
        $StdErr = $Process.StandardError.ReadToEnd()
        $Process.WaitForExit(30000)

        if ($Process.ExitCode -ne 0) {
            Write-Warn "QBAF bridge error: $StdErr"
            Write-Warn 'Falling back to base_strength only (no propagation)'
            $QbafResult = $null
        }
        else {
            $QbafResult = $StdOut | ConvertFrom-Json
            Write-OK "QBAF computed: $($QbafResult.iterations) iterations, converged=$($QbafResult.converged)"
        }
    }
    catch {
        Write-Warn "QBAF bridge failed: $($_.Exception.Message) — using base_strength only"
    }

    # ── Step 4: Build output ──────────────────────────────────────────────────
    Write-Step 'Building QBAF conflict analysis'

    $StrengthMap = @{}
    if ($QbafResult -and $QbafResult.PSObject.Properties['strengths']) {
        foreach ($Prop in $QbafResult.strengths.PSObject.Properties) {
            $StrengthMap[$Prop.Name] = [Math]::Round($Prop.Value, 4)
        }
    }

    $Output = [ordered]@{
        generated_at = (Get-Date).ToString('o')
        claim_count  = $AllClaims.Count
        edge_count   = $Edges.Count
        qbaf_converged = if ($QbafResult) { $QbafResult.converged } else { $false }
        qbaf_iterations = if ($QbafResult) { $QbafResult.iterations } else { 0 }
        claims = @($AllClaims | ForEach-Object {
            if ($StrengthMap.ContainsKey($_.Id)) { $CS = $StrengthMap[$_.Id] } else { $CS = $_.BaseStrength }
            $Rec = [ordered]@{
                id               = $_.Id
                doc_id           = $_.DocId
                label            = $_.Label
                category         = $_.Category
                base_strength    = $_.BaseStrength
                computed_strength = $CS
                strength_delta   = [Math]::Round($CS - $_.BaseStrength, 4)
                linked_nodes     = $_.Nodes
            }
            # Only on a claim taken from a marked copy (spec 7.4), so output without marks is unchanged.
            if ($_.Via) { $Rec['via'] = $_.Via }
            $Rec
        })
        edges = @($Edges | ForEach-Object {
            [ordered]@{
                source        = $_.Source
                target        = $_.Target
                type          = $_.Type
                weight        = $_.Weight
                attack_type   = $_.AttackType
                # t/1403 — provenance of the edge (node-overlap vs embedding+llm)
                relation_source = $_.Source_
            }
        })
        # t/1403 — Stage B diagnostics (present regardless of whether embedding subsystem was up)
        embedding_enabled = ($null -ne $ClaimEmbeddings)
        stage_b_candidates = $StageBCandidates
        stage_b_confirmed  = $StageBConfirmed
        stage_b_rejected   = $StageBRejected
        stage_b_llm_errors = $StageBLlmErrors
    }

    # Write output
    $OutputFile = Join-Path $OutputDir "qbaf-analysis-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').json"
    if ($PSCmdlet.ShouldProcess($OutputFile, 'Write QBAF conflict analysis')) {
        $Output | ConvertTo-Json -Depth 10 | Write-Utf8NoBom -Path $OutputFile 
        Write-OK "Analysis saved to $OutputFile"
    }

    if ($PassThru) {
        return [PSCustomObject]$Output
    }
}

# ── Helper: compute base_strength from evidence_criteria ──────────────────────
function Get-BaseStrengthFromCriteria {
    param(
        [PSObject]$Criteria,
        [string]$Category
    )

    $SpW = @{ vague = 0; qualified = 0.08; precise = 0.15 }

    $Score = 0.1  # floor
    if ($Criteria.PSObject.Properties['specificity']) { $Sp = $Criteria.specificity } else { $Sp = 'vague' }
    if ($SpW.ContainsKey($Sp)) { $SpIncrement = $SpW[$Sp] } else { $SpIncrement = 0 }
    $Score += $SpIncrement
    if ($Criteria.PSObject.Properties['has_warrant'] -and $Criteria.has_warrant) { $Score += 0.15 }
    if ($Criteria.PSObject.Properties['internally_consistent'] -and $Criteria.internally_consistent) { $Score += 0.10 }

    if ($Criteria.PSObject.Properties['category_criteria']) { $CatCriteria = $Criteria.category_criteria } else { $CatCriteria = $null }
    if ($CatCriteria) {
        switch ($Category) {
            'Desires' {
                if ($CatCriteria.PSObject.Properties['values_grounded'] -and $CatCriteria.values_grounded) { $Score += 0.15 }
                if ($CatCriteria.PSObject.Properties['tradeoff_acknowledged'] -and $CatCriteria.tradeoff_acknowledged) { $Score += 0.15 }
                if ($CatCriteria.PSObject.Properties['precedent_cited'] -and $CatCriteria.precedent_cited) { $Score += 0.20 }
            }
            'Intentions' {
                if ($CatCriteria.PSObject.Properties['mechanism_specified'] -and $CatCriteria.mechanism_specified) { $Score += 0.15 }
                if ($CatCriteria.PSObject.Properties['scope_bounded'] -and $CatCriteria.scope_bounded) { $Score += 0.15 }
                if ($CatCriteria.PSObject.Properties['failure_mode_addressed'] -and $CatCriteria.failure_mode_addressed) { $Score += 0.20 }
            }
        }
    }

    return [Math]::Max(0.1, [Math]::Min(1.0, [Math]::Round($Score, 2)))
}
