# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4468 offline measurement: Arm A (per-key_point recall@set, stratified by
    verbatim/attribution_text position before/after char 2000 of its CHUNK)
    and Arm B (overall displacement guard), OLD query construction (first
    2000 chars of the chunk, single encode) vs NEW (the whole chunk, windowed
    via Split-RagQueryWindows, scored MaxSim and RankFusion). No LLM spend —
    only the local embedding model and the existing, already-generated
    summaries' key_points / taxonomy_node_id ground truth.
.DESCRIPTION
    Read-only against ../ai-triad-sources and ../ai-triad-data. Chunks each
    document with the real Split-DocumentChunks (same MaxChunkTokens default
    as production), locates each key_point's attribution_text (or verbatim
    fallback) inside its chunk by substring search, and records whether its
    own recorded taxonomy_node_id appears anywhere in the RAG candidate set
    built from that chunk under OLD vs NEW query construction. Per-chunk
    candidate sets are computed once and reused across all key_points that
    land in the same chunk.
#>
[CmdletBinding()]
param(
    [string[]]$DocIds = @(
        'foundational-challenges-assuring-alignment-safety-large-2026',
        'generative-ai-copyright-training-creation-regulation-2026',
        'approach-technical-agi-safety-security-2026',
        'ai-as-normal-technology-2026',
        'artificial-intelligence-civil-liability-european-perspective-2026',
        'ai-now-2023-landscape-confronting-tech-power-2026'
    ),
    [string]$SourcesDir = 'C:\Users\jsnov\repos\ai-triad-sources',
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [int]$MaxTotal = 150
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ModulePath = Join-Path $PSScriptRoot '..' '..' 'AITriad' 'AITriad.psm1'
Import-Module $ModulePath -Force -WarningAction SilentlyContinue
$AITriad = Get-Module AITriad

# Split-DocumentChunks / Split-RagQueryWindows are Private; invoke the body inside the
# module's own session state (outside Pester, InModuleScope isn't available).
& $AITriad {
param($DocIds, $SourcesDir, $DataDir, $MaxTotal, $ScriptRoot)

# Rows: { doc_id, pov, node_id, stratum, old_hit, new_maxsim_hit, new_rrf_hit }
$Rows = [System.Collections.Generic.List[object]]::new()
$ChunkCache = @{}   # "$DocId|$ChunkIndex" -> { OldHitSet; MaxSimHitSet; RrfHitSet }

foreach ($DocId in $DocIds) {
    $SnapPath = Join-Path (Join-Path $SourcesDir $DocId) 'snapshot.md'
    $SumPath  = Join-Path $DataDir "summaries\$DocId.json"
    if (-not (Test-Path $SnapPath) -or -not (Test-Path $SumPath)) { Write-Warning "skip $DocId (missing snapshot or summary)"; continue }

    $Snap = Get-Content -LiteralPath $SnapPath -Raw
    $Summary = Get-Content -LiteralPath $SumPath -Raw | ConvertFrom-Json

    $Chunks = @(Split-DocumentChunks -Text $Snap)
    Write-Host "$DocId : $($Chunks.Count) chunk(s), snapshot $($Snap.Length) chars"

    foreach ($Pov in @('accelerationist', 'safetyist', 'skeptic')) {
        if (-not $Summary.pov_summaries.PSObject.Properties[$Pov]) { continue }
        $KeyPoints = @($Summary.pov_summaries.$Pov.key_points)
        foreach ($Kp in $KeyPoints) {
            $Q = if ($Kp.PSObject.Properties['attribution_text'] -and $Kp.attribution_text) { $Kp.attribution_text } else { $Kp.verbatim }
            if (-not $Q -or -not $Kp.taxonomy_node_id) { continue }
            $Needle = $Q.Substring(0, [Math]::Min(50, $Q.Length))

            # Find which chunk contains the quote, and the offset within that chunk.
            $ChunkIdx = -1; $Offset = -1
            for ($i = 0; $i -lt $Chunks.Count; $i++) {
                $pos = $Chunks[$i].IndexOf($Needle)
                if ($pos -ge 0) { $ChunkIdx = $i; $Offset = $pos; break }
            }
            if ($ChunkIdx -lt 0) { continue }   # not locatable (paraphrase drift) — excluded, not counted as a miss

            $CacheKey = "$DocId|$ChunkIdx"
            if (-not $ChunkCache.ContainsKey($CacheKey)) {
                $ChunkText = $Chunks[$ChunkIdx]
                $OldQuery = if ($ChunkText.Length -gt 2000) { $ChunkText.Substring(0, 2000) } else { $ChunkText }

                $OldNodes = @(Get-RelevantTaxonomyNodes -Query $OldQuery -MaxTotal $MaxTotal -Format objects -IncludeSituations 3>$null | ForEach-Object Id)

                $Split = Split-RagQueryWindows -Text $ChunkText
                $WinTexts = @($Split.Windows)
                $WinEmb = if ($WinTexts.Count -gt 0) { Invoke-BatchEmbeddings -Texts $WinTexts } else { @{} }
                $QVecs = [System.Collections.Generic.List[double[]]]::new()
                foreach ($T in $WinTexts) { if ($WinEmb.ContainsKey($T)) { $QVecs.Add([double[]]$WinEmb[$T]) } }

                if ($QVecs.Count -eq 0) {
                    $MaxSimNodes = $OldNodes; $RrfNodes = $OldNodes   # windowing produced nothing; same as old-fallback path
                }
                else {
                    $MaxSimNodes = @(Get-RelevantTaxonomyNodes -Query $ChunkText -QueryVectors $QVecs.ToArray() -WindowScoring MaxSim -MaxTotal $MaxTotal -Format objects -IncludeSituations 3>$null | ForEach-Object Id)
                    $RrfNodes    = @(Get-RelevantTaxonomyNodes -Query $ChunkText -QueryVectors $QVecs.ToArray() -WindowScoring RankFusion -MaxTotal $MaxTotal -Format objects -IncludeSituations 3>$null | ForEach-Object Id)
                }
                $ChunkCache[$CacheKey] = @{
                    OldSet    = [System.Collections.Generic.HashSet[string]]::new([string[]]$OldNodes, [System.StringComparer]::OrdinalIgnoreCase)
                    MaxSimSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$MaxSimNodes, [System.StringComparer]::OrdinalIgnoreCase)
                    RrfSet    = [System.Collections.Generic.HashSet[string]]::new([string[]]$RrfNodes, [System.StringComparer]::OrdinalIgnoreCase)
                }
            }
            $C = $ChunkCache[$CacheKey]
            $Rows.Add([PSCustomObject]@{
                DocId        = $DocId
                Pov          = $Pov
                NodeId       = $Kp.taxonomy_node_id
                Stratum      = if ($Offset -ge 2000) { 'after2000' } else { 'before2000' }
                OldHit       = $C.OldSet.Contains($Kp.taxonomy_node_id)
                MaxSimHit    = $C.MaxSimSet.Contains($Kp.taxonomy_node_id)
                RrfHit       = $C.RrfSet.Contains($Kp.taxonomy_node_id)
            })
        }
    }
}

Write-Host ""
Write-Host "=== Arm A: per-key_point recall@set, stratified by position in its chunk ==="
foreach ($Stratum in 'before2000', 'after2000') {
    $S = @($Rows | Where-Object Stratum -eq $Stratum)
    $n = $S.Count
    if ($n -eq 0) { Write-Host "$Stratum : n=0"; continue }
    $oldR = [Math]::Round(100.0 * (@($S | Where-Object OldHit).Count) / $n, 1)
    $msR  = [Math]::Round(100.0 * (@($S | Where-Object MaxSimHit).Count) / $n, 1)
    $rrfR = [Math]::Round(100.0 * (@($S | Where-Object RrfHit).Count) / $n, 1)
    Write-Host "$Stratum : n=$n  old=$oldR%  new-MaxSim=$msR%  new-RankFusion=$rrfR%"
}

Write-Host ""
Write-Host "=== Arm B: overall displacement guard (new recall >= old recall - 2pts) ==="
$n = $Rows.Count
$oldR = [Math]::Round(100.0 * (@($Rows | Where-Object OldHit).Count) / $n, 1)
$msR  = [Math]::Round(100.0 * (@($Rows | Where-Object MaxSimHit).Count) / $n, 1)
$rrfR = [Math]::Round(100.0 * (@($Rows | Where-Object RrfHit).Count) / $n, 1)
Write-Host "overall n=$n  old=$oldR%  new-MaxSim=$msR%  new-RankFusion=$rrfR%"
Write-Host "guard: MaxSim $(if ($msR -ge $oldR - 2) {'PASS'} else {'FAIL'}); RankFusion $(if ($rrfR -ge $oldR - 2) {'PASS'} else {'FAIL'})"

$Rows | Export-Csv -LiteralPath (Join-Path $ScriptRoot 'arm-results.csv') -NoTypeInformation
Write-Host ""
Write-Host "chunks scored: $($ChunkCache.Count); rows: $($Rows.Count)"

} $DocIds $SourcesDir $DataDir $MaxTotal $PSScriptRoot
