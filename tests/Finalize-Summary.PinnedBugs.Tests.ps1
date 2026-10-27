# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the Finalize-Summary bugs pinned by the t/4136 characterization (t/4079).
.DESCRIPTION
    One Describe per item:
      1. metadata.json key order is deterministic (ordered dictionaries, ordinal key order), checked
         directly and across 3 separate pwsh processes with no masking;
      2. model_info.max_tokens and fire_confidence_threshold record the values actually used;
      3. the metadata-update and unmapped-resolution failures are WARNs naming the condition;
      4. a key point missing stance / taxonomy_node_id / point degrades with a WARN instead of throwing;
      5. an empty [] is "present but empty", not null (Get-SummaryField);
      6. a missing metadata.json is a WARN, not a raw Get-Content error, and the summary is still written.
    Item 7 (the summary-write failure skips the metadata write, run for real) is in
    Finalize-Summary.Characterization.Tests.ps1, next to the scenario runner it uses.

    Finalize-Summary runs in module scope, where the module's Set-StrictMode -Version Latest applies.
    The passes it delegates to are mocked; Write-Utf8NoBom is mocked to record (or fail) each write.
#>

BeforeAll {
    $script:ModulePsm1 = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
    $script:Mod = Get-Module AITriad
    $script:ModelId = 'gemini-3.5-flash-lite'

    # Runs Finalize-Summary on $SummaryJson. Returns @{ Result; Warnings; Errors; Writes (path -> text) }.
    # -FailWritePattern makes the mocked sink throw for a path that matches it.
    function script:Invoke-Finalize {
        param(
            [string]$SummaryJson, [string]$MetaFile, [hashtable]$Extra = @{},
            [string]$FailWritePattern = '', [string[]]$NodeIds = @('acc-beliefs-001', 'saf-beliefs-003'),
            [switch]$ResolutionThrows
        )
        $script:Writes = [ordered]@{}
        $script:FailWritePattern = $FailWritePattern
        $script:NodeIds = $NodeIds
        $script:ResolutionThrows = [bool]$ResolutionThrows
        Mock Get-TaxonomyNodeIdSet -ModuleName AITriad {
            $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($i in $script:NodeIds) { [void]$set.Add($i) }
            , $set
        }
        Mock Invoke-PolarityGatePass -ModuleName AITriad {
            @{ opposes = 0; agrees = 0; unrelated = 0; unresolved = 0; gated = 0; reps = 0; judge_flipped = 0; judge_kept = 0; self_healed = 0 }
        }
        Mock Resolve-UnmappedConcepts -ModuleName AITriad {
            if ($script:ResolutionThrows) { throw 'resolver offline' }
            [pscustomobject]@{ Resolved = @(); Remaining = @($UnmappedConcepts) }
        }
        Mock Write-Utf8NoBom -ModuleName AITriad {
            if ($script:FailWritePattern -and $Path -like $script:FailWritePattern) { throw "disk full writing $(Split-Path -Leaf $Path)" }
            $script:Writes[[string]$Path] = [string]$Value
        }
        & $script:Mod { $script:CachedEmbeddings = $null; $script:TaxonomyData = @{}; $script:ContextRotStages = @() }

        $p = @{
            SummaryObject   = ($SummaryJson | ConvertFrom-Json)
            ThisDocId       = 'doc-1'
            TaxonomyVersion = '2.4.0'
            Model           = $script:ModelId
            Temperature     = 0.2
            Now             = '2026-01-02T03:04:05Z'
            SummariesDir    = (Join-Path $TestDrive 'summaries')
            Doc             = @{ DocId = 'doc-1'; MetaFile = $MetaFile }
            Elapsed         = [TimeSpan]::FromSeconds(1)
        }
        foreach ($k in $Extra.Keys) { $p[$k] = $Extra[$k] }

        $records = @(& $script:Mod { param($P) Finalize-Summary @P 2>&1 3>&1 6>$null } $p)
        @{
            Result   = @($records | Where-Object { $_ -is [hashtable] }) | Select-Object -First 1
            Warnings = @($records | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message })
            Errors   = @($records | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
            Writes   = $script:Writes
        }
    }

    function script:New-MetaFile([string]$Name) {
        $path = Join-Path $TestDrive "$Name-metadata.json"
        $json = '{ "title": "Doc", "summary_status": "pending", "claims_by_pov": { "accelerationist": 9 } }'
        [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
        $path
    }

    # Child script for the 3-process determinism test (item 1). Its own data root, so no real taxonomy loads.
    $script:DeterminismChild = @'
param([string]$ModulePath, [string]$WorkDir)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Join-Path $WorkDir 'summaries') -Force | Out-Null
# An empty data root of its own, so no real taxonomy loads; the files written live outside it.
$env:AI_TRIAD_DATA_ROOT = Join-Path $WorkDir 'empty-data-root'
New-Item -ItemType Directory -Path $env:AI_TRIAD_DATA_ROOT -Force | Out-Null
Import-Module $ModulePath -Force -WarningAction SilentlyContinue
$mod = Get-Module AITriad
$meta = Join-Path $WorkDir 'metadata.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($meta, '{ "title": "Doc", "summary_status": "pending", "claims_by_pov": { "accelerationist": 9 }, "custom_field": "kept" }', $utf8)
$summary = @"
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } },
  "factual_claims": [ { "claim": "c1", "linked_taxonomy_nodes": ["skp-beliefs-001", "sit-004", "saf-beliefs-003", "acc-beliefs-001"] },
                      { "claim": "c2", "linked_taxonomy_nodes": ["sit-004", "acc-beliefs-001"] } ],
  "unmapped_concepts": [] }
