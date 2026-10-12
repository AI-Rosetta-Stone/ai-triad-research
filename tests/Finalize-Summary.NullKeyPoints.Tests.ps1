# Tag: summarization (t/3434)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Regression tests for Finalize-Summary null/absent camp key_points handling (t/3434, Diagnostics p/17).
# Bug: a camp with null (or absent) key_points added a SchemaError that printed a red "✗ Schema:" line —
# which LOOKED fatal but wasn't (the function only returns failure when pov_summaries itself is missing)
# — and did NOT normalize the field to @() like the sibling factual_claims / unmapped_concepts do.
# Fix: WARN + default to @() (+ force-array/write-back), no SchemaError.
#
# Fixtures are built via ConvertFrom-Json (the real pipeline input shape) — a `[]` stays a non-null empty
# array, unlike `[pscustomobject]@{ key_points = @() }` which collapses @() to $null. All camps carry
# EMPTY key_points so the heavy gated passes (retrieval/polarity/veto) never fire. Finalize-Summary is a
# SIMPLE function (no CmdletBinding), so warnings are captured via the `3>` stream redirect, not
# -WarningVariable. Write-Utf8NoBom is mocked; the metadata read/write is try/caught inside the function.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Finalize-Summary null/absent camp key_points (t/3434)' -Tag 'summarization' {

    It 'normalizes a NULL camp key_points to @(), warns, and does NOT fail' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            $summary = '{"pov_summaries":{"accelerationist":{"key_points":null},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}' | ConvertFrom-Json

            $wf = Join-Path $TestDrive "warn-null-$(Get-Random).txt"
            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-null-kp' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) 3> $wf
            $warnText = [string](Get-Content -Raw -LiteralPath $wf -ErrorAction SilentlyContinue)

            $r.Success | Should -BeTrue                                                   # not a schema failure
            @($summary.pov_summaries.accelerationist.key_points).Count | Should -Be 0     # normalized to empty
            $summary.pov_summaries.accelerationist.PSObject.Properties['key_points'] | Should -Not -BeNullOrEmpty
            $warnText | Should -Match 'accelerationist\.key_points missing/null'           # WARN, not red ✗
        }
    }

    It 'normalizes an ABSENT camp key_points property to @() (hardening beyond the null case)' {
        InModuleScope AITriad {
            $script:CachedEmbeddings = @{}; $script:TaxonomyData = @{}; $script:ContextRotStages = @()
            Mock Get-TaxonomyNodeIdSet { [System.Collections.Generic.HashSet[string]]::new() }
            Mock Write-Utf8NoBom { }

            # accelerationist has NO key_points property at all.
            $summary = '{"pov_summaries":{"accelerationist":{},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}' | ConvertFrom-Json

            $wf = Join-Path $TestDrive "warn-absent-$(Get-Random).txt"
            $r = Finalize-Summary -SummaryObject $summary -ThisDocId 'doc-absent-kp' -TaxonomyVersion 'v1' `
                -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -Now '2026-09-12T00:00:00Z' `
                -SummariesDir $TestDrive -Doc @{ MetaFile = (Join-Path $TestDrive 'nope-meta.json') } `
                -Elapsed ([TimeSpan]::FromSeconds(1)) 3> $wf
            $warnText = [string](Get-Content -Raw -LiteralPath $wf -ErrorAction SilentlyContinue)

            $r.Success | Should -BeTrue
            $prop = $summary.pov_summaries.accelerationist.PSObject.Properties['key_points']
            $prop | Should -Not -BeNullOrEmpty                                            # property was created
            @($prop.Value).Count | Should -Be 0
            $warnText | Should -Match 'accelerationist\.key_points missing/null'
        }
    }

    # NOTE: since t/4079 a camp with an empty array `[]` is "present but empty" (Get-SummaryField no
    # longer unrolls @() to $null), so it does NOT take the warn path; that arm is pinned in
    # Finalize-Summary.PinnedBugs.Tests.ps1 (item 5).
}
