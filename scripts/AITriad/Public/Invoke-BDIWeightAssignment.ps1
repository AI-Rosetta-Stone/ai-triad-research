# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-BDIWeightAssignment {
    <#
    .SYNOPSIS
        Assigns confidence (Beliefs), priority (Desires), and operationality (Intentions) to taxonomy nodes.
    .DESCRIPTION
        Implements the multi-signal formulas from docs/weighted-bdi-proposal.md:

        BELIEF CONFIDENCE (0.10–0.95):
          base(epistemic_type, falsifiability)
          + evidence_boost(source_doc_count, +0.05/doc, cap +0.15)
          + debate_boost(debate_ref_count, +0.03/ref, cap +0.10)
          + edge_boost(supports - attacks, range -0.05 to +0.05)

        DESIRE PRIORITY (1–5):
          5 = doctrinal boundary (from POVER_INFO)
          4 = root-level (no parent)
          3 = mid-tree (has parent + children)
          2 = leaf (has parent, no children)

        Reads source_evidence_index.json for evidence counts and edges.json
        for edge balance. Writes results back to taxonomy JSON files with
        history entries.
    .PARAMETER POV
        One or more POVs to process. Default: all three.
    .PARAMETER DryRun
        Show computed values without writing to files.
    .PARAMETER DoctrinalBoundaryMap
        Hashtable mapping POV name to array of Desire node IDs that are
        doctrinal boundaries (priority 5). If omitted, uses semantic matching
        against POVER_INFO boundary strings.
    .EXAMPLE
        Invoke-BDIWeightAssignment
    .EXAMPLE
        Invoke-BDIWeightAssignment -DryRun
    .EXAMPLE
        Invoke-BDIWeightAssignment -POV accelerationist
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-AIByUsage
    .LINK
        Invoke-EdgeWeightEvaluation
    .LINK
        Invoke-VernacularBatch
    .LINK
        Invoke-AphorismBatch
    .LINK
        New-SyntheticCorpus
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [ValidateSet('accelerationist', 'safetyist', 'skeptic')]
        [string[]]$POV = @('accelerationist', 'safetyist', 'skeptic'),

        [switch]$DryRun,

        [hashtable]$DoctrinalBoundaryMap
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir = Get-TaxonomyDir
    $Today  = Get-Date -Format 'yyyy-MM-dd'

    # ── Load inputs (t/3910: each loader WARNs + returns empty on a missing file) ──
    Write-Host 'Loading data...' -ForegroundColor Cyan
    $SourceDocCounts = Get-SourceEvidenceDocCounts -Path (Join-Path $TaxDir 'source_evidence_index.json') `
        -Resolution (Get-DefaultSourceResolution -Caller 'Invoke-BDIWeightAssignment')
    $EdgeCounts      = Get-EdgeBalanceCounts -Path (Join-Path $TaxDir 'edges.json')
    # Root-level Desires get priority 5 only via -DoctrinalBoundaryMap; with no map, tree position only.
    $DocBoundaryIds  = Resolve-DoctrinalBoundaryIds -Map $DoctrinalBoundaryMap

    # ── Process each POV ──────────────────────────────────────────────────
    $Totals = @{ Beliefs = 0; Desires = 0; Intentions = 0 }

    foreach ($PovName in $POV) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) {
            Write-Warning "Taxonomy file not found: $FilePath"
            continue
        }

        $Data = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)
        $Nodes = @($Data.nodes)
        Write-Host "`n── $PovName ($($Nodes.Count) nodes) ──" -ForegroundColor Cyan

        # Statement-form assignment, NOT `$x = if (...) {...}`: an if-expression's output is enumerated,
        # so an empty HashSet would arrive as $null and a non-empty one as loose strings.
        if ($DocBoundaryIds.ContainsKey($PovName)) {
            $BoundarySet = $DocBoundaryIds[$PovName]
        } else {
            $BoundarySet = [System.Collections.Generic.HashSet[string]]::new()
        }
        $Context = @{ SourceDocCounts = $SourceDocCounts; Supports = $EdgeCounts.Supports; Attacks = $EdgeCounts.Attacks; BoundarySet = $BoundarySet }
        $Counts = @{ Beliefs = 0; Desires = 0; Intentions = 0 }
        foreach ($Node in $Nodes) {
            $Kind = Invoke-BdiNodeWeight -Node $Node -Context $Context -Today $Today -DryRun:$DryRun
            if ($Kind) { $Counts[$Kind]++ }
        }

        Write-Host "  Beliefs: $($Counts.Beliefs) confidence scores assigned" -ForegroundColor Green
        Write-Host "  Desires: $($Counts.Desires) priorities assigned" -ForegroundColor Green
        Write-Host "  Intentions: $($Counts.Intentions) operationality scores assigned" -ForegroundColor Green
        foreach ($K in 'Beliefs', 'Desires', 'Intentions') { $Totals[$K] += $Counts[$K] }

        # Write back — the one write per POV file (TL t/3910#10 cond 2 pins this).
        if (-not $DryRun -and $PSCmdlet.ShouldProcess("$PovName.json", 'Write confidence + priority + operationality')) {
            Write-PovTaxonomyFile -Path $FilePath -Data $Data   # canonical TS format (t/4356)
            Write-Host "  Saved $PovName.json" -ForegroundColor Green
        }
    }

    # ── Summary ───────────────────────────────────────────────────────────
    Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
    Write-Host "  Belief nodes:     $($Totals.Beliefs) confidence scores"
    Write-Host "  Desire nodes:     $($Totals.Desires) priorities"
    Write-Host "  Intention nodes:  $($Totals.Intentions) operationality scores"
    if ($DryRun) { Write-Host "  (DRY RUN — no files written)" -ForegroundColor Yellow }
}
