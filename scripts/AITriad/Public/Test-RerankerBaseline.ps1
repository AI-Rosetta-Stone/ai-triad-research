# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-RerankerBaseline {
    <#
    .SYNOPSIS
        Evaluates cross-encoder reranking on top-K bi-encoder candidates.
    .DESCRIPTION
        Uses the current production bi-encoder embeddings to retrieve top-K
        candidate nodes per golden test claim, then reranks with a cross-encoder
        model and measures MRR lift.

        Gate decision context: if reranking captures >80% of available lift,
        the synthetic corpus investment may not be justified.
    .PARAMETER TopK
        Number of bi-encoder candidates to rerank per claim (default: 10).
    .PARAMETER RerankerModel
        Cross-encoder model name (default: cross-encoder/ms-marco-MiniLM-L-6-v2).
    .PARAMETER GoldenSetPath
        Path to the golden test set JSON. Defaults to research/comp-linguist/_golden_test_set.json.
    .EXAMPLE
        Test-RerankerBaseline
        # Evaluates with default settings (top-10, ms-marco reranker).
    .EXAMPLE
        Test-RerankerBaseline -TopK 20 -RerankerModel 'cross-encoder/ms-marco-MiniLM-L-12-v2'  # model-lint:allow-pin reranker cross-encoder model, not an ai-models.json LLM backend
    .LINK
        Show-AITriadHelp
    .LINK
        New-SyntheticCorpus
    .LINK
        Sync-SyntheticCorpus
    .LINK
        Update-SyntheticCorpus
    .LINK
        Export-SyntheticEmbeddings
    .LINK
        Compare-EmbeddingModel
    #>
    [CmdletBinding()]
    param(
        [ValidateRange(1, 100)]
        [int]$TopK = 10,

        [string]$RerankerModel = 'cross-encoder/ms-marco-MiniLM-L-6-v2',  # model-lint:allow-pin reranker cross-encoder model, not an ai-models.json LLM backend

        [string]$GoldenSetPath
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Resolve paths ───────────────────────────────────────────────────
    if (-not $GoldenSetPath) {
        $GoldenSetPath = Join-Path $script:RepoRoot 'research/comp-linguist/_golden_test_set.json'
    }
    if (-not (Test-Path $GoldenSetPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Run reranker baseline evaluation' `
            -Problem "Golden test set not found: $GoldenSetPath" `
            -Location 'Test-RerankerBaseline' `
            -NextSteps 'Build the golden test set first (CL prerequisite).')
    }

    $EvalScript = Join-Path $script:RepoRoot 'scripts/evaluate_embeddings.py'
    if (-not (Test-Path $EvalScript)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Run reranker baseline evaluation' `
            -Problem "evaluate_embeddings.py not found at $EvalScript" `
            -Location 'Test-RerankerBaseline' `
            -NextSteps 'Ensure scripts/evaluate_embeddings.py exists.')
    }

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    # ── Invoke Python evaluation ────────────────────────────────────────
    Write-Host "`nReranker Baseline — cross-encoder on top-$TopK bi-encoder candidates" -ForegroundColor Cyan
    Write-Host "Reranker: $RerankerModel" -ForegroundColor DarkGray
    Write-Host "Golden set: $GoldenSetPath`n" -ForegroundColor DarkGray

    $TaxDir = Get-TaxonomyDir
    $PyArgs = @('rerank-baseline', '--golden-set', $GoldenSetPath, '--top-k', $TopK, '--reranker-model', $RerankerModel, '--taxonomy-dir', $TaxDir)

    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Output = & $PythonCmd $EvalScript @PyArgs 2>&1
    }
    finally { $ErrorActionPreference = $PrevEAP }

    $StdOut = @($Output | Where-Object { $_ -is [string] }) -join "`n"
    $StdErr = @($Output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) | ForEach-Object { $_.ToString() }
    if ($StdErr) { $StdErr | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray } }

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Run reranker baseline evaluation' `
            -Problem "evaluate_embeddings.py failed (exit code $LASTEXITCODE)" `
            -Location 'Test-RerankerBaseline' `
            -NextSteps "Check that sentence-transformers is installed: pip install sentence-transformers`nStderr: $StdErr")
    }

    $Result = $StdOut | ConvertFrom-Json

    # ── Display results ─────────────────────────────────────────────────
    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    Write-Host " RERANKER BASELINE RESULTS" -ForegroundColor Cyan
    Write-Host "$('═' * 72)" -ForegroundColor Cyan

    Write-Host "`n  $(''.PadRight(20)) $('MRR'.PadLeft(8)) $('R@1'.PadLeft(8)) $('R@3'.PadLeft(8)) $('R@5'.PadLeft(8)) $('R@10'.PadLeft(8))" -ForegroundColor White
    Write-Host "  $('─' * 60)" -ForegroundColor DarkGray

    if ($Result.PSObject.Properties['baseline_biencoder'] -and $Result.baseline_biencoder) {
        $bl = $Result.baseline_biencoder
        $bMrr  = if ($bl.PSObject.Properties['global_mrr'])   { $bl.global_mrr }   else { 0 }
        $bR1   = if ($bl.PSObject.Properties['recall_at_1'])  { $bl.recall_at_1 }  else { 0 }
        $bR3   = if ($bl.PSObject.Properties['recall_at_3'])  { $bl.recall_at_3 }  else { 0 }
        $bR5   = if ($bl.PSObject.Properties['recall_at_5'])  { $bl.recall_at_5 }  else { 0 }
        $bR10  = if ($bl.PSObject.Properties['recall_at_10']) { $bl.recall_at_10 } else { 0 }
        Write-Host "  $('Bi-encoder'.PadRight(20)) $("$bMrr".PadLeft(8)) $("$bR1".PadLeft(8)) $("$bR3".PadLeft(8)) $("$bR5".PadLeft(8)) $("$bR10".PadLeft(8))"

        if ($bl.PSObject.Properties['per_pov'] -and $bl.per_pov) {
            foreach ($PovProp in $bl.per_pov.PSObject.Properties) {
                $p = $PovProp.Value
                $pMrr = if ($p.PSObject.Properties['mrr']) { $p.mrr } else { 0 }
                $pR1  = if ($p.PSObject.Properties['recall_at_1']) { $p.recall_at_1 } else { 0 }
                $pCt  = if ($p.PSObject.Properties['count']) { $p.count } else { 0 }
                Write-Host "    $($PovProp.Name.PadRight(18)) $("$pMrr".PadLeft(8)) $("$pR1".PadLeft(8)) $("(n=$pCt)".PadLeft(8))" -ForegroundColor DarkGray
            }
        }
    }

    if ($Result.PSObject.Properties['reranked'] -and $Result.reranked) {
        $rr = $Result.reranked
        $rMrr  = if ($rr.PSObject.Properties['global_mrr'])   { $rr.global_mrr }   else { 0 }
        $rR1   = if ($rr.PSObject.Properties['recall_at_1'])  { $rr.recall_at_1 }  else { 0 }
        $rR3   = if ($rr.PSObject.Properties['recall_at_3'])  { $rr.recall_at_3 }  else { 0 }
        $rR5   = if ($rr.PSObject.Properties['recall_at_5'])  { $rr.recall_at_5 }  else { 0 }
        $rR10  = if ($rr.PSObject.Properties['recall_at_10']) { $rr.recall_at_10 } else { 0 }
        Write-Host "  $('+ Reranker'.PadRight(20)) $("$rMrr".PadLeft(8)) $("$rR1".PadLeft(8)) $("$rR3".PadLeft(8)) $("$rR5".PadLeft(8)) $("$rR10".PadLeft(8))" -ForegroundColor Green

        if ($rr.PSObject.Properties['per_pov'] -and $rr.per_pov) {
            foreach ($PovProp in $rr.per_pov.PSObject.Properties) {
                $p = $PovProp.Value
                $pMrr = if ($p.PSObject.Properties['mrr']) { $p.mrr } else { 0 }
                $pR1  = if ($p.PSObject.Properties['recall_at_1']) { $p.recall_at_1 } else { 0 }
                $pCt  = if ($p.PSObject.Properties['count']) { $p.count } else { 0 }
                Write-Host "    $($PovProp.Name.PadRight(18)) $("$pMrr".PadLeft(8)) $("$pR1".PadLeft(8)) $("(n=$pCt)".PadLeft(8))" -ForegroundColor DarkGray
            }
        }
    }

    # ── Lift summary ────────────────────────────────────────────────────
    Write-Host "`n$('─' * 72)" -ForegroundColor DarkGray
    if ($Result.PSObject.Properties['lift'] -and $Result.lift) {
        $lift = $Result.lift
        $mrrDelta = if ($lift.PSObject.Properties['mrr_delta']) { $lift.mrr_delta } else { 0 }
        $r1Delta  = if ($lift.PSObject.Properties['recall_at_1_delta']) { $lift.recall_at_1_delta } else { 0 }
        $r5Delta  = if ($lift.PSObject.Properties['recall_at_5_delta']) { $lift.recall_at_5_delta } else { 0 }
        $Color = if ($mrrDelta -gt 0) { 'Green' } else { 'Yellow' }
        Write-Host "  MRR lift:  $("{0:+0.0000;-0.0000;0.0000}" -f $mrrDelta)" -ForegroundColor $Color
        Write-Host "  R@1 lift:  $("{0:+0.0000;-0.0000;0.0000}" -f $r1Delta)" -ForegroundColor $Color
        Write-Host "  R@5 lift:  $("{0:+0.0000;-0.0000;0.0000}" -f $r5Delta)" -ForegroundColor $Color
    }
    if ($Result.PSObject.Properties['elapsed_seconds']) {
        Write-Host "  Elapsed: $($Result.elapsed_seconds)s" -ForegroundColor DarkGray
    }
    Write-Host ""

    return $Result
}
