# Tag: ingestion
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Race-safe characterization tests for Invoke-IterativeExtraction (FIRE).
.DESCRIPTION
    Pins the orchestration behavior of the FIRE loop across its branches
    (all-confident, iterate, drop-on-failed-verification, drift, parse-failure,
    no-claims, null-initial-result) WITHOUT importing the module. Only the one
    Private file is dot-sourced; every module dependency is replaced by a
    deterministic stub defined in this script's scope. This keeps the test
    independent of concurrent edits to other files in the same worktree.
#>

BeforeAll {
    . "$PSScriptRoot/../scripts/AITriad/Private/Invoke-IterativeExtraction.ps1"

    # Module-scoped state the production code reads via $script:
    $script:TaxonomyData = @{}
    $script:CachedEmbeddings = $null

    # Per-test AI response handler: ($Prompt, $MaxTokens) -> response object or $null.
    $script:AIHandler = { param($Prompt, $MaxTokens) $null }

    # --- Dependency stubs (deterministic) ---------------------------------
    function Invoke-AIApi {
        param(
            $Prompt, $SystemInstruction, $Model, $ApiKey, $Temperature,
            $MaxTokens, [switch]$JsonMode, $ResponseSchema, $TimeoutSec
        )
        & $script:AIHandler $Prompt $MaxTokens
    }

    function Repair-TruncatedJson { param($Text) $null }

    function New-ActionableError {
        param($Goal, $Problem, $Location, $NextSteps, [switch]$Throw)
        if ($Throw) { throw "$Goal`: $Problem" }
    }

    function Get-TextEmbedding { param($Texts, $Ids) @{} }

    function Get-WordTokens {
        param($Text)
        @(($Text.ToLower() -split '\W+') | Where-Object { $_ })
    }

    function Get-JaccardSimilarity {
        param($A, $B)
        $sa = [System.Collections.Generic.HashSet[string]]::new([string[]]@($A))
        $sb = [System.Collections.Generic.HashSet[string]]::new([string[]]@($B))
        if ($sa.Count -eq 0 -and $sb.Count -eq 0) { return 1.0 }
        $inter = [System.Collections.Generic.HashSet[string]]::new($sa); $inter.IntersectWith($sb)
        $uni = [System.Collections.Generic.HashSet[string]]::new($sa); $uni.UnionWith($sb)
        if ($uni.Count -eq 0) { return 0.0 }
        [double]$inter.Count / $uni.Count
    }

    function New-Resp {
        param($Text)
        [PSCustomObject]@{ Text = $Text; Backend = 'gemini'; Model = 'm'; Truncated = $false; Usage = $null; RawResponse = @{} }
    }
}

