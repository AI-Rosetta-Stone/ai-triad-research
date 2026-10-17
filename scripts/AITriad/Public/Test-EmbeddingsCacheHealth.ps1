# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    One-shot verdict on whether the precomputed embeddings cache is resolving on the live
    prod revision, or silently re-computing — the recurring baseline-validation question for
    the embedding-saturation incident class (t/2905, t/3072, t/3085, t/3165).
.DESCRIPTION
    Every embedding-saturation triage re-runs the same manual Log Analytics correlation to answer
    one question: is the precomputed embeddings cache actually resolving on the serving revision,
    or is the server silently re-embedding ~800 static texts per debate? This cmdlet assembles
    that verdict in a single call.

    It pulls all `embeddings`-tagged console lines over a window via Get-TaxEditorServerLogs
    (reusing its Log Analytics workspace resolution and Pino parsing), then derives:
      - Compute request durations on `/api/embeddings/compute` (cache-hit ≈ 1-183ms; re-compute ≈ 1.5-8.4s)
      - Any `embeddings.compute: load-shed 503` back-pressure rows
      - The boot-time `embeddings.json loaded` / `cache ready` signal, if it fell in the window
      - The serving revision name (from the newest matching row)

    Verdict logic (duration-based; robust today, sharper once t/3166's request-time cache-miss
    log lands):
      - p95 < 500ms and no load-shed 503  -> 'resolving'
      - p95 > 1000ms or any load-shed 503  -> 're-computing'
      - zero compute rows                  -> 'no-traffic'  (can't tell — reported, never false-passed)
      - otherwise (p95 in the 500-1000ms grey band) -> 'unknown'

    Requires the az CLI logged in with reader access to the Log Analytics workspace. No AI calls.
.PARAMETER From
    Lower bound of the window (UTC-compared). Default: 30 minutes before -To.
.PARAMETER To
    Upper bound. Default: now (UTC).
.PARAMETER App
    Container app to inspect. Default 'taxonomy-editor' (prod). Passed through to
    Get-TaxEditorServerLogs. (Deviation from the ticket's -BaseUrl: the verdict is computed from
    Log Analytics, not an HTTP probe, so -BaseUrl would be a dead parameter; -App is the real
    log-source selector.)
.PARAMETER ResourceGroup
    Azure resource group. Default 'ai-triad'. Passed through to Get-TaxEditorServerLogs.
.PARAMETER Max
    Row cap for the underlying Log Analytics query. Default 2000.
.OUTPUTS
    [PSCustomObject] AITriad.EmbeddingsCacheHealth with fields: Revision, ComputeCount,
    ComputeP50Ms, ComputeP95Ms, LoadShed503Count, CacheReadySignalSeen, Verdict, From, To.
.EXAMPLE
    Test-EmbeddingsCacheHealth
    # Is the cache resolving on the live revision over the last 30 minutes?
.EXAMPLE
    Test-EmbeddingsCacheHealth -From (Get-Date).AddHours(-2)
    # Widen the window to catch a boot 'cache ready' signal after a recent deploy.
.LINK
    Get-TaxEditorServerLogs
.LINK
    Show-AITriadHelp
#>
function Test-EmbeddingsCacheHealth {
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [datetime]$From,

        [Parameter()]
        [datetime]$To,

        [Parameter()]
        [ValidateSet('taxonomy-editor', 'taxonomy-editor-staging')]
        [string]$App = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [ValidateRange(1, 50000)]
        [int]$Max = 2000
    )

    process {
        Set-StrictMode -Version Latest

        # ── Window (default last 30 min) ──────────────────────────────────
        $toUtc   = if ($PSBoundParameters.ContainsKey('To'))   { $To.ToUniversalTime() }   else { [datetime]::UtcNow }
        $fromUtc = if ($PSBoundParameters.ContainsKey('From')) { $From.ToUniversalTime() } else { $toUtc.AddMinutes(-30) }
        if ($fromUtc -gt $toUtc) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal     'Assess embeddings-cache health over a time window' `
                -Problem  "-From ($fromUtc) is after -To ($toUtc)." `
                -Location 'Test-EmbeddingsCacheHealth' `
                -NextSteps @('Pass -From earlier than -To, or omit both for the last 30 minutes.'))
        }

        # ── Pull all embeddings-tagged console lines in one query ─────────
        # -Pattern 'embeddings' captures compute request completions, load-shed 503s, and the
        # boot 'embeddings.json loaded' / 'cache ready' signal (all contain the substring).
        # Get-TaxEditorServerLogs owns workspace resolution + Pino parsing; New-ActionableError
        # on an unreachable workspace propagates from there unchanged.
        $rows = @(Get-TaxEditorServerLogs -From $fromUtc -To $toUtc -App $App `
                -ResourceGroup $ResourceGroup -Pattern 'embeddings' -Max $Max)

        # ── Classify rows (StrictMode-safe property reads) ────────────────
        $field = {
            param($obj, [string]$name)
            if ($null -eq $obj) { return $null }
            $p = $obj.PSObject.Properties[$name]
            if ($p) { return $p.Value } else { return $null }
        }

        $computeDurations = [System.Collections.Generic.List[double]]::new()
        $loadShed503      = 0
        $cacheReadySeen   = $false
        $revision         = $null

        foreach ($row in $rows) {
            $path    = & $field $row 'Path'
            $msg     = & $field $row 'Message'
            $status  = & $field $row 'Status'
            $dur     = & $field $row 'DurationMs'
            $rev     = & $field $row 'Revision'
            $msgText = if ($null -ne $msg) { [string]$msg } else { '' }
            $pathText = if ($null -ne $path) { [string]$path } else { '' }

            # Newest row's revision wins (rows arrive chronologically ascending).
            if (-not [string]::IsNullOrWhiteSpace([string]$rev)) { $revision = [string]$rev }

            # Compute request completion with a measured duration.
            if ($pathText -like '*/api/embeddings/compute*' -and $null -ne $dur) {
                $d = 0.0
                if ([double]::TryParse([string]$dur, [ref]$d)) { $computeDurations.Add($d) }
            }

            # Load-shed 503 back-pressure (message-tagged, or a 503 on the compute path).
            if ($msgText -match '(?i)load-shed' -or
                (($status -eq 503 -or [string]$status -eq '503') -and $pathText -like '*embeddings*')) {
                $loadShed503++
            }

            # Boot-time cache-ready signal.
            if ($msgText -match '(?i)embeddings\.json loaded' -or $msgText -match '(?i)cache ready') {
                $cacheReadySeen = $true
            }
        }

        # ── Percentiles (nearest-rank on the sorted duration set) ─────────
        $percentile = {
            param([System.Collections.Generic.List[double]]$values, [double]$p)
            $n = $values.Count
            if ($n -eq 0) { return $null }
            $sorted = @($values | Sort-Object)
            $rank = [int][math]::Ceiling(($p / 100.0) * $n)
            if ($rank -lt 1) { $rank = 1 }
            if ($rank -gt $n) { $rank = $n }
            [math]::Round($sorted[$rank - 1], 1)
        }

        $computeCount = $computeDurations.Count
        $p50 = & $percentile $computeDurations 50
        $p95 = & $percentile $computeDurations 95

        # ── Verdict ───────────────────────────────────────────────────────
        $verdict =
            if ($computeCount -eq 0) {
                'no-traffic'
            } elseif ($loadShed503 -gt 0 -or ($null -ne $p95 -and $p95 -gt 1000)) {
                're-computing'
            } elseif ($null -ne $p95 -and $p95 -lt 500) {
                'resolving'
            } else {
                'unknown'
            }

        [PSCustomObject]@{
            PSTypeName           = 'AITriad.EmbeddingsCacheHealth'
            Revision             = $revision
            ComputeCount         = $computeCount
            ComputeP50Ms         = $p50
            ComputeP95Ms         = $p95
            LoadShed503Count     = $loadShed503
            CacheReadySignalSeen = $cacheReadySeen
            Verdict              = $verdict
            From                 = $fromUtc
            To                   = $toUtc
        }
    }
}
