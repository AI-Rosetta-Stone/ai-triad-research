# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Finalize-Summary (t/4136, plan t/3910#37 section 4), written BEFORE its
    complexity refactor and required to pass unchanged after it.
.DESCRIPTION
    Three layers, all pinned against goldens in tests/fixtures/finalize-summary/:

    1. Direct scenarios. Finalize-Summary is called in module scope against a fixture tree in $TestDrive.
       The passes it delegates to (Get-TaxonomyNodeIdSet, Invoke-RetrievalConfidencePass,
       Invoke-PolarityGatePass, Invoke-Mechanism5RetrievalPass, Invoke-ExcludesVetoPass,
       Resolve-UnmappedConcepts, New-ContextRotMetrics) are mocked and every call to them is recorded, in
       order, with its arguments. Write-Utf8NoBom is REAL: the sink writes to $TestDrive, and the writes are
       counted (and failed on demand) through the Assert-DataWriteAllowed guard it calls. Each golden
       <scenario>.json holds the interleaved host/warning transcript (with colours, via HostCapture.ps1),
       the returned hashtable, the recorded calls, the ordered write list, and the written summary and
       metadata.json text.

    2. A "real run" (TL condition, t/3910#39): Invoke-DocumentSummary end to end on a fixture data root
       ($env:AI_TRIAD_DATA_ROOT -> $TestDrive) with Invoke-AIApi mocked (canned summary JSON). The written
       summary and metadata.json are compared BYTE FOR BYTE (after the normalization below) with
       e2e-single-call.summary.json / e2e-single-call.metadata.json, and the console transcript with
       e2e-single-call.transcript.json. Besides Invoke-AIApi, two more seams are faked, neither of them
       code under change:
         - Get-Date is frozen (determinism: measured_at, elapsed seconds);
         - Get-TextEmbedding returns $null, which is exactly what it returns when the local embedding
           model is unavailable (CI). The real call spawns a ~25s Python model load per call. The canned
           texts are mutually dissimilar, so dedup removes nothing either way, and setting
           $env:FINALIZESUMMARY_E2E_REAL_EMBEDDINGS = '1' runs the real embedder to prove the bytes do
           not change. Everything else (CHESS, RAG fallback to the compact taxonomy, FIRE sniff, density
           check, stance/backfill, unmapped resolution, the polarity gate, excludes-veto, the dirty-tree
           write guard) runs for real against the fixture taxonomy.

    3. The parallel batch path (TL condition 2). No pre-existing test runs Finalize-Summary inside a
       ForEach-Object -Parallel runspace (Invoke-BatchSummary.ParallelResilience replays the try/catch
       mechanism with a stand-in; Invoke-BatchSummary.Characterization mocks Invoke-DocSummaryWithCapture).
       This file runs the PRODUCTION -Parallel scriptblock, lifted verbatim from
       Invoke-BatchParallelSummarySet's AST, with a single inserted line that installs the same three
       fakes into each runspace's freshly imported module (Pester mocks do not reach runspaces). Every
       runspace therefore resolves Invoke-DocumentSummary -> Finalize-Summary -> its helpers from a fresh
       Import-Module, so a refactor helper that is not loaded by the module fails here.

    Determinism / normalization (Sage #220):
      - metadata.json is compared exactly as written. node_references_by_pov and primary_pov_distribution
        used to be plain @{} hashtables whose key order varied per process, so the lines inside those two
        blocks were sorted before comparison. Since t/4079 they are ordered dictionaries in ordinal key
        order, so that sort is gone: a regression to per-process order now fails the golden.
      - e2e summary: context_rot.stages[].flags used to be built as [ordered]@{} + <plain @{}> in
        New-ContextRotStage, so a multi-key flags block came out in per-process order. Since t/4144 the
        flags are copied in ordinal key order, so this sort is now a no-op kept as a harmless guard. Only
        the lines inside each "flags" block are sorted; every other byte is compared as written. (The
        direct scenarios use at most one flag per stage, so their summary text is compared unnormalized.)
      - The returned hashtable is a plain @{}; its keys are sorted in the transcript golden.
      - $TestDrive paths are masked as <ROOT>.

    Regenerate the goldens ONLY when a behaviour change is intended and reviewed:
    set $env:FINALIZESUMMARY_REGEN_GOLDEN = '1' and run once.
#>

# ---------------------------------------------------------------------------------------------------
# Scenario data (discovery-time; passed into each It via -ForEach)
# ---------------------------------------------------------------------------------------------------

# The workhorse summary: every pass has something to do.
$script:RichSummary = @'
{
  "pov_summaries": {
    "accelerationist": { "key_points": [
      { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Scaling compute keeps delivering capability gains.", "stance": "aligned", "verbatim": "scale keeps working" },
      { "taxonomy_node_id": "acc-desires-002", "category": "Desires", "point": "Weak signal that open release speeds diffusion.", "stance": "Supports strongly", "verbatim": ["span one", "span two"] }
    ] },
    "safetyist": { "key_points": [
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "Independent audits remain rare.", "stance": "opposed" },
      { "taxonomy_node_id": null, "category": "Intentions", "point": "Labs should publish incident reports.", "stance": null }
    ] },
    "skeptic": { "key_points": [
      { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Even critics concede scores rose with scale.", "stance": "aligned" }
    ] }
  },
  "factual_claims": [
    { "claim": "Compute doubled every six months.", "linked_taxonomy_nodes": ["acc-beliefs-001", "saf-beliefs-003", "acc-desires-002"] },
    { "claim": "Few labs publish audits.", "linked_taxonomy_nodes": ["sit-004", null, "skp-beliefs-005"] },
    { "claim": "A policy registry entry.", "linked_taxonomy_nodes": "pol-001" },
    { "claim": "No links at all.", "linked_taxonomy_nodes": [] },
    { "claim": "No links field." }
  ],
  "unmapped_concepts": [
    { "suggested_label": "Compute Governance Treaties", "concept": "Binding treaties on training compute.", "suggested_pov": "safetyist", "suggested_category": "Intentions", "reason": "novel" },
    { "suggested_label": "Leaderboard Skepticism", "concept": "Leaderboards as marketing.", "suggested_pov": "skeptic", "suggested_category": "Beliefs", "reason": "novel" }
  ]
}
'@

$script:SmallSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "One.", "stance": "aligned" } ] },
    "safetyist": { "key_points": [ { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "Two.", "stance": "opposed" } ] },
    "skeptic": { "key_points": [ { "taxonomy_node_id": null, "category": "Desires", "point": "Three.", "stance": "neutral" } ] } },
  "factual_claims": [ { "claim": "Short claim.", "linked_taxonomy_nodes": ["saf-beliefs-003"] } ],
  "unmapped_concepts": [] }
'@

