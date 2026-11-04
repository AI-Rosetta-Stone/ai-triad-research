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
    .OUTPUTS
        PSCustomObject: NodesProcessed, Proposed, Written, ReviewQueueCount, EmptyCount,
        TypeCounts (hashtable), AgreementRate, ActualCost, CostCeilingHit, Skipped, Failed.
    .EXAMPLE
        Invoke-IssueTypeClassification -NodeIds $GoldSetIds -SkipCrossCheck
    .EXAMPLE
        Invoke-IssueTypeClassification -RunId 'issue-types-full-2026-11-04' -WriteProposals
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
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $ValidTypes = @('loss_of_control', 'misuse', 'power_concentration', 'economic', 'political', 'social')
    $PromptVersion = 'issue-types-v1'

    if (-not $OutputPath) {
        $OutputPath = Join-Path (Get-TaxonomyDir) 'issue-type-proposals.json'
    }

    # ── Resume / overwrite guard ─────────────────────────────────────────────
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

    # ── Gather nodes ─────────────────────────────────────────────────────────
    $PovByFile = @{ accelerationist = 'accelerationist'; safetyist = 'safetyist'; skeptic = 'skeptic'; situations = $null }
    $AllNodesById = @{}
    $Targets = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($PovKey in $script:TaxonomyData.Keys) {
        $PovFile = $script:TaxonomyData[$PovKey]
        if (-not $PovFile.PSObject.Properties['nodes']) { continue }
        foreach ($n in @($PovFile.nodes)) {
            if (-not $n.PSObject.Properties['id']) { continue }
            $AllNodesById[[string]$n.id] = $n
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
    Write-Host "Issue-type classification: $($Targets.Count) node(s) to classify (run_id=$RunId, model=$Model$(if (-not $SkipCrossCheck) { ", second_model=$SecondModel" }))."

    if ($Targets.Count -eq 0) {
        return [PSCustomObject]@{
            NodesProcessed = 0; Proposed = 0; Written = 0; ReviewQueueCount = 0; EmptyCount = 0
            TypeCounts = @{}; AgreementRate = $null; ActualCost = 0.0; CostCeilingHit = $false
            Skipped = 0; Failed = @()
        }
    }

    $ResponseSchema = @{
        type       = 'object'
        properties = @{
            types      = @{ type = 'array'; items = @{ type = 'string'; enum = $ValidTypes }; maxItems = 3 }
            confidence = @{ type = 'object' }
            rationale  = @{ type = 'string' }
        }
        required   = @('types', 'confidence', 'rationale')
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
            $Ai = Invoke-AIApi -Prompt $Prompt -Model $M -ApiKey $ApiKey `
                -Temperature 0.1 -MaxTokens 400 -ResponseSchema $ResponseSchema -TimeoutSec 30
            if ($Ai -and $Ai.Usage) { $Result.InputTokens = [int]$Ai.Usage.InputTokens; $Result.OutputTokens = [int]$Ai.Usage.OutputTokens }
            if (-not $Ai -or -not $Ai.Text) { throw 'empty response' }

            $CleanText = $Ai.Text -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
            $Parsed = $CleanText.Trim() | ConvertFrom-Json

            $Types = if ($Parsed.PSObject.Properties['types'] -and $null -ne $Parsed.types) { @($Parsed.types | ForEach-Object { [string]$_ }) } else { @() }
            if (@($Types).Count -gt 3) { throw "too many types ($(@($Types).Count) > 3)" }
            $Dupes = @($Types | Group-Object | Where-Object { $_.Count -gt 1 })
            if ($Dupes.Count -gt 0) { throw "duplicate type(s): $(($Dupes | ForEach-Object { $_.Name }) -join ', ')" }
            $Unknown = @($Types | Where-Object { $ValidTypes -notcontains $_ })
            if ($Unknown.Count -gt 0) { throw "unknown type(s): $($Unknown -join ', ')" }

            $ConfidenceRaw = if ($Parsed.PSObject.Properties['confidence']) { $Parsed.confidence } else { $null }
            $Confidence = [ordered]@{}
            foreach ($t in $Types) {
                $v = if ($ConfidenceRaw -and $ConfidenceRaw.PSObject.Properties[$t]) { [double]$ConfidenceRaw.$t } else { 0.0 }
                $Confidence[$t] = $v
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

    foreach ($Node in $Targets) {
        $NodeId = [string]$Node.id

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
        $Final = if ($Status -eq 'accepted') { @($Primary.Types) } else { $null }

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
    foreach ($p in $ExistingProposals.Values) { $AllProposals.Add($p) }
    foreach ($p in $NewProposals) { $AllProposals.Add($p) }

    $File = [ordered]@{
        version    = 1
        run_id     = $RunId
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
    $TypeCounts = [ordered]@{}
    foreach ($t in $ValidTypes) { $TypeCounts[$t] = 0 }
    $EmptyCount = 0
    foreach ($p in $NewProposals) {
        $types = @($p.proposed)
        if ($types.Count -eq 0) { $EmptyCount++ }
        foreach ($t in $types) { if ($TypeCounts.Contains($t)) { $TypeCounts[$t]++ } }
    }
    $ReviewQueueCount = @($NewProposals | Where-Object { $_.status -eq 'pending' }).Count
    $AgreementRate = if ($CompareCount -gt 0) { [Math]::Round($AgreeCount / $CompareCount, 4) } else { $null }

    Write-Host ""
    Write-Host "Classified: $($NewProposals.Count) | Skipped: $Skipped | Review queue: $ReviewQueueCount | Empty ([]): $EmptyCount | Agreement: $(if ($null -ne $AgreementRate) { "$AgreementRate ($AgreeCount/$CompareCount)" } else { 'n/a (cross-check off)' }) | Actual cost: `$$([Math]::Round($ActualCost, 4))"

    [PSCustomObject]@{
        NodesProcessed   = $NewProposals.Count
        Proposed         = $NewProposals.Count
        Written          = $Written
        ReviewQueueCount = $ReviewQueueCount
        EmptyCount       = $EmptyCount
        TypeCounts       = $TypeCounts
        AgreementRate    = $AgreementRate
        ActualCost       = [Math]::Round($ActualCost, 4)
        CostCeilingHit   = $CostCeilingHit
        Skipped          = $Skipped
        Failed           = @($Failed)
        RunId            = $RunId
        OutputPath       = $OutputPath
    }
}
