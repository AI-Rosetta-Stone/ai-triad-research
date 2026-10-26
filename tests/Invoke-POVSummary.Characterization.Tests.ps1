# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-POVSummary (t/3910), written BEFORE its complexity refactor and
    required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Invoke-POVSummary end to end against a fixture data tree in $TestDrive and
    compares a full transcript to a golden in tests/fixtures/pov-summary/<scenario>.json:
      - every host line (text and colour), warning and verbose message;
      - the thrown error's message, if any;
      - every Invoke-SummaryPipeline, Resolve-AIApiKey, Get-Prompt and Update-AITSourceIndex call;
      - every data write, in order (via the Assert-DataWriteAllowed guard that Write-Utf8NoBom calls);
      - the full file tree afterwards, with each file's exact bytes.
    Invoke-SummaryPipeline (the only AI step) is mocked; Invoke-AIApi is mocked to throw, so nothing
    can reach a live backend. Get-Date is frozen, which covers the -Format stamps and
    New-ContextRotMetrics' measured_at.
    One normalization: metadata.json's node_references_by_pov and primary_pov_distribution are plain
    hashtables, so their key order is randomized per process. Only the lines inside those two blocks
    are sorted; every other byte is compared as written.
    t/4070 fixed the bugs these goldens first pinned: claim-missing-label, keypoint-missing-stance,
    camp-missing and current-no-version now degrade with a fallback WARN instead of throwing; -WhatIf
    writes and reports nothing (whatif); -DryRun creates no directories (dryrun-no-taxonomy); and the
    summary file's factual_claims/unmapped_concepts are always arrays. Every scenario that reaches the
    write phase also carries ShouldProcess's "Performing the operation" verbose line.
    Regenerate the goldens ONLY when a behaviour change is intended and reviewed: set
    $env:POVSUMMARY_REGEN_GOLDEN = '1' and run once.
#>

# Summaries the mocked pipeline returns (as parsed JSON, like the real one). Every claim and key point
# carries the fields pov-summary-schema always emits (possibly null); the missing-field crashes are
# pinned separately (claim-missing-label, keypoint-missing-stance, camp-missing).
$script:RichSummary = @'
{
  "pov_summaries": {
    "accelerationist": { "key_points": [
      { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "Scale wins.", "stance": "supports", "verbatim": ["span one", "span two"] },
      { "taxonomy_node_id": null, "category": "Desires", "point": "Ship faster.", "stance": null, "verbatim": "single span" },
      { "taxonomy_node_id": "", "category": "Beliefs", "point": "Empty node id.", "stance": "disputes" }
    ] },
    "safetyist": { "key_points": [
      { "taxonomy_node_id": "saf-desires-002", "category": "Desires", "point": "Slow down.", "stance": "qualifies", "verbatim": "" }
    ] },
    "skeptic": { "key_points": [] }
  },
  "factual_claims": [
    { "claim": "Appends to an existing conflict.", "claim_label": "existing", "doc_position": "supports",
      "potential_conflict_id": "conflict-existing", "linked_taxonomy_nodes": ["acc-beliefs-001", "saf-beliefs-003", "acc-beliefs-001"] },
    { "claim": "Already logged for this doc.", "claim_label": "logged", "doc_position": "disputes",
      "potential_conflict_id": "conflict-logged", "linked_taxonomy_nodes": ["skp-beliefs-004"] },
    { "claim": "A hinted conflict that does not exist yet.", "claim_label": "Hinted label", "doc_position": "qualifies",
      "potential_conflict_id": "conflict-new-hint", "linked_taxonomy_nodes": "sit-001" },
    { "claim": "A hinted conflict with no label whose claim text runs well past the eighty character label cutoff point.",
      "claim_label": null, "doc_position": "neutral", "potential_conflict_id": "conflict-new-nolabel", "linked_taxonomy_nodes": [] },
    { "claim": "Compute doubles every six months, say analysts.", "claim_label": null, "doc_position": "supports",
      "potential_conflict_id": null, "linked_taxonomy_nodes": ["acc-desires-005", null, "other-001"] },
    { "claim": "Open weights reduce concentration of power.", "claim_label": "weights", "doc_position": "disputes",
      "potential_conflict_id": null, "linked_taxonomy_nodes": ["sit-002"] },
    { "claim": "Liability rules lag behind deployment!", "claim_label": null, "doc_position": "contradicts",
      "potential_conflict_id": "", "linked_taxonomy_nodes": null }
  ],
  "unmapped_concepts": [
    { "suggested_pov": "safetyist", "suggested_category": "Beliefs", "suggested_label": "Label one", "concept": "Concept one", "reason": "Reason one" },
    { "concept": "Only a concept" },
    { "suggested_label": "Label only", "suggested_description": "Description only" },
    { }
  ]
}
'@