# ConvertFrom-Json keeps a JSON array an array, so a bare object is what the "single element unwrapped
# to a scalar" case looks like by the time it reaches Finalize-Summary.
$script:ScalarSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Lone point.", "stance": "aligned" } },
    "safetyist": { "key_points": [] },
    "skeptic": { "key_points": [] } },
  "factual_claims": { "claim": "Lone claim.", "linked_taxonomy_nodes": "skp-beliefs-001" },
  "unmapped_concepts": { "suggested_label": "Lone Concept", "concept": "Only one.", "reason": "novel" } }
'@

$script:NullKeyPointsSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": null },
    "safetyist": { "key_points": [] },
    "skeptic": { } },
  "factual_claims": [], "unmapped_concepts": [] }
'@

$script:NullUnmappedSummary = @'
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": [],
  "unmapped_concepts": [ null, { "suggested_label": "Kept Concept", "concept": "Survives the filter.", "reason": "novel" }, null ] }
'@

$script:IdShapedSummary = @'
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": [],
  "unmapped_concepts": [
    { "suggested_label": "skp-intentions-003", "concept": "Treat public leaderboards as marketing rather than as evidence of capability.", "reason": "novel" },
    { "suggested_label": "sit-12", "concept": "", "reason": "novel" },
    { "suggested_label": "A Normal Label", "concept": "Stays as is.", "reason": "novel" } ] }
'@

# saf-beliefs-999 and skp-desires-404 are not in the node set; ACC-Beliefs-001 differs only in case.
$script:HallucinatedSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "ACC-Beliefs-001", "category": "Beliefs", "point": "Case differs from the live id.", "stance": "neutral" } ] },
    "safetyist": { "key_points": [ { "taxonomy_node_id": "saf-beliefs-999", "category": "Beliefs", "point": "Regulators should require incident reporting within seventy two hours of discovery.", "stance": "aligned" } ] },
    "skeptic": { "key_points": [ { "taxonomy_node_id": "skp-desires-404", "category": "Desires", "point": null, "stance": "opposed" } ] } },
  "factual_claims": [],
  "unmapped_concepts": [] }
'@

$script:CrossCampSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "A1.", "stance": "opposed" },
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "A2 same camp, no warning.", "stance": "opposed" } ] },
    "safetyist": { "key_points": [ { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "S1.", "stance": "opposed" } ] },
    "skeptic": { "key_points": [
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "K1.", "stance": "opposed" },
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "K2 other stance.", "stance": "aligned" } ] } },
  "factual_claims": [], "unmapped_concepts": [] }
'@

$script:StanceSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s1", "stance": "Strongly Aligned" },
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s2", "stance": "strongly-opposed" },
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s3", "stance": "disagree" } ] },
    "safetyist": { "key_points": [
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s4", "stance": "N/A" },
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s5", "stance": "whatever" },
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s6", "stance": "" } ] },
    "skeptic": { "key_points": [
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s7", "stance": "an existential threat" },
      { "taxonomy_node_id": null, "category": "Beliefs", "point": "s8", "stance": "qualifies" } ] } },
  "factual_claims": [], "unmapped_concepts": [] }
'@

$script:NoPovSummariesSummary = '{ "factual_claims": [], "unmapped_concepts": [ { "suggested_label": "sit-9", "concept": "x" } ] }'

$script:MissingFieldsSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "One.", "stance": "aligned" } ] },
    "safetyist": { "key_points": [] } } }
'@

$script:NullFactualSummary = @'
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": null }
'@

$script:RagContext  = "=== RELEVANT TAXONOMY NODES ===`n  acc-beliefs-001: Scale wins`n  saf-beliefs-003: Audits`n    (indented detail, not a node)`n  skp-beliefs-001: Doubt it"
$script:FullContext = '{"nodes":[{"id":"acc-beliefs-001"},{"id":"saf-beliefs-003"},{ "id" : "skp-beliefs-001"}]}'

# Keys: Summary, TaxonomyJson, ChunkCount, FireStats, NodeIds ('none' = validation skipped),
# Embeddings / TaxonomyData (gate the passes), Gate ($true | $false | 'unset'), Polarity (counts the
# mocked gate returns; 'unset' omits -EnablePolarityGate), Flip (stances the mocked gate flips), Veto, Resolution ('none'|'resolve'|'throw'),
# ContextRot, FailWrite (relative path), NoMetadata, MaxTokens (passed to Finalize-Summary; default 32768, the
# single-call extraction budget; the chunked scenarios pass the chunked path's 65536, t/4079).
$script:Scenarios = @(
    @{ Name = 'rich-rag'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Embeddings = $true; TaxonomyData = $true
       Gate = $true; Polarity = @{ gated = 2; reps = 3; unresolved = 1; judge_flipped = 0; judge_kept = 1; self_healed = 0 }
       Veto = @{ VetoCount = 0; AmbiguousCount = 1 }; ContextRot = $true }
    @{ Name = 'full-taxonomy-no-passes'; Summary = $script:SmallSummary; TaxonomyJson = $script:FullContext; Gate = $true }
    @{ Name = 'chunked'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; ChunkCount = 3; TaxonomyData = $true
       Gate = $true; Veto = @{ VetoCount = 0; AmbiguousCount = 0 }; MaxTokens = 65536 }
    @{ Name = 'fire'; Summary = $script:SmallSummary; TaxonomyJson = $script:FullContext; FireStats = $true; Gate = $true }
    @{ Name = 'fire-chunked-rag'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; FireStats = $true; ChunkCount = 2; Gate = $true; MaxTokens = 65536 }
    @{ Name = 'single-element-force-array'; Summary = $script:ScalarSummary; TaxonomyJson = $script:RagContext; Embeddings = $true; Gate = $true }
    @{ Name = 'null-key-points'; Summary = $script:NullKeyPointsSummary; TaxonomyJson = $script:RagContext; Gate = 'unset' }
    @{ Name = 'null-unmapped-entries'; Summary = $script:NullUnmappedSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'id-shaped-label'; Summary = $script:IdShapedSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'hallucinated-node-id'; Summary = $script:HallucinatedSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'node-validation-skipped'; Summary = $script:HallucinatedSummary; TaxonomyJson = $script:RagContext; Gate = $true; NodeIds = 'none' }
    @{ Name = 'cross-camp-agreement'; Summary = $script:CrossCampSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'stance-normalization'; Summary = $script:StanceSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'polarity-flip'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Gate = $true
       Polarity = @{ gated = 3; reps = 5; unresolved = 0; judge_flipped = 2; judge_kept = 0; self_healed = 1 }; Flip = 2 }
    @{ Name = 'polarity-all-unresolved'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Gate = $true
       Polarity = @{ gated = 2; reps = 4; unresolved = 4; judge_flipped = 0; judge_kept = 0; self_healed = 0 } }
    @{ Name = 'polarity-off'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Gate = $false
       Polarity = @{ gated = 2; reps = 4; unresolved = 4; judge_flipped = 1; judge_kept = 0; self_healed = 0 } }
    @{ Name = 'polarity-gate-omitted-defaults-on'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; Gate = 'unset' }
    @{ Name = 'veto-counts'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; TaxonomyData = $true; Gate = $true
       Veto = @{ VetoCount = 2; AmbiguousCount = 0 } }
    @{ Name = 'unmapped-resolved'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Gate = $true; Resolution = 'resolve' }
    @{ Name = 'unmapped-resolution-throws'; Summary = $script:RichSummary; TaxonomyJson = $script:RagContext; Gate = $true; Resolution = 'throw' }
    @{ Name = 'missing-pov-summaries'; Summary = $script:NoPovSummariesSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'missing-camp-and-fields'; Summary = $script:MissingFieldsSummary; TaxonomyJson = $script:RagContext; Gate = $true; ContextRot = $true }
    @{ Name = 'null-factual-claims'; Summary = $script:NullFactualSummary; TaxonomyJson = $script:RagContext; Gate = $true }
    @{ Name = 'summary-write-fails'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; Gate = $true; FailWrite = 'summaries/doc-1.json' }
    @{ Name = 'metadata-write-fails'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; Gate = $true; FailWrite = 'sources/doc-1/metadata.json' }
    @{ Name = 'metadata-missing'; Summary = $script:SmallSummary; TaxonomyJson = $script:RagContext; Gate = $true; NoMetadata = $true }
)

