# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4468 offline measurement (CL t/4468#2 and #4 spec): Arm A (recall@set of
    each key_point's own per-key_point top-3 + mechanism5_candidates, a
    reference independent of both the old candidate set and the LLM's pick)
    and Arm B (the LLM-picked taxonomy_node_id, as a displacement guard).
    OLD query construction (first 2000 chars of the chunk, single encode) vs
    NEW (the whole chunk, windowed via Split-RagQueryWindows, scored MaxSim
    and RankFusion). Uses the pipeline's own candidate-set parameters
    (-MaxTotal 150 -TopK 60 -MinPerCategory 2, Invoke-DocumentSummary.ps1:268)
    so a recall difference isn't just a set-size difference. No LLM spend —
    local embedding model only, against existing summaries' key_points.
.DESCRIPTION
    Read-only against ../ai-triad-sources and ../ai-triad-data. Chunks each
    document with the real Split-DocumentChunks, locates each key_point's
    attribution_text (or verbatim fallback) inside its chunk by substring
    search for stratification, and reports recall separately for Arm A and
    Arm B, by stratum, plus mean/median candidate-set size per scoring arm.
    Stale recorded node ids (not in the currently loaded taxonomy) are
    dropped and counted rather than silently scored as misses.
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
    [int]$MaxTotal = 150,
    [int]$TopK = 60,
    [int]$MinPerCategory = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ModulePath = Join-Path $PSScriptRoot '..' '..' 'AITriad' 'AITriad.psm1'
Import-Module $ModulePath -Force -WarningAction SilentlyContinue
$AITriad = Get-Module AITriad

