#Requires -Version 7.0
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    CI gate: fails if maxReplicas > 1 while any in-memory single-replica store is still in use.
.DESCRIPTION
    Reads deploy/azure/main.bicep and checks the taxonomy-editor maxReplicas value.
    Greps all *.ts files under taxonomy-editor/src/server/** for either in-memory marker:
      @INMEMORY_JOB_STORE            — per-process job store (blob-migration track, t/2885)
      @INMEMORY_CACHE_SINGLE_REPLICA — in-memory cache that must not span replicas (t/3504)
    If ANY file carries either marker and maxReplicas > 1, the gate fails — raising the
    replica count while any per-process in-memory store is active reinstates cross-replica
    data-isolation bugs. Remove a marker only when the corresponding store has been migrated
    to a shared/replica-safe backend.
.PARAMETER BicepPath
    Path to deploy/azure/main.bicep. Defaults to the canonical repo location.
.PARAMETER ServerDir
    Directory to search for in-memory markers. Defaults to taxonomy-editor/src/server.
    All *.ts files are checked recursively.
.PARAMETER JobStorePath
    Legacy single-file mode: checks only one .ts file for the marker. Superseded by
    -ServerDir (multi-file directory scan). Provided for backward compatibility with
    tests and scripts that pre-date the directory-scan approach (t/2885).
#>
[CmdletBinding()]
param(
    [string] $BicepPath    = "$PSScriptRoot/../../deploy/azure/main.bicep",
    [string] $ServerDir    = "$PSScriptRoot/../../taxonomy-editor/src/server",
    [string] $JobStorePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── 1. Check for in-memory store markers ─────────────────────────────────────
# Single-file legacy mode (-JobStorePath) or directory scan (-ServerDir, default).
$markerPattern = '@INMEMORY_JOB_STORE|@INMEMORY_CACHE_SINGLE_REPLICA'
if ($JobStorePath) {
    $markedFiles = @(if ((Select-String -Path $JobStorePath -Pattern $markerPattern -Quiet) -eq $true) {
        [System.IO.FileInfo]$JobStorePath
    })
} else {
    $markedFiles = @(Get-ChildItem -Path $ServerDir -Recurse -Filter '*.ts' |
        Where-Object { Select-String -Path $_.FullName -Pattern $markerPattern -Quiet })
}

if ($markedFiles.Count -eq 0) {
    Write-Host "InMemory scale guard: no @INMEMORY_JOB_STORE or @INMEMORY_CACHE_SINGLE_REPLICA markers found — all single-replica stores migrated. Gate passes unconditionally."
    return
}

# ── 2. Extract taxonomy-editor maxReplicas from main.bicep ────────────────────
# NOTE: the regex anchors on the literal string 'maxReplicas capped at' (followed by the
# number) — that string is load-bearing for this gate (Gate Co-Location, t/2885; widened
# from 'capped at 1' when the cap was raised to 5, t/4176). Rewording the cap comment in
# main.bicep requires updating the regex here.
$bicepContent = Get-Content -Path $BicepPath -Raw

$match = [regex]::Match($bicepContent, 'maxReplicas capped at \d+[\s\S]*?maxReplicas:\s*(\d+)')
if (-not $match.Success) {
    throw "InMemoryJobStore scale guard: could not parse taxonomy-editor maxReplicas from $BicepPath. Ensure the t/2885 cap comment and maxReplicas line are present and intact."
}
$maxReplicas = [int]$match.Groups[1].Value

# ── 3. Enforce the invariant ──────────────────────────────────────────────────
if ($maxReplicas -gt 1) {
    $fileList = ($markedFiles | Select-Object -ExpandProperty Name) -join ', '
    Write-Host "::error::InMemory scale guard FAILED: maxReplicas=$maxReplicas but single-replica markers present in: $fileList"
    Write-Host "::error::Raising maxReplicas above 1 while any per-process in-memory store is active reinstates cross-replica 404 race (POST on replica A, GET poll on replica B → 404)."
    Write-Host "::error::Migrate ALL marked stores to shared/replica-safe backends and remove their markers before scaling out. See t/2885, t/3504."
    throw "InMemory scale guard FAILED: maxReplicas=$maxReplicas with in-memory stores still in use: $fileList"
}

Write-Host "InMemory scale guard: maxReplicas=$maxReplicas, single-replica markers present in $($markedFiles.Count) file(s) ($($markedFiles.Name -join ', ')) — invariant holds. Gate passes."