BeforeAll {
    # Run-phase constants (top-level script variables exist only at discovery in Pester 5).
    $script:DefaultNodeIds = @('acc-beliefs-001', 'acc-desires-002', 'saf-beliefs-003', 'skp-beliefs-001', 'sit-004')
    # confidence_threshold: what Invoke-IterativeExtraction reports at its default (t/4079).
    $script:FireStats = [ordered]@{ confidence_threshold = 0.7; total_api_calls = 9; total_iterations = 3; claims_total = 12; claims_confident = 10; claims_iterated = 2; elapsed_seconds = 41.5; termination_reason = 'converged' }

    # e2e canned model output. Aligned key points carry no verbatim/canonical/attribution reps, so the
    # REAL polarity gate selects them (gated > 0) but has no pair to send to the Python directional engine.
    # Every text is distinct enough that dedup removes nothing with or without real embeddings.
    $script:E2ECannedSummary = @'
{
  "pov_summaries": {
    "accelerationist": { "key_points": [
      { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Frontier labs argue that scaling compute keeps producing capability gains.", "stance": "aligned", "extraction_confidence": 0.82 },
      { "taxonomy_node_id": "acc-desires-002", "category": "Desires", "point": "Developers want fewer licensing hurdles for open model releases.", "stance": "Strongly Aligned", "extraction_confidence": 0.74 }
    ] },
    "safetyist": { "key_points": [
      { "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "Independent third party audits of frontier systems remain rare.", "stance": "opposed", "verbatim": "independent audits remain rare", "extraction_confidence": 0.9 },
      { "taxonomy_node_id": "saf-beliefs-999", "category": "Intentions", "point": "Regulators should require incident reporting within seventy two hours.", "stance": "aligned", "extraction_confidence": 0.6 }
    ] },
    "skeptic": { "key_points": [
      { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Even critics concede that benchmark scores have risen alongside scale.", "stance": "aligned", "extraction_confidence": 0.7 },
      { "taxonomy_node_id": null, "category": "Desires", "point": "Benchmark saturation makes progress claims hard to verify independently.", "stance": "neutral", "extraction_confidence": 0.55 }
    ] }
  },
  "factual_claims": [
    { "claim": "Training compute for frontier models doubled roughly every six months.", "doc_position": "supports", "linked_taxonomy_nodes": ["acc-beliefs-001", "saf-beliefs-003"], "extraction_confidence": 0.9 },
    { "claim": "Only a handful of laboratories publish third party audit results.", "doc_position": "supports", "linked_taxonomy_nodes": ["saf-beliefs-003", null, "sit-004"],
      "evidence_criteria": { "specificity": "precise", "has_warrant": true, "internally_consistent": true } },
    { "claim": "Public leaderboards get revised several times each year.", "doc_position": "neutral", "linked_taxonomy_nodes": "skp-beliefs-001" }
  ],
  "unmapped_concepts": [
    { "suggested_label": "skp-intentions-003", "concept": "Treat public leaderboards as marketing rather than evidence of capability.", "suggested_pov": "skeptic", "suggested_category": "Intentions", "reason": "No node covers leaderboard skepticism" },
    { "suggested_label": "Incident Disclosure Clocks", "concept": "Mandatory short deadline reporting of serious incidents.", "suggested_pov": "safetyist", "suggested_category": "Intentions", "reason": "Novel reporting mechanism" },
    null
  ]
}
'@

    $script:ModulePsm1 =Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    . (Join-Path $PSScriptRoot 'HostCapture.ps1')
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'finalize-summary'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    $script:Regen = $env:FINALIZESUMMARY_REGEN_GOLDEN -eq '1'
    $script:FrozenUtc = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
    $script:ModelId = 'gemini-3.5-flash-lite'   # registered in ai-models.json

    # --- e2e fixture data root, set BEFORE the module import so its taxonomy loads from here ---------
    $script:E2ERoot = Join-Path $TestDrive 'e2e-data'
    $script:SavedEnv = @{}
    foreach ($n in 'AI_TRIAD_DATA_ROOT', 'AI_TRIAD_SOURCES_ROOT') { $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n) }

    function script:Write-FixtureFile([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $script:Utf8)
    }
    function script:ConvertTo-FixtureJson($Obj) { ($Obj | ConvertTo-Json -Depth 10) -replace "`r`n", "`n" }

    $tax = Join-Path $script:E2ERoot 'taxonomy' 'Origin'
    $node = { param($id, $cat, $label, $desc) [ordered]@{ id = $id; category = $cat; label = $label; description = $desc } }
    script:Write-FixtureFile (Join-Path $tax 'accelerationist.json') (script:ConvertTo-FixtureJson ([ordered]@{ nodes = @(
        (& $node 'acc-beliefs-001' 'Beliefs' 'Scaling delivers' 'Compute scaling keeps producing capability gains.')
        (& $node 'acc-desires-002' 'Desires' 'Permissionless release' 'Open release without licensing.')) }))
    script:Write-FixtureFile (Join-Path $tax 'safetyist.json') (script:ConvertTo-FixtureJson ([ordered]@{ nodes = @(
        (& $node 'saf-beliefs-003' 'Beliefs' 'Oversight gap' 'External oversight of frontier labs is thin.')
        (& $node 'saf-desires-002' 'Desires' 'Slowdown' 'A coordinated pause.')) }))
    script:Write-FixtureFile (Join-Path $tax 'skeptic.json') (script:ConvertTo-FixtureJson ([ordered]@{ nodes = @(
        (& $node 'skp-beliefs-001' 'Beliefs' 'Hype cycle' 'Capability claims outrun evidence.')) }))
    script:Write-FixtureFile (Join-Path $tax 'situations.json') (script:ConvertTo-FixtureJson ([ordered]@{ nodes = @(
        (& $node 'sit-004' 'Situations' 'Audit market' 'The state of third party auditing.')) }))
    New-Item -ItemType Directory -Path (Join-Path $script:E2ERoot 'summaries') -Force | Out-Null

    $script:E2ESnapshot = @"
# Compute, audits and leaderboards

Frontier laboratories argue that scaling compute keeps producing capability gains, and training compute
has doubled roughly every six months. Developers also want fewer licensing hurdles for open releases.

Critics reply that independent audits remain rare: only a handful of laboratories publish third party
audit results. Some propose that regulators require incident reporting within seventy two hours.

Skeptics note that public leaderboards get revised several times each year, and that benchmark
saturation makes progress claims hard to verify independently.
"@
    $script:E2EMetadata = [ordered]@{
        title = 'Compute, audits and leaderboards'; pov_tags = @('accelerationist', 'safetyist'); topic_tags = @('compute', 'audits')
        source_type = 'blog'; summary_status = 'pending'; claims_by_pov = [ordered]@{ accelerationist = 9 }; custom_field = 'kept as is'
    }

    $env:AI_TRIAD_DATA_ROOT = $script:E2ERoot
    $env:AI_TRIAD_SOURCES_ROOT = Join-Path $script:E2ERoot 'sources'
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
    $script:Mod = Get-Module AITriad

    # --- shared helpers -----------------------------------------------------------------------------
    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { if ($p) { $r = $r.Replace($p, '<ROOT>') } }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r -replace "`r`n", "`n"
    }

    # Canonical, order-stable form: plain-hashtable keys sorted (their order is randomized per process),
    # ordered dictionaries and PSCustomObjects kept in their own order, strings masked.
    function script:ConvertTo-Canonical($Obj) {
        if ($null -eq $Obj) { return $null }
        if ($Obj -is [string]) { return (script:Format-Masked $Obj) }
        if ($Obj -is [System.Collections.Specialized.OrderedDictionary]) {
            $o = [ordered]@{}; foreach ($k in $Obj.Keys) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IDictionary]) {
            $o = [ordered]@{}; foreach ($k in @($Obj.Keys | Sort-Object)) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IEnumerable]) { return , @(foreach ($i in $Obj) { script:ConvertTo-Canonical $i }) }
        if ($Obj -is [pscustomobject]) {
            $o = [ordered]@{}; foreach ($p in $Obj.PSObject.Properties) { $o[$p.Name] = script:ConvertTo-Canonical $p.Value }; return $o
        }
        if ($Obj -is [switch]) { return [bool]$Obj }
        return $Obj
    }

    # Sorts the lines inside every "key": { ... } block that holds only scalars (no nested braces).
    function script:Sort-JsonBlock([string]$Text, [string]$Key) {
        $rx = [regex]::new('("' + [regex]::Escape($Key) + '":\s*\{\n)([^{}]*?)(\n\s*\})')
        $rx.Replace($Text, {
                param($m)
                $lines = @($m.Groups[2].Value -split "`n" | ForEach-Object { $_.TrimEnd(',') } | Sort-Object -CaseSensitive)
                $m.Groups[1].Value + ($lines -join ",`n") + $m.Groups[3].Value
            })
    }
    # A written file as the golden sees it: text plus the byte-level facts ReadAllText would hide.
    function script:Read-Written([string]$Path) {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $text = $script:Utf8.GetString($bytes)
        $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if ($bom) { $text = $text.Substring(1) }
        # One golden entry per line (split on LF, so a trailing "" records the final newline): exact
        # content, but reviewable as a line diff.
        [ordered]@{ bom = $bom; crlf = $text.Contains("`r"); lines = @($text -split "`n") }
    }

    function script:Compare-Golden([string]$Name, [string]$Actual) {
        $golden = Join-Path $script:GoldenDir $Name
        if ($script:Regen) {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $Actual, $script:Utf8)
        }
        $expected = [System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n"
        $Actual | Should -BeExactly $expected -Because "$Name must match its golden"
    }

    function script:Register-FrozenClock {
        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            # Key off $Format itself: $PSBoundParameters is not reliable inside a mock body.
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
    }

    # Splits merged 3>&1 6>&1 output into an interleaved transcript plus the remaining output objects.
    function script:Split-Records($Records) {
        $lines = [System.Collections.Generic.List[string]]::new()
        $output = [System.Collections.Generic.List[object]]::new()
        foreach ($r in $Records) {
            if ($r -is [System.Management.Automation.InformationRecord]) {
                $h = Get-HostCaptureParts $r.MessageData
                $nn = if ($h -and $h.NoNewLine) { ' <nonewline>' } else { '' }
                if ($h) { $lines.Add("[$($h.Color)]$nn $($h.Message)") } else { $lines.Add("[info] $($r.MessageData)") }
            }
            # Warnings are masked too: the t/4079 metadata WARNs name the metadata.json path.
            elseif ($r -is [System.Management.Automation.WarningRecord]) { $lines.Add("[warning] $(script:Format-Masked $r.Message)") }
            elseif ($r -is [System.Management.Automation.ErrorRecord]) {
                # No filter here any more: a missing metadata.json used to surface as a raw, platform-dependent
                # Get-Content PathNotFound error, which was left out. Since t/4079 it is checked for explicitly
                # and reported as a WARN, so any error record is real and pinned.
                $lines.Add("[error] $(script:Format-Masked $r.Exception.Message)")
            }
            else { $output.Add($r) }
        }
        @{ Lines = $lines.ToArray(); Output = $output.ToArray() }
    }

    # --- direct-scenario runner -------------------------------------------------------------------------
    function script:Invoke-FinalizeScenario($S) {
        $script:S = $S
        $script:Calls = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[object]]::new()
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        New-Item -ItemType Directory -Path (Join-Path $root 'summaries') -Force | Out-Null
        $metaFile = Join-Path $root 'sources' 'doc-1' 'metadata.json'
        if (-not $S['NoMetadata']) {
            script:Write-FixtureFile $metaFile (script:ConvertTo-FixtureJson ([ordered]@{
                title = 'Doc Title'; pov_tags = @('accelerationist', 'safetyist'); source_type = 'blog'; summary_status = 'pending'
                summary_version = '2.3.0'; claims_by_pov = [ordered]@{ accelerationist = 9 }; total_claims = 99; custom_field = 'kept as is' }))
        }

        Register-FrozenClock
        Register-HostCaptureMock
        Mock Get-TaxonomyNodeIdSet -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Get-TaxonomyNodeIdSet' })
            if ($script:S['NodeIds'] -eq 'none') { return $null }
            $ids = if ($script:S['NodeIds']) { $script:S.NodeIds } else { $script:DefaultNodeIds }
            $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($i in $ids) { [void]$set.Add($i) }
            # Returned intact, exactly as the real function's `return , $IdSet` is (t/4144), so the caller keeps
            # the case-insensitive comparer (hallucinated-node-id: ACC-Beliefs-001 is accepted).
            , $set
        }
        Mock Invoke-RetrievalConfidencePass -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Invoke-RetrievalConfidencePass'; threshold = $Threshold; points = @($KeyPoints | ForEach-Object { [string]$_.point }) })
            foreach ($kp in @($KeyPoints)) { $kp | Add-Member -NotePropertyName 'retrieval_low_confidence' -NotePropertyValue ([string]$kp.point -match '^Weak') -Force }
        }
        Mock Invoke-PolarityGatePass -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Invoke-PolarityGatePass'; skipDirectionalGate = [bool]$SkipDirectionalGate
                                          items = @($KeyPoints | ForEach-Object { "$($_.POV): $($_.KeyPoint.point) [$($_.KeyPoint.stance)]" }) })
            $flip = if ($script:S['Flip']) { [int]$script:S.Flip } else { 0 }
            foreach ($it in @($KeyPoints)) {
                if ($flip -le 0) { break }
                if ($it.KeyPoint.stance -in 'aligned', 'strongly_aligned') {
                    $it.KeyPoint | Add-Member -NotePropertyName 'stance_pre_gate' -NotePropertyValue $it.KeyPoint.stance -Force
                    $it.KeyPoint.stance = 'strongly_opposed'
                    $it.KeyPoint | Add-Member -NotePropertyName 'stance_polarity_flag' -NotePropertyValue $true -Force
                    $flip--
                }
            }
            $c = @{ opposes = 0; agrees = 0; unrelated = 0; unresolved = 0; gated = 0; reps = 0; judge_flipped = 0; judge_kept = 0; self_healed = 0 }
            if ($script:S['Polarity']) { foreach ($k in $script:S.Polarity.Keys) { $c[$k] = $script:S.Polarity[$k] } }
            $c
        }
        Mock Invoke-Mechanism5RetrievalPass -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Invoke-Mechanism5RetrievalPass'; items = @($KeyPointItems | ForEach-Object { "$($_.POV): $($_.KeyPoint.point)" }) })
        }
        Mock Invoke-ExcludesVetoPass -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Invoke-ExcludesVetoPass'; points = @($KeyPoints | ForEach-Object { [string]$_.point }) })
            if ($script:S['Veto']) { $script:S.Veto.Clone() } else { @{ VetoCount = 0; AmbiguousCount = 0 } }
        }
        Mock Resolve-UnmappedConcepts -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'Resolve-UnmappedConcepts'; labels = @($UnmappedConcepts | ForEach-Object { if ($null -eq $_) { '<null>' } else { [string]$_.suggested_label } }) })
            switch ($script:S['Resolution']) {
                'throw' { throw 'resolver offline' }
                'resolve' {
                    $all = @($UnmappedConcepts)
                    [pscustomobject]@{
                        Resolved  = @([pscustomobject]@{ ConceptLabel = $all[0].suggested_label; MatchedNodeId = 'saf-beliefs-003'; Score = 0.91 })
                        Remaining = @($all | Select-Object -Skip 1)
                    }
                }
                default { [pscustomobject]@{ Resolved = @(); Remaining = @($UnmappedConcepts) } }
            }
        }
        Mock New-ContextRotMetrics -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'New-ContextRotMetrics'; pipeline = $Pipeline; docId = $DocId; stages = @($Stages | ForEach-Object { $_.stage }) })
            [ordered]@{ schema_version = 1; pipeline = $Pipeline; doc_id = $DocId; measured_at = '2026-01-02T03:04:05.0000000Z'; stages = @($Stages); cumulative_retention = 0.25 }
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            $script:Writes.Add($rel)
            if ($script:S['FailWrite'] -and $rel -eq $script:S.FailWrite) { throw "disk full writing $rel" }
        }

        # Module state the function reads implicitly.
        & $script:Mod {
            param($S)
            $script:CachedEmbeddings = if ($S['Embeddings']) { @{ 'acc-beliefs-001' = [double[]]@(1.0, 0.0) } } else { $null }
            $script:TaxonomyData = if ($S['TaxonomyData']) { @{ accelerationist = [pscustomobject]@{ nodes = @() } } } else { @{} }
            $script:ContextRotStages = if ($S['ContextRot']) {
                @(
                    (New-ContextRotStage -Stage 'rag_filtering' -InUnits 'nodes' -InCount 400 -OutUnits 'nodes' -OutCount 100 -Flags @{ capped = $true })
                    (New-ContextRotStage -Stage 'extraction' -InUnits 'prompt_chars' -InCount 20000 -OutUnits 'items' -OutCount 12)
                )
            } else { @() }
            # -EnablePolarityGate is an explicit Finalize-Summary parameter (t/4136 B1); it used to resolve from
            # the caller's scope. No module-scope variable may stand in for it, so make sure none exists.
            Remove-Variable -Name EnablePolarityGate -Scope Script -ErrorAction SilentlyContinue
        } $S

        $p = @{
            SummaryObject   = ($S.Summary | ConvertFrom-Json)
            ThisDocId       = 'doc-1'
            TaxonomyVersion = '2.4.0'
            Model           = $script:ModelId
            Temperature     = 0.2
            Now             = '2026-01-02T03:04:05Z'
            SummariesDir    = (Join-Path $root 'summaries')
            Doc             = @{ DocId = 'doc-1'; MetaFile = $metaFile }
            Elapsed         = [TimeSpan]::FromSeconds(42.5)
            TaxonomyJson    = $S.TaxonomyJson
        }
        if ($S['ChunkCount']) { $p.ChunkCount = $S.ChunkCount }
        $p.MaxTokens = if ($S['MaxTokens']) { $S.MaxTokens } else { 32768 }
        if ($S['FireStats']) { $p.FireStats = [pscustomobject]$script:FireStats }
        if ($S['Gate'] -isnot [string]) { $p.EnablePolarityGate = [bool]$S['Gate'] }   # 'unset' omits it: the default applies

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        try {
            & $script:Mod { param($P) Finalize-Summary @P 2>&1 3>&1 6>&1 } $p | ForEach-Object { $records.Add($_) }
        }
        catch { $err = $_.Exception.Message }
        $split = script:Split-Records $records

        $t = [ordered]@{
            scenario   = $S.Name
            transcript = $split.Lines
            error      = $err
            result     = @($split.Output)
            calls      = $script:Calls.ToArray()
            writes     = $script:Writes.ToArray()
            summary    = script:Read-Written (Join-Path $root 'summaries' 'doc-1.json')
            metadata   = script:Read-Written $metaFile
        }
        ((script:ConvertTo-Canonical $t) | ConvertTo-Json -Depth 30) -replace "`r`n", "`n"
    }

    # --- e2e runner ---------------------------------------------------------------------------------------
    $script:E2EShared = @{
        ApiKey                    = 'fixture-not-a-real-key'
        Model                     = $script:ModelId
        Temperature               = 0.2
        TaxonomyVersion           = '2.4.0'
        TaxonomyJson              = '{"unused":"Invoke-DocumentSummary single-call path takes the pipeline taxonomy"}'
        OutputSchema              = '{"type":"object"}'
        SystemPromptTemplate      = 'Extract. Words={{WORD_COUNT}} kp={{KP_MIN}}-{{KP_MAX}} uc={{UC_MIN}}-{{UC_MAX}} floor={{TOTAL_FLOOR}}'
        ChunkSystemPromptTemplate = 'Chunk.'
        SummariesDir              = (Join-Path $script:E2ERoot 'summaries')
        Now                       = '2026-01-02T03:04:05Z'
    }

    function script:New-E2EDoc([string]$DocId) {
        $dir = Join-Path $script:E2ERoot 'sources' $DocId
        script:Write-FixtureFile (Join-Path $dir 'snapshot.md') $script:E2ESnapshot
        script:Write-FixtureFile (Join-Path $dir 'metadata.json') (script:ConvertTo-FixtureJson $script:E2EMetadata)
        $summaryFile = Join-Path $script:E2ERoot 'summaries' "$DocId.json"
        if (Test-Path -LiteralPath $summaryFile) { Remove-Item -LiteralPath $summaryFile -Force }
        @{
            DocId        = $DocId
            Meta         = (Get-Content -Raw -LiteralPath (Join-Path $dir 'metadata.json') | ConvertFrom-Json)
            PovTags      = @('accelerationist', 'safetyist')
            SnapshotFile = (Join-Path $dir 'snapshot.md')
            MetaFile     = (Join-Path $dir 'metadata.json')
        }
    }

    # Byte-level normalization for the e2e goldens (see .DESCRIPTION).
    function script:Read-E2EBytes([string]$Path, [switch]$Metadata) {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $bytes.Length | Should -BeGreaterThan 3
        ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should -BeFalse -Because 'Write-Utf8NoBom writes no BOM'
        $text = $script:Utf8.GetString($bytes)
        $text.Contains("`r") | Should -BeFalse -Because 'the sink writes LF only'
        $text = script:Hide-PromptLengthValues $text
        if ($Metadata) { $text } else { script:Sort-JsonBlock $text 'flags' }
    }

    # The extraction stage's prompt length is PLATFORM-dependent: the assembled prompt carries the
    # platform's line endings (measured on the same fixture: 1255 chars on Windows, 1239 on Linux CI,
    # i.e. one extra CR per line on Windows). The .prompt files themselves are LF on both, so the CRs come
    # from text assembled at runtime. So only the values derived from that length are masked: the
    # prompt_chars stage's in_count and ratio, and metadata.json's worst_ratio when the worst stage is
    # that extraction stage. They are computed by New-ContextRotMetrics, not by Finalize-Summary;
    # Finalize-Summary only places them, and every key and every other value is still compared exactly.
    function script:Hide-PromptLengthValues([string]$Text) {
        $Text = [regex]::Replace($Text,
            '("in_units": "prompt_chars",\s*"in_count": )[0-9.]+(,\s*"out_units": "[^"]*",\s*"out_count": [0-9.]+,\s*"ratio": )[0-9.]+',
            '${1}"<PROMPT_CHARS>"${2}"<PROMPT_RATIO>"')
        [regex]::Replace($Text, '("worst_stage": "extraction",\s*"worst_ratio": )[0-9.]+', '${1}"<PROMPT_RATIO>"')
    }

    # Stub installer for -Parallel runspaces, where Pester mocks do not reach. Runs in each runspace's
    # freshly imported AITriad module scope and defines the same three fakes as the in-process e2e.
    $script:RunspaceStubSource = @'