# Split-DocumentChunks / Split-RagQueryWindows are Private; invoke the body inside the
# module's own session state (outside Pester, InModuleScope isn't available).
& $AITriad {
param($DocIds, $SourcesDir, $DataDir, $MaxTotal, $TopK, $MinPerCategory, $ScriptRoot)

# $script:CachedEmbeddings is lazily populated inside Get-RelevantTaxonomyNodes itself; force
# the load with a throwaway call before reading it.
$null = Get-RelevantTaxonomyNodes -Query 'warmup' -MaxTotal 1 -Format objects 3>$null
$ValidNodeIds = [System.Collections.Generic.HashSet[string]]::new([string[]]@($script:CachedEmbeddings.Keys), [System.StringComparer]::OrdinalIgnoreCase)
$PovOf = { param($Id) if ($Id -match '^acc-') { 'accelerationist' } elseif ($Id -match '^saf-') { 'safetyist' } elseif ($Id -match '^skp-') { 'skeptic' } else { 'situations' } }

# Rows: one per key_point: { DocId, Pov, Stratum, ArmA_ref(string[]), ArmB_ref(string),
#   OldSet/MaxSimSet/RrfSet (shared per chunk, referenced by key) }
$Rows = [System.Collections.Generic.List[object]]::new()
$ChunkCache = @{}           # "$DocId|$ChunkIndex" -> { OldSet; MaxSimSet; RrfSet; OldCount; MaxSimCount; RrfCount }
$StaleDropped = 0

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

            # Find which chunk contains the quote, and the offset within that chunk (for stratification).
            $ChunkIdx = -1; $Offset = -1
            for ($i = 0; $i -lt $Chunks.Count; $i++) {
                $pos = $Chunks[$i].IndexOf($Needle)
                if ($pos -ge 0) { $ChunkIdx = $i; $Offset = $pos; break }
            }
            if ($ChunkIdx -lt 0) { continue }   # not locatable (paraphrase drift) — excluded, not counted as a miss

            # ── Arm B reference: the LLM's own pick, filtered against the current taxonomy ──
            $ArmBRef = @()
            if ($ValidNodeIds.Contains($Kp.taxonomy_node_id)) { $ArmBRef = @($Kp.taxonomy_node_id) } else { $StaleDropped++ }

            # ── Arm A reference: this key_point's OWN per-key_point top-3 (focused query, same
            # text Mechanism #5 uses) union any surfaced mechanism5_candidates — independent of
            # both the old candidate set and the LLM's pick (CL t/4468#2 item 1, t/4468#4 item 2).
            $KpPov = & $PovOf $Kp.taxonomy_node_id
            $OwnTop3 = @(Get-RelevantTaxonomyNodes -Query $Q -POV $KpPov -Format objects -MinPerCategory 1 3>$null | Select-Object -First 3 | ForEach-Object Id)
            $Mech5Raw = if ($Kp.PSObject.Properties['mechanism5_candidates']) { @($Kp.mechanism5_candidates) } else { @() }
            $Mech5 = @($Mech5Raw | ForEach-Object Id)
            $ArmARefRaw = @($OwnTop3 + $Mech5 | Select-Object -Unique)
            $ArmARef = @($ArmARefRaw | Where-Object { $ValidNodeIds.Contains($_) })
            $StaleDropped += ($ArmARefRaw.Count - $ArmARef.Count)
            if ($ArmARef.Count -eq 0) { continue }   # nothing left to measure recall against

            # ── Per-chunk candidate sets (shared across all key_points in the same chunk) ──
            $CacheKey = "$DocId|$ChunkIdx"
            if (-not $ChunkCache.ContainsKey($CacheKey)) {
                $ChunkText = $Chunks[$ChunkIdx]
                $OldQuery = if ($ChunkText.Length -gt 2000) { $ChunkText.Substring(0, 2000) } else { $ChunkText }

                $OldNodes = @(Get-RelevantTaxonomyNodes -Query $OldQuery -MaxTotal $MaxTotal -TopK $TopK -MinPerCategory $MinPerCategory -Format objects -IncludeSituations 3>$null | ForEach-Object Id)

                $Split = Split-RagQueryWindows -Text $ChunkText
                $WinTexts = @($Split.Windows)
                $WinEmb = if ($WinTexts.Count -gt 0) { Invoke-BatchEmbeddings -Texts $WinTexts } else { @{} }
                $QVecs = [System.Collections.Generic.List[double[]]]::new()
                foreach ($T in $WinTexts) { if ($WinEmb.ContainsKey($T)) { $QVecs.Add([double[]]$WinEmb[$T]) } }

                if ($QVecs.Count -eq 0) {
                    $MaxSimNodes = $OldNodes; $RrfNodes = $OldNodes   # windowing produced nothing; same as old-fallback path
                }
                else {
                    $MaxSimNodes = @(Get-RelevantTaxonomyNodes -Query $ChunkText -QueryVectors $QVecs.ToArray() -WindowScoring MaxSim -MaxTotal $MaxTotal -TopK $TopK -MinPerCategory $MinPerCategory -Format objects -IncludeSituations 3>$null | ForEach-Object Id)
                    $RrfNodes    = @(Get-RelevantTaxonomyNodes -Query $ChunkText -QueryVectors $QVecs.ToArray() -WindowScoring RankFusion -MaxTotal $MaxTotal -TopK $TopK -MinPerCategory $MinPerCategory -Format objects -IncludeSituations 3>$null | ForEach-Object Id)
                }
                $ChunkCache[$CacheKey] = @{
                    OldSet      = [System.Collections.Generic.HashSet[string]]::new([string[]]$OldNodes, [System.StringComparer]::OrdinalIgnoreCase)
                    MaxSimSet   = [System.Collections.Generic.HashSet[string]]::new([string[]]$MaxSimNodes, [System.StringComparer]::OrdinalIgnoreCase)
                    RrfSet      = [System.Collections.Generic.HashSet[string]]::new([string[]]$RrfNodes, [System.StringComparer]::OrdinalIgnoreCase)
                    OldCount    = $OldNodes.Count
                    MaxSimCount = $MaxSimNodes.Count
                    RrfCount    = $RrfNodes.Count
                }
            }
            $C = $ChunkCache[$CacheKey]

            $Rows.Add([PSCustomObject]@{
                DocId         = $DocId
                Pov           = $Pov
                Stratum       = if ($Offset -ge 2000) { 'after2000' } else { 'before2000' }
                OldSetSize    = $C.OldCount
                MaxSimSetSize = $C.MaxSimCount
                RrfSetSize    = $C.RrfCount
                ArmA_n        = $ArmARef.Count
                ArmA_OldHits  = (@($ArmARef | Where-Object { $C.OldSet.Contains($_) })).Count
                ArmA_MsHits   = (@($ArmARef | Where-Object { $C.MaxSimSet.Contains($_) })).Count
                ArmA_RrfHits  = (@($ArmARef | Where-Object { $C.RrfSet.Contains($_) })).Count
                ArmB_n        = $ArmBRef.Count
                ArmB_OldHits  = (@($ArmBRef | Where-Object { $C.OldSet.Contains($_) })).Count
                ArmB_MsHits   = (@($ArmBRef | Where-Object { $C.MaxSimSet.Contains($_) })).Count
                ArmB_RrfHits  = (@($ArmBRef | Where-Object { $C.RrfSet.Contains($_) })).Count
            })
        }
    }
}