$script:BareSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "One.", "stance": "aligned" } ] },
    "safetyist": { "key_points": [] },
    "skeptic": { "key_points": [ { "taxonomy_node_id": null, "category": "Intentions", "point": "Two.", "stance": null } ] } } }
'@

$script:SmallSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [] },
    "safetyist": { "key_points": [ { "taxonomy_node_id": "saf-beliefs-001", "category": "Beliefs", "point": "One.", "stance": "supports" } ] },
    "skeptic": { "key_points": [] } },
  "factual_claims": [
    { "claim": "Short claim.", "claim_label": "short", "doc_position": "supports", "potential_conflict_id": null, "linked_taxonomy_nodes": ["saf-beliefs-001"] },
    { "claim": "Second short claim.", "claim_label": null, "potential_conflict_id": "conflict-small", "doc_position": "neutral", "linked_taxonomy_nodes": ["skp-beliefs-001"] }
  ],
  "unmapped_concepts": [] }
'@

$script:MissingCampSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "One.", "stance": "aligned" } ] },
    "safetyist": { "key_points": [] } },
  "factual_claims": [], "unmapped_concepts": [] }
'@

$script:ClaimMissingLabelSummary = @'
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": [ { "claim": "No label or hint fields.", "doc_position": "supports", "linked_taxonomy_nodes": ["acc-beliefs-001"] } ],
  "unmapped_concepts": [] }
'@