"@
$hashes = foreach ($run in 1..2) {
    $p = @{
        SummaryObject = ($summary | ConvertFrom-Json); ThisDocId = 'doc-1'; TaxonomyVersion = '2.4.0'
        Model = 'gemini-3.5-flash-lite'; Temperature = 0.2; Now = '2026-01-02T03:04:05Z'
        SummariesDir = (Join-Path $WorkDir 'summaries'); Doc = @{ DocId = 'doc-1'; MetaFile = $meta }
        Elapsed = [TimeSpan]::FromSeconds(1); MaxTokens = 32768
    }
    $r = @(& $mod { param($P) $script:ContextRotStages = @(); Finalize-Summary @P 6>$null 3>$null } $p) |
        Where-Object { $_ -is [hashtable] } | Select-Object -First 1
    if (-not $r.Success) { throw "Finalize-Summary failed: $($r.Error)" }
    (Get-FileHash -LiteralPath $meta -Algorithm SHA256).Hash
}
"HASHES $($hashes -join ' ')"
'@

    # A complete FireStats as Invoke-IterativeExtraction returns it, minus confidence_threshold.
    function script:New-FireStats([hashtable]$With = @{}) {
        $f = [ordered]@{ total_api_calls = 1; total_iterations = 0; claims_total = 0; claims_confident = 0
                         claims_iterated = 0; elapsed_seconds = 1.0; termination_reason = 'no_claims' }
        foreach ($k in $With.Keys) { $f[$k] = $With[$k] }
        [pscustomobject]$f
    }

    $script:EmptyCamps = '"pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } }'
    $script:FourPovClaims = @'
[ { "claim": "c1", "linked_taxonomy_nodes": ["skp-beliefs-001", "sit-004", "saf-beliefs-003", "acc-beliefs-001"] },
  { "claim": "c2", "linked_taxonomy_nodes": ["sit-004", "acc-beliefs-001"] } ]
'@
}

