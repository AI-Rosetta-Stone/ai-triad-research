# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Race-safe characterization tests for Merge-ChunkSummaries (Refactorer).
.DESCRIPTION
    Pins the CURRENT observable behavior of Merge-ChunkSummaries across its
    branches so a behavior-preserving complexity refactor can be verified
    without importing the (concurrently-edited) batch worktree module. This
    dot-sources ONLY Merge-ChunkSummaries.ps1 and provides faithful stubs for
    its dependencies (Get-SummaryProp, Invoke-BatchEmbeddings,
    New-ContextRotStage) plus the two camp/category script constants.
#>

BeforeAll {
    $FileUnderTest = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Merge-ChunkSummaries.ps1'
    . $FileUnderTest

    # ── Canonical constants (mirrors Get-SummaryProp.ps1) ──────────────────
    $script:AITriadPovCamps      = @('accelerationist', 'safetyist', 'skeptic')
    $script:AITriadPovCategories = @('Desires', 'Beliefs', 'Intentions')

    # ── Faithful Get-SummaryProp stub (mirrors Get-JsonField shape dispatch) ─
    function Get-SummaryProp {
        param($Object, [string]$Name)
        if ($null -eq $Object -or $Object -is [string] -or $Object -is [System.ValueType]) { return $null }
        if ($Object -is [System.Collections.IDictionary]) {
            if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null }
        }
        if ($Object -is [System.Collections.IEnumerable]) { return $null }
        $p = $Object.PSObject.Properties[$Name]
        if ($null -ne $p) { return $p.Value } else { return $null }
    }

    # ── Embedding stub, driven per-test by $script:EmbeddingMap ─────────────
    $script:EmbeddingMap = @{}
    function Invoke-BatchEmbeddings {
        param([string[]]$Texts)
        return $script:EmbeddingMap
    }

    function New-ContextRotStage {
        param($Stage, $InUnits, $InCount, $OutUnits, $OutCount, $Flags)
        return [ordered]@{ stage = $Stage; in = $InCount; out = $OutCount; flags = $Flags }
    }

    function New-Vec2 { param([double]$Cos) @($Cos, [Math]::Sqrt(1 - $Cos * $Cos)) }
}

Describe 'Merge-ChunkSummaries characterization: malformed-chunk resilience' {
    BeforeEach { $script:EmbeddingMap = @{} }

    It 'does not throw and merges valid chunks when a camp lacks key_points' {
        $Good = '{"pov_summaries":{"accelerationist":{"key_points":[{"point":"Automation raises productivity","taxonomy_node_id":"acc-beliefs-001"}]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[{"claim_label":"gdp-up","claim":"GDP rose"}],"unmapped_concepts":[{"suggested_label":"new-idea"}]}' | ConvertFrom-Json
        $BadCamp  = '{"pov_summaries":{"safetyist":{}},"factual_claims":[{}],"unmapped_concepts":[{}]}' | ConvertFrom-Json
        $BadEmpty = '{}' | ConvertFrom-Json

        { Merge-ChunkSummaries -ChunkResults @($Good, $BadCamp, $BadEmpty) -WarningAction SilentlyContinue } | Should -Not -Throw
        $Merged = Merge-ChunkSummaries -ChunkResults @($Good, $BadCamp, $BadEmpty) -WarningAction SilentlyContinue
        @($Merged['pov_summaries']['accelerationist']['key_points']).Count | Should -Be 1
        @($Merged['factual_claims']).Count | Should -BeGreaterThan 0
    }

    It 'drops a bare null unmapped_concepts entry and keeps the real one (t/3907)' {
        $ChunkWithNull = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[null,{"suggested_label":"real-concept","concept":"A genuinely new concept."}]}' | ConvertFrom-Json
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkWithNull) -WarningAction SilentlyContinue
        @($Merged['unmapped_concepts']).Count | Should -Be 1
        @($Merged['unmapped_concepts'] | Where-Object { $null -eq $_ }).Count | Should -Be 0
    }
}