$script:KeypointMissingStanceSummary = @'
{ "pov_summaries": {
    "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "category": "Beliefs", "point": "No stance property." } ] },
    "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": [], "unmapped_concepts": [] }
'@

$script:RagContext = "=== RELEVANT TAXONOMY NODES ===`n  acc-beliefs-001: Scale wins`n  saf-desires-002: Slow down`n    (indented detail, not a node)`n  skp-beliefs-004: Doubt it"
$script:FullContext = '{"nodes":[{"id":"acc-1"},{"id":"saf-1"},{ "id" : "skp-1"}]}'

$script:Scenarios = @(
    @{ Name = 'reextract-none'; Params = @{ ReExtract = $true }
       Docs = [ordered]@{ 'doc-a' = 'current'; 'doc-b' = '(no metadata)'; 'doc-c' = '(no status)' } }
    @{ Name = 'reextract-one-flagged'; Params = @{ ReExtract = $true; ModelEscalation = 'claude-haiku-4-5'; AutoFire = $true; ApiKey = 'explicit-key'; FullTaxonomy = $true }
       Docs = [ordered]@{ 'doc-a' = 'needs_reextraction'; 'doc-b' = 'current' }
       Pipeline = @{ Summary = $script:SmallSummary; FactualCount = 2; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'err-root-missing'; RootMissing = $true }
    @{ Name = 'err-docdir-missing'; Missing = @('docdir') }
    @{ Name = 'err-snapshot-missing'; Missing = @('snapshot') }
    @{ Name = 'err-metadata-missing'; Missing = @('metadata') }
    @{ Name = 'skip-already-current'; Status = 'current' }
    @{ Name = 'current-no-version'; Status = 'current-no-version' }
    @{ Name = 'err-no-key-claude'; Params = @{ Model = 'claude-haiku-4-5' }; NoKey = $true }
    @{ Name = 'err-no-key-openai'; Params = @{ Model = 'openai-gpt-4o-mini' }; NoKey = $true }
    @{ Name = 'err-no-key-groq'; Params = @{ Model = 'groq-openai-gpt-oss-20b' }; NoKey = $true }
    @{ Name = 'err-version-missing'; Missing = @('version') }
    @{ Name = 'err-pipeline-failed'; Pipeline = @{ Success = $false; Error = 'CHESS pre-classification timed out' } }
    @{ Name = 'err-summary-write-failed'; FailWrite = 'summaries/doc-1.json'
       Pipeline = @{ Summary = $script:SmallSummary; FactualCount = 2; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'dryrun-current-long'; Params = @{ DryRun = $true }; Status = 'current'; LongSnapshot = $true; Taxonomy = $true }
    @{ Name = 'dryrun-no-taxonomy'; Params = @{ DryRun = $true }; NoConflictsDir = $true }
    @{ Name = 'rich-rag'; DocId = 'altman-2024-agi-path'; ContextRot = 'Mixed'; SeedConflicts = $true
       Pipeline = @{ Summary = $script:RichSummary; FactualCount = 7; UnmappedCount = 4; TaxonomyJson = $script:RagContext } }
    @{ Name = 'fire-full-taxonomy'; LargeSnapshot = $true; ContextRot = 'NoSameUnit'; IndexThrows = $true
       Params = @{ Model = 'groq-openai-gpt-oss-20b'; Temperature = 0.3; FullTaxonomy = $true; IterativeExtraction = $true; AutoFire = $true; CrossEncoderRerank = $true; RagMaxTotal = 50; Force = $true }
       Status = 'current'
       # MaxTokens and confidence_threshold differ from the old hard-coded 32768 / 0.7, so the golden
       # shows model_info records what the pipeline reports (t/4172).
       Pipeline = @{ Summary = $script:BareSummary; FactualCount = 0; UnmappedCount = 0; TaxonomyJson = $script:FullContext; UsedFire = $true; MaxTokens = 16384
                     FireStats = [ordered]@{ confidence_threshold = 0.65; total_api_calls = 9; total_iterations = 3; claims_total = 12; claims_confident = 10; claims_iterated = 2; claims_dropped_verification = 0; elapsed_seconds = 41.5; termination_reason = 'converged' } } }
    @{ Name = 'fire-no-stats-unknown-prefix'; Params = @{ Model = 'xai-grok-4-6' }
       Pipeline = @{ Summary = $script:SmallSummary; FactualCount = 2; UnmappedCount = 0; TaxonomyJson = $script:FullContext; UsedFire = $true } }
    @{ Name = 'metadata-write-failed'; FailWrite = 'sources/doc-1/metadata.json'
       Pipeline = @{ Summary = $script:SmallSummary; FactualCount = 2; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'whatif'; Params = @{ WhatIf = $true }; SeedConflicts = $true
       Pipeline = @{ Summary = $script:SmallSummary; FactualCount = 2; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'claim-missing-label'; Pipeline = @{ Summary = $script:ClaimMissingLabelSummary; FactualCount = 1; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'keypoint-missing-stance'; Pipeline = @{ Summary = $script:KeypointMissingStanceSummary; FactualCount = 0; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
    @{ Name = 'camp-missing';Pipeline = @{ Summary = $script:MissingCampSummary; FactualCount = 0; UnmappedCount = 0; TaxonomyJson = $script:RagContext } }
)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    . (Join-Path $PSScriptRoot 'HostCapture.ps1')
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'pov-summary'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)

    function script:Write-FixtureFile([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $script:Utf8)
    }
    function script:ConvertTo-FixtureJson($Obj) { ($Obj | ConvertTo-Json -Depth 10) -replace "`r`n", "`n" }

    function script:New-Metadata([string]$Status) {
        $m = [ordered]@{ title = 'Doc Title'; pov_tags = @('accelerationist', 'safetyist'); source_type = 'blog' }
        if ($Status -ne '(no status)') { $m.summary_status = $Status }
        # Real metadata gains summary_version when a summary is written; 'current-no-version' omits it.
        if ($Status -eq 'current') { $m.summary_version = '2.3.0' }
        if ($Status -eq 'current-no-version') { $m.summary_status = 'current' }
        $m.claims_by_pov = [ordered]@{ accelerationist = 9 }
        $m
    }

    function script:New-Conflict([string]$Id, [string[]]$Linked, [object[]]$Instances) {
        [ordered]@{ claim_id = $Id; claim_label = "$Id label"; description = "$Id description"; status = 'open'
                    linked_taxonomy_nodes = @($Linked); instances = @($Instances); human_notes = @() }
    }

    # Builds the fixture tree for a scenario and returns its root.
    function script:New-PovFixture($S) {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $missing = @($S['Missing'])
        $docId = if ($S['DocId']) { $S.DocId } else { 'doc-1' }
        foreach ($d in 'sources', 'summaries', 'taxonomy') { New-Item -ItemType Directory -Path (Join-Path $root $d) -Force | Out-Null }
        if (-not $S['NoConflictsDir']) { New-Item -ItemType Directory -Path (Join-Path $root 'conflicts') -Force | Out-Null }
        if ('version' -notin $missing) { script:Write-FixtureFile (Join-Path $root 'TAXONOMY_VERSION') "2.4.0`n" }

        if ($S['Docs']) {
            foreach ($id in $S.Docs.Keys) {
                $dir = Join-Path $root 'sources' $id
                script:Write-FixtureFile (Join-Path $dir 'snapshot.md') "# $id`n`nShort snapshot for $id."
                if ($S.Docs[$id] -ne '(no metadata)') {
                    script:Write-FixtureFile (Join-Path $dir 'metadata.json') (script:ConvertTo-FixtureJson (script:New-Metadata $S.Docs[$id]))
                }
            }
        }
        elseif ('docdir' -notin $missing) {
            $dir = Join-Path $root 'sources' $docId
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $snap = if ($S['LongSnapshot']) { 'word ' * 80001 }
                    elseif ($S['LargeSnapshot']) { "# Large`n`n" + ('x' * 31300) }
                    else { "# Doc`n`nThe snapshot body. It has a few sentences.`nAnd a second line." }
            if ('snapshot' -notin $missing) { script:Write-FixtureFile (Join-Path $dir 'snapshot.md') $snap }
            if ('metadata' -notin $missing) {
                $status = if ($S['Status']) { $S.Status } else { 'pending' }
                script:Write-FixtureFile (Join-Path $dir 'metadata.json') (script:ConvertTo-FixtureJson (script:New-Metadata $status))
            }
        }

        if ($S['Taxonomy']) {
            script:Write-FixtureFile (Join-Path $root 'taxonomy' 'accelerationist.json') '{ "nodes": [ { "id": "acc-1", "label": "A" } ] }'
            script:Write-FixtureFile (Join-Path $root 'taxonomy' 'skeptic.json') '{ "nodes": [ { "id": "skp-1" } ] }'
        }

        if ($S['SeedConflicts']) {
            $cd = Join-Path $root 'conflicts'
            $mine = [ordered]@{ doc_id = $docId; stance = 'supports'; assertion = 'earlier'; date_flagged = '2025-12-01' }
            $other = [ordered]@{ doc_id = 'someone-else'; stance = 'disputes'; assertion = 'other'; date_flagged = '2025-11-01' }
            script:Write-FixtureFile (Join-Path $cd 'conflict-existing.json') (script:ConvertTo-FixtureJson (script:New-Conflict 'conflict-existing' @('acc-beliefs-001', 'skp-beliefs-009') @($other)))
            script:Write-FixtureFile (Join-Path $cd 'conflict-logged.json') (script:ConvertTo-FixtureJson (script:New-Conflict 'conflict-logged' @('skp-beliefs-004') @($mine)))
            script:Write-FixtureFile (Join-Path $cd 'conflict-compute-doubles-every-x.json') (script:ConvertTo-FixtureJson (script:New-Conflict 'conflict-compute-doubles-every-x' @() @($other)))
            script:Write-FixtureFile (Join-Path $cd 'conflict-open-weights-reduce-power.json') (script:ConvertTo-FixtureJson (script:New-Conflict 'conflict-open-weights-reduce-power' @('sit-009') @($mine)))
            script:Write-FixtureFile (Join-Path $cd 'conflict-small.json') (script:ConvertTo-FixtureJson (script:New-Conflict 'conflict-small' @('skp-beliefs-001') @($other)))
        }
        $root
    }

    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r -replace "`r`n", "`n"
    }

    # Canonical, order-stable form: hashtable keys sorted (their order is randomized per process),
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

    # Sorts the lines inside one top-level "key": { ... } block (plain-hashtable key order is random).
    function script:Sort-JsonBlock([string]$Text, [string]$Key) {
        $rx = [regex]::new('("' + [regex]::Escape($Key) + '":\s*\{\n)([^{}]*?)(\n\s*\})')
        $rx.Replace($Text, {
                param($m)
                $lines = @($m.Groups[2].Value -split "`n" | ForEach-Object { $_.TrimEnd(',') } | Sort-Object -CaseSensitive)
                $m.Groups[1].Value + ($lines -join ",`n") + $m.Groups[3].Value
            })
    }

    function script:Get-Tree([string]$Root) {
        $tree = [ordered]@{}
        if (-not (Test-Path -LiteralPath $Root)) { return $tree }
        $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
                [pscustomobject]@{ Rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/'); Item = $_ } })
        foreach ($e in @($items | Sort-Object { $_.Rel } -CaseSensitive)) {
            if ($e.Item.PSIsContainer) { $tree[$e.Rel + '/'] = '(dir)'; continue }
            $text = [System.IO.File]::ReadAllText($e.Item.FullName)
            if ($e.Rel -like '*/metadata.json') {
                foreach ($k in 'node_references_by_pov', 'primary_pov_distribution') { $text = script:Sort-JsonBlock $text $k }
            }
            # Only the large fixture snapshots are abbreviated; every written file is kept whole.
            if ($e.Rel -like '*/snapshot.md' -and $text.Length -gt 2000) { $text = "<$($text.Length) chars> " + $text.Substring(0, 60) }
            $tree[$e.Rel] = $text
        }
        $tree
    }

    function script:Invoke-Scenario($S) {
        $script:Calls = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[object]]::new()
        $script:S = $S
        $root = script:New-PovFixture $S
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:RootFixture = $root

        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            # Key off $Format itself: $PSBoundParameters is not reliable inside a mock body.
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
        Mock Get-SourcesDir   -ModuleName AITriad { Join-Path $script:RootFixture 'sources' }
        Mock Get-SummariesDir -ModuleName AITriad { Join-Path $script:RootFixture 'summaries' }
        Mock Get-ConflictsDir -ModuleName AITriad { Join-Path $script:RootFixture 'conflicts' }
        Mock Get-TaxonomyDir  -ModuleName AITriad { Join-Path $script:RootFixture 'taxonomy' }
        Mock Get-VersionFile  -ModuleName AITriad { Join-Path $script:RootFixture 'TAXONOMY_VERSION' }
        Mock Invoke-AIApi     -ModuleName AITriad { throw 'live AI call attempted in a characterization test' }
        Mock Resolve-AIApiKey -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'resolveKey'; explicitKey = $ExplicitKey; backend = $Backend })
            if ($script:S['NoKey']) { '' } else { "resolved-$Backend-key" }
        }
        Mock Get-Prompt -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'prompt'; name = $Name; replacements = $Replacements })
            $lines = foreach ($k in @($Replacements.Keys | Sort-Object)) { "{$k}=$($Replacements[$k])" }
            "<<$Name>>" + $(if ($lines) { "`n" + ($lines -join "`n") } else { '' })
        }
        Mock Update-AITSourceIndex -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'indexRebuild'; quiet = [bool]$Quiet })
            if ($script:S['IndexThrows']) { throw 'index lock held' }
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            $script:Writes.Add($rel)
            if ($script:S['FailWrite'] -and $rel -eq $script:S.FailWrite) { throw "disk full writing $rel" }
        }
        Mock Invoke-SummaryPipeline -ModuleName AITriad {
            $p = $script:S.Pipeline
            $snap = if ($SnapshotText.Length -gt 200) { "<$($SnapshotText.Length) chars>" } else { $SnapshotText }
            $script:Calls.Add([ordered]@{
                    call = 'pipeline'; docId = $DocId; model = $Model; apiKey = $ApiKey; temperature = $Temperature
                    taxonomyVersion = $TaxonomyVersion; systemPromptTemplate = $SystemPromptTemplate; outputSchema = $OutputSchema
                    fullTaxonomy = [bool]$FullTaxonomy; iterativeExtraction = [bool]$IterativeExtraction; autoFire = [bool]$AutoFire
                    ragMaxTotal = $RagMaxTotal; crossEncoderRerank = [bool]$CrossEncoderRerank; snapshotText = $snap; metadata = $Metadata
                })
            # The real pipeline appends to the module's $script:ContextRotStages; do the same in module scope.
            & (Get-Module AITriad) {
                param($Kind)
                switch ($Kind) {
                    'Mixed' {
                        $script:ContextRotStages = @(
                            (New-ContextRotStage -Stage 'chunking' -InUnits 'chars' -InCount 1000 -OutUnits 'chars' -OutCount 800)
                            (New-ContextRotStage -Stage 'rag' -InUnits 'nodes' -InCount 400 -OutUnits 'nodes' -OutCount 100 -Flags @{ capped = $true })
                            (New-ContextRotStage -Stage 'extraction' -InUnits 'chars' -InCount 20000 -OutUnits 'items' -OutCount 12)
                        )
                    }
                    'NoSameUnit' {
                        $script:ContextRotStages = @((New-ContextRotStage -Stage 'extraction' -InUnits 'chars' -InCount 0 -OutUnits 'items' -OutCount 0))
                    }
                }
            } $script:S['ContextRot']
            if ($p.ContainsKey('Success') -and -not $p.Success) {
                return [pscustomobject]@{ Success = $false; Error = $p.Error }
            }
            # Summary and TaxonomyJson come from the scenario table (top-level variables exist only at discovery).
            # MaxTokens: the real pipeline always returns it (32768 unless the scenario says otherwise, t/4172).
            [pscustomobject]@{
                MaxTokens = if ($p.ContainsKey('MaxTokens')) { $p.MaxTokens } else { 32768 }
                Success = $true; Summary = ($p.Summary | ConvertFrom-Json); FactualCount = $p.FactualCount
                UnmappedCount = $p.UnmappedCount; TaxonomyJson = $p.TaxonomyJson; FireStats = $p['FireStats']; UsedFire = [bool]$p['UsedFire']
                ElapsedSeconds = 12.5; Backend = 'mock-backend'
            }
        }

        $p = @{} + $(if ($S['Params']) { $S.Params } else { @{} })
        $docId = if ($S['DocId']) { $S.DocId } else { 'doc-1' }
        $p.DocId = $docId
        $p.RepoRoot = if ($S['RootMissing']) { Join-Path $root 'no-such-root' } else { $root }

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        Register-HostCaptureMock
        try {
            Invoke-POVSummary @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
        } catch {
            $err = $_.Exception.Message
        }
        $hostLines = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object {
                $m = $_.MessageData
                $h = Get-HostCaptureParts $m
                if ($h) { "[$($h.Color)] $($h.Message)" } else { "[info] $m" }
            })
        $verbose = @($records | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { $_.Message })
        $output  = @($records | Where-Object { $_ -isnot [System.Management.Automation.VerboseRecord] -and $_ -isnot [System.Management.Automation.InformationRecord] })

        $t = [ordered]@{
            scenario = $S.Name
            host     = $hostLines
            warnings = @($w | ForEach-Object { [string]$_ })
            verbose  = $verbose
            error    = $err
            output   = $output
            calls    = $script:Calls.ToArray()
            writes   = $script:Writes.ToArray()
            tree     = script:Get-Tree $root
        }
        ((script:ConvertTo-Canonical $t) | ConvertTo-Json -Depth 30) -replace "`r`n", "`n"
    }
}