function Get-Median([double[]]$Values) {
    if ($Values.Count -eq 0) { return 0 }
    $Sorted = @($Values | Sort-Object)
    $Mid = [int]($Sorted.Count / 2)
    if ($Sorted.Count % 2 -eq 0) { ($Sorted[$Mid - 1] + $Sorted[$Mid]) / 2.0 } else { $Sorted[$Mid] }
}

function Report-Recall([object[]]$Set, [string]$Label, [string]$NField, [string]$OldField, [string]$MsField, [string]$RrfField) {
    $n = (@($Set | ForEach-Object { $_.$NField })) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
    if (-not $n) { Write-Host "$Label : n=0"; return }
    $oldHits = (@($Set | ForEach-Object { $_.$OldField })) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
    $msHits  = (@($Set | ForEach-Object { $_.$MsField }))  | Measure-Object -Sum | Select-Object -ExpandProperty Sum
    $rrfHits = (@($Set | ForEach-Object { $_.$RrfField })) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
    $oldR = [Math]::Round(100.0 * $oldHits / $n, 1)
    $msR  = [Math]::Round(100.0 * $msHits  / $n, 1)
    $rrfR = [Math]::Round(100.0 * $rrfHits / $n, 1)
    Write-Host "$Label : n=$n (over $(@($Set).Count) key_points)  old=$oldR%  new-MaxSim=$msR%  new-RankFusion=$rrfR%"
}

Write-Host ""
Write-Host "=== Candidate-set size per chunk (mean / median), production params -MaxTotal $MaxTotal -TopK $TopK -MinPerCategory $MinPerCategory ==="
$ChunkSizes = $ChunkCache.Values
"Old", "MaxSim", "Rrf" | ForEach-Object {
    $Field = "${_}Count"
    $Vals = @($ChunkSizes | ForEach-Object { [double]$_.$Field })
    $Mean = [Math]::Round(($Vals | Measure-Object -Average).Average, 1)
    $Med = Get-Median $Vals
    Write-Host "$_ : mean=$Mean  median=$Med  (n chunks=$($Vals.Count))"
}

Write-Host ""
Write-Host "=== Arm A: recall@set of each key_point's OWN top-3 + mechanism5_candidates (independent reference) ==="
foreach ($Stratum in 'before2000', 'after2000') {
    $S = @($Rows | Where-Object Stratum -eq $Stratum)
    Report-Recall $S $Stratum 'ArmA_n' 'ArmA_OldHits' 'ArmA_MsHits' 'ArmA_RrfHits'
}
Report-Recall $Rows 'overall' 'ArmA_n' 'ArmA_OldHits' 'ArmA_MsHits' 'ArmA_RrfHits'

Write-Host ""
Write-Host "=== Arm B: displacement guard on the LLM's recorded pick (new >= old - 2pts) ==="
$ArmBOverall = $Rows | Where-Object { $_.ArmB_n -gt 0 }
Report-Recall $ArmBOverall 'overall' 'ArmB_n' 'ArmB_OldHits' 'ArmB_MsHits' 'ArmB_RrfHits'
$bn = (@($ArmBOverall | ForEach-Object ArmB_n)) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
$boldR = 100.0 * ((@($ArmBOverall | ForEach-Object ArmB_OldHits)) | Measure-Object -Sum | Select-Object -ExpandProperty Sum) / $bn
$bmsR  = 100.0 * ((@($ArmBOverall | ForEach-Object ArmB_MsHits))  | Measure-Object -Sum | Select-Object -ExpandProperty Sum) / $bn
$brrfR = 100.0 * ((@($ArmBOverall | ForEach-Object ArmB_RrfHits)) | Measure-Object -Sum | Select-Object -ExpandProperty Sum) / $bn
Write-Host "guard: MaxSim $(if ($bmsR -ge $boldR - 2) {'PASS'} else {'FAIL'}); RankFusion $(if ($brrfR -ge $boldR - 2) {'PASS'} else {'FAIL'})"

Write-Host ""
Write-Host "stale recorded node ids dropped (not in current taxonomy): $StaleDropped"
Write-Host "chunks scored: $($ChunkCache.Count); key_points scored: $($Rows.Count)"

$Rows | Export-Csv -LiteralPath (Join-Path $ScriptRoot 'arm-results.csv') -NoTypeInformation

} $DocIds $SourcesDir $DataDir $MaxTotal $TopK $MinPerCategory $PSScriptRoot
