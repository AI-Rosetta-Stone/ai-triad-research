# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Compare-EmbeddingModel {
    <#
    .SYNOPSIS
        Encoder ablation: compares MRR across embedding models on the golden test set.
    .DESCRIPTION
        Re-embeds taxonomy nodes and golden test claims with each specified model,
        computes cosine similarity rankings, and reports MRR and Recall@K per model
        with per-POV breakdowns.

        Gate decision context: if an alternative encoder captures >80% of available
        lift, the synthetic corpus investment may not be justified.
    .PARAMETER Models
        Embedding model names to compare (sentence-transformers compatible).
    .PARAMETER GoldenSetPath
        Path to the golden test set JSON. Defaults to research/comp-linguist/_golden_test_set.json.
    .EXAMPLE
        Compare-EmbeddingModel
        # Compares default models (MiniLM, mpnet, BGE) on golden test set.
    .EXAMPLE
        Compare-EmbeddingModel -Models 'all-MiniLM-L6-v2', 'all-mpnet-base-v2'  # model-lint:allow-pin embedding models (sentence-transformers), not ai-models.json LLM backends
        # Compares two specific models.
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
        Test-RerankerBaseline
    #>
    [CmdletBinding()]
    param(
        [string[]]$Models = @('all-MiniLM-L6-v2', 'all-mpnet-base-v2', 'BAAI/bge-base-en-v1.5'),

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
            -Goal    'Run embedding model comparison' `
            -Problem "Golden test set not found: $GoldenSetPath" `
            -Location 'Compare-EmbeddingModel' `
            -NextSteps 'Build the golden test set first (CL prerequisite).')
    }

    $EvalScript = Join-Path $script:RepoRoot 'scripts/evaluate_embeddings.py'
    if (-not (Test-Path $EvalScript)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Run embedding model comparison' `
            -Problem "evaluate_embeddings.py not found at $EvalScript" `
            -Location 'Compare-EmbeddingModel' `
            -NextSteps 'Ensure scripts/evaluate_embeddings.py exists.')
    }

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    $ModelList = $Models -join ','

    # ── Invoke Python evaluation ────────────────────────────────────────
    Write-Host "`nEncoder Ablation — comparing $($Models.Count) models on golden test set" -ForegroundColor Cyan
    Write-Host "Models: $ModelList" -ForegroundColor DarkGray
    Write-Host "Golden set: $GoldenSetPath`n" -ForegroundColor DarkGray

    $TaxDir = Get-TaxonomyDir
    $Args = @('compare-models', '--golden-set', $GoldenSetPath, '--models', $ModelList, '--taxonomy-dir', $TaxDir)

    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Output = & $PythonCmd $EvalScript @Args 2>&1
    }
    finally { $ErrorActionPreference = $PrevEAP }

    $StdOut = @($Output | Where-Object { $_ -is [string] }) -join "`n"
    $StdErr = @($Output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) | ForEach-Object { $_.ToString() }
    if ($StdErr) { $StdErr | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray } }

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Run embedding model comparison' `
            -Problem "evaluate_embeddings.py failed (exit code $LASTEXITCODE)" `
            -Location 'Compare-EmbeddingModel' `
            -NextSteps "Check that sentence-transformers is installed: pip install sentence-transformers`nStderr: $StdErr")
    }

    $Result = $StdOut | ConvertFrom-Json

    # ── Display results ─────────────────────────────────────────────────
    Write-Host "`n$('═' * 72)" -ForegroundColor Cyan
    Write-Host " ENCODER ABLATION RESULTS" -ForegroundColor Cyan
    Write-Host "$('═' * 72)" -ForegroundColor Cyan

    if ($Result.PSObject.Properties['baseline_reference'] -and $Result.baseline_reference) {
        $bl = $Result.baseline_reference
        if ($bl.PSObject.Properties['global_mrr']) {
            Write-Host "`n  Production baseline (weighted multi-field): MRR = $($bl.global_mrr)" -ForegroundColor Yellow
        }
    }

    Write-Host "`n  $('Model'.PadRight(35)) $('MRR'.PadLeft(8)) $('R@1'.PadLeft(8)) $('R@3'.PadLeft(8)) $('R@5'.PadLeft(8)) $('Dim'.PadLeft(6))" -ForegroundColor White
    Write-Host "  $('─' * 73)" -ForegroundColor DarkGray

    $BestModel = $null
    $BestMrr = 0.0
    $ModelNames = @()
    if ($Result.PSObject.Properties['models'] -and $Result.models) {
        foreach ($Prop in $Result.models.PSObject.Properties) {
            $ModelNames += $Prop.Name
        }
    }

    foreach ($Name in $ModelNames) {
        $m = $Result.models.$Name
        $mrr  = if ($m.PSObject.Properties['global_mrr'])  { $m.global_mrr }  else { 0 }
        $r1   = if ($m.PSObject.Properties['recall_at_1']) { $m.recall_at_1 } else { 0 }
        $r3   = if ($m.PSObject.Properties['recall_at_3']) { $m.recall_at_3 } else { 0 }
        $r5   = if ($m.PSObject.Properties['recall_at_5']) { $m.recall_at_5 } else { 0 }
        $dim  = if ($m.PSObject.Properties['dimension'])   { $m.dimension }   else { '?' }
        Write-Host "  $($Name.PadRight(35)) $("$mrr".PadLeft(8)) $("$r1".PadLeft(8)) $("$r3".PadLeft(8)) $("$r5".PadLeft(8)) $("$dim".PadLeft(6))"
        if ($mrr -gt $BestMrr) { $BestMrr = $mrr; $BestModel = $Name }

        if ($m.PSObject.Properties['per_pov'] -and $m.per_pov) {
            foreach ($PovProp in $m.per_pov.PSObject.Properties) {
                $p = $PovProp.Value
                $pMrr = if ($p.PSObject.Properties['mrr']) { $p.mrr } else { 0 }
                $pR1  = if ($p.PSObject.Properties['recall_at_1']) { $p.recall_at_1 } else { 0 }
                $pCt  = if ($p.PSObject.Properties['count']) { $p.count } else { 0 }
                Write-Host "    $($PovProp.Name.PadRight(33)) $("$pMrr".PadLeft(8)) $("$pR1".PadLeft(8)) $("(n=$pCt)".PadLeft(8))" -ForegroundColor DarkGray
            }
        }
    }

    # ── Recommendation ──────────────────────────────────────────────────
    Write-Host "`n$('─' * 72)" -ForegroundColor DarkGray
    if ($Result.PSObject.Properties['recommendation'] -and $Result.recommendation) {
        $rec = $Result.recommendation
        $lift = if ($rec.PSObject.Properties['lift_vs_production']) { $rec.lift_vs_production } else { 0 }
        $liftPct = if ($BestMrr -gt 0) { [Math]::Round($lift / [Math]::Max(0.001, $rec.production_baseline_mrr) * 100, 1) } else { 0 }
        Write-Host "  Best model: $BestModel (MRR $BestMrr)" -ForegroundColor Green
        Write-Host "  Lift vs production: $("{0:+0.0000;-0.0000;0.0000}" -f $lift) ($liftPct%)" -ForegroundColor $(if ($lift -gt 0) { 'Green' } else { 'Yellow' })
    }
    Write-Host ""

    return $Result
}