Describe 'Invoke-POVSummary characterization (t/3910)' -Tag 'summary' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:POVSUMMARY_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: each golden is only as good as the branch it exercised, so pin the
    # discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name>' -ForEach @(
        @{ Name = 'reextract-none';              Text = 'No documents flagged for re-extraction' }
        @{ Name = 'reextract-one-flagged';       Text = 'RE-EXTRACTION: 1 document\(s\) flagged' }
        @{ Name = 'err-root-missing';            Text = 'Repo root not found' }
        @{ Name = 'err-docdir-missing';          Text = 'Document folder not found: sources/doc-1/' }
        @{ Name = 'err-snapshot-missing';        Text = 'snapshot.md not found for doc-1' }
        @{ Name = 'err-metadata-missing';        Text = 'metadata.json not found for doc-1' }
        @{ Name = 'skip-already-current';        Text = 'Use -Force to re-process anyway' }
        @{ Name = 'err-no-key-claude';           Text = 'Set ANTHROPIC_API_KEY, or pass -ApiKey.' }   # no AI_API_KEY: gemini-only fallback (t/4102)
        @{ Name = 'err-no-key-openai';           Text = 'Set OPENAI_API_KEY, or pass -ApiKey.' }   # registry hint, not the missing-entry fallback (t/4087)
        @{ Name = 'err-no-key-groq';             Text = 'Set GROQ_API_KEY, or pass -ApiKey.' }
        @{ Name = 'err-version-missing';         Text = 'TAXONOMY_VERSION not found' }
        @{ Name = 'err-pipeline-failed';         Text = 'Pipeline failed for doc-1: CHESS pre-classification timed out' }
        @{ Name = 'err-summary-write-failed';    Text = 'AI response was valid but could not be saved' }
        @{ Name = 'dryrun-current-long';         Text = 'Document is very long' }
        @{ Name = 'dryrun-no-taxonomy';          Text = 'DRY RUN complete. No API call made. No files written.' }
        @{ Name = 'rich-rag';                    Text = 'Appended to fuzzy-matched conflict: conflict-compute-doubles-every-x' }
        @{ Name = 'fire-full-taxonomy';          Text = 'Under-extraction detected: 0 claims' }
        @{ Name = 'fire-no-stats-unknown-prefix'; Text = 'extraction_mode\\": \\"fire' }
        @{ Name = 'metadata-write-failed';       Text = 'Summary written but metadata update failed' }
        @{ Name = 'whatif';                      Text = 'No files written\.' }
        @{ Name = 'current-no-version';          Text = 'taxonomy version not recorded' }
        @{ Name = 'claim-missing-label';         Text = 'is missing claim_label, potential_conflict_id' }
        @{ Name = 'keypoint-missing-stance';     Text = 'a key point is missing stance' }
        @{ Name = 'camp-missing';                Text = "has no 'skeptic' camp" }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json"))
        $g | Should -Match $Text
    }

    It 'writes summary, then metadata, then each conflict, once each, on the right paths (rich-rag)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich-rag.json')) | ConvertFrom-Json
        @($g.writes) | Should -Be @(
            'summaries/altman-2024-agi-path.json'
            'sources/altman-2024-agi-path/metadata.json'
            'conflicts/conflict-existing.json'
            'conflicts/conflict-new-hint.json'
            'conflicts/conflict-new-nolabel.json'
            'conflicts/conflict-compute-doubles-every-x.json'
            'conflicts/conflict-liability-rules-lag-behind-deployment-altman-2.json'
        )
    }

    It 'whatif makes no write, rebuilds no index and reports no file as written (t/4070)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'whatif.json')) | ConvertFrom-Json
        @($g.writes).Count | Should -Be 0
        @($g.calls | Where-Object call -eq 'indexRebuild').Count | Should -Be 0
        # Case-sensitive: the footer "No files written." must not count as a "Files written:" claim.
        @($g.host | Where-Object { $_ -cmatch 'written to|updated:|Appended to|Created new conflict|Files written:' }).Count | Should -Be 0
    }

    It 'dryrun-no-taxonomy creates no conflicts/ directory (t/4070)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'dryrun-no-taxonomy.json')) | ConvertFrom-Json
        @($g.tree.PSObject.Properties.Name) | Should -Not -Contain 'conflicts/'
    }

    It '<Name> leaves every pre-existing file byte-identical' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'dryrun-current-long', 'whatif', 'skip-already-current' }
    ) {
        $s = $_
        # Build the same fixture twice: once untouched, once run; every file must match.
        $pristine = script:New-PovFixture $s
        $script:RootCurrent = [System.IO.Path]::GetFullPath($pristine).TrimEnd('\', '/')
        $before = script:Get-Tree $pristine
        $null = script:Invoke-Scenario $s
        $after = script:Get-Tree $script:RootFixture
        foreach ($k in @($before.Keys)) { $after[$k] | Should -BeExactly $before[$k] -Because "$k must be untouched" }
        @($after.Keys | Where-Object { $_ -notlike '*/' }).Count | Should -Be @($before.Keys | Where-Object { $_ -notlike '*/' }).Count
    }
}