Describe 'Merge-ChunkSummaries characterization: empty_cells (t/4601)' {
    BeforeEach { $script:EmbeddingMap = @{} }

    It 'carries a cell when every chunk declared it empty, first reason wins' {
        $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk A reason"}]}' | ConvertFrom-Json
        $ChunkB = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk B reason"}]}' | ConvertFrom-Json
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB)
        $Cell = @($Merged['empty_cells']) | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }
        @($Cell).Count | Should -Be 1
        $Cell.reason | Should -Be 'chunk A reason'
    }

    It 'carries a cell when only some chunks declared it empty, warns on disagreement' {
        $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"chunk A reason"}]}' | ConvertFrom-Json
        $ChunkB = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[]}},"factual_claims":[],"unmapped_concepts":[]}' | ConvertFrom-Json
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningVariable warnings -WarningAction SilentlyContinue
        $Cell = @($Merged['empty_cells']) | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }
        @($Cell).Count | Should -Be 1
        @($warnings | Where-Object { "$_" -match 't/4601' }).Count | Should -Be 1
    }

    It 'does not carry a cell when merged key_points have a point in that category' {
        $ChunkA = '{"pov_summaries":{"accelerationist":{"key_points":[]},"safetyist":{"key_points":[]},"skeptic":{"key_points":[{"point":"a skeptic point","category":"Intentions"}]}},"factual_claims":[],"unmapped_concepts":[],"empty_cells":[{"camp":"skeptic","category":"Intentions","reason":"stale"}]}' | ConvertFrom-Json
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA)
        @($Merged['empty_cells'] | Where-Object { $_.camp -eq 'skeptic' -and $_.category -eq 'Intentions' }).Count | Should -Be 0
    }
}

