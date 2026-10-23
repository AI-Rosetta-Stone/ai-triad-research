# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    CI assertion for Test-CitationLinkIntegrity leg (c), both arms (t/4443, t/4147 SO C5a).
.DESCRIPTION
    The data repo's citation-link-integrity.yml checks out this code repo's `main` with no
    `ref:`, so a code change to Test-CitationLinkIntegrity, Build-NodeSourceIndex,
    Get-SummariesInputHash or their Private helpers changes the verdict of a BLOCKING data
    gate without that gate ever running on the code PR itself (t/4147 C5). This script runs
    leg (c) against a small COMMITTED fixture (tests/fixtures/citation-link-integrity/) and
    asserts both arms: a fresh, correctly-built index passes; a committed index that predates
    a later-added summary (the real "forgot to regenerate" shape, not a hand-edited hash)
    fails. It is the job's own assertion, not just a tolerated red step — a regression in
    either direction (fresh fails, or stale passes) exits non-zero.

    Scope note: this first pass covers arms (a) fresh-passes and (b) stale-fails only, per
    t/4443's own description. The superseded_by/duplicate_of fixture shapes (arms d/e) are
    deferred to a follow-up once t/4441 (the shared live-node function) lands.
#>

#Requires -Version 7
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '../..')
Import-Module (Join-Path $RepoRoot 'scripts/AITriad/AITriad.psm1') -Force

$FixtureRoot = Join-Path $RepoRoot 'tests/fixtures/citation-link-integrity'
$failures = [System.Collections.Generic.List[string]]::new()

function script:AssertLegC([string]$label, [string]$fixtureDir, [bool]$expectPass) {
    $tax = Join-Path $fixtureDir 'taxonomy'
    $sum = Join-Path $fixtureDir 'summaries'
    $idx = Join-Path $tax 'source_index.json'

    $result = Test-CitationLinkIntegrity -SummariesDir $sum -TaxonomyDir $tax -SourceIndexPath $idx -SkipSourceResolution -WarningAction SilentlyContinue
    $legC = $result.results | Where-Object { $_.leg -eq 'c' }
    $actualPass = [bool]$legC.pass

    if ($actualPass -eq $expectPass) {
        Write-Host "PASS: $label — leg (c) pass=$actualPass as expected"
    } else {
        $offenders = $legC.offenders | ConvertTo-Json -Compress -Depth 5
        $script:failures.Add("$label — expected leg (c) pass=$expectPass, got pass=$actualPass (offenders: $offenders)")
        Write-Host "::error::$label — expected leg (c) pass=$expectPass, got pass=$actualPass (offenders: $offenders)"
    }
}

script:AssertLegC 'fresh fixture (index matches committed summaries)' (Join-Path $FixtureRoot 'fresh') $true
script:AssertLegC 'stale fixture (index predates an added summary)'  (Join-Path $FixtureRoot 'stale') $false

if ($failures.Count -gt 0) {
    Write-Host "::error::citation-link-integrity-ci-fixture: $($failures.Count) assertion(s) failed"
    exit 1
}

Write-Host "citation-link-integrity-ci-fixture: both arms confirmed (fresh passes, stale fails)."