Describe 'Invoke-POVSummary persists factual_claims and unmapped_concepts as arrays (t/4070)' -Tag 'summary' {

    # A bare if-expression in the summary literal unrolled: 0 items persisted as null and 1 item as a
    # bare object. Readers expect arrays (t/1726), which is what 869 of 870 summaries on disk hold.
    It 'writes <Field> as a JSON array for <Case>' -ForEach @(
        foreach ($f in 'factual_claims', 'unmapped_concepts') {
            @{ Field = $f; Case = 'an omitted field'; Json = '{ "pov_summaries": {} }'; Count = 0 }
            @{ Field = $f; Case = 'an explicit null'; Json = "{ `"pov_summaries`": {}, `"$f`": null }"; Count = 0 }
            @{ Field = $f; Case = '0 items'; Json = "{ `"pov_summaries`": {}, `"$f`": [] }"; Count = 0 }
            @{ Field = $f; Case = '1 item'; Json = "{ `"pov_summaries`": {}, `"$f`": [ { `"claim`": `"one`" } ] }"; Count = 1 }
            @{ Field = $f; Case = '2 items'; Json = "{ `"pov_summaries`": {}, `"$f`": [ { `"claim`": `"one`" }, { `"claim`": `"two`" } ] }"; Count = 2 }
        }
    ) {
        $written = InModuleScope AITriad -Parameters @{ Json = $Json } {
            param($Json)
            $script:Captured = $null
            Mock Write-Utf8NoBom { $script:Captured = $Value }
            Mock Write-OK { }
            $summary = $Json | ConvertFrom-Json
            Write-POVSummaryFile -Path 'unused.json' -DocId 'doc-1' -TaxonomyVersion '2.4.0' -ModelInfo ([ordered]@{}) `
                -SummaryObject $summary -ContextRotObj $null
            $script:Captured
        }
        $written | Should -Match ('"' + $Field + '":\s*\[')
        $parsed = $written | ConvertFrom-Json -AsHashtable
        ($parsed[$Field] -is [System.Collections.IList]) | Should -BeTrue -Because 'null or a bare object must not be persisted in place of an array'
        @($parsed[$Field]).Count | Should -Be $Count
    }
}
