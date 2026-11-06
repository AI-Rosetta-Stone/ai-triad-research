# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-IssueTypeClassification {
    <#
    .SYNOPSIS
        Classifies taxonomy nodes by issue type (t/4828-C, spec docs/issue-type-taxonomy.md) and
        writes proposals ONLY. Never modifies node files.
    .DESCRIPTION
        Per node: label, description, BDI category, parent's label, and POV camp go to the
        'issue-type-classification' prompt (prompt_version 'issue-types-v1'), asking for 0-3
        ordered issue-type tags (primary first), a per-tag confidence, and a <=300-char rationale.
        0 tags ([]) is valid -- intentionally not about any of the six areas.

        Validates the response against the t/4832 enum and the 0-3/no-duplicates rule. An invalid
        response (bad enum value, >3 tags, duplicates) is WARNed and that node is skipped, not
        guessed at.

        CROSS-CHECK (unless -SkipCrossCheck): a second call with -SecondModel (a different
        backend) classifies the same node independently. A node whose primary type disagrees
        between the two models, or whose chosen tag has any confidence below 0.5 (primary
        model's own confidences), goes into the review queue (status 'pending'); everything else
        is auto-accepted (status 'accepted', final = proposed, method 'llm') -- still a proposal,
        never a node-file write (t/4836 is the separate corpus write).

        Writes ONLY taxonomy/Origin/issue-type-proposals.json, same shape and pattern as
        pov-tag-proposals.json (lib/schema/povTagProposals.ts): {version, proposals: [...]}. Each
        proposal: node_id, proposed, status, final, reviewed_by, reviewed_at, confidence,
        rationale, provenance {method, model, prompt_version, run_id, classified_at,
        second_model, second_types, agree}.

        RESUMABLE: with the same -RunId, a second invocation skips node_ids already present in
        the existing output file's proposals (idempotent per run_id). A different -RunId against
        an existing file from another run_id is refused -- pass -Force to start over.

        COST: tracked per call via the existing ai-models.json pricing (Get-AICostPricing /
        ConvertTo-AIUsageCostEstimate), not re-estimated. Stops BETWEEN nodes (never mid-call) and
        reports once the running total would exceed -CostCeiling.
    .PARAMETER NodeIds
        Restrict the run to these node ids (e.g. the gold set). Default: every node across the
        four taxonomy files (accelerationist/safetyist/skeptic/situations).
    .PARAMETER Model
        Primary classification model. Default: Get-AITierModel -Tier basic -Backend gemini.
    .PARAMETER SecondModel
        Cross-check model, a different backend from -Model. Default:
        Get-AITierModel -Tier basic -Backend groq. Ignored with -SkipCrossCheck.
    .PARAMETER SkipCrossCheck
        Classify with -Model only. Every node is then auto-accepted on confidence alone (no
        agreement signal) -- used for the gold-set calibration path (t/4835 D), not the full run.
    .PARAMETER ApiKey
        Explicit API key. Empty resolves via Resolve-AIApiKey (t/4087).
    .PARAMETER RunId
        Identifies this run for resume/idempotency. Default: a new GUID (fresh run).
    .PARAMETER CostCeiling
        Stop and report once the running actual cost would exceed this many USD. Default: 10.0.
    .PARAMETER OutputPath
        Proposals file path. Default: <TaxonomyDir>/issue-type-proposals.json.
    .PARAMETER WriteProposals
        Write OutputPath. Without it, reports what would be written (dry run) -- same default-safe
        convention as Invoke-OrgClaimMatching's -WriteProposals.
    .PARAMETER Force
        Allow continuing into an existing OutputPath written under a DIFFERENT run_id (overwrites
        it). Without -Force, a run_id mismatch against an existing file is refused.
    .PARAMETER AdjudicateQueue
        t/4835#4: instead of classifying taxonomy nodes, re-processes the EXISTING review queue
        (status 'pending') at -OutputPath with a third, stronger model (-AdjudicatorModel),
        BLIND to the two prior models' answers (the prompt never includes them, same as the
        normal path). Auto-accepts (status 'accepted', method 'llm-adjudicated') when the
        adjudicator's primary tag matches either prior model's primary AND (if it chose a tag at
        all) its confidence for that tag is >= 0.6; a "no tag" adjudication matches a "no tag"
        prior with no confidence gate (there is no tag to be confident about). Everything else
        stays 'pending' for a human, with the adjudicator's own attempt recorded in provenance so
        the reviewer isn't working blind. -NodeIds narrows which queued nodes to adjudicate (e.g.
        a resume); default is every 'pending' node in the file.
    .PARAMETER AdjudicatorModel
        Model for -AdjudicateQueue. Default: 'claude-sonnet-5' (the model t/4835#4 names). Must be
        a registered model id (Test-AIModelId) -- its backend comes from ai-models.json, never
        from the id's prefix.
    .PARAMETER FinalAdjudication
        t/4920: requires -AdjudicateQueue. The PI's instruction is "label everything" -- this
        drops the match/confidence gate entirely and accepts the adjudicator's answer as final
        (status 'accepted', method 'llm-final-adjudication'), including a "no tag" ([]) answer,
        as long as it passes the same 0-3-unique-known-type validity check every other
        classification call already does. A response that fails that check (unknown slug,
        duplicate, >3 types) is WARNed by name and id and leaves the entry 'pending' -- unconditional
        accept is not the same as accepting a malformed answer. The PRIOR adjudication (model,
        answer, whether it matched) is preserved under provenance.prior_adjudication before the
        new adjudicator_* fields are written, so the earlier claude-sonnet-5 attempt is never lost.
    .OUTPUTS
        PSCustomObject: NodesProcessed, Proposed, Written, ReviewQueueCount, EmptyCount,
        TypeCounts (hashtable), AgreementRate, ActualCost, CostCeilingHit, Skipped, Failed. In
        -AdjudicateQueue mode, additionally AdjudicatedAccepted and AdjudicatedStillPending.
    .EXAMPLE
        Invoke-IssueTypeClassification -NodeIds $GoldSetIds -SkipCrossCheck
    .EXAMPLE
        Invoke-IssueTypeClassification -RunId 'issue-types-full-2026-11-04' -WriteProposals
    .EXAMPLE
        Invoke-IssueTypeClassification -AdjudicateQueue -OutputPath $Path -WriteProposals -CostCeiling 5.0
    .EXAMPLE
        Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -OutputPath $Path -WriteProposals -CostCeiling 5.0
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter()]
        [string[]]$NodeIds,

        [Parameter()]
        [string]$Model = (Get-AITierModel -Tier basic -Backend gemini),

        [Parameter()]
        [string]$SecondModel = (Get-AITierModel -Tier basic -Backend groq),

        [Parameter()]
        [switch]$SkipCrossCheck,

        [Parameter()]
        [string]$ApiKey = '',

        [Parameter()]
        [string]$RunId = ([guid]::NewGuid().ToString()),

        [Parameter()]
        [ValidateRange(0.01, 1000.0)]
        [double]$CostCeiling = 10.0,

        [Parameter()]
        [string]$OutputPath,

        [Parameter()]
        [switch]$WriteProposals,

        [Parameter()]
        [switch]$Force,

        [Parameter()]
        [switch]$AdjudicateQueue,

        [Parameter()]
        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$AdjudicatorModel = 'claude-sonnet-5',

        [Parameter()]
        [switch]$FinalAdjudication
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if ($FinalAdjudication -and -not $AdjudicateQueue) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Run a final, unconditional-accept adjudication pass' `
            -Problem '-FinalAdjudication was passed without -AdjudicateQueue' `
            -Location 'Invoke-IssueTypeClassification' `
            -NextSteps @('-FinalAdjudication only changes behavior inside -AdjudicateQueue mode — pass both switches together',
                         'Or drop -FinalAdjudication to run the normal conditional-accept adjudication'))
    }

    $ValidTypes = @('loss_of_control', 'misuse', 'power_concentration', 'economic', 'political', 'social')
    $PromptVersion = 'issue-types-v1'

    if (-not $OutputPath) {
        $OutputPath = Join-Path (Get-TaxonomyDir) 'issue-type-proposals.json'
    }

    # ── Gather nodes (both modes need the taxonomy lookup) ───────────────────
    $PovByFile = @{ accelerationist = 'accelerationist'; safetyist = 'safetyist'; skeptic = 'skeptic'; situations = $null }
    $AllNodesById = @{}
    foreach ($PovKey in $script:TaxonomyData.Keys) {
        $PovFile = $script:TaxonomyData[$PovKey]
        if (-not $PovFile.PSObject.Properties['nodes']) { continue }
        foreach ($n in @($PovFile.nodes)) {
            if (-not $n.PSObject.Properties['id']) { continue }
            $AllNodesById[[string]$n.id] = $n
        }
    }

    $AllAdjQueueProposals = $null   # populated only in -AdjudicateQueue mode; the full file, for write-back
    $Targets = [System.Collections.Generic.List[PSObject]]::new()

    if ($AdjudicateQueue) {
        # ── -AdjudicateQueue: targets are the EXISTING file's 'pending' entries, not fresh
        # taxonomy nodes. No resume/run_id guard applies -- this mutates specific entries of an
        # already-written file in place, it does not start or continue a classification run.
        if (-not (Test-Path $OutputPath)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Adjudicate the issue-type review queue' `
                -Problem "No existing proposals file at $OutputPath to adjudicate" `
                -Location 'Invoke-IssueTypeClassification' `
                -NextSteps @('Run the classification first (without -AdjudicateQueue) to produce the file',
                             'Or pass the correct -OutputPath'))
        }
        $ExistingFile = Get-Content $OutputPath -Raw | ConvertFrom-Json
        $AllAdjQueueProposals = if ($ExistingFile.PSObject.Properties['proposals']) { , @($ExistingFile.proposals) } else { , @() }
        $PendingByNodeId = @{}
        foreach ($p in $AllAdjQueueProposals) {
            if ($p.PSObject.Properties['node_id'] -and $p.PSObject.Properties['status'] -and $p.status -eq 'pending') {
                $PendingByNodeId[[string]$p.node_id] = $p
            }
        }
        $WantedIds = if ($NodeIds -and @($NodeIds).Count -gt 0) { @($NodeIds) } else { @($PendingByNodeId.Keys) }
        foreach ($id in $WantedIds) {
            if (-not $PendingByNodeId.ContainsKey($id)) {
                Write-Warning "Invoke-IssueTypeClassification -AdjudicateQueue: '$id' is not a pending queue entry — skipping"
                continue
            }
            if (-not $AllNodesById.ContainsKey($id)) {
                Write-Warning "Invoke-IssueTypeClassification -AdjudicateQueue: node id '$id' not found in the loaded taxonomy — skipping"
                continue
            }
            $Targets.Add($AllNodesById[$id])
        }
        Write-Host "Issue-type adjudication: $($Targets.Count) queued node(s) to adjudicate with $AdjudicatorModel (blind)."
    } else {
        # ── Resume / overwrite guard ──────────────────────────────────────────
        $ExistingProposals = @{}
        if (Test-Path $OutputPath) {
            try {
                $ExistingFile = Get-Content $OutputPath -Raw | ConvertFrom-Json
                $ExistingRunId = if ($ExistingFile.PSObject.Properties['run_id']) { [string]$ExistingFile.run_id } else { $null }
                if ($ExistingRunId -and $ExistingRunId -ne $RunId -and -not $Force) {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal 'Resume or start an issue-type classification run' `
                        -Problem "$OutputPath already holds run_id '$ExistingRunId', not the requested '$RunId'" `
                        -Location 'Invoke-IssueTypeClassification' `
                        -NextSteps @("Pass -RunId '$ExistingRunId' to resume that run",
                                     'Or pass -Force to start a new run and overwrite it'))
                }
                if ($ExistingFile.PSObject.Properties['proposals']) {
                    foreach ($p in @($ExistingFile.proposals)) {
                        if ($p.PSObject.Properties['node_id']) { $ExistingProposals[[string]$p.node_id] = $p }
                    }
                }
                if ($ExistingProposals.Count -gt 0) {
                    Write-Host "Resuming run '$RunId' — $($ExistingProposals.Count) node(s) already classified, skipping them."
                }
            } catch [System.Management.Automation.RuntimeException] {
                throw
            } catch {
                Write-Warning "Invoke-IssueTypeClassification: could not read existing $OutputPath ($($_.Exception.Message)) — treating as empty"
            }
        }

        $WantedIds = if ($NodeIds -and @($NodeIds).Count -gt 0) { @($NodeIds) } else { @($AllNodesById.Keys) }
        foreach ($id in $WantedIds) {
            if ($ExistingProposals.ContainsKey($id)) { continue }
            if (-not $AllNodesById.ContainsKey($id)) {
                Write-Warning "Invoke-IssueTypeClassification: node id '$id' not found in the loaded taxonomy — skipping"
                continue
            }
            $Targets.Add($AllNodesById[$id])
        }
    }
    if (-not $AdjudicateQueue) {
        Write-Host "Issue-type classification: $($Targets.Count) node(s) to classify (run_id=$RunId, model=$Model$(if (-not $SkipCrossCheck) { ", second_model=$SecondModel" }))."
    }

    if ($Targets.Count -eq 0) {
        return [PSCustomObject]@{
            NodesProcessed = 0; Proposed = 0; Written = 0; ReviewQueueCount = 0; EmptyCount = 0
            TypeCounts = @{}; StatusCounts = @{}; AgreementRate = $null; ActualCost = 0.0; CostCeilingHit = $false
            Skipped = 0; Failed = @(); AdjudicatedAccepted = 0; AdjudicatedStillPending = 0
            RunId = $RunId; OutputPath = $OutputPath
        }
    }

    # Array-of-objects, not a dynamic {type: confidence} map (t/4833 pilot finding): a schema
    # map with no fixed property set either gets coerced to {} under Gemini's constrained
    # decoding (every confidence silently read back as 0.0), or is rejected outright by Groq's
    # stricter structured-output mode ("additionalProperties:false must be set on every
    # object" -- impossible to satisfy for a genuinely open key set). A fixed-shape array of
    # {type, confidence} entries works under both backends; converted to the proposals file's
    # own {type: confidence} map shape after parsing (that shape is t/4832's spec, not the AI
    # protocol's problem to solve).
    $ResponseSchema = @{
        type       = 'object'
        properties = @{
            types = @{
                type     = 'array'
                items    = @{
                    type       = 'object'
                    properties = @{
                        type       = @{ type = 'string'; enum = $ValidTypes }
                        confidence = @{ type = 'number' }
                    }
                    required             = @('type', 'confidence')
                    additionalProperties = $false
                }
                maxItems = 3
            }
            rationale = @{ type = 'string' }
        }
        required             = @('types', 'rationale')
        additionalProperties = $false
    }

    # ── Classify one node with one model. Returns $null on any invalid/failed response (WARNed). ──
    $Classify = {
        param($Node, [string]$M)
        $NodeId = [string]$Node.id
        $ParentLabel = ''
        if ($Node.PSObject.Properties['parent_id'] -and $Node.parent_id -and $AllNodesById.ContainsKey([string]$Node.parent_id)) {
            $ParentLabel = [string]$AllNodesById[[string]$Node.parent_id].label
        }
        $Pov = if ($NodeId -match '^(acc|saf|skp)-') {
            @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }[$Matches[1]]
        } else { 'situations' }
        $Category = if ($Node.PSObject.Properties['category'] -and $Node.category) { [string]$Node.category } else { 'none' }
        $Description = if ($Node.PSObject.Properties['description']) { [string]$Node.description } else { '' }

        # Always returns a result (never $null): .Success distinguishes a usable classification
        # from a failed one, and .InputTokens/.OutputTokens are recorded whenever the AI call
        # itself succeeded, even if the response later fails validation -- those are real tokens
        # spent and must still be costed (t/4835 TL condition, t/4833#5).
        $Result = [PSCustomObject]@{
            Success = $false; Types = @(); Confidence = [ordered]@{}; Rationale = ''
            InputTokens = 0; OutputTokens = 0; Model = $M
        }
        try {
            $Prompt = Get-Prompt -Name 'issue-type-classification' -Replacements @{
                pov           = $Pov
                category      = $Category
                parent_label  = $ParentLabel
                label         = [string]$Node.label
                description   = $Description
            }
            # 700 was enough for gemini/groq (t/4833) but claude-sonnet-5 (t/4835#4's adjudicator)
            # routinely hit max_tokens with no usable text -- Anthropic models run more verbose
            # before landing structured output. 1800 gives real headroom for all three backends;
            # cost impact is negligible since output is still schema-capped at 3 types + a
            # 300-char rationale.
            $Ai = Invoke-AIApi -Prompt $Prompt -Model $M -ApiKey $ApiKey `
                -Temperature 0.1 -MaxTokens 1800 -ResponseSchema $ResponseSchema -TimeoutSec 30
            if ($Ai -and $Ai.Usage) { $Result.InputTokens = [int]$Ai.Usage.InputTokens; $Result.OutputTokens = [int]$Ai.Usage.OutputTokens }
            if (-not $Ai -or -not $Ai.Text) { throw 'empty response' }

            $CleanText = $Ai.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
            $Parsed = $CleanText.Trim() | ConvertFrom-Json

            # Unary comma on BOTH branches: an if/else used as an expression collapses an empty
            # array result to $null on capture (same unrolling class as t/4742's postmortem,
            # confirmed empirically -- `$x = if (c) { @($y) } else { @() }` loses a genuinely
            # empty $y). Without this, a valid "types": [] response throws ".Count cannot be
            # found on this object" further down and the node is wrongly skipped.
            $TypeEntries = if ($Parsed.PSObject.Properties['types'] -and $null -ne $Parsed.types) { , @($Parsed.types) } else { , @() }
            if (@($TypeEntries).Count -gt 3) { throw "too many types ($(@($TypeEntries).Count) > 3)" }
            $Types = @($TypeEntries | ForEach-Object { if ($_.PSObject.Properties['type']) { [string]$_.type } else { '' } })
            $Dupes = @($Types | Group-Object | Where-Object { $_.Count -gt 1 })
            if ($Dupes.Count -gt 0) { throw "duplicate type(s): $(($Dupes | ForEach-Object { $_.Name }) -join ', ')" }
            $Unknown = @($Types | Where-Object { $ValidTypes -notcontains $_ })
            if ($Unknown.Count -gt 0) { throw "unknown type(s): $($Unknown -join ', ')" }

            $Confidence = [ordered]@{}
            for ($ti = 0; $ti -lt $TypeEntries.Count; $ti++) {
                $v = if ($TypeEntries[$ti].PSObject.Properties['confidence']) { [double]$TypeEntries[$ti].confidence } else { 0.0 }
                $Confidence[$Types[$ti]] = $v
            }
            $Rationale = if ($Parsed.PSObject.Properties['rationale']) { [string]$Parsed.rationale } else { '' }
            if ($Rationale.Length -gt 300) { $Rationale = $Rationale.Substring(0, 300) }

            $Result.Types = @($Types)
            $Result.Confidence = $Confidence
            $Result.Rationale = $Rationale
            $Result.Success = $true
        }
        catch {
            Write-Warning "Invoke-IssueTypeClassification: classification failed for '$NodeId' with model '$M': $($_.Exception.Message)"
        }
        $Result
    }

    # One retry on failure (TL condition, t/4833#5): an invalid/failed response is retried once
    # before being counted as skipped, so a transient parse/response hiccup doesn't drop a node
    # from the run. Both attempts' token usage (if any) are returned for costing.
    $ClassifyWithRetry = {
        param($Node, [string]$M)
        $Attempt1 = & $Classify $Node $M
        if ($Attempt1.Success) { return , @($Attempt1) }
        Write-Warning "Invoke-IssueTypeClassification: retrying '$([string]$Node.id)' with model '$M' once"
        $Attempt2 = & $Classify $Node $M
        return , @($Attempt1, $Attempt2)
    }

    # ── Cost tracking (actual, not estimated — t/4835 report requirement) ───
    $Pricing = Get-AICostPricing
    $CostEntries = [System.Collections.Generic.List[PSObject]]::new()
    $Recost = {
        $local = [System.Collections.Generic.List[PSObject]]::new()
        foreach ($e in $CostEntries) { $local.Add($e) }
        if ($local.Count -gt 0) { ConvertTo-AIUsageCostEstimate -Entries $local -Pricing $Pricing.Pricing -ApiModelIdMap $Pricing.ApiModelIdMap }
        $sum = 0.0
        foreach ($e in $local) { if ($e.PSObject.Properties['estimatedCost']) { $sum += [double]$e.estimatedCost } }
        $sum
    }

    # ── Main loop ─────────────────────────────────────────────────────────────
    $NewProposals = [System.Collections.Generic.List[PSObject]]::new()
    $Skipped = 0
    $Failed = [System.Collections.Generic.List[string]]::new()
    $CostCeilingHit = $false
    $AgreeCount = 0
    $CompareCount = 0
    $ClassifiedAt = (Get-Date).ToString('o')
    $AdjudicatedAccepted = 0
    $AdjudicatedStillPending = 0

    # Idempotent: Add-Member -Force on a PSCustomObject parsed from JSON, since these fields
    # don't exist on the original proposal and plain `.prop = value` throws for a genuinely new
    # property under StrictMode (unlike an existing one, which plain assignment is fine for).
    $SetAdjudicatorFields = {
        param($Entry, [string]$AdjModel, $AdjTypes, $AdjConfidence, [string]$AdjRationale, $Matched)
        $Entry.provenance | Add-Member -NotePropertyName 'adjudicator_model' -NotePropertyValue $AdjModel -Force
        $Entry.provenance | Add-Member -NotePropertyName 'adjudicator_types' -NotePropertyValue @($AdjTypes) -Force
        $Entry.provenance | Add-Member -NotePropertyName 'adjudicator_confidence' -NotePropertyValue $AdjConfidence -Force
        $Entry.provenance | Add-Member -NotePropertyName 'adjudicator_rationale' -NotePropertyValue $AdjRationale -Force
        $Entry.provenance | Add-Member -NotePropertyName 'adjudicator_matched_prior' -NotePropertyValue $Matched -Force
    }

    foreach ($Node in $Targets) {
        $NodeId = [string]$Node.id

        if ($AdjudicateQueue) {
            # t/4835#4: a third, stronger model adjudicates ONE queued node, blind (the prompt
            # never includes either prior model's answer -- same prompt-building path as the
            # normal classification, which already never surfaces that). Auto-accept when its
            # primary tag matches either prior model's primary AND (if it chose a tag at all) its
            # own confidence for that tag is >= 0.6; a "no tag" adjudication matching a "no tag"
            # prior needs no confidence gate, since there is no tag to be confident about.
            $AdjAttempts = & $ClassifyWithRetry $Node $AdjudicatorModel
            foreach ($a in $AdjAttempts) { $CostEntries.Add([PSCustomObject]@{ modelId = $AdjudicatorModel; promptTokens = $a.InputTokens; completionTokens = $a.OutputTokens }) }
            $Adj = $AdjAttempts[-1]
            $Entry = $PendingByNodeId[$NodeId]

            # t/4920 condition 1 (Quality, t/4920#2): a -FinalAdjudication pass must never
            # overwrite an earlier adjudication attempt in place -- move whatever adjudicator_*
            # fields are already there (e.g. the claude-sonnet-5 pass from t/4835#4) under
            # provenance.prior_adjudication BEFORE this entry's new adjudicator_* fields are
            # written below, so the earlier attempt stays auditable instead of being lost.
            #
            # -not already-has-prior_adjudication guard (Quality, t/4920#4): without this, a
            # resumed run (this entry failed/stayed-pending on a first -FinalAdjudication pass,
            # so adjudicator_model is now THIS run's model, not the original claude-sonnet-5 one)
            # would copy the FAILED OPUS attempt into prior_adjudication on the second pass,
            # -Force-overwriting and permanently losing the original sonnet record -- exactly the
            # loss this snapshot exists to prevent. Once prior_adjudication exists, it is frozen.
            if ($FinalAdjudication -and $Entry.provenance.PSObject.Properties['adjudicator_model'] -and -not $Entry.provenance.PSObject.Properties['prior_adjudication']) {
                $PriorAdjudication = [ordered]@{
                    model         = $Entry.provenance.adjudicator_model
                    types         = @($Entry.provenance.adjudicator_types)
                    confidence    = $Entry.provenance.adjudicator_confidence
                    rationale     = $Entry.provenance.adjudicator_rationale
                    matched_prior = $Entry.provenance.adjudicator_matched_prior
                }
                $Entry.provenance | Add-Member -NotePropertyName 'prior_adjudication' -NotePropertyValue $PriorAdjudication -Force
            }

            if (-not $Adj.Success) {
                Write-Warning "Invoke-IssueTypeClassification -AdjudicateQueue: adjudication failed twice for '$NodeId' — leaving it pending, unresolved"
                & $SetAdjudicatorFields $Entry $AdjudicatorModel @() $null '' 'call_failed'
                $AdjudicatedStillPending++
            } else {
                $AdjTypes = @($Adj.Types)
                $AdjPrimary = if ($AdjTypes.Count -gt 0) { $AdjTypes[0] } else { $null }
                $PriorPrimary1 = if ($Entry.PSObject.Properties['proposed'] -and @($Entry.proposed).Count -gt 0) { $Entry.proposed[0] } else { $null }
                $PriorPrimary2 = $null
                if ($Entry.PSObject.Properties['provenance'] -and $Entry.provenance.PSObject.Properties['second_types'] -and $Entry.provenance.second_types -and @($Entry.provenance.second_types).Count -gt 0) {
                    $PriorPrimary2 = @($Entry.provenance.second_types)[0]
                }
                $Matched = if ($AdjPrimary -eq $PriorPrimary1) { 'primary' } elseif ($AdjPrimary -eq $PriorPrimary2) { 'second' } else { 'none' }
                $ConfidenceOk = if ($null -eq $AdjPrimary) { $true } else { [double]$Adj.Confidence[$AdjPrimary] -ge 0.6 }

                # t/4920 condition 2 (Quality, t/4920#2): -FinalAdjudication drops the
                # match/confidence gate, but NOT validity -- $Classify already throws (Success =
                # $false) on >3 types, a duplicate, or an unknown enum value, so a $Success = $true
                # $Adj here is already guaranteed valid. This re-check is defense-in-depth against
                # that upstream guarantee ever loosening (same rationale as t/4836's own
                # validate-all-or-abort guard). It is NOT reachable through the public surface
                # today -- the unknown-slug/four-tag tests below go through the mocked
                # Invoke-AIApi, and $Classify's own try/catch rejects those before $Adj is even
                # built, landing them in the "-not $Adj.Success" branch above instead (Quality,
                # t/4920#4). If this guard is ever made reachable, it needs a direct test against
                # a fabricated $Adj; until then, this comment is the honest statement of that gap.
                $ValidAdjAnswer = (@($AdjTypes).Count -le 3) `
                    -and (@($AdjTypes | Group-Object | Where-Object { $_.Count -gt 1 }).Count -eq 0) `
                    -and (@($AdjTypes | Where-Object { $ValidTypes -notcontains $_ }).Count -eq 0)
                if (-not $ValidAdjAnswer) {
                    Write-Warning "Invoke-IssueTypeClassification -AdjudicateQueue: '$NodeId' adjudicator answer is not 0-3 unique known issue-types-v1 slugs ($($AdjTypes -join ', ')) — leaving it pending, unresolved"
                }

                $AutoAccept = if ($FinalAdjudication) { $ValidAdjAnswer } else { ($Matched -ne 'none') -and $ConfidenceOk -and $ValidAdjAnswer }
                & $SetAdjudicatorFields $Entry $AdjudicatorModel $AdjTypes $Adj.Confidence $Adj.Rationale $Matched
                if ($AutoAccept) {
                    $Entry.status = 'accepted'
                    # No unary comma here: this is a plain property assignment, not a scriptblock
                    # return or an if/else-expression capture, so @() alone preserves a genuinely
                    # empty array AND a non-empty one correctly. `, @($AdjTypes)` (the pattern
                    # used elsewhere in this file to protect an if/else EXPRESSION's empty-array
                    # branch from collapsing to $null) wraps the array in an extra, spurious layer
                    # here instead -- e.g. ["political","misuse"] became [["political","misuse"]]
                    # on every accepted adjudication (TL-reported via t/4835's 30-item spot-check).
                    $Entry.final = @($AdjTypes)
                    $Entry.confidence = $Adj.Confidence
                    $Entry.rationale = $Adj.Rationale
                    $Entry.provenance | Add-Member -NotePropertyName 'method' -NotePropertyValue $(if ($FinalAdjudication) { 'llm-final-adjudication' } else { 'llm-adjudicated' }) -Force
                    $AdjudicatedAccepted++
                } else {
                    $AdjudicatedStillPending++
                }
            }

            $RunningCost = & $Recost
            if ($RunningCost -gt $CostCeiling) {
                Write-Warning "Invoke-IssueTypeClassification -AdjudicateQueue: running cost `$$([Math]::Round($RunningCost, 2)) exceeds the `$$CostCeiling ceiling — stopping."
                $CostCeilingHit = $true
                break
            }
            continue
        }

        # No @()-wrap here: $ClassifyWithRetry already returns `,@(...)`, a single protected
        # pipeline object -- wrapping the CALL in @() nests it one level deeper (same class of
        # bug as t/4742's postmortem). Assign directly; it unrolls correctly.
        $PrimaryAttempts = & $ClassifyWithRetry $Node $Model
        foreach ($a in $PrimaryAttempts) { $CostEntries.Add([PSCustomObject]@{ modelId = $Model; promptTokens = $a.InputTokens; completionTokens = $a.OutputTokens }) }
        $Primary = $PrimaryAttempts[-1]
        if (-not $Primary.Success) {
            $Skipped++; $Failed.Add($NodeId)
            Write-Warning "Invoke-IssueTypeClassification: '$NodeId' failed classification twice (original + 1 retry) — skipping"
            continue
        }

        $SecondTypes = $null
        $Agree = $null
        if (-not $SkipCrossCheck) {
            $SecondAttempts = & $ClassifyWithRetry $Node $SecondModel
            foreach ($a in $SecondAttempts) { $CostEntries.Add([PSCustomObject]@{ modelId = $SecondModel; promptTokens = $a.InputTokens; completionTokens = $a.OutputTokens }) }
            $Second = $SecondAttempts[-1]
            if ($Second.Success) {
                $SecondTypes = @($Second.Types)
                $PrimaryTop = if (@($Primary.Types).Count -gt 0) { $Primary.Types[0] } else { $null }
                $SecondTop  = if (@($SecondTypes).Count -gt 0) { $SecondTypes[0] } else { $null }
                $Agree = ($PrimaryTop -eq $SecondTop)
                $CompareCount++
                if ($Agree) { $AgreeCount++ }
            } else {
                Write-Warning "Invoke-IssueTypeClassification: cross-check call failed for '$NodeId' — treating as a review-queue item (no agreement signal)"
            }
        }

        $LowConfidence = @($Primary.Confidence.Values | Where-Object { $_ -lt 0.5 }).Count -gt 0
        $NeedsReview = ($Agree -eq $false) -or ($null -eq $Agree -and -not $SkipCrossCheck) -or $LowConfidence
        $Status = if ($NeedsReview) { 'pending' } else { 'accepted' }
        # Unary comma: an accepted 0-tag node's @($Primary.Types) is a genuinely empty array,
        # and the if/else-as-expression capture would otherwise collapse it to $null -- which
        # would wrongly read as "not yet reviewed" (t/4832's own meaning for a null final)
        # instead of "accepted with no tags" (same collapse class just fixed above for
        # $TypeEntries).
        $Final = if ($Status -eq 'accepted') { , @($Primary.Types) } else { $null }

        $NewProposals.Add([PSCustomObject]@{
            node_id     = $NodeId
            proposed    = @($Primary.Types)
            status      = $Status
            final       = $Final
            reviewed_by = $null
            reviewed_at = $null
            confidence  = $Primary.Confidence
            rationale   = $Primary.Rationale
            provenance  = [ordered]@{
                method        = 'llm'
                model         = $Model
                prompt_version = $PromptVersion
                run_id        = $RunId
                classified_at = $ClassifiedAt
                second_model  = if ($SkipCrossCheck) { $null } else { $SecondModel }
                second_types  = $SecondTypes
                agree         = $Agree
            }
        })

        $RunningCost = & $Recost
        if ($RunningCost -gt $CostCeiling) {
            Write-Warning "Invoke-IssueTypeClassification: running cost `$$([Math]::Round($RunningCost, 2)) exceeds the `$$CostCeiling ceiling after $($NewProposals.Count) of $($Targets.Count) node(s) — stopping."
            $CostCeilingHit = $true
            break
        }
    }

    $ActualCost = & $Recost

    # ── Merge with any resumed proposals and write ───────────────────────────
    $AllProposals = [System.Collections.Generic.List[PSObject]]::new()
    if ($AdjudicateQueue) {
        foreach ($p in $AllAdjQueueProposals) { $AllProposals.Add($p) }
    } else {
        foreach ($p in $ExistingProposals.Values) { $AllProposals.Add($p) }
        foreach ($p in $NewProposals) { $AllProposals.Add($p) }
    }

    $FileRunId = if ($AdjudicateQueue -and $ExistingFile.PSObject.Properties['run_id']) { [string]$ExistingFile.run_id } else { $RunId }
    $File = [ordered]@{
        version    = 1
        run_id     = $FileRunId
        proposals  = @($AllProposals)
    }

    $Written = 0
    if ($WriteProposals) {
        if ($PSCmdlet.ShouldProcess($OutputPath, 'Write issue-type proposals')) {
            $Json = $File | ConvertTo-Json -Depth 10
            Write-Utf8NoBom -Path $OutputPath -Value $Json
            $Written = $AllProposals.Count
            Write-Host "Wrote $Written proposal(s) to $OutputPath"
        }
    } else {
        Write-Host "Dry run — $($AllProposals.Count) proposal(s) would be written to $OutputPath (pass -WriteProposals to write)"
    }

    # ── Report ────────────────────────────────────────────────────────────────
    # Adjudication reports status/type breakdown over the WHOLE file ($AllProposals), since the
    # TL's ask (t/4835#4) is "final counts by status and by type" for the queue as it now stands
    # — not just the subset touched this run. Normal-mode reporting stays scoped to $NewProposals,
    # matching every prior run's report shape.
    $ReportSource = if ($AdjudicateQueue) { $AllProposals } else { $NewProposals }

    $TypeCounts = [ordered]@{}
    foreach ($t in $ValidTypes) { $TypeCounts[$t] = 0 }
    $EmptyCount = 0
    $StatusCounts = [ordered]@{ accepted = 0; pending = 0 }
    foreach ($p in $ReportSource) {
        # Unary comma on BOTH branches: an if/else-as-expression capture collapses a genuinely
        # empty-array branch result to $null (t/4742's bug class, hit again here — see the
        # $Final assignment above for the same pattern).
        $types = if ($AdjudicateQueue -and $p.status -eq 'accepted' -and $p.PSObject.Properties['final'] -and $null -ne $p.final) { , @($p.final) } else { , @($p.proposed) }
        if ($types.Count -eq 0) { $EmptyCount++ }
        foreach ($t in $types) { if ($TypeCounts.Contains($t)) { $TypeCounts[$t]++ } }
        if ($StatusCounts.Contains([string]$p.status)) { $StatusCounts[[string]$p.status]++ }
    }
    $ReviewQueueCount = @($ReportSource | Where-Object { $_.status -eq 'pending' }).Count
    $AgreementRate = if ($CompareCount -gt 0) { [Math]::Round($AgreeCount / $CompareCount, 4) } else { $null }

    Write-Host ""
    if ($AdjudicateQueue) {
        Write-Host "Adjudicated: $($Targets.Count) | Auto-accepted: $AdjudicatedAccepted | Still pending: $AdjudicatedStillPending | Queue now — accepted: $($StatusCounts['accepted']) pending: $($StatusCounts['pending']) | Empty ([]): $EmptyCount | Actual cost: `$$([Math]::Round($ActualCost, 4))"
    } else {
        Write-Host "Classified: $($NewProposals.Count) | Skipped: $Skipped | Review queue: $ReviewQueueCount | Empty ([]): $EmptyCount | Agreement: $(if ($null -ne $AgreementRate) { "$AgreementRate ($AgreeCount/$CompareCount)" } else { 'n/a (cross-check off)' }) | Actual cost: `$$([Math]::Round($ActualCost, 4))"
    }

    [PSCustomObject]@{
        NodesProcessed         = if ($AdjudicateQueue) { $Targets.Count } else { $NewProposals.Count }
        Proposed               = $NewProposals.Count
        Written                = $Written
        ReviewQueueCount       = $ReviewQueueCount
        EmptyCount             = $EmptyCount
        TypeCounts             = $TypeCounts
        StatusCounts           = $StatusCounts
        AgreementRate          = $AgreementRate
        ActualCost             = [Math]::Round($ActualCost, 4)
        CostCeilingHit         = $CostCeilingHit
        Skipped                = $Skipped
        Failed                 = @($Failed)
        AdjudicatedAccepted    = $AdjudicatedAccepted
        AdjudicatedStillPending = $AdjudicatedStillPending
        RunId                  = $FileRunId
        OutputPath             = $OutputPath
    }
}
