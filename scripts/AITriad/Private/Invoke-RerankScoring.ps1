# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-RerankScoring {
    <#
    .SYNOPSIS
        Scores (query, candidate) pairs with the cross-encoder for live re-ranking (t/2287).
    .DESCRIPTION
        Thin wrapper over `evaluate_embeddings.py rerank`: pipes a JSON payload via
        stdin and parses the [{id, score, raw}] result. Isolated as a Private helper
        so Get-RelevantTaxonomyNodes' rerank ordering logic stays unit-testable
        without a live model — tests Mock this function.

        NEVER throws — returns $null on any failure (Python/script/model unavailable,
        non-zero exit, empty/invalid output) so the caller degrades to bi-encoder order.
        `score` is the cross-encoder sigmoid (0-1 display scale); `raw` is the logit.
    .PARAMETER Query
        The query text.
    .PARAMETER Candidates
        Array of objects each with `id` and `text` properties (the candidate nodes).
    .PARAMETER RerankerModel
        Cross-encoder model name.
    .OUTPUTS
        [PSCustomObject[]] with id/score/raw properties, or $null on failure.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Query,
        [Parameter(Mandatory)][object[]]$Candidates,
        [string]$RerankerModel = 'cross-encoder/ms-marco-MiniLM-L6-v2'  # model-lint:allow-pin reranker cross-encoder model, not an ai-models.json LLM backend
    )

    Set-StrictMode -Version Latest
    if (@($Candidates).Count -eq 0) { return $null }

    try {
        $EvalScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'evaluate_embeddings.py'
        if (-not (Test-Path $EvalScript)) { $EvalScript = Join-Path $script:ModuleRoot 'evaluate_embeddings.py' }
        if (-not (Test-Path $EvalScript)) {
            Write-Verbose "Invoke-RerankScoring: evaluate_embeddings.py not found at $EvalScript"
            return $null
        }
        if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

        $Payload = ([ordered]@{
                query          = $Query
                candidates     = @($Candidates | ForEach-Object { [ordered]@{ id = $_.id; text = $_.text } })
                reranker_model = $RerankerModel
            } | ConvertTo-Json -Depth 5 -Compress)

        $PrevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $__RrSw = [System.Diagnostics.Stopwatch]::StartNew()
            $RrOut = $Payload | & $PythonCmd $EvalScript rerank --reranker-model $RerankerModel 2>$null
            $__RrSw.Stop()
            Add-StageTiming -Name 'cross-encoder rerank (subprocess)' -Milliseconds $__RrSw.Elapsed.TotalMilliseconds
        }
        finally { $ErrorActionPreference = $PrevEAP }

        if ($LASTEXITCODE -ne 0 -or -not $RrOut -or "$RrOut".Trim().Length -eq 0) {
            Write-Verbose "Invoke-RerankScoring: subprocess failed (exit $LASTEXITCODE) or produced no output"
            return $null
        }
        # ConvertFrom-Json returns a single object for a 1-element array — wrap to guarantee array.
        return @($RrOut | ConvertFrom-Json)
    }
    catch {
        Write-Verbose "Invoke-RerankScoring: $($_.Exception.Message)"
        return $null
    }
}
