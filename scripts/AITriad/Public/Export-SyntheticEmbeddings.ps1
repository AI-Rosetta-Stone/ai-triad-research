# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Export-SyntheticEmbeddings {
    <#
    .SYNOPSIS
        Exports synthetic corpus embeddings in dual format (JSON + NumPy).
    .DESCRIPTION
        Embeds all non-pruned corpus statements and exports in two formats:
        - NumPy: {pov}_vectors.npy + {pov}_index.json (for PS/Python pipeline)
        - JSON: synthetic_embeddings.json (for TS attribution pipeline)

        Both formats are written to the synthetic corpus directory.
    .PARAMETER CorpusPath
        Path to synthetic corpus directory. Defaults to taxonomy/Origin/synthetic/.
    .PARAMETER OutputPath
        Override output directory (default: same as CorpusPath).
    .PARAMETER Format
        Output format: numpy, json, or all (default: all).
    .EXAMPLE
        Export-SyntheticEmbeddings
        # Exports both formats to the default location.
    .EXAMPLE
        Export-SyntheticEmbeddings -Format json
        # JSON only (for TS pipeline).
    .LINK
        Show-AITriadHelp
    .LINK
        New-SyntheticCorpus
    .LINK
        Sync-SyntheticCorpus
    .LINK
        Update-SyntheticCorpus
    .LINK
        Compare-EmbeddingModel
    .LINK
        Test-RerankerBaseline
    #>
    [CmdletBinding()]
    param(
        [string]$CorpusPath,
        [string]$OutputPath,

        [ValidateSet('numpy', 'json', 'all')]
        [string]$Format = 'all'
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $CorpusScript = Join-Path $script:RepoRoot 'scripts/generate_corpus.py'
    $TaxDir = Get-TaxonomyDir
    if (-not $CorpusPath) { $CorpusPath = Join-Path $TaxDir 'synthetic' }

    if (-not (Test-Path $CorpusPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Export synthetic embeddings' `
            -Problem "Corpus directory not found: $CorpusPath" `
            -Location 'Export-SyntheticEmbeddings' `
            -NextSteps 'Generate the corpus first with New-SyntheticCorpus.')
    }

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    Write-Host "`nExport Synthetic Embeddings — format: $Format" -ForegroundColor Cyan
    Write-Host "  Corpus: $CorpusPath" -ForegroundColor DarkGray

    $PyArgs = @('export-embeddings', '--taxonomy-dir', $TaxDir, '--format', $Format)
    if ($OutputPath) { $PyArgs += @('--output-dir', $OutputPath) }

    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $RawOutput = & $PythonCmd $CorpusScript @PyArgs 2>&1 }
    finally { $ErrorActionPreference = $PrevEAP }

    $StdOut = @($RawOutput | Where-Object { $_ -is [string] }) -join "`n"
    $StdErr = @($RawOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) | ForEach-Object { $_.ToString() }
    if ($StdErr) { $StdErr | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Export synthetic embeddings' `
            -Problem "generate_corpus.py export-embeddings failed (exit $LASTEXITCODE)" `
            -Location 'Export-SyntheticEmbeddings' `
            -NextSteps "Check that sentence-transformers is installed and corpus files exist.`n$StdErr")
    }

    $Result = $StdOut | ConvertFrom-Json

    Write-Host "`n  Export complete — $($Result.nodes) nodes embedded." -ForegroundColor Green
    Write-Host ""

    return $Result
}