param($Canned)
$script:__FinalizeCharCanned = $Canned
function script:Invoke-AIApi {
    param([string]$Prompt, [string]$SystemInstruction, [string]$Model, [string]$ApiKey, [double]$Temperature,
          [int]$MaxTokens, [switch]$JsonMode, [hashtable]$ResponseSchema, [int]$TimeoutSec, [int]$MaxRetries, [int[]]$RetryDelays)
    $text = if ($ResponseSchema) { '{"perspectives":["accelerationist","safetyist","skeptic"]}' } else { $script:__FinalizeCharCanned }
    [pscustomobject]@{ Text = $text; Backend = 'mock-backend'; Model = $Model; Truncated = $false; Usage = $null; RawResponse = $null }
}
function script:Get-Date {
    param([string]$Format)
    $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
    if ($Format) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
}
function script:Get-TextEmbedding { param($Texts, $Ids) $null }
'@
}

AfterAll {
    foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
    # Leave a clean module (real data root, default state) for whatever runs next in this process.
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
}

Describe 'Finalize-Summary characterization (t/4136)' -Tag 'summarization' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        # metadata-missing used to need its platform-specific Get-Content failure text normalized here. Since
        # t/4079 a missing metadata.json is checked for explicitly, so the transcript is the same everywhere.
        $actual = script:Invoke-FinalizeScenario $_
        script:Compare-Golden "$($_.Name).json" ($actual + "`n")
    }

    # Branch witnesses: each golden is only as good as the branch it exercised, so pin the
    # discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name>' -ForEach @(
        @{ Name = 'rich-rag';                    Text = '"taxonomy_filter": "rag"' }
        @{ Name = 'rich-rag';                    Text = 'excludes-veto: 0 vetoed, 1 ambiguous' }
        @{ Name = 'rich-rag';                    Text = 'Cross-camp agreement: accelerationist \+ skeptic' }
        @{ Name = 'rich-rag';                    Text = 'judge_flipped=0 judge_kept=1 self_healed=0 over 2 gated' }
        @{ Name = 'full-taxonomy-no-passes';     Text = '"taxonomy_nodes": 3' }
        @{ Name = 'chunked';                     Text = '"taxonomy_filter": "rag_per_chunk"' }
        @{ Name = 'fire';                        Text = '"extraction_mode": "fire"' }
        @{ Name = 'fire-chunked-rag';            Text = '"chunk_count": 2' }
        @{ Name = 'single-element-force-array';  Text = 'points: 1 \(0 unmapped\)  factual: 1  new_concepts: 1' }
        @{ Name = 'null-key-points';             Text = 'accelerationist.key_points missing/null' }
        @{ Name = 'null-unmapped-entries';       Text = 'dropped 2 null unmapped_concepts' }
        @{ Name = 'id-shaped-label';             Text = 'ID-shaped suggested_label replaced: 2' }
        @{ Name = 'hallucinated-node-id';        Text = 'Hallucinated node IDs moved to unmapped' }
        @{ Name = 'node-validation-skipped';     Text = '"taxonomy_node_id": "saf-beliefs-999"' }
        @{ Name = 'cross-camp-agreement';        Text = 'Cross-camp agreement: accelerationist \+ safetyist' }
        @{ Name = 'stance-normalization';        Text = '"stance": "strongly_aligned"' }
        @{ Name = 'polarity-flip';               Text = '\[Yellow\]\s+\u26a0\s+Polarity gate \(two-stage\): judge_flipped=2' }
        @{ Name = 'polarity-all-unresolved';     Text = 'directional engine may be down' }
        @{ Name = 'polarity-off';                Text = '"skipDirectionalGate": true' }
        @{ Name = 'polarity-gate-omitted-defaults-on'; Text = '"skipDirectionalGate": false' }
        @{ Name = 'veto-counts';                 Text = 'excludes-veto: 2 vetoed, 0 ambiguous' }
        @{ Name = 'unmapped-resolved';           Text = "Resolved: 'Compute Governance Treaties'" }
        @{ Name = 'unmapped-resolution-throws';  Text = '\[warning\] Finalize-Summary: unmapped concept resolution failed — keeping all 2 unmapped concept\(s\) unresolved: resolver offline' }
        @{ Name = 'missing-pov-summaries';       Text = 'Schema validation failed: Missing required field: pov_summaries' }
        @{ Name = 'missing-camp-and-fields';     Text = 'Schema: Missing camp in pov_summaries: skeptic' }
        @{ Name = 'null-factual-claims';         Text = 'Schema: Missing required field: factual_claims' }
        @{ Name = 'summary-write-fails';         Text = 'Failed to write summary: disk full writing summaries/doc-1.json' }
        @{ Name = 'metadata-write-fails';        Text = "\[warning\] Finalize-Summary: summary written but metadata update failed, leaving '<ROOT>/sources/doc-1/metadata\.json' stale: disk full" }
        @{ Name = 'metadata-missing';            Text = "\[warning\] Finalize-Summary: summary written but metadata\.json not updated — the file is missing: '<ROOT>/sources/doc-1/metadata\.json'" }
    ) {
        # Match against the unescaped content (the golden stores file text as JSON-escaped lines).
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json")) | ConvertFrom-Json
        $hay = @(
            @($g.transcript); [string]$g.error
            $(if ($g.summary) { @($g.summary.lines) -join "`n" }); $(if ($g.metadata) { @($g.metadata.lines) -join "`n" })
            ($g.calls | ConvertTo-Json -Depth 10); ($g.result | ConvertTo-Json -Depth 10)
        ) -join "`n"
        $hay | Should -Match $Text
    }

    It 'calls the enrichment passes in the pinned order, with the pinned guards (rich-rag)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich-rag.json')) | ConvertFrom-Json
        @($g.calls.call) | Should -Be @(
            'Get-TaxonomyNodeIdSet'
            'Invoke-RetrievalConfidencePass'
            'Invoke-PolarityGatePass'
            'Invoke-Mechanism5RetrievalPass'
            'Invoke-ExcludesVetoPass'
            'Resolve-UnmappedConcepts'
            'New-ContextRotMetrics'
        )
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'full-taxonomy-no-passes.json')) | ConvertFrom-Json
        @($g.calls.call) | Should -Be @('Get-TaxonomyNodeIdSet', 'Invoke-PolarityGatePass') -Because 'no CachedEmbeddings, no TaxonomyData, no unmapped concepts, no context-rot stages'
    }

    It 'write order and count: summary then metadata, exactly once each, on success paths' -ForEach @(
        @{ Name = 'rich-rag' }, @{ Name = 'chunked' }, @{ Name = 'fire' }, @{ Name = 'metadata-write-fails' }, @{ Name = 'metadata-missing' }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json")) | ConvertFrom-Json
        $expected = if ($Name -eq 'metadata-missing') { @('summaries/doc-1.json') } else { @('summaries/doc-1.json', 'sources/doc-1/metadata.json') }
        @($g.writes) | Should -Be $expected
        $g.result[0].Success | Should -BeTrue
    }

    It 'failure semantics: schema failure writes nothing; summary-write failure skips the metadata write' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'summary-write-fails' }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'missing-pov-summaries.json')) | ConvertFrom-Json
        @($g.writes).Count | Should -Be 0
        $g.result[0].Success | Should -BeFalse
        $g.summary | Should -BeNullOrEmpty
        # Runs the code (t/4079 item 7; t/4136#11): the write sink throws on the summary path, and the metadata
        # write must never be attempted. If Finalize-Summary carried on to Update-SummaryMetadata after a failed
        # summary write, the sink would record the metadata path and the file would no longer say "pending".
        $_.Name | Should -Be 'summary-write-fails'
        $g = (script:Invoke-FinalizeScenario $_) | ConvertFrom-Json
        @($script:Writes) | Should -Be @('summaries/doc-1.json') -Because 'the sink saw the summary write fail and no metadata write after it'
        @($g.writes) | Should -Be @('summaries/doc-1.json')
        $g.result[0].Success | Should -BeFalse
        $g.result[0].Error | Should -Be 'Failed to write summary file: disk full writing summaries/doc-1.json'
        (@($g.metadata.lines) -join "`n") | Should -Match '"summary_status": "pending"' -Because 'metadata.json is left untouched'
        (@($g.metadata.lines) -join "`n") | Should -Not -Match 'summary_updated'
    }

    It 'the golden itself is deterministic within the process: <Name>' -ForEach @($script:Scenarios | Where-Object { $_.Name -in 'rich-rag', 'fire-chunked-rag' }) {
        $s = $_
        (script:Invoke-FinalizeScenario $s) | Should -BeExactly (script:Invoke-FinalizeScenario $s)
    }
}

