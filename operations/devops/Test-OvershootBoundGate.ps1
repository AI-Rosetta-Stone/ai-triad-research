#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deploy gate (t/467, TL p/16#219 condition 1b): fails the prod deploy if the taxonomy-editor
    maxReplicas is above 1 without a reviewed anonymous-spend overshoot bound.
.DESCRIPTION
    The anonymous op-ed spend bound (taxonomy-editor/src/server/routes/opedRunSlots.ts,
    replicaOvershootBoundUsd) is replicas x ANON_PROCESS_RUN_CAP x the largest run cost. The
    per-process cap is per replica, so a raise of maxReplicas raises the overshoot past the
    ceilings. This gate makes that raise a deliberate, reviewed step.

    Reads the prod app's maxReplicas from deploy/azure/main.bicep, using the same anchor as the
    CI scale guard (Test-InMemoryJobStoreScaleGuard.ps1): the span from the literal
    'maxReplicas capped at' comment to the maxReplicas line. The span is the only place the
    attestation is honoured, so one elsewhere in the file never counts.

    Rules:
      maxReplicas <= 1                              -> pass (the bound does not grow).
      maxReplicas >  1, '@OVERSHOOT_BOUND_REVIEWED: t/NNNN' in the span -> pass, the bound was reviewed in t/NNNN.
      maxReplicas >  1, no valid attestation        -> FAIL (fail closed).
      Anchor or maxReplicas cannot be parsed        -> FAIL (fail closed).

    Scope: prod only (taxonomy-editor). The staging app is not checked here; its load-test
    setting allows 3 replicas and it also serves anonymous op-eds. That is a separate decision.
.PARAMETER BicepPath
    Path to deploy/azure/main.bicep. Defaults to the canonical repo location.
#>
[CmdletBinding()]
param(
    [string] $BicepPath = "$PSScriptRoot/../../deploy/azure/main.bicep"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $BicepPath -PathType Leaf)) {
    throw "Overshoot bound gate: Bicep file not found at $BicepPath. The gate fails closed rather than passing without reading maxReplicas."
}

$bicepContent = Get-Content -LiteralPath $BicepPath -Raw
$match = [regex]::Match($bicepContent, 'maxReplicas capped at \d+[\s\S]*?maxReplicas:\s*(\d+)')
if (-not $match.Success) {
    throw "Overshoot bound gate: could not parse taxonomy-editor maxReplicas from $BicepPath. The 'maxReplicas capped at' comment and the maxReplicas line must be present and intact (failing closed)."
}
$maxReplicas = [int]$match.Groups[1].Value

$attest = [regex]::Match($match.Value, '@OVERSHOOT_BOUND_REVIEWED:\s*(\S*)')
$hasAttest = $attest.Success
$attestTicket = $attest.Groups[1].Value
$attestValid = $hasAttest -and ($attestTicket -match '^t/\d+$')

if ($maxReplicas -le 1) {
    Write-Host "Overshoot bound gate: prod maxReplicas=$maxReplicas. The per-process anonymous cap bound does not grow above one replica. Gate passes."
    return
}

if ($attestValid) {
    Write-Host "Overshoot bound gate: prod maxReplicas=$maxReplicas, bound reviewed per $attestTicket. Gate passes."
    return
}

if ($hasAttest) {
    Write-Host "::error::Overshoot bound gate FAILED: prod maxReplicas=$maxReplicas and the @OVERSHOOT_BOUND_REVIEWED line is malformed (got '$attestTicket', expected t/NNNN)."
} else {
    Write-Host "::error::Overshoot bound gate FAILED: prod maxReplicas=$maxReplicas and no @OVERSHOOT_BOUND_REVIEWED: t/NNNN is recorded (t/467)."
}
Write-Host "::error::The anonymous op-ed spend bound is replicas x ANON_PROCESS_RUN_CAP x largest run cost (replicaOvershootBoundUsd). Raising maxReplicas above 1 grows that bound."
Write-Host "::error::Review the bound for the new replica count, then add '// @OVERSHOOT_BOUND_REVIEWED: t/NNNN' next to the 'maxReplicas capped at' comment in $BicepPath, naming the ticket where the review was done."
throw "Overshoot bound gate FAILED: prod maxReplicas=$maxReplicas without a reviewed overshoot bound."
