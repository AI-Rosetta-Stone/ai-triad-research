# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Characterization tests for Invoke-IterativeExtraction's FIRE entry point (t/3849 complexity
# refactor). These pin the ORIGINAL behaviour on the edge inputs a review (PR #5503) found the
# first refactor had changed: phase-1 parse of ''/null/[]/garbage, and the refinement loop's
# paid-API-call count when a claim has no 'claim' property. Written to pass on the pre-refactor
# code first. Race-safe: dot-sources ONLY this one Private file with deterministic stubs, never
# Import-Module the module.

BeforeAll {
    function New-ActionableError { param($Goal, $Problem, $Location, $NextSteps, [switch]$Throw) throw "$Goal : $Problem" }
    function Repair-TruncatedJson { param($Text) $null }
    function Get-TextEmbedding { $null }
    function Get-WordTokens { param($t) @($t -split '\s+') }
    function Get-JaccardSimilarity { param($a, $b) 1.0 }
    $script:TaxonomyData = @{}
    $script:CachedEmbeddings = $null
    $script:Responses = $null
    $script:Calls = 0
    function Invoke-AIApi {
        param($Prompt, $SystemInstruction, $Model, $ApiKey, $Temperature, $MaxTokens, [switch]$JsonMode, $ResponseSchema, $TimeoutSec)
        $r = $script:Responses[[Math]::Min($script:Calls, $script:Responses.Count - 1)]
        $script:Calls++
        [PSCustomObject]@{ Text = $r; Backend = 'stub' }
    }
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'Invoke-IterativeExtraction.ps1')

    function script:RunFire([object[]]$Responses) {
        $script:Responses = @($Responses); $script:Calls = 0
        $out = Invoke-IterativeExtraction -Prompt p -Model m -ApiKey '' -WallClockSeconds 600 3>$null
        [PSCustomObject]@{ Result = $out; Calls = $script:Calls }
    }
}

Describe 'Invoke-IterativeExtraction FIRE phase-1 parse' -Tag 'data-mutation' {
    It 'throws on empty text (strict-mode property access on a null parse)' {
        { RunFire @('') } | Should -Throw
    }
    It 'throws on literal null JSON' {
        { RunFire @('null') } | Should -Throw
    }
    It 'treats an empty array [] as no_claims, not a parse failure' {
        $r = RunFire @('[]')
        $r.Result.FireStats['termination_reason'] | Should -BeExactly 'no_claims'
        $r.Result.FireStats.ContainsKey('parse_failed') | Should -BeFalse
    }
    It 'treats a top-level array of objects as no_claims' {
        $r = RunFire @('[{"factual_claims":[]},{"a":1}]')
        $r.Result.FireStats['termination_reason'] | Should -BeExactly 'no_claims'
    }
    It 'reports parse_failed only on genuinely unparseable text' {
        $r = RunFire @('{not json')
        $r.Result.FireStats['termination_reason'] | Should -BeExactly 'parse_failed'
        $r.Result.FireStats['parse_failed'] | Should -BeTrue
    }
}

Describe 'Invoke-IterativeExtraction FIRE refinement loop' -Tag 'data-mutation' {
    It 'a claim with no claim property + high-confidence refinement confirms in ONE iteration (2 API calls)' {
        # Regression guard: losing $Confidence on the refined_claim assignment throw used to burn
        # all 5 iterations (6 paid calls). Must be 2 calls, 1 iteration, confident.
        $r = RunFire @(
            '{"factual_claims":[{"claim_label":"c1"}]}',
            '{"claim_label":"c1","verified":true,"refined_claim":"new text","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true},"confidence":0.9}'
        )
        $r.Calls | Should -Be 2
        $r.Result.FireStats['total_iterations'] | Should -Be 1
        $r.Result.FireStats['termination_reason'] | Should -BeExactly 'all_confident'
        $r.Result.Summary.factual_claims[0].fire_confidence | Should -Be 0.9
    }
    It 'a refinement with evidence_criteria:null on a claim that HAS evidence_criteria still confirms in one iteration (2 API calls)' {
        # Regression guard (2nd trigger): Add-FireEvidenceChanges throws on a null evidence_criteria;
        # the confidence applied before it must survive, or the loop burns 6 calls / 5 iterations.
        $r = RunFire @(
            '{"factual_claims":[{"claim_label":"c1","claim":"old","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":true}}]}',
            '{"claim_label":"c1","confidence":0.9,"evidence_criteria":null}'
        )
        $r.Calls | Should -Be 2
        $r.Result.FireStats['total_iterations'] | Should -Be 1
        $r.Result.FireStats['termination_reason'] | Should -BeExactly 'all_confident'
        $r.Result.Summary.factual_claims[0].fire_confidence | Should -Be 0.9
        # original evidence_criteria preserved (the null overwrite threw before it applied)
        $r.Result.Summary.factual_claims[0].evidence_criteria.specificity | Should -BeExactly 'vague'
    }

    It 'a normal uncertain->refined->confident claim confirms in one iteration' {
        $r = RunFire @(
            '{"factual_claims":[{"claim_label":"c1","claim":"old","taxonomy_node_id":"acc-x-001"}]}',
            '{"claim_label":"c1","verified":true,"refined_claim":"new text","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true},"confidence":0.9}'
        )
        $r.Calls | Should -Be 2
        $r.Result.Summary.factual_claims[0].claim | Should -BeExactly 'new text'
    }
}