Describe 'Finalize-Summary end to end via Invoke-DocumentSummary, Invoke-AIApi mocked (t/4136 real run)' -Tag 'summarization' {

    BeforeAll {
        function script:Invoke-E2E([string]$DocId) {
            $script:AICalls = [System.Collections.Generic.List[object]]::new()
            $script:RootCurrent = [System.IO.Path]::GetFullPath($script:E2ERoot).TrimEnd('\', '/')
            $doc = script:New-E2EDoc $DocId
            Register-FrozenClock
            Register-HostCaptureMock
            Mock Invoke-AIApi -ModuleName AITriad {
                $isChess = $PesterBoundParameters.ContainsKey('ResponseSchema')
                if (-not $isChess) {
                    $script:AICalls.Add([ordered]@{ model = $Model; temperature = $Temperature; maxTokens = $MaxTokens; jsonMode = [bool]$JsonMode })
                }
                $text = if ($isChess) { '{"perspectives":["accelerationist","safetyist","skeptic"]}' } else { $script:E2ECannedSummary }
                [pscustomobject]@{ Text = $text; Backend = 'mock-backend'; Model = $Model; Truncated = $false; Usage = $null; RawResponse = $null }
            }
            if ($env:FINALIZESUMMARY_E2E_REAL_EMBEDDINGS -ne '1') {
                Mock Get-TextEmbedding -ModuleName AITriad { $null }
            }
            # Fresh module state for the parts Invoke-DocumentSummary does not reset itself.
            & $script:Mod { $script:CachedEmbeddings = $null; $script:TaxonomyNodeIdSet = $null }

            $records = [System.Collections.Generic.List[object]]::new()
            & $script:Mod { param($D, $P) Invoke-DocumentSummary -Doc $D @P 2>&1 3>&1 6>&1 } $doc $script:E2EShared |
                ForEach-Object { $records.Add($_) }
            $split = script:Split-Records $records
            [ordered]@{
                Doc        = $doc
                Transcript = ((script:ConvertTo-Canonical ([ordered]@{
                                transcript = $split.Lines; result = @($split.Output); extractionCalls = $script:AICalls.ToArray() })) |
                                ConvertTo-Json -Depth 20) -replace "`r`n", "`n"
            }
        }
        # Fresh import (the data root still points at the fixture): production module state, including the
        # fixture taxonomy in $script:TaxonomyData, not whatever the direct scenarios above left behind.
        Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
        $script:Mod = Get-Module AITriad
        $script:E2E = script:Invoke-E2E 'e2e-doc'
    }

    It 'writes the summary byte-for-byte as the golden (flags blocks sorted)' {
        $actual = script:Read-E2EBytes (Join-Path $script:E2ERoot 'summaries' 'e2e-doc.json')
        script:Compare-Golden 'e2e-single-call.summary.json' $actual
    }

    It 'rewrites metadata.json byte-for-byte as the golden (no normalization since t/4079)' {
        $actual = script:Read-E2EBytes $script:E2E.Doc.MetaFile -Metadata
        script:Compare-Golden 'e2e-single-call.metadata.json' $actual
    }

    It 'prints the golden console transcript and returns the golden result' {
        script:Compare-Golden 'e2e-single-call.transcript.json' ($script:E2E.Transcript + "`n")
    }

    It 'exercised the real pipeline branches it claims to (branch witnesses)' {
        $t = $script:E2E.Transcript
        $t | Should -Match 'Pipeline complete \(mock-backend\)'
        $t | Should -Match 'Hallucinated node IDs moved to unmapped: safetyist/saf-beliefs-999'
        $t | Should -Match 'Cross-camp agreement: accelerationist \+ skeptic'
        $t | Should -Match 'Polarity gate \(two-stage\)'
        $t | Should -Match 'node-ID-shaped'
        $t | Should -Match 'dropped 1 null unmapped_concepts'
        $s = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'e2e-single-call.summary.json'))
        $s | Should -Match '"taxonomy_filter": "compact"' -Because 'RAG fails without embeddings.json, so the compact taxonomy is used and labelled compact (t/4144)'
        $s | Should -Match '"taxonomy_nodes": 6' -Because 'the compact taxonomy lists all 6 fixture nodes (t/4144; was 0)'
        $t | Should -Not -Match 'Unmapped concept resolution failed' -Because 'the Jaccard path no longer throws (t/4144)'
        $m = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'e2e-single-call.metadata.json'))
        $m | Should -Not -Match '"worst_stage": "extraction"' -Because 'worst_stage comes only from retention stages (t/4144)'
        $s | Should -Match '"extraction_confidence": 0.8' -Because 'the single-shot confidence backfill ran'
        $m = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'e2e-single-call.metadata.json'))
        $m | Should -Not -Match 'claims_by_pov'
        $m | Should -Match '"custom_field": "kept as is"'
    }

    It 'a second run on the same fixture is byte-identical (re-summarize churn check)' {
        $first = [ordered]@{
            s = [System.IO.File]::ReadAllText((Join-Path $script:E2ERoot 'summaries' 'e2e-doc.json'))
            m = [System.IO.File]::ReadAllText($script:E2E.Doc.MetaFile)
        }
        $again = script:Invoke-E2E 'e2e-doc'
        script:Sort-JsonBlock ([System.IO.File]::ReadAllText((Join-Path $script:E2ERoot 'summaries' 'e2e-doc.json'))) 'flags' |
            Should -BeExactly (script:Sort-JsonBlock $first.s 'flags')
        [System.IO.File]::ReadAllText($again.Doc.MetaFile) | Should -BeExactly $first.m
        $again.Transcript | Should -BeExactly $script:E2E.Transcript
    }
}