Describe 'item 1: metadata.json key order is deterministic (t/4079)' -Tag 'summarization' {

    It 'node_references_by_pov and primary_pov_distribution are ordered dictionaries in ordinal key order' {
        $claims = $script:FourPovClaims | ConvertFrom-Json
        $counts = & $script:Mod { param($C) Get-SummaryClaimPovCounts -FactualClaims $C } $claims
        foreach ($name in 'NodeRefs', 'Primary') {
            $d = $counts[$name]
            ($d -is [System.Collections.Specialized.OrderedDictionary]) | Should -BeTrue -Because "$name must not be a plain @{} (per-process key order)"
            $keys = [string[]]@($d.Keys)
            $sorted = [string[]]$keys.Clone(); [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
            $keys | Should -Be $sorted
            $keys | Should -Be @('accelerationist', 'safetyist', 'situations', 'skeptic')
        }
        @($counts.NodeRefs.Values) | Should -Be @(2, 1, 2, 1)
        @($counts.Primary.Values) | Should -Be @(0, 0, 1, 1) -Because 'c1 first links skeptic, c2 first links situations'
    }

    It 'the written metadata.json carries both blocks in ordinal key order' {
        $meta = script:New-MetaFile 'order'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": $($script:FourPovClaims), `"unmapped_concepts`": [] }" -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        $text = $r.Writes[$meta]
        $text | Should -Not -BeNullOrEmpty
        foreach ($block in 'node_references_by_pov', 'primary_pov_distribution') {
            $text | Should -Match ('"' + $block + '": \{\s*"accelerationist": \d+,\s*"safetyist": \d+,\s*"situations": \d+,\s*"skeptic": \d+\s*\}')
        }
    }

    It 're-summarizing the same doc gives byte-identical metadata.json across 3 separate processes (no masking)' {
        # Each child imports the module fresh (its own string-hash seed), writes the same metadata fixture,
        # runs Finalize-Summary on the same summary twice and reports the SHA-256 of metadata.json after each.
        $child = Join-Path $TestDrive 'f79-determinism-child.ps1'
        [System.IO.File]::WriteAllText($child, $script:DeterminismChild, [System.Text.UTF8Encoding]::new($false))
        $hashes = foreach ($i in 1..3) {
            $dir = Join-Path $TestDrive "proc-$i"
            $out = & pwsh -NoProfile -NonInteractive -File $child -ModulePath $script:ModulePsm1 -WorkDir $dir 2>&1
            $LASTEXITCODE | Should -Be 0 -Because "child process $i failed: $($out -join "`n")"
            $line = @($out | Where-Object { "$_" -like 'HASHES *' })
            $line.Count | Should -Be 1 -Because "child $i output: $($out -join "`n")"
            $pair = ("$($line[0])" -replace '^HASHES ', '') -split ' '
            $pair[0] | Should -Be $pair[1] -Because "process ${i}: a re-summarize must not change metadata.json"
            $pair[0]
        }
        @($hashes | Select-Object -Unique).Count | Should -Be 1 -Because "the hashes were: $($hashes -join ', ')"
    }
}

Describe 'item 2: model_info records the MaxTokens and FIRE threshold actually used (t/4079)' -Tag 'summarization' {

    It 'New-SummaryModelInfo records the passed MaxTokens and the threshold FireStats reports' {
        $mi = & $script:Mod {
            param($F)
            New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -TaxonomyJson '' -ChunkCount 0 -MaxTokens 12345 `
                -FireStats $F
        } -F (script:New-FireStats @{ confidence_threshold = 0.55 })
        $mi['max_tokens'] | Should -Be 12345
        $mi['fire_confidence_threshold'] | Should -Be 0.55
    }

    It 'records null, not a made-up number, when the value is not known' {
        $mi = & $script:Mod { param($F) New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -TaxonomyJson '' -ChunkCount 0 -FireStats $F } (script:New-FireStats)
        $mi.Contains('max_tokens') | Should -BeTrue
        $mi['max_tokens'] | Should -BeNullOrEmpty
        $mi.Contains('fire_confidence_threshold') | Should -BeTrue
        $mi['fire_confidence_threshold'] | Should -BeNullOrEmpty
    }

    It 'Finalize-Summary writes the MaxTokens it is given into the summary' {
        $meta = script:New-MetaFile 'maxtok'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": [], `"unmapped_concepts`": [] }" -MetaFile $meta `
            -Extra @{ MaxTokens = 4242; FireStats = (script:New-FireStats @{ confidence_threshold = 0.61 }) }
        $summaryPath = Join-Path $TestDrive 'summaries' 'doc-1.json'
        $s = $r.Writes[$summaryPath] | ConvertFrom-Json
        $s.model_info.max_tokens | Should -Be 4242
        $s.model_info.fire_confidence_threshold | Should -Be 0.61
    }

    It 'Invoke-IterativeExtraction uses -MaxTokens for its call and reports -ConfidenceThreshold in FireStats' {
        $script:SeenMaxTokens = $null
        Mock Invoke-AIApi -ModuleName AITriad {
            $script:SeenMaxTokens = $MaxTokens
            [pscustomobject]@{ Text = '{ "pov_summaries": {} }'; Backend = 'mock'; Truncated = $false }
        }
        $r = & $script:Mod { Invoke-IterativeExtraction -Prompt 'p' -Model 'gemini-3.5-flash-lite' -ApiKey 'k' -MaxTokens 1234 -ConfidenceThreshold 0.55 }
        $script:SeenMaxTokens | Should -Be 1234
        $r.FireStats.confidence_threshold | Should -Be 0.55
        $r.FireStats.termination_reason | Should -Be 'no_claims'
    }

    It 'the chunked path records the MaxTokens its chunk calls used (65536), not the single-call 32768' {
        $snap = Join-Path $TestDrive 'chunked-snapshot.md'
        [System.IO.File]::WriteAllText($snap, 'Some text.')
        $script:ChunkCallMaxTokens = [System.Collections.Generic.List[int]]::new()
        $script:FinalizeMaxTokens = 'not called'
        Mock Split-DocumentChunks -ModuleName AITriad { @('chunk one text', 'chunk two text') }
        Mock Invoke-BatchEmbeddings -ModuleName AITriad { @{} }
        Mock Get-RelevantTaxonomyNodes -ModuleName AITriad { 'ctx' }
        Mock Add-StageTiming -ModuleName AITriad { }
        Mock Invoke-AIApi -ModuleName AITriad {
            $script:ChunkCallMaxTokens.Add($MaxTokens)
            [pscustomobject]@{ Text = '{}'; Backend = 'mock'; Truncated = $false }
        }
        Mock Parse-AIResponse -ModuleName AITriad {
            '{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } }, "factual_claims": [], "unmapped_concepts": [] }' | ConvertFrom-Json
        }
        Mock Merge-ChunkSummaries -ModuleName AITriad { [ordered]@{ pov_summaries = [ordered]@{}; factual_claims = @(); unmapped_concepts = @() } }
        Mock Test-SummaryDensity -ModuleName AITriad { @{ Pass = $true; Shortfalls = @() } }
        Mock Finalize-Summary -ModuleName AITriad { $script:FinalizeMaxTokens = $MaxTokens; @{ Success = $true } }

        $doc = @{ DocId = 'big-doc'; Meta = [pscustomobject]@{ title = 'T' }; PovTags = @('safetyist'); SnapshotFile = $snap; MetaFile = 'unused' }
        $null = & $script:Mod {
            param($D)
            Invoke-ChunkedSummary -Doc $D -ApiKey 'k' -Model 'gemini-3.5-flash-lite' -Temperature 0.2 -TaxonomyVersion 'v' `
                -TaxonomyJson 'x' -SystemPromptTemplate 's' -ChunkSystemPromptTemplate 'c' -OutputSchema '{}' `
                -SummariesDir $TestDrive -Now 'now' 6>$null
        } $doc
        @($script:ChunkCallMaxTokens | Select-Object -Unique) | Should -Be @(65536)
        $script:FinalizeMaxTokens | Should -Be 65536 -Because 'model_info.max_tokens must be what the chunk calls used'
    }
}

