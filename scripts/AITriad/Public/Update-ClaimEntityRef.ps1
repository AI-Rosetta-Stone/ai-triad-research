# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-ClaimEntityRef {
    <#
    .SYNOPSIS
        Resolve and (re)write entity_refs[] onto summary claims — the claim-side entity
        grounding pass (t/3124, claims-entity-fol-recommendations.md §4/R2.3).
    .DESCRIPTION
        The post-extraction resolution pass that grounds claims to the entity register. For
        every summary under Get-SummariesDir (or -SummariesPath), it walks each
        pov_summaries.<pov>.key_points[] (text = .point) and each top-level factual_claims[]
        (text = .claim) and writes an entity_refs[] array of EntityLinkRef records
        (lib/entities/types.ts, t/3157):

            { ref, surface, method: exact|alias, link_confidence: 1.0, match_level: 'exact', status: 'linked' }

        Resolution is PRECISE-ONLY — surface/alias word-boundary matching against the approved
        entity register — mirroring CL's shipped node reconciler
        (research/comp-linguist/scripts/reconcile_grounding.py). Entities are deliberately NOT
        embedding-linked here (claims-entity-fol-recommendations.md §13.3: entity embedding is
        propose-only, never an auto-link; the "Andreessen cos-matches 45 nodes it doesn't
        mention" over-link). The refs are written by THIS pass, never by the extraction LLM
        (R2.3 — "Do not ask the extraction LLM to emit register IDs it cannot reliably know").

        Idempotent: a claim whose resolved refs equal what is already persisted is not
        rewritten, and a file is written only when at least one of its claims changed (unless
        -Force). A claim that resolves to nothing has any prior entity_refs REMOVED (absence ==
        "no links yet", never an empty-array sentinel), matching the node reconciler.

        DERIVED artifact discipline: entity_refs[] is a rebuildable projection of (claim text ×
        approved register). Re-running after a register change or a claim edit refreshes it.
    .PARAMETER SummariesPath
        Summary JSON files to process. Default: every *.json directly under Get-SummariesDir.
        Pass explicit paths (fixtures/tests) or a subset to scope a run. Absent files are
        skipped with a warning (non-fatal).
    .PARAMETER EntitiesPath
        Override entities.json path (fixtures/tests). Defaults to Get-EntitiesFilePath.
    .PARAMETER Status
        Which entity statuses are grounding targets. Default @('approved') — the
        caller-filters-to-approved contract (only approved entities are eligible link targets;
        the resolution ladder's cosine rung is fed from approved vectors, and precise links
        follow the same discipline).
    .PARAMETER Force
        Rewrite each scanned file even when its claims are unchanged.
    .OUTPUTS
        [pscustomobject] with FilesScanned, FilesWritten, ClaimsProcessed, RefsWritten,
        AliasCount, IndexedStatus, and PerFile[] detail.
    .EXAMPLE
        Update-ClaimEntityRef
        Grounds every summary against the approved register, writing only changed files.
    .EXAMPLE
        Update-ClaimEntityRef -SummariesPath ./summaries/170306856v3-2026.json -WhatIf
        Previews the claim-entity resolution for one summary without writing.
    .LINK
        Update-EntityMentionIndex
    .LINK
        Invoke-EntityExtraction
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string[]]$SummariesPath,

        [Parameter()]
        [string]$EntitiesPath,

        [Parameter()]
        [ValidateSet('proposed', 'approved', 'deprecated')]
        [string[]]$Status = @('approved'),

        [Parameter()]
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # --- Entity register + alias table -----------------------------------------------------
    $EntPath = if ($EntitiesPath) { $EntitiesPath } else { Get-EntitiesFilePath }
    $Store = Get-EntitiesStore -Path $EntPath -InitIfMissing
    $Entities = if ($Store.PSObject.Properties['entities']) { @($Store.entities) } else { @() }
    $AliasEntries = @(Get-EntityAliasEntry -Entities $Entities -Status $Status)

    if ($AliasEntries.Count -eq 0) {
        # Fallback-path logging (docs/error-handling.md): an empty alias table means every
        # claim resolves to nothing and any prior entity_refs are cleared. That is correct when
        # the register genuinely has no in-scope entities, but is worth surfacing so an
        # unexpectedly-empty register (e.g. nothing approved yet) is visible, not silent.
        Write-Warning "Update-ClaimEntityRef: no in-scope entities (status: $($Status -join ',')) in $EntPath — entity_refs will be cleared from all scanned claims."
    }

    # --- Resolve target summary files ------------------------------------------------------
    if ($PSBoundParameters.ContainsKey('SummariesPath')) {
        $SummaryFiles = @($SummariesPath)
    }
    else {
        $SummDir = Get-SummariesDir
        if (Test-Path -LiteralPath $SummDir) {
            # duplicate_of (t/4337 C1): a marked copy's summary isn't enriched.
            $All = @(Get-ChildItem -LiteralPath $SummDir -Filter '*.json' -File | Sort-Object -Property Name)
            $SummaryFiles = @(Select-SelectableSummaryFile -Files $All -Resolution (Get-DefaultSourceResolution -Caller 'Update-ClaimEntityRef') |
                    ForEach-Object { $_.FullName })
        }
        else {
            Write-Warning "Update-ClaimEntityRef: summaries dir not found ($SummDir); nothing to process."
            $SummaryFiles = @()
        }
    }

    # --- Per-file resolve + conditional write ----------------------------------------------
    $perFile = [System.Collections.Generic.List[object]]::new()
    $filesWritten = 0
    $claimsTotal = 0
    $refsTotal = 0

    foreach ($file in $SummaryFiles) {
        if (-not (Test-Path -LiteralPath $file)) {
            Write-Warning "Update-ClaimEntityRef: summary file not found ($file); skipping."
            continue
        }

        try {
            # ConvertFrom-JsonPreserveShape (NOT ConvertFrom-Json): PS 7.4 mutates document shape on
            # a whole-file round-trip — it coerces ISO datetimes to [datetime] (re-emitting
            # measured_at/generated_at in a different offset) AND unwraps single-element arrays to
            # scalars (vocabulary_terms: ["x"] -> "x"). The re-serialize below would bake both into
            # fields this pass never targeted (t/3124 follow-up; class of ConvertFrom-EdgesJson/t/2974).
            $summary = ConvertFrom-JsonPreserveShape -Json (Get-Content -Raw -LiteralPath $file -Encoding utf8)
        }
        catch {
            # Fallback-path logging: an unreadable/invalid summary is skipped rather than
            # aborting the whole batch (one bad file must not strand the rest).
            Write-Warning "Update-ClaimEntityRef: could not parse $file ($($_.Exception.Message)); skipping."
            continue
        }

        $stats = Set-ClaimEntityRef -Summary $summary -AliasEntries $AliasEntries
        $claimsTotal += $stats.ClaimsProcessed
        $refsTotal += $stats.RefsWritten

        $write = $stats.Changed -or $Force
        $written = $false
        if ($write -and $PSCmdlet.ShouldProcess($file, "Write entity_refs[] ($($stats.RefsWritten) ref(s) over $($stats.ClaimsProcessed) claim(s))")) {
            Assert-DataWriteAllowed -Path $file
            $json = $summary | ConvertTo-Json -Depth 20
            $tmp = "$file.tmp"
            try {
                Set-Content -LiteralPath $tmp -Value $json -Encoding utf8NoBOM
                [System.IO.File]::Move($tmp, $file, $true)
            }
            catch {
                if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                throw (New-ActionableError -PassThru `
                        -Goal 'Write claim entity_refs into the summary file' `
                        -Problem "Failed to write ${file}: $($_.Exception.Message)" `
                        -Location 'Update-ClaimEntityRef' `
                        -NextSteps @('Verify the data-repo path is writable', 'Check disk space and that the summaries directory exists') `
                        -InnerError $_)
            }
            $written = $true
            $filesWritten++
        }

        $perFile.Add([pscustomobject]@{
                File            = $file
                ClaimsProcessed = $stats.ClaimsProcessed
                RefsWritten     = $stats.RefsWritten
                Changed         = $stats.Changed
                Written         = $written
            })
    }

    return [pscustomobject]@{
        FilesScanned    = @($SummaryFiles).Count
        FilesWritten    = $filesWritten
        ClaimsProcessed = $claimsTotal
        RefsWritten     = $refsTotal
        AliasCount      = $AliasEntries.Count
        IndexedStatus   = @($Status | Sort-Object -Unique)
        PerFile         = $perFile.ToArray()
    }
}