Describe 'Finalize-Summary inside ForEach-Object -Parallel runspaces (t/4136, TL condition 2)' -Tag 'summarization' {

    It 'the production parallel block summarizes each doc through a freshly imported module, matching the e2e golden' {
        # Lift the -Parallel scriptblock out of the production function, unmodified except for one inserted
        # line after its Import-Module. If the production block changes shape, the anchor check fails loudly.
        $fn = & $script:Mod { Get-Command Invoke-BatchParallelSummarySet }
        $feo = $fn.ScriptBlock.Ast.FindAll({ param($a)
                $a -is [System.Management.Automation.Language.CommandAst] -and $a.GetCommandName() -eq 'ForEach-Object' }, $true) |
            Select-Object -First 1
        $feo | Should -Not -BeNullOrEmpty
        $body = ($feo.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.ScriptBlockExpressionAst] } |
                Select-Object -First 1).ScriptBlock.Extent.Text
        $anchor = 'Import-Module $using:ModulePath -Force'
        $body | Should -Match ([regex]::Escape($anchor)) -Because 'the stub insertion point must still exist in the production block'
        $body | Should -Match 'Invoke-DocSummaryWithCapture' -Because 'the production block must still route through the capture wrapper'
        $inject = $anchor + "`n        & (Get-Module AITriad) ([scriptblock]::Create(`$using:RunspaceStubSource)) `$using:CannedJson"
        $parallelBody = [scriptblock]::Create($body.Substring(1, $body.Length - 2).Replace($anchor, $inject))

        # The $using: variables the production block reads, exactly as Invoke-BatchParallelSummarySet binds them.
        $ModulePath = Join-Path ($script:Mod.ModuleBase) 'AITriad.psm1'
        $Results = [System.Collections.Concurrent.ConcurrentBag[object]]::new()
        $SharedParams = $script:E2EShared.Clone()
        $RunspaceStubSource = $script:RunspaceStubSource
        $CannedJson = $script:E2ECannedSummary
        $docs = [System.Collections.Generic.List[hashtable]]::new()
        # Same length as 'e2e-doc': the doc id is inside the prompt, whose length the extraction stage records.
        foreach ($id in 'par-d-a', 'par-d-b') { $docs.Add((script:New-E2EDoc $id)) }

        $docs | ForEach-Object -Parallel $parallelBody -ThrottleLimit 2 6>$null 3>$null

        $res = @($Results.ToArray() | Sort-Object DocId)
        $res.Count | Should -Be 2
        foreach ($r in $res) {
            $err = if ($r.PSObject.Properties['Error']) { $r.Error } else { '' }
            $r.Success | Should -BeTrue -Because "runspace for $($r.DocId) failed: $err"
            $r.TotalPoints | Should -Be 6
        }
        @($res.DocId) | Should -Be @('par-d-a', 'par-d-b')

        $goldS = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'e2e-single-call.summary.json')) -replace "`r`n", "`n"
        $goldM = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'e2e-single-call.metadata.json')) -replace "`r`n", "`n"
        foreach ($d in $docs) {
            $s = script:Read-E2EBytes (Join-Path $script:E2ERoot 'summaries' "$($d.DocId).json")
            $s.Replace($d.DocId, 'e2e-doc') | Should -BeExactly $goldS -Because "the runspace-written summary for $($d.DocId) must match the in-process golden"
            script:Read-E2EBytes $d.MetaFile -Metadata | Should -BeExactly $goldM
        }
    }
}