Describe 'Merge-ChunkSummaries characterization: clustering + folding (t/4472)' {
    BeforeEach { $script:EmbeddingMap = @{} }

    It 'folds two same-category key_points above threshold into evidence_spans' {
        $TextA = 'Automation will raise aggregate productivity across the economy.'
        $TextB = 'Automation increases productivity economy-wide.'
        $script:EmbeddingMap = @{ $TextA = @(1.0, 0.0); $TextB = (New-Vec2 0.95) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'short point A'; canonical_proposition = $TextA; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001'; verbatim = 'VERBATIM A'; excerpt_context = 'CONTEXT A' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'a much longer point B that restates the same thesis in different words'; canonical_proposition = $TextB; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001'; verbatim = 'VERBATIM B'; excerpt_context = 'CONTEXT B' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
        $Points.Count | Should -Be 1
        $Points[0].point | Should -Match 'longer point B'
        $Points[0].verbatim | Should -Be 'VERBATIM B'
        @($Points[0].evidence_spans).Count | Should -Be 1
        @($Points[0].evidence_spans)[0].verbatim | Should -Be 'VERBATIM A'
        @($Points[0].evidence_spans)[0].canonical_proposition | Should -Be $TextA
    }

    It 'does not cluster key_points in different categories' {
        $Text = 'Identical proposition text for both.'
        $script:EmbeddingMap = @{ $Text = @(1.0, 0.0) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @(
                [PSCustomObject]@{ point = 'p'; canonical_proposition = $Text; category = 'Beliefs' },
                [PSCustomObject]@{ point = 'p'; canonical_proposition = $Text; category = 'Desires' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA) -WarningAction SilentlyContinue
        @($Merged['pov_summaries']['accelerationist']['key_points']).Count | Should -Be 2
    }

    It 'vetoes a fold when both key_points have disjoint non-empty anchors' {
        $TextA = 'Shared thesis text.'; $TextB = 'Shared thesis restated.'
        $script:EmbeddingMap = @{ $TextA = @(1.0, 0.0); $TextB = (New-Vec2 0.98) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'point A'; canonical_proposition = $TextA; category = 'Beliefs'; anchors = @('EU AI Act Article 6') }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'point B'; canonical_proposition = $TextB; category = 'Beliefs'; anchors = @('NIST AI RMF 1.1') }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        @($Merged['pov_summaries']['accelerationist']['key_points']).Count | Should -Be 2
    }

    It 'unions a lone anchor set onto the primary when a fold happens' {
        $TextA = 'Shared thesis text.'; $TextB = 'Shared thesis restated.'
        $script:EmbeddingMap = @{ $TextA = @(1.0, 0.0); $TextB = (New-Vec2 0.98) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'point A, much shorter'; canonical_proposition = $TextA; category = 'Beliefs'; anchors = @('EU AI Act Article 6') }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'point B, the much longer restatement that becomes primary'; canonical_proposition = $TextB; category = 'Beliefs' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
        $Points.Count | Should -Be 1
        @($Points[0].anchors) | Should -Be @('EU AI Act Article 6')
    }

    It 'folds factual_claims on a genuine numeric superset' {
        $ClaimA = 'Adoption reached 57% among surveyed firms.'
        $ClaimB = 'Adoption reached 57% among surveyed firms in the 2026 cohort.'
        $script:EmbeddingMap = @{ $ClaimA = @(1.0, 0.0); $ClaimB = (New-Vec2 0.92) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimA; claim_label = 'adoption-rate' }); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimB; claim_label = 'adoption-rate-detailed' }); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        $Claims = @($Merged['factual_claims'])
        $Claims.Count | Should -Be 1
        $Claims[0].claim | Should -Be $ClaimB
        @($Claims[0].evidence_spans)[0].claim | Should -Be $ClaimA
    }

    It 'does not fold factual_claims with differing non-subset numbers' {
        $ClaimA = 'Asian adults report usage at 57%.'
        $ClaimB = 'Asian adults report usage at 36%.'
        $script:EmbeddingMap = @{ $ClaimA = @(1.0, 0.0); $ClaimB = (New-Vec2 0.987) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimA }); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimB }); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        @($Merged['factual_claims']).Count | Should -Be 2
    }

    It 'requires >= 0.95 cosine to fold no-number factual_claims' {
        $ClaimA = 'The report emphasizes long-term structural risk.'
        $ClaimB = 'The report stresses long-run structural danger.'
        $script:EmbeddingMap = @{ $ClaimA = @(1.0, 0.0); $ClaimB = (New-Vec2 0.93) }
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimA }); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{}; factual_claims = @([PSCustomObject]@{ claim = $ClaimB }); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningAction SilentlyContinue
        @($Merged['factual_claims']).Count | Should -Be 2
    }

    It 'falls back to first-occurrence dedup with no evidence_spans when model unavailable' {
        $script:EmbeddingMap = @{}
        $ChunkA = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'Automation raises productivity'; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $ChunkB = [PSCustomObject]@{ pov_summaries = [PSCustomObject]@{
            accelerationist = [PSCustomObject]@{ key_points = @([PSCustomObject]@{ point = 'Automation raises productivity'; category = 'Beliefs'; taxonomy_node_id = 'acc-beliefs-001' }) }
            safetyist = [PSCustomObject]@{ key_points = @() }; skeptic = [PSCustomObject]@{ key_points = @() } }
            factual_claims = @(); unmapped_concepts = @() }
        $Merged = Merge-ChunkSummaries -ChunkResults @($ChunkA, $ChunkB) -WarningVariable w -WarningAction SilentlyContinue
        $Points = @($Merged['pov_summaries']['accelerationist']['key_points'])
        $Points.Count | Should -Be 1
        $Points[0].PSObject.Properties['evidence_spans'] | Should -BeNullOrEmpty
        @($w | Where-Object { "$_" -match 'embedding model unavailable' }).Count | Should -BeGreaterThan 0
    }
}
