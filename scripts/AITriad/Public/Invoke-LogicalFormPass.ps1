# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-LogicalFormPass {
    <#
    .SYNOPSIS
        Formalize summary claims into neo-Davidsonian first-order logical forms (t/3215).
    .DESCRIPTION
        The FOL track's Phase-1 formalization pass (schema of record: t/3126,
        research/comp-linguist/docs/logical-form-schema.md). For every summary under
        Get-SummariesDir (or -SummariesPath) it walks each pov_summaries.<pov>.key_points[] (a BDI
        claim) and each top-level factual_claims[], renders the logical-form-formalization prompt per
        claim, invokes the `enrichment.logical-form-formalization` UsageID, then GROUNDS + VALIDATES
        the model output before attaching it as claim.logical_form.

        PIPELINE POSITION. This runs AFTER Update-ClaimEntityRef (t/3124): it reads the entity_refs[]
        that pass writes and joins each to the register's dolce_category to fill args[].sort. (The AC's
        "wired in Invoke-DocumentSummary after entity resolution" is not literally possible —
        entity_refs are a post-extraction artifact written to summaries on disk, not produced inside
        the extractor — so, like Update-ClaimEntityRef, this is a standalone pass over on-disk
        summaries. See t/3215#1.)

        GROUNDING IS ENFORCED, NOT TRUSTED (schema §8.1, R6/t/2294). Every ent-* argument the model
        emits must appear in the claim's own entity_refs[] or it is dropped (no minted ids); sort +
        match_level for a grounded arg are copied from the register/entity_ref, never the model's guess
        (one-identity, §7.4). modality is mechanical (holder=camp, attitude=category); factual claims
        get modality:null. A model output that fails enum validation is skipped (counted), never
        persisted — nothing downstream trusts a logical_form until CL's formalization_accuracy gate
        measures it, so a malformed one must not leak in.

        SELECTION. By default only claims carrying entity_refs[] are processed (the D3b-stratifiable,
        grounded set) — pass -IncludeUngrounded to also formalize claims with no register links (all
        arguments become lit:"…"). A claim that already has a logical_form is skipped unless -Force
        (LLM calls are not free and are non-deterministic, so re-running is opt-in). -MaxClaims caps
        the number of model calls for a bounded first batch.

        Idempotent at the file level: a summary is rewritten only when at least one of its claims
        gained or changed a logical_form. Uses ConvertFrom-JsonPreserveShape so appending logical_form
        never mutates untargeted fields (ISO datetimes, single-element arrays — same discipline as
        Update-ClaimEntityRef, t/3124 follow-up).
    .PARAMETER SummariesPath
        Summary JSON files to process. Default: every *.json directly under Get-SummariesDir. Absent
        files are skipped with a warning (non-fatal — one bad file must not strand the batch).
    .PARAMETER EntitiesPath
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER MaxClaims
        Cap on the number of claims formalized this run (a bounded first batch for the CL D3b handoff).
        Default: no cap.
    .PARAMETER IncludeUngrounded
        Also formalize claims that carry no entity_refs[] (every arg becomes a lit:). Default: skip
        them — the grounded set is what the golden-set scorer stratifies.
    .PARAMETER Model
        Override the model resolved from the UsageID (experimentation). Default: the UsageID's model.
    .PARAMETER Force
        Re-formalize claims that already have a logical_form (overwrites the prior one).
    .OUTPUTS
        [pscustomobject] FilesScanned, FilesWritten, ClaimsSelected, LogicalFormsWritten,
        RejectedWritten, InvalidDropped, Failed, Skipped, PerFile[].
    .EXAMPLE
        Invoke-LogicalFormPass -MaxClaims 40
        Formalizes up to 40 grounded claims across all summaries — a first batch to hand CL for the
        D3b formalization_accuracy run (score_golden.py).
    .EXAMPLE
        Invoke-LogicalFormPass -SummariesPath ./summaries/170306856v3-2026.json -WhatIf
        Previews formalization for one summary without writing.
    .LINK
        Update-ClaimEntityRef
    .LINK
        Invoke-EntityExtraction
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string[]]$SummariesPath,

        [Parameter()]
        [string]$EntitiesPath,

        [Parameter()]
        [ValidateRange(1, 100000)]
        [int]$MaxClaims,

        [Parameter()]
        [switch]$IncludeUngrounded,

        [Parameter()]
        [ValidateScript({ Test-AIModelId $_ })]
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ValidModelIds | Where-Object { $_ -like "$word*" } })]
        [string]$Model,

        [Parameter()]
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Entity register → dolce_category map (the sort join the entity_ref lacks) ─────────
    $entPath = if ($EntitiesPath) { $EntitiesPath } else { Get-EntitiesFilePath }
    $store    = Get-EntitiesStore -Path $entPath -InitIfMissing
    $entities = @()
    if ($store.PSObject.Properties['entities'] -and $store.entities) { $entities = @($store.entities) }
    $dolceMap = Get-EntityDolceMap -Entities $entities
    if ($dolceMap.Count -eq 0) {
        # Fallback-path logging (docs/error-handling.md): with no register sorts, every ent-* arg is
        # ungroundable and drops to lit:/nothing. Correct when the register is genuinely empty, but
        # worth surfacing so an unexpectedly-empty register is visible, not silent.
        Write-Warning "Invoke-LogicalFormPass: no entities with dolce_category in $entPath — ent-* args cannot be grounded (all participants will be literals)."
    }

    # ── Resolve target summary files ─────────────────────────────────────────────────────
    if ($PSBoundParameters.ContainsKey('SummariesPath')) {
        $summaryFiles = @($SummariesPath)
    }
    else {
        $summDir = Get-SummariesDir
        if (Test-Path -LiteralPath $summDir) {
            # duplicate_of (t/4337 C1): no AI pass over a marked copy's summary.
            $all = @(Get-ChildItem -LiteralPath $summDir -Filter '*.json' -File | Sort-Object -Property Name)
            $summaryFiles = @(Select-SelectableSummaryFile -Files $all -Resolution (Get-DefaultSourceResolution -Caller 'Invoke-LogicalFormPass') |
                    ForEach-Object { $_.FullName })
        }
        else {
            Write-Warning "Invoke-LogicalFormPass: summaries dir not found ($summDir); nothing to process."
            $summaryFiles = @()
        }
    }

    $overrideModel = $PSBoundParameters.ContainsKey('Model')

    # ── Per-file resolve + conditional write ─────────────────────────────────────────────
    $perFile        = [System.Collections.Generic.List[object]]::new()
    $filesWritten   = 0
    $claimsSelected = 0
    $formsWritten   = 0
    $rejectedWritten = 0
    $invalidDropped = 0
    $failed         = 0
    $skipped        = 0
    $capReached     = $false

    foreach ($file in $summaryFiles) {
        if ($capReached) { break }
        if (-not (Test-Path -LiteralPath $file)) {
            Write-Warning "Invoke-LogicalFormPass: summary file not found ($file); skipping."
            continue
        }

        try {
            $summary = ConvertFrom-JsonPreserveShape -Json (Get-Content -Raw -LiteralPath $file -Encoding utf8)
        }
        catch {
            Write-Warning "Invoke-LogicalFormPass: could not parse $file ($($_.Exception.Message)); skipping."
            continue
        }

        # Collect the claims for this summary: BDI key_points then factual_claims.
        $claims = [System.Collections.Generic.List[object]]::new()
        if ($summary.PSObject.Properties['pov_summaries'] -and $summary.pov_summaries) {
            foreach ($pov in @('accelerationist', 'safetyist', 'skeptic')) {
                if (-not $summary.pov_summaries.PSObject.Properties[$pov]) { continue }
                $povData = $summary.pov_summaries.$pov
                if (-not $povData -or -not $povData.PSObject.Properties['key_points'] -or -not $povData.key_points) { continue }
                foreach ($kp in @($povData.key_points)) {
                    $nodeId   = if ($kp.PSObject.Properties['taxonomy_node_id']) { [string]$kp.taxonomy_node_id } else { '' }
                    $category = if ($kp.PSObject.Properties['category']) { [string]$kp.category } else { '' }
                    $claims.Add([pscustomobject]@{ Claim = $kp; IsFactual = $false; Category = $category; Camp = (Get-ClaimCamp -NodeId $nodeId) })
                }
            }
        }
        if ($summary.PSObject.Properties['factual_claims'] -and $summary.factual_claims) {
            foreach ($fc in @($summary.factual_claims)) {
                $claims.Add([pscustomobject]@{ Claim = $fc; IsFactual = $true; Category = 'factual'; Camp = '' })
            }
        }

        $fileChanged = $false
        $fileForms   = 0

        foreach ($entry in $claims) {
            if ($capReached) { break }
            $claim = $entry.Claim

            # Idempotence: skip a claim that already carries a logical_form unless -Force.
            if (-not $Force -and $claim.PSObject.Properties['logical_form'] -and $claim.logical_form) {
                $skipped++
                continue
            }

            # Direct-assign the empty case: an `if (...) { @() }` EXPRESSION collapses to $null on
            # assignment (PS gotcha, same as ClaimEntityResolution), which would null-deref .Count below.
            $refs = @()
            if ($claim.PSObject.Properties['entity_refs'] -and $claim.entity_refs) { $refs = @($claim.entity_refs) }
            if ($refs.Count -eq 0 -and -not $IncludeUngrounded) {
                $skipped++
                continue   # not in the grounded set
            }
            # concept_refs[] (term:* universals, t/3389 Option C): grounds the about[]->topical_candidates
            # split. Optional/empty on summary claims today (0 present), so this is dormant-but-correct;
            # the grounded-set gate above stays keyed on entity_refs only (a claim with only concept_refs
            # is not part of the D3b-stratifiable grounded set).
            $conceptRefs = @()
            if ($claim.PSObject.Properties['concept_refs'] -and $claim.concept_refs) { $conceptRefs = @($claim.concept_refs) }

            $proposition = Get-ClaimProposition -Claim $claim -IsFactual:$entry.IsFactual
            if ([string]::IsNullOrWhiteSpace($proposition)) {
                $skipped++
                continue   # nothing to formalize
            }

            $refTable = Get-LogicalFormRefTable -EntityRefs $refs -DolceMap $dolceMap -ConceptRefs $conceptRefs
            $refsJson = ConvertTo-EntityRefsPromptJson -RefTable $refTable
            $claimCategory = if ($entry.IsFactual) { 'factual' } else { $entry.Category }

            if (-not $PSCmdlet.ShouldProcess("claim in $(Split-Path $file -Leaf)", 'Formalize logical_form via enrichment.logical-form-formalization')) {
                continue
            }

            $claimsSelected++
            # Cap on ATTEMPTS, not successes (t/3215#3 (c)): set here — right after this attempt is
            # counted — so invalid/failed forms still consume the budget. The prior cap-on-success
            # placement let a run of dropped forms blow past -MaxClaims (unbounded paid-spend hazard).
            if ($MaxClaims -and $claimsSelected -ge $MaxClaims) { $capReached = $true }

            # Render the prompt (Get-Prompt substitutes {{...}} case-sensitively).
            $rendered = Get-Prompt -Name 'logical-form-formalization' -Replacements @{
                CLAIM_CATEGORY = $claimCategory
                CAMP           = $entry.Camp
                PROPOSITION    = $proposition
                ENTITY_REFS    = $refsJson
            }

            # ── Model call ────────────────────────────────────────────────────────────────
            try {
                $override = @{}
                if ($overrideModel) { $override['model'] = $Model }
                $ai = Invoke-AIByUsage -UsageId 'enrichment.logical-form-formalization' `
                    -Values @{ prompt = $rendered } -Override $override
            }
            catch {
                $failed++
                Write-Warning "Invoke-LogicalFormPass: model call failed for a claim in $(Split-Path $file -Leaf): $($_.Exception.Message)"
                continue
            }

            if ($null -eq $ai -or -not $ai.Text) {
                $failed++
                Write-Warning "Invoke-LogicalFormPass: empty model response for a claim in $(Split-Path $file -Leaf)."
                continue
            }

            # Defensive fence-strip + parse (prompt says raw JSON, but models sometimes fence).
            $body = [string]$ai.Text
            $body = $body -replace '^\s*```(json)?\s*', ''
            $body = $body -replace '\s*```\s*$', ''
            try {
                $raw = $body.Trim() | ConvertFrom-Json -ErrorAction Stop
            }
            catch {
                $failed++
                Write-Warning "Invoke-LogicalFormPass: unparseable model JSON for a claim in $(Split-Path $file -Leaf): $($_.Exception.Message)"
                continue
            }

            # Ground + validate.
            $lf = ConvertTo-GroundedLogicalForm -Raw $raw -RefTable $refTable -Category $claimCategory -Camp $entry.Camp
            $check = Test-LogicalFormStructure -LogicalForm $lf -Category $claimCategory
            if (-not $check.Ok) {
                $invalidDropped++
                Write-Warning "Invoke-LogicalFormPass: dropped invalid logical_form for a claim in $(Split-Path $file -Leaf): $($check.Reason)"
                continue
            }

            # Attach (guarded set — direct assignment to an absent property throws under StrictMode).
            if ($claim.PSObject.Properties['logical_form']) { $claim.logical_form = $lf }
            else { Add-Member -InputObject $claim -NotePropertyName 'logical_form' -NotePropertyValue $lf -Force }

            $fileChanged = $true
            $fileForms++
            $formsWritten++
            if ([string]$lf.status -eq 'rejected') { $rejectedWritten++ }
            # (cap is set on attempt above, not here — a dropped/failed form still counts, t/3215#3 (c))
        }

        $written = $false
        if ($fileChanged -and $PSCmdlet.ShouldProcess($file, "Write $fileForms logical_form(s)")) {
            Assert-DataWriteAllowed -Path $file   # t/2902
            $tmp = "$file.tmp"
            try {
                $json = $summary | ConvertTo-Json -Depth 20
                Set-Content -LiteralPath $tmp -Value $json -Encoding utf8NoBOM
                [System.IO.File]::Move($tmp, $file, $true)
            }
            catch {
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                throw (New-ActionableError -PassThru `
                        -Goal 'Write claim logical_form into the summary file' `
                        -Problem "Failed to write ${file}: $($_.Exception.Message)" `
                        -Location 'Invoke-LogicalFormPass' `
                        -NextSteps @('Verify the data-repo path is writable', 'Check disk space and that the summaries directory exists') `
                        -InnerError $_)
            }
            $written = $true
            $filesWritten++
        }

        $perFile.Add([pscustomobject]@{
                File             = $file
                Forms            = $fileForms
                Changed          = $fileChanged
                Written          = $written
            })
    }

    Write-Host ""
    Write-Host ("Done. Files: {0} | Logical forms written: {1} (rejected: {2}) | Invalid dropped: {3} | Failed: {4} | Skipped: {5} | Files written: {6}" -f `
            @($summaryFiles).Count, $formsWritten, $rejectedWritten, $invalidDropped, $failed, $skipped, $filesWritten)
    if ($capReached) { Write-Host "  (stopped at -MaxClaims $MaxClaims)" -ForegroundColor DarkYellow }

    return [pscustomobject]@{
        FilesScanned        = @($summaryFiles).Count
        FilesWritten        = $filesWritten
        ClaimsSelected      = $claimsSelected
        LogicalFormsWritten = $formsWritten
        RejectedWritten     = $rejectedWritten
        InvalidDropped      = $invalidDropped
        Failed              = $failed
        Skipped             = $skipped
        PerFile             = $perFile.ToArray()
    }
}