Describe 'item 3: failures are WARNs naming the triggering condition (t/4079)' -Tag 'summarization' {

    It 'a failed metadata write is a WARN that names the stale metadata.json, and the call still succeeds' {
        $meta = script:New-MetaFile 'metafail'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": [], `"unmapped_concepts`": [] }" `
            -MetaFile $meta -FailWritePattern '*-metadata.json'
        $r.Result.Success | Should -BeTrue
        $w = @($r.Warnings | Where-Object { $_ -like '*metadata update failed*' })
        $w.Count | Should -Be 1
        $w[0] | Should -BeExactly "Finalize-Summary: summary written but metadata update failed, leaving '$meta' stale: disk full writing metafail-metadata.json"
        $r.Writes.Contains((Join-Path $TestDrive 'summaries' 'doc-1.json')) | Should -BeTrue
    }

    It 'a failed unmapped-concept resolution is a WARN that says the concepts stay unresolved' {
        $meta = script:New-MetaFile 'resfail'
        $json = "{ $($script:EmptyCamps), `"factual_claims`": [], `"unmapped_concepts`": [ { `"suggested_label`": `"A`", `"concept`": `"a`" }, { `"suggested_label`": `"B`", `"concept`": `"b`" } ] }"
        $r = script:Invoke-Finalize -SummaryJson $json -MetaFile $meta -ResolutionThrows
        $r.Result.Success | Should -BeTrue
        $r.Result.UnmappedCount | Should -Be 2
        @($r.Warnings) | Should -Contain 'Finalize-Summary: unmapped concept resolution failed — keeping all 2 unmapped concept(s) unresolved: resolver offline'
    }
}

Describe 'item 4: a key point missing a field degrades with a WARN instead of throwing (t/4079)' -Tag 'summarization' {

    # saf-beliefs-404 is not in the node set, so the hallucinated-ID reroute reads the point text too.
    It 'missing <Field>: no throw, a WARN naming the field and camp, and the field defaulted to null' -ForEach @(
        @{ Field = 'stance';           Kp = '{ "taxonomy_node_id": "saf-beliefs-003", "category": "Beliefs", "point": "P." }' }
        @{ Field = 'taxonomy_node_id'; Kp = '{ "category": "Beliefs", "point": "P.", "stance": "opposed" }' }
        @{ Field = 'point';            Kp = '{ "taxonomy_node_id": "saf-beliefs-404", "category": "Beliefs", "stance": "opposed" }' }
    ) {
        $meta = script:New-MetaFile "kp-$Field"
        $json = "{ `"pov_summaries`": { `"accelerationist`": { `"key_points`": [] }, `"safetyist`": { `"key_points`": [ $Kp ] }, `"skeptic`": { `"key_points`": [] } }, `"factual_claims`": [], `"unmapped_concepts`": [] }"
        $r = script:Invoke-Finalize -SummaryJson $json -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        $r.Result.TotalPoints | Should -Be 1
        @($r.Warnings) | Should -Contain "Finalize-Summary: pov_summaries.safetyist.key_points[0] has no '$Field' field — defaulting it to null (t/4079)"
        @($r.Warnings | Where-Object { $_ -like '*has no*field*' }).Count | Should -Be 1 -Because 'only the missing field is reported'
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        $kp = @($s.pov_summaries.safetyist.key_points)[0]
        $kp.PSObject.Properties[$Field] | Should -Not -BeNullOrEmpty -Because 'the field is added'
        switch ($Field) {
            'stance'           { $kp.stance | Should -Be 'neutral' -Because 'a null stance resolves to neutral' }
            'taxonomy_node_id' { $kp.taxonomy_node_id | Should -BeNullOrEmpty; $r.Result.NullNodes | Should -Be 1 }
            'point'            { @($s.unmapped_concepts)[0].suggested_label | Should -Be 'Unresolved concept' }
        }
    }
}

Describe 'item 5: an empty [] is present but empty, not null (t/4079)' -Tag 'summarization' {

    It 'Get-SummaryField returns an empty array for [] on a <Shape>' -ForEach @(@{ Shape = 'PSCustomObject' }, @{ Shape = 'dictionary' }) {
        $obj = if ($Shape -eq 'dictionary') { [ordered]@{ xs = @(); one = @('a') } } else { '{ "xs": [], "one": ["a"] }' | ConvertFrom-Json }
        $r = & $script:Mod { param($O) , (Get-SummaryField $O 'xs') } $obj
        $null -eq $r | Should -BeFalse -Because '[] must not read as null'
        @($r).Count | Should -Be 0
        $one = & $script:Mod { param($O) , (Get-SummaryField $O 'one') } $obj
        $one -is [array] | Should -BeTrue -Because 'a one-element array stays an array'
        & $script:Mod { param($O) $null -eq (Get-SummaryField $O 'absent') } $obj | Should -BeTrue
    }

    It '"factual_claims": [] is not a schema error, and "key_points": [] is not the missing/null WARN' {
        $meta = script:New-MetaFile 'empty'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": [], `"unmapped_concepts`": [] }" -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        @($r.Warnings | Where-Object { $_ -like '*key_points missing/null*' }).Count | Should -Be 0
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        $s.PSObject.Properties['warnings'] | Should -BeNullOrEmpty -Because 'no "Missing required field: factual_claims"'
    }

    It 'a real null still is one (negative control): factual_claims null is a schema error, key_points null WARNs' {
        $meta = script:New-MetaFile 'null'
        $json = '{ "pov_summaries": { "accelerationist": { "key_points": null }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } }, "factual_claims": null, "unmapped_concepts": [] }'
        $r = script:Invoke-Finalize -SummaryJson $json -MetaFile $meta
        @($r.Warnings | Where-Object { $_ -like '*key_points missing/null*' }) | Should -HaveCount 1
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        @($s.warnings) | Should -Be @('Schema: Missing required field: factual_claims')
    }
}

Describe 'item 6: a missing metadata.json is a WARN, and the summary is still written (t/4079)' -Tag 'summarization' {

    It 'WARNs that the file is missing, raises no error record, writes the summary and succeeds' {
        $missing = Join-Path $TestDrive 'no-such-dir' 'metadata.json'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": [], `"unmapped_concepts`": [] }" -MetaFile $missing
        $r.Result.Success | Should -BeTrue
        $r.Errors | Should -HaveCount 0 -Because 'no raw Get-Content error and no "Cannot index into a null array"'
        @($r.Warnings) | Should -Contain "Finalize-Summary: summary written but metadata.json not updated — the file is missing: '$missing'"
        @($r.Writes.Keys) | Should -Be @((Join-Path $TestDrive 'summaries' 'doc-1.json')) -Because 'the summary is written and no metadata write is attempted'
    }
}

Describe 'item 8: empty_cells persists through finalize, and an empty camp does not break the metadata rollup (t/4473/t/4519)' -Tag 'summarization' {

    It 'carries empty_cells into the written summary.json verbatim' {
        $meta = script:New-MetaFile 'empty-cells'
        $json = @'
{ "pov_summaries": { "accelerationist": { "key_points": [] }, "safetyist": { "key_points": [ { "point": "p", "taxonomy_node_id": "saf-beliefs-003", "stance": "aligned" } ] }, "skeptic": { "key_points": [] } },
  "factual_claims": [], "unmapped_concepts": [],
  "empty_cells": [
    { "camp": "accelerationist", "category": "Beliefs", "reason": "no accelerationist content" },
    { "camp": "skeptic", "category": "Intentions", "reason": "no skeptic argument" }
  ] }
'@
        $r = script:Invoke-Finalize -SummaryJson $json -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        @($s.empty_cells).Count | Should -Be 2
        ($s.empty_cells | Where-Object { $_.camp -eq 'skeptic' }).reason | Should -Be 'no skeptic argument'
    }

    It 'defaults empty_cells to [] (present, not null) when the model omits the field, and the metadata write still succeeds' {
        $meta = script:New-MetaFile 'no-empty-cells-field'
        $r = script:Invoke-Finalize -SummaryJson "{ $($script:EmptyCamps), `"factual_claims`": $($script:FourPovClaims), `"unmapped_concepts`": [] }" -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        $s.PSObject.Properties['empty_cells'] | Should -Not -BeNullOrEmpty -Because 'empty_cells is always present, default []'
        @($s.empty_cells).Count | Should -Be 0
        $metaWritten = $r.Writes[$meta] | ConvertFrom-Json
        $metaWritten.node_references_by_pov | Should -Not -BeNullOrEmpty -Because 'an empty camp plus empty_cells must not break the metadata rollup'
    }

    It 'does not throw under StrictMode when an untagged camp key is omitted entirely, not just empty (t/4553)' {
        # #3867/t/4519 license the model to leave an untagged camp's key out of pov_summaries
        # outright. accelerationist is absent below, not { "key_points": [] }.
        $meta = script:New-MetaFile 'camp-key-omitted'
        $json = @'
{ "pov_summaries": { "safetyist": { "key_points": [ { "point": "p", "taxonomy_node_id": "saf-beliefs-003", "stance": "aligned" } ] }, "skeptic": { "key_points": [] } },
  "factual_claims": [], "unmapped_concepts": [] }
'@
        { script:Invoke-Finalize -SummaryJson $json -MetaFile $meta } | Should -Not -Throw
        $r = script:Invoke-Finalize -SummaryJson $json -MetaFile $meta
        $r.Result.Success | Should -BeTrue
        $s = $r.Writes[(Join-Path $TestDrive 'summaries' 'doc-1.json')] | ConvertFrom-Json
        $s.pov_summaries.PSObject.Properties['accelerationist'] | Should -BeNullOrEmpty -Because 'the model omitting the camp is licensed, not normalized away'
    }
}

