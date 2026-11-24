#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deploy gate (t/467 condition 1b, t/468): fails the deploy if the prod or staging
    taxonomy-editor maxReplicas is above 1 without a reviewed anonymous-spend overshoot bound,
    or if staging resolves to a replica count other than the one this gate states.
.DESCRIPTION
    The anonymous op-ed spend bound (taxonomy-editor/src/server/routes/opedRunSlots.ts,
    replicaOvershootBoundUsd) is replicas x ANON_PROCESS_RUN_CAP x the largest run cost. The
    per-process cap is per replica, so a raise of maxReplicas raises the bound. Prod and staging
    both serve anonymous op-eds, so both are checked.

    Prod: reads the literal `maxReplicas: <n>` in the span from the 'maxReplicas capped at'
    comment (the same anchor as the CI scale guard). Staging: reads the load-test ternary
    `maxReplicas: stagingLoadTestSize ? <a> : <b>` in the span from the 't/4203' comment, and
    resolves it with -StagingLoadTestSize (the same flag the deploy passes to Bicep).

    Rules, per app:
      replicas <= 1                                             -> pass.
      replicas >  1, '@OVERSHOOT_BOUND_REVIEWED: t/NNNN' in span -> pass (bound reviewed in t/NNNN).
      replicas >  1, no valid attestation                       -> FAIL (fail closed).
      anchor or value cannot be parsed                          -> FAIL (fail closed).
    Staging also must equal -ExpectedStagingReplicas (default 1). Any other resolved value fails,
    so a load test (3 replicas) needs the expected count changed here and a reviewed attestation.
.PARAMETER BicepPath
    Path to deploy/azure/main.bicep. Defaults to the canonical repo location.
.PARAMETER StagingLoadTestSize
    True when the deploy sets stagingLoadTestSize (staging_load_test_size input). Default false.
.PARAMETER ExpectedStagingReplicas
    The staging replica count this gate expects for the deploy. Default 1.
#>
[CmdletBinding()]
param(
    [string] $BicepPath = "$PSScriptRoot/../../deploy/azure/main.bicep",
    [bool]   $StagingLoadTestSize = $false,
    [int]    $ExpectedStagingReplicas = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-OvershootAttestation ([string] $Span) {
    $m = [regex]::Match($Span, '@OVERSHOOT_BOUND_REVIEWED:\s*(\S*)')
    return [pscustomobject]@{
        Present = $m.Success
        Ticket  = $m.Groups[1].Value
        Valid   = $m.Success -and ($m.Groups[1].Value -match '^t/\d+$')
    }
}

if (-not (Test-Path -LiteralPath $BicepPath -PathType Leaf)) {
    throw "Overshoot bound gate: Bicep file not found at $BicepPath. The gate fails closed rather than passing without reading maxReplicas."
}
$bicepContent = Get-Content -LiteralPath $BicepPath -Raw

# ── Prod ─────────────────────────────────────────────────────────────────────
$prodMatch = [regex]::Match($bicepContent, 'maxReplicas capped at \d+[\s\S]*?maxReplicas:\s*(\d+)')
if (-not $prodMatch.Success) {
    throw "Overshoot bound gate: could not parse prod maxReplicas from $BicepPath. The 'maxReplicas capped at' comment and the maxReplicas line must be present and intact (failing closed)."
}
$prodReplicas = [int]$prodMatch.Groups[1].Value
$prodAttest = Get-OvershootAttestation $prodMatch.Value

# ── Staging ──────────────────────────────────────────────────────────────────
$stagingMatch = [regex]::Match($bicepContent, 't/4203: max \d+[\s\S]*?maxReplicas:\s*stagingLoadTestSize\s*\?\s*(\d+)\s*:\s*(\d+)')
if (-not $stagingMatch.Success) {
    throw "Overshoot bound gate: could not parse staging maxReplicas from $BicepPath. The 't/4203' comment and the 'maxReplicas: stagingLoadTestSize ? a : b' line must be present and intact (failing closed)."
}
$stagingReplicas = if ($StagingLoadTestSize) { [int]$stagingMatch.Groups[1].Value } else { [int]$stagingMatch.Groups[2].Value }
$stagingAttest = Get-OvershootAttestation $stagingMatch.Value

$failed = $false

function Test-AppReplicas ([string] $App, [int] $Replicas, $Attest, [string] $Remedy) {
    if ($Replicas -le 1) {
        Write-Host "Overshoot bound gate: $App maxReplicas=$Replicas. The per-process anonymous bound does not grow above one replica."
        return $true
    }
    if ($Attest.Valid) {
        Write-Host "Overshoot bound gate: $App maxReplicas=$Replicas, bound reviewed per $($Attest.Ticket)."
        return $true
    }
    if ($Attest.Present) {
        Write-Host "::error::Overshoot bound gate FAILED: $App maxReplicas=$Replicas and the @OVERSHOOT_BOUND_REVIEWED line is malformed (got '$($Attest.Ticket)', expected t/NNNN)."
    } else {
        Write-Host "::error::Overshoot bound gate FAILED: $App maxReplicas=$Replicas and no @OVERSHOOT_BOUND_REVIEWED: t/NNNN is recorded (t/467)."
    }
    Write-Host "::error::The anonymous op-ed spend bound is replicas x ANON_PROCESS_RUN_CAP x largest run cost (replicaOvershootBoundUsd). Raising maxReplicas above 1 grows that bound."
    Write-Host "::error::$Remedy"
    return $false
}

if (-not (Test-AppReplicas -App 'prod' -Replicas $prodReplicas -Attest $prodAttest `
        -Remedy "Review the bound for the new replica count, then add '// @OVERSHOOT_BOUND_REVIEWED: t/NNNN' next to the 'maxReplicas capped at' comment in $BicepPath.")) {
    $failed = $true
}

if ($stagingReplicas -ne $ExpectedStagingReplicas) {
    Write-Host "::error::Overshoot bound gate FAILED: staging resolves to maxReplicas=$stagingReplicas (stagingLoadTestSize=$StagingLoadTestSize), but this gate expects $ExpectedStagingReplicas. Any other staging replica count fails until the expected value is changed here, with review (t/467)."
    $failed = $true
} elseif (-not (Test-AppReplicas -App 'staging' -Replicas $stagingReplicas -Attest $stagingAttest `
        -Remedy "Review the bound for the staging replica count, then add '// @OVERSHOOT_BOUND_REVIEWED: t/NNNN' in the t/4203 comment block in $BicepPath.")) {
    $failed = $true
}

if ($failed) {
    throw 'Overshoot bound gate FAILED: an app would exceed one replica without a reviewed overshoot bound, or staging resolved to an unexpected count.'
}
Write-Host 'Overshoot bound gate: prod and staging pass.'