Describe 'Invoke-IterativeExtraction characterization' -Tag 'ingestion' {

    It 'All-confident claim: no iteration, termination all_confident' {
        $script:AIHandler = {
            param($Prompt, $MaxTokens)
            New-Resp '{"factual_claims":[{"claim_label":"c0","claim":"X","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true}}]}'
        }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' -ConfidenceThreshold 0.7 -MaxIterPerClaim 1 -WallClockSeconds 30 3>$null
        $r.FireStats.claims_confident | Should -Be 1
        $r.FireStats.claims_iterated | Should -Be 0
        $r.FireStats.termination_reason | Should -Be 'all_confident'
        $r.FireStats.claims_total | Should -Be 1
        $r.FireStats.total_api_calls | Should -Be 1
    }

    It 'Parse failure: Summary null, parse_failed stats shape' {
        $script:AIHandler = { param($Prompt, $MaxTokens) New-Resp 'not json at all {' }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' 3>$null
        $r.Summary | Should -BeNullOrEmpty
        $r.FireStats.termination_reason | Should -Be 'parse_failed'
        $r.FireStats.parse_failed | Should -BeTrue
        $r.FireStats.phase1_only | Should -BeTrue
        $r.FireStats.claims_total | Should -Be 0
    }

    It 'No factual_claims: termination no_claims' {
        $script:AIHandler = { param($Prompt, $MaxTokens) New-Resp '{"pov_summaries":{}}' }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' 3>$null
        $r.FireStats.termination_reason | Should -Be 'no_claims'
        $r.FireStats.claims_total | Should -Be 0
        $r.Summary | Should -Not -BeNullOrEmpty
    }

    It 'Null initial result throws via New-ActionableError' {
        $script:AIHandler = { param($Prompt, $MaxTokens) $null }
        { Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' 3>$null } | Should -Throw
    }

    It 'Drops a claim whose verification says verified=false; counts the drop' {
        $script:AIHandler = {
            param($Prompt, $MaxTokens)
            if ($MaxTokens -eq 32768) {
                return New-Resp ('{"factual_claims":[' +
                    '{"claim_label":"claim-0","claim":"A settlement was offered","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":true}},' +
                    '{"claim_label":"claim-1","claim":"A real claim","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":true}}]}')
            }
            if ($Prompt -match 'claim-0') {
                return New-Resp '{"claim_label":"claim-0","verified":false,"refined_claim":"The source document does not contain that","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":false},"confidence":0.1}'
            }
            New-Resp '{"claim_label":"claim-1","verified":true,"refined_claim":"A real claim, refined","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true},"confidence":0.9}'
        }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' -ConfidenceThreshold 0.7 -MaxIterPerClaim 1 -WallClockSeconds 30 3>$null
        @($r.Summary.factual_claims).Count | Should -Be 1
        $r.Summary.factual_claims[0].claim_label | Should -Be 'claim-1'
        @($r.Summary.factual_claims | Where-Object { $_.claim -match 'does not contain' }) | Should -BeNullOrEmpty
        $r.FireStats.claims_total | Should -Be 2
        $r.FireStats.claims_dropped_verification | Should -Be 1
    }

    It 'Flags drift_warning when refined claim diverges (Jaccard fallback)' {
        $script:TaxonomyData = @{
            'acc' = [PSCustomObject]@{
                nodes = @([PSCustomObject]@{ id = 'acc-beliefs-001'; label = 'Rapid AI development benefits humanity'; description = 'Fast AI progress yields economic and social gains.' })
            }
        }
        $script:CachedEmbeddings = $null
        $script:AIHandler = {
            param($Prompt, $MaxTokens)
            if ($MaxTokens -eq 32768) {
                return New-Resp '{"factual_claims":[{"claim_label":"claim-0","claim":"Rapid AI development benefits humanity","taxonomy_node_id":"acc-beliefs-001","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":true}}]}'
            }
            New-Resp '{"claim_label":"claim-0","verified":true,"refined_claim":"International trade tariffs reduce consumer purchasing power elsewhere","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true},"confidence":0.85}'
        }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' -ConfidenceThreshold 0.7 -MaxIterPerClaim 1 -WallClockSeconds 30 3>$null
        $r.Summary.factual_claims[0].drift_warning | Should -BeTrue
        $r.FireStats.claims_drifted | Should -BeGreaterOrEqual 1
    }

    It 'Iterates an uncertain claim to confidence; no drift without taxonomy id' {
        $script:TaxonomyData = @{}
        $script:CachedEmbeddings = $null
        $script:AIHandler = {
            param($Prompt, $MaxTokens)
            if ($MaxTokens -eq 32768) {
                return New-Resp '{"factual_claims":[{"claim_label":"claim-0","claim":"Some observation","evidence_criteria":{"specificity":"vague","has_warrant":false,"internally_consistent":true}}]}'
            }
            New-Resp '{"claim_label":"claim-0","verified":true,"refined_claim":"Some observation, sharpened","evidence_criteria":{"specificity":"precise","has_warrant":true,"internally_consistent":true},"confidence":0.9}'
        }
        $r = Invoke-IterativeExtraction -Prompt 'p' -Model 'm' -ApiKey '' -ConfidenceThreshold 0.7 -MaxIterPerClaim 1 -WallClockSeconds 30 3>$null
        $r.FireStats.claims_iterated | Should -Be 1
        $r.FireStats.claims_drifted | Should -Be 0
        $r.FireStats.total_api_calls | Should -Be 2
        $r.Summary.factual_claims[0].claim | Should -Be 'Some observation, sharpened'
    }
}
