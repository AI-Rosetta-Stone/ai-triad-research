# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-SyntheticCorpus {
    <#
    .SYNOPSIS
        Incrementally updates the synthetic corpus for stale, deleted, or new nodes.
    .DESCRIPTION
        Compares current node description hashes against the description_hash stored
        in corpus entries. Stale entries (hash mismatch) and entries for deleted nodes
        are removed. New nodes not yet in the corpus are identified. Affected nodes
        plus their confusable neighbors are regenerated via New-SyntheticCorpus.
    .PARAMETER Pov
        Which POV camp to update (default: all).
    .PARAMETER Force
        Regenerate all entries regardless of staleness.
    .EXAMPLE
        Update-SyntheticCorpus -Pov acc
    .EXAMPLE
        Update-SyntheticCorpus -Force
    .LINK
        Show-AITriadHelp
    .LINK
        New-SyntheticCorpus
    .LINK
        Sync-SyntheticCorpus
    .LINK
        Export-SyntheticEmbeddings
    .LINK
        Compare-EmbeddingModel
    .LINK
        Test-RerankerBaseline
    #>
    [CmdletBinding()]
    param(
        [ValidateSet('acc', 'saf', 'skp', 'all')]
        [string]$Pov = 'all',

        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $CorpusScript = Join-Path $script:RepoRoot 'scripts/generate_corpus.py'
    $TaxDir = Get-TaxonomyDir
    $SyntheticDir = Join-Path $TaxDir 'synthetic'

    if (Get-Command python -ErrorAction SilentlyContinue) { $PythonCmd = 'python' } else { $PythonCmd = 'python3' }

    # ── Get current description hashes ──────────────────────────────────
    Write-Host "`nUpdate Synthetic Corpus — computing description hashes..." -ForegroundColor Cyan

    $PrevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $HashOutput = & $PythonCmd $CorpusScript get-hashes --taxonomy-dir $TaxDir 2>$null }
    finally { $ErrorActionPreference = $PrevEAP }

    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal    'Update synthetic corpus' `
            -Problem "generate_corpus.py get-hashes failed (exit $LASTEXITCODE)" `
            -Location 'Update-SyntheticCorpus' `
            -NextSteps 'Check that generate_corpus.py and prerequisite artifacts exist.')
    }

    $CurrentHashes = ($HashOutput -join '') | ConvertFrom-Json -AsHashtable

    # ── Scan corpus files for stale entries ─────────────────────────────
    $Povs = if ($Pov -eq 'all') { @('acc', 'saf', 'skp') } else { @($Pov) }
    $StaleNodes = [System.Collections.Generic.HashSet[string]]::new()
    $OrphanedNodes = [System.Collections.Generic.HashSet[string]]::new()
    $NewNodes = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($P in $Povs) {
        $CorpusPath = Join-Path $SyntheticDir "corpus_$P.json"
        if (-not (Test-Path $CorpusPath)) {
            foreach ($Key in $CurrentHashes.Keys) {
                if ($Key.StartsWith("$P-")) { [void]$NewNodes.Add($Key) }
            }
            continue
        }

        $Corpus = Get-Content -Raw -Path $CorpusPath | ConvertFrom-Json
        $CorpusNodeIds = [System.Collections.Generic.HashSet[string]]::new()

        foreach ($Entry in @($Corpus.entries)) {
            $Nid = $Entry.node_id
            [void]$CorpusNodeIds.Add($Nid)

            if (-not $CurrentHashes.ContainsKey($Nid)) {
                [void]$OrphanedNodes.Add($Nid)
            }
            elseif ($Force) {
                [void]$StaleNodes.Add($Nid)
            }
            elseif ($Entry.PSObject.Properties['description_hash'] -and $Entry.description_hash -ne $CurrentHashes[$Nid]) {
                [void]$StaleNodes.Add($Nid)
            }
        }

        foreach ($Key in $CurrentHashes.Keys) {
            if ($Key.StartsWith("$P-") -and -not $CorpusNodeIds.Contains($Key)) {
                [void]$NewNodes.Add($Key)
            }
        }
    }

    # ── Report ──────────────────────────────────────────────────────────
    Write-Host "`n  Stale nodes (description changed): $($StaleNodes.Count)" -ForegroundColor $(if ($StaleNodes.Count -gt 0) { 'Yellow' } else { 'Green' })
    Write-Host "  Orphaned nodes (deleted from taxonomy): $($OrphanedNodes.Count)" -ForegroundColor $(if ($OrphanedNodes.Count -gt 0) { 'Yellow' } else { 'Green' })
    Write-Host "  New nodes (not yet in corpus): $($NewNodes.Count)" -ForegroundColor $(if ($NewNodes.Count -gt 0) { 'Yellow' } else { 'Green' })

    if ($OrphanedNodes.Count -gt 0) {
        Write-Host "  Orphaned: $($OrphanedNodes -join ', ')" -ForegroundColor DarkGray
    }

    $NodesToRegenerate = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($n in $StaleNodes) { [void]$NodesToRegenerate.Add($n) }
    foreach ($n in $NewNodes) { [void]$NodesToRegenerate.Add($n) }

    if ($NodesToRegenerate.Count -eq 0 -and $OrphanedNodes.Count -eq 0) {
        Write-Host "`n  Corpus is up to date — nothing to do." -ForegroundColor Green
        return
    }

    # ── Remove orphaned entries ─────────────────────────────────────────
    if ($OrphanedNodes.Count -gt 0) {
        foreach ($P in $Povs) {
            $CorpusPath = Join-Path $SyntheticDir "corpus_$P.json"
            if (-not (Test-Path $CorpusPath)) { continue }
            $Corpus = Get-Content -Raw -Path $CorpusPath | ConvertFrom-Json
            $Cleaned = @($Corpus.entries | Where-Object { -not $OrphanedNodes.Contains($_.node_id) })
            $Corpus.entries = $Cleaned
            $Corpus.entry_count = $Cleaned.Count
            Assert-DataWriteAllowed -Path $CorpusPath  # t/2902
            $Corpus | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path $CorpusPath -Encoding UTF8
        }
        Write-Host "  Removed $($OrphanedNodes.Count) orphaned node entries." -ForegroundColor Yellow
    }

    # ── Regenerate stale + new nodes ────────────────────────────────────
    if ($NodesToRegenerate.Count -gt 0) {
        Write-Host "`n  Regenerating $($NodesToRegenerate.Count) nodes..." -ForegroundColor Cyan
        $NodeList = @($NodesToRegenerate) | Sort-Object
        New-SyntheticCorpus -PilotNodes $NodeList
    }
}
