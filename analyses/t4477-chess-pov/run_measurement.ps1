# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4477 CHESS POV-classification measurement (CL design, t/4477#8).
.DESCRIPTION
    Per doc in sample.json (n=16): Run A (old input: title + first 500 words), Run B (the SAME
    old input, run again -- the noise baseline, A vs B), Run C (new input: title +
    Get-PovClassificationSample's whole-document sample). 3 calls/doc = 48 calls, under the
    PI-approved 50-call cap (t/4477#6). Hard stop at 50 calls regardless.

    Read-only against the real corpus (snapshot.md/metadata.json only read, never written). No
    repo state is mutated; this only makes billed AI calls and writes its own results file.
#>
[CmdletBinding()]
param(
    [int]$MaxCalls = 50
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Import-Module (Join-Path $repoRoot 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

$sample = Get-Content (Join-Path $PSScriptRoot 'sample.json') -Raw | ConvertFrom-Json
Write-Host "Sample: $(@($sample).Count) docs, 3 calls/doc = $(@($sample).Count * 3) calls planned (cap $MaxCalls)."

function Get-SubstantivePovs([string[]]$Povs) {
    @($Povs | Where-Object { $_ -ne 'situations' } | Sort-Object)
}

$callCount = 0
$results = [System.Collections.Generic.List[object]]::new()

InModuleScope AITriad -Parameters @{
    Sample     = $sample
    MaxCalls   = $MaxCalls
    Results    = $results
    CallCountRef = [ref]$callCount
} {
    param($Sample, $MaxCalls, $Results, $CallCountRef)

    $srcDir = Get-SourcesDir
    foreach ($doc in $Sample) {
        if ($CallCountRef.Value + 3 -gt $MaxCalls) {
            Write-Warning "t/4477: stopping before $($doc.Id) -- 3 more calls would exceed the $MaxCalls-call cap (used $($CallCountRef.Value))."
            break
        }

        $docDir = Join-Path $srcDir $doc.Id
        $metaPath = Join-Path $docDir 'metadata.json'
        $snapPath = Join-Path $docDir 'snapshot.md'
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        $title = [string]$meta.title
        $snapshotText = Read-SnapshotForModel -Path $snapPath -CallerName 't4477-measurement' 3>$null

        # OLD input: title + first 500 words (the pre-fix construction, Invoke-SummaryPipeline
        # pre-t/4477).
        $words = @($snapshotText -split '\s+')
        $first500 = ($words | Select-Object -First 500) -join ' '
        $oldQueryText = "$title. $first500"

        # NEW input: title + Get-PovClassificationSample's whole-document, section-stratified
        # sample (the t/4477 fix, same ~500-word budget).
        $ragQueryText = "$title. $snapshotText"
        $docSplit = Split-RagQueryWindows -Text $ragQueryText
        $chessSample = if (@($docSplit.Windows).Count -gt 0) { Get-PovClassificationSample -Windows $docSplit.Windows } else { '' }
        $newQueryText = "$title. $chessSample"

        Write-Host "`n[$($doc.Id)] old-words=$($words.Count) windows=$(@($docSplit.Windows).Count) new-sample-words=$(@($chessSample -split '\s+').Count)"

        $runA = Get-DocumentPovClassification -QueryText $oldQueryText
        $CallCountRef.Value++
        $runB = Get-DocumentPovClassification -QueryText $oldQueryText
        $CallCountRef.Value++
        $runC = Get-DocumentPovClassification -QueryText $newQueryText
        $CallCountRef.Value++

        $subA = Get-SubstantivePovs $runA
        $subB = Get-SubstantivePovs $runB
        $subC = Get-SubstantivePovs $runC

        $flipAB = (($subA -join ',') -cne ($subB -join ','))
        $flipAC = (($subA -join ',') -cne ($subC -join ','))
        $flipBC = (($subB -join ',') -cne ($subC -join ','))
        $abStable = -not $flipAB
        $informative = $abStable -and $flipAC   # the case CL's adjudication is scoped to

        Write-Host "  A=$($subA -join '+') B=$($subB -join '+') C=$($subC -join '+')  flipAB=$flipAB flipAC=$flipAC informative=$informative"

        $Results.Add([pscustomobject]@{
            Id              = $doc.Id
            StoredPovTag    = $doc.Tag
            WordCount       = $doc.WordCount
            RunA            = $subA
            RunB            = $subB
            RunC            = $subC
            FlipAB          = $flipAB
            FlipAC          = $flipAC
            FlipBC          = $flipBC
            AB_Stable       = $abStable
            Informative     = $informative
        })
    }

    Write-Host "`nTotal calls used: $($CallCountRef.Value)"
}

$resultsPath = Join-Path $PSScriptRoot 'results.json'
$results | ConvertTo-Json -Depth 6 | Set-Content -Path $resultsPath -Encoding utf8
Write-Host "`nResults written to $resultsPath"

$n = @($results).Count
$noiseFlips = @($results | Where-Object FlipAB).Count
$effectFlips = @($results | Where-Object FlipAC).Count
$informativeFlips = @($results | Where-Object Informative).Count
$excludedUnstable = @($results | Where-Object { -not $_.AB_Stable }).Count

Write-Host "`n=== SUMMARY (n=$n) ==="
Write-Host "Noise baseline (A vs B flip rate):   $noiseFlips/$n"
Write-Host "New-input effect (A vs C flip rate): $effectFlips/$n"
Write-Host "Informative flips (A==B, A!=C):      $informativeFlips/$n  <- CL adjudication set"
Write-Host "Excluded (A!=B, baseline unstable):  $excludedUnstable/$n"
Write-Host "Calls used: $callCount / $MaxCalls"
