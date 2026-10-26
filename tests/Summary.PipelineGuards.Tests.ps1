# Tag: summarization (t/4168, t/4172)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression tests for the summary-path bugs found next to Finalize-Summary while fixing t/4144 and
    t/4079 (t/4168, t/4172). Each Describe fails if its fix is reverted.
.DESCRIPTION
    t/4168
      1. A null in unmapped_concepts failed Invoke-SummaryPipeline's resolution step (Resolve-UnmappedConcepts
         takes [object[]] without [AllowNull()]), and the failure was logged only at Verbose.
      2. unmapped_resolution was recorded twice in context_rot.stages when the pipeline's resolution and
         Finalize-Summary's both ran.
    t/4172
      1. Invoke-POVSummary's model_info hard-coded max_tokens = 32768 and fire_confidence_threshold = 0.7.
      2. Invoke-SummaryPipeline Stage 7 and Invoke-ChunkedSummary's chunk loop read $_.taxonomy_node_id
         unguarded, so a key point without that field threw under StrictMode.
      3. FIRE's parse-failure FireStats lacked claims_total and the other fields the model_info builders read.
    No AI call is made: Invoke-AIApi is mocked wherever the code under test would reach it.
#>

BeforeAll {
    $script:ModulePsm1 = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
    $script:Mod = Get-Module AITriad
    $script:ModelId = 'gemini-3.5-flash-lite'   # registered in ai-models.json

    # Jaccard resolution only (no embeddings), against a two-node taxonomy.
    function script:Initialize-ResolutionState {
        & $script:Mod {
            $script:CachedEmbeddings = $null
            $script:ContextRotStages = @()
            $script:TaxonomyData = @{
                accelerationist = [pscustomobject]@{ nodes = @([pscustomobject]@{ id = 'acc-beliefs-001'; category = 'Beliefs'; label = 'Scaling compute delivers gains' }) }
                safetyist       = [pscustomobject]@{ nodes = @([pscustomobject]@{ id = 'saf-beliefs-003'; category = 'Beliefs'; label = 'Oversight gap' }) }
            }
        }
    }

    function script:Get-ResolutionStages {
        @(& $script:Mod { @($script:ContextRotStages) } | Where-Object { $_['stage'] -eq 'unmapped_resolution' })
    }

    # Runs Invoke-SummaryPipeline single-shot on a canned model response. Returns @{ Result; Warnings; Verbose }.
    function script:Invoke-PipelineOn([string]$SummaryJson) {
        $script:CannedSummary = $SummaryJson
        Mock Test-FireRequired -ModuleName AITriad { @{ ShouldFire = $false; Reason = 'test' } }
        Mock Invoke-AIApi -ModuleName AITriad { [pscustomobject]@{ Text = $script:CannedSummary; Backend = 'mock-backend'; Truncated = $false } }
        Mock Test-SummaryDensity -ModuleName AITriad { @{ Pass = $true; Shortfalls = @() } }
        Mock Remove-DuplicateClaims -ModuleName AITriad { @{ Summary = $SummaryObject; Metrics = @{ points_removed = 0; claims_removed = 0 } } }
        Mock Add-StageTiming -ModuleName AITriad { }
        $records = @(& $script:Mod {
                param($Model)
                Invoke-SummaryPipeline -SnapshotText 'A short document body.' -DocId 'guard-doc' `
                    -Metadata ([pscustomobject]@{ title = 'Guard' }) -ApiKey 'fixture-not-a-real-key' -Model $Model `
                    -TaxonomyVersion 'v' -SystemPromptTemplate 'System prompt.' -OutputSchema '{}' `
                    -TaxonomyJsonOverride 'x' -Verbose 3>&1 4>&1 6>$null
            } $script:ModelId)
        @{
            Result   = @($records | Where-Object { $_ -is [hashtable] })[0]
            Warnings = @($records | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object Message)
            Verbose  = @($records | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object Message)
        }
    }

    $script:Camps = '"accelerationist": { "key_points": [] }, "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] }'
}

AfterAll {
    Import-Module $script:ModulePsm1 -Force -WarningAction SilentlyContinue
}

Describe 't/4168 item 1: a null unmapped_concepts entry no longer fails the pipeline''s resolution' -Tag 'summarization' {

    BeforeEach { script:Initialize-ResolutionState }

    It 'skips the null with a WARN naming the count, and resolves the other concepts' {
        $json = "{ `"pov_summaries`": { $($script:Camps) }, `"factual_claims`": [], `"unmapped_concepts`": [
            { `"suggested_label`": `"Scaling compute delivers gains`" }, null, null,
            { `"suggested_label`": `"Incident disclosure clocks`" } ] }"
        $r = script:Invoke-PipelineOn $json
        $r.Result.Success | Should -BeTrue
        @($r.Warnings -match "skipped 2 null unmapped_concepts entry/entries for 'guard-doc'").Count | Should -Be 1
        @($r.Verbose -match 'unmapped resolution failed').Count | Should -Be 0
        @($r.Warnings -match 'resolution failed').Count | Should -Be 0
        @($r.Result.Summary.unmapped_concepts | ForEach-Object suggested_label) | Should -Be @('Incident disclosure clocks')
        $stages = @(script:Get-ResolutionStages)
        $stages.Count | Should -Be 1
        $stages[0]['in_count'] | Should -Be 2
        $stages[0]['flags']['resolved_count'] | Should -Be 1
    }

    It 'emits no null WARN when there are no nulls' {
        $json = "{ `"pov_summaries`": { $($script:Camps) }, `"factual_claims`": [], `"unmapped_concepts`": [ { `"suggested_label`": `"Incident disclosure clocks`" } ] }"
        $r = script:Invoke-PipelineOn $json
        @($r.Warnings -match 'null unmapped_concepts').Count | Should -Be 0
    }

    It 'a resolution failure is a WARN naming the fallback, not a Verbose line' {
        Mock Resolve-UnmappedConcepts -ModuleName AITriad { throw 'resolver offline' }
        $json = "{ `"pov_summaries`": { $($script:Camps) }, `"factual_claims`": [], `"unmapped_concepts`": [ { `"suggested_label`": `"A`" }, { `"suggested_label`": `"B`" } ] }"
        $r = script:Invoke-PipelineOn $json
        $r.Result.Success | Should -BeTrue
        @($r.Warnings -match "unmapped concept resolution failed for 'guard-doc' .* keeping all 2 unmapped concept\(s\) unresolved: resolver offline").Count | Should -Be 1
    }
}

Describe 't/4168 item 2: unmapped_resolution is recorded once' -Tag 'summarization' {

    BeforeEach { script:Initialize-ResolutionState }

    It 'the pipeline pass then the Finalize-Summary pass leave one stage covering both, and the same concepts resolve' {
        $remaining = & $script:Mod {
            $s = '{ "unmapped_concepts": [ { "suggested_label": "Scaling compute delivers gains" }, { "suggested_label": "Incident disclosure clocks" } ] }' | ConvertFrom-Json
            Resolve-PipelineUnmappedConcepts -SummaryObject $s -DocId 'd'
            # What Move-HallucinatedNodeIdsToUnmapped does between the passes: reroute a key point.
            $s.unmapped_concepts = @($s.unmapped_concepts) + @([pscustomobject]@{ suggested_label = 'Oversight gap' })
            $state = Resolve-SummaryUnmappedConcepts -SummaryObject $s -UnmappedConcs $s.unmapped_concepts -UnmappedCount 2 6>$null
            @($state.Concepts | ForEach-Object suggested_label)
        }
        $remaining | Should -Be @('Incident disclosure clocks') -Because 'both passes still run: each resolves its concept'
        $stages = @(script:Get-ResolutionStages)
        $stages.Count | Should -Be 1
        $stages[0]['in_count'] | Should -Be 3 -Because '2 from the model, plus 1 rerouted before the second pass'
        $stages[0]['out_count'] | Should -Be 1
        $stages[0]['flags']['resolved_count'] | Should -Be 2
    }

    It 'Merge-UnmappedResolutionStage folds the stages at the last one''s position' {
        $stages = @(& $script:Mod {
            $script:ContextRotStages = @(
                (New-ContextRotStage -Stage 'rag_filtering' -InUnits 'nodes' -InCount 400 -OutUnits 'nodes' -OutCount 100)
                (New-ContextRotStage -Stage 'unmapped_resolution' -InUnits 'concepts' -InCount 5 -OutUnits 'still_unmapped' -OutCount 3 `
                    -Flags @{ resolved_count = 2; near_miss_count = 4; threshold = 0.5; used_embeddings = 0 })
                (New-ContextRotStage -Stage 'extraction' -InUnits 'prompt_chars' -InCount 900 -OutUnits 'items' -OutCount 9)
                (New-ContextRotStage -Stage 'unmapped_resolution' -InUnits 'concepts' -InCount 4 -OutUnits 'still_unmapped' -OutCount 1 `
                    -Flags @{ resolved_count = 3; near_miss_count = 1; threshold = 0.5; used_embeddings = 0 })
            )
            Merge-UnmappedResolutionStage
            @($script:ContextRotStages)
        })
        @($stages | ForEach-Object { $_['stage'] }) | Should -Be @('rag_filtering', 'extraction', 'unmapped_resolution')
        $m = $stages[2]
        $m['in_count'] | Should -Be 6 -Because '5 in the first pass, plus 1 added before the second (4 - 3)'
        $m['out_count'] | Should -Be 1
        $m['ratio'] | Should -Be 0.1667
        @($m['flags'].Keys) | Should -Be @('near_miss_count', 'resolved_count', 'threshold', 'used_embeddings')
        $m['flags']['resolved_count'] | Should -Be 5
        $m['flags']['near_miss_count'] | Should -Be 1
    }

    It 'leaves a single stage as it is' {
        $stages = @(& $script:Mod {
            $one = New-ContextRotStage -Stage 'unmapped_resolution' -InUnits 'concepts' -InCount 3 -OutUnits 'still_unmapped' -OutCount 3 -Flags @{ resolved_count = 0 }
            $script:ContextRotStages = @($one)
            Merge-UnmappedResolutionStage
            @($script:ContextRotStages)
        })
        $stages.Count | Should -Be 1
        $stages[0]['in_count'] | Should -Be 3
    }
}

Describe 't/4172 item 1: Invoke-POVSummary model_info records the real max_tokens and FIRE threshold' -Tag 'summarization' {

    It 'records -MaxTokens and the threshold FIRE reported' {
        $mi = & $script:Mod {
            Get-POVSummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -UsedFire $true -TaxonomyNodeCount 3 -MaxTokens 4096 `
                -FireStats @{ confidence_threshold = 0.55; total_api_calls = 1; total_iterations = 0; claims_total = 0; claims_confident = 0
                              claims_iterated = 0; elapsed_seconds = 1.0; termination_reason = 'no_claims' }
        }
        $mi['max_tokens'] | Should -Be 4096
        $mi['fire_confidence_threshold'] | Should -Be 0.55
    }

    It 'records null for a value it was not given, rather than a made-up number' {
        $mi = & $script:Mod {
            Get-POVSummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -UsedFire $true -TaxonomyNodeCount 3 `
                -FireStats @{ total_api_calls = 1; total_iterations = 0; claims_total = 0; claims_confident = 0
                              claims_iterated = 0; elapsed_seconds = 1.0; termination_reason = 'no_claims' }
        }
        $mi.Contains('max_tokens') | Should -BeTrue
        $mi['max_tokens'] | Should -BeNullOrEmpty
        $mi.Contains('fire_confidence_threshold') | Should -BeTrue
        $mi['fire_confidence_threshold'] | Should -BeNullOrEmpty
    }

    It 'Invoke-POVSummary passes the pipeline''s MaxTokens (the fire-full-taxonomy golden)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixtures' 'pov-summary' 'fire-full-taxonomy.json')) | ConvertFrom-Json
        $s = $g.tree.'summaries/doc-1.json' | ConvertFrom-Json
        $s.model_info.max_tokens | Should -Be 16384
        $s.model_info.fire_confidence_threshold | Should -Be 0.65
    }
}

Describe 't/4172 item 2: a key point without taxonomy_node_id is counted, not thrown on' -Tag 'summarization' {

    BeforeEach { script:Initialize-ResolutionState }

    It 'Invoke-SummaryPipeline counts it as unmapped, with a WARN naming the camp' {
        $json = '{ "pov_summaries": {
            "accelerationist": { "key_points": [ { "taxonomy_node_id": "acc-beliefs-001", "point": "Mapped.", "stance": "aligned" },
                                                 { "point": "No node-ID field.", "stance": "aligned" } ] },
            "safetyist": { "key_points": [ { "taxonomy_node_id": null, "point": "Null id.", "stance": "opposed" } ] },
            "skeptic": { "key_points": [] } }, "factual_claims": [], "unmapped_concepts": [] }'
        $r = script:Invoke-PipelineOn $json
        $r.Result.Success | Should -BeTrue
        $r.Result.TotalPoints | Should -Be 3
        $r.Result.NullNodes | Should -Be 2
        @($r.Warnings -match '^Invoke-SummaryPipeline \(guard-doc\): 1 key point\(s\) in pov_summaries\.accelerationist have no taxonomy_node_id field').Count | Should -Be 1
        @($r.Warnings -match 'pov_summaries\.safetyist').Count | Should -Be 0 -Because 'a null node ID is not a missing field'
    }

    It 'Get-SummaryKeyPointNodeCount reads a dictionary summary and counts a null key point as unmapped' {
        $out = @(& $script:Mod {
                $s = [ordered]@{ pov_summaries = [ordered]@{
                        skeptic = [ordered]@{ key_points = @([ordered]@{ taxonomy_node_id = 'skp-beliefs-001' }, $null) } } }
                Get-SummaryKeyPointNodeCount -SummaryObject $s -Context 'ctx' 3>&1
            })
        $counts = @($out | Where-Object { $_ -is [hashtable] })[0]
        $counts.TotalPoints | Should -Be 2
        $counts.NullNodes | Should -Be 1
        @($out | Where-Object { $_ -is [System.Management.Automation.WarningRecord] -and $_.Message -match '^ctx: 1 key point' }).Count | Should -Be 1
    }

    It 'Invoke-ChunkedSummary keeps the chunk (no failure line) and WARNs with the chunk number' {
        $snap = Join-Path $TestDrive 'guard-chunked.md'
        [System.IO.File]::WriteAllText($snap, 'Some text.')
        $script:FinalizeCalled = $false
        Mock Split-DocumentChunks -ModuleName AITriad { @('chunk one text') }
        Mock Invoke-BatchEmbeddings -ModuleName AITriad { @{} }
        Mock Get-RelevantTaxonomyNodes -ModuleName AITriad { 'ctx' }
        Mock Add-StageTiming -ModuleName AITriad { }
        Mock Invoke-AIApi -ModuleName AITriad { [pscustomobject]@{ Text = '{}'; Backend = 'mock'; Truncated = $false } }
        Mock Parse-AIResponse -ModuleName AITriad {
            '{ "pov_summaries": { "accelerationist": { "key_points": [ { "point": "No node-ID field." }, { "taxonomy_node_id": "acc-beliefs-001", "point": "Mapped." } ] },
               "safetyist": { "key_points": [] }, "skeptic": { "key_points": [] } }, "factual_claims": [], "unmapped_concepts": [] }' | ConvertFrom-Json
        }
        Mock Merge-ChunkSummaries -ModuleName AITriad { [ordered]@{ pov_summaries = [ordered]@{}; factual_claims = @(); unmapped_concepts = @() } }
        Mock Test-SummaryDensity -ModuleName AITriad { @{ Pass = $true; Shortfalls = @() } }
        Mock Finalize-Summary -ModuleName AITriad { $script:FinalizeCalled = $true; @{ Success = $true } }

        $doc = @{ DocId = 'big-doc'; Meta = [pscustomobject]@{ title = 'T' }; PovTags = @('safetyist'); SnapshotFile = $snap; MetaFile = 'unused' }
        $records = @(& $script:Mod {
                param($D, $Model)
                $script:ContextRotStages = @()
                Invoke-ChunkedSummary -Doc $D -ApiKey 'k' -Model $Model -Temperature 0.2 -TaxonomyVersion 'v' `
                    -TaxonomyJson 'x' -SystemPromptTemplate 's' -ChunkSystemPromptTemplate 'c' -OutputSchema '{}' `
                    -SummariesDir $TestDrive -Now 'now' 3>&1 6>&1
                $script:ContextRotStages | Where-Object { $_['stage'] -eq 'extraction' }
            } $doc $script:ModelId)
        $script:FinalizeCalled | Should -BeTrue
        $host6 = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { [string]$_.MessageData })
        @($host6 -match '✗').Count | Should -Be 0 -Because 'the chunk must not be reported as failed'
        @($host6 -match 'failed').Count | Should -Be 0
        @($records | Where-Object { $_ -is [System.Management.Automation.WarningRecord] -and $_.Message -match 'big-doc chunk 1\): 1 key point\(s\) in pov_summaries\.accelerationist' }).Count | Should -Be 1
        $extraction = @($records | Where-Object { $_ -is [System.Collections.IDictionary] -and $_['stage'] -eq 'extraction' })[0]
        $extraction['flags']['total_points'] | Should -Be 2
        $extraction['flags']['null_node_rate'] | Should -Be 0.5
    }
}

Describe 't/4172 item 3: FIRE''s parse-failure FireStats has the full stats shape' -Tag 'summarization' {

    BeforeAll {
        function script:Invoke-FireOn([string]$Text) {
            $script:FireText = $Text
            Mock Invoke-AIApi -ModuleName AITriad { [pscustomobject]@{ Text = $script:FireText; Backend = 'mock'; Truncated = $false } }
            Mock Repair-TruncatedJson -ModuleName AITriad { $null }
            & $script:Mod { param($Model) Invoke-IterativeExtraction -Prompt 'p' -Model $Model -ApiKey 'k' -ConfidenceThreshold 0.6 } $script:ModelId
        }
    }

    It 'carries every model_info field, with zero claims and termination_reason parse_failed' {
        $r = script:Invoke-FireOn 'not json {oops'
        $r.Summary | Should -BeNullOrEmpty
        $fs = $r.FireStats
        $fs.parse_failed | Should -BeTrue
        $fs.phase1_only | Should -BeTrue
        $fs.confidence_threshold | Should -Be 0.6
        foreach ($k in 'claims_total', 'claims_confident', 'claims_iterated', 'claims_drifted') { $fs[$k] | Should -Be 0 -Because $k }
        $fs.termination_reason | Should -Be 'parse_failed'
        $fs.total_api_calls | Should -Be 1
    }

    It 'New-SummaryModelInfo and Get-POVSummaryModelInfo read it without throwing' {
        $r = script:Invoke-FireOn 'not json {oops'
        $mi = & $script:Mod { param($Fs) New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson '' -ChunkCount 0 -FireStats $Fs -MaxTokens 32768 } $r.FireStats
        $mi['fire_stats']['claims_total'] | Should -Be 0
        $mi['fire_stats']['termination_reason'] | Should -Be 'parse_failed'
        $mi['fire_confidence_threshold'] | Should -Be 0.6
        $pmi = & $script:Mod { param($Fs) Get-POVSummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -UsedFire $true -FireStats $Fs -TaxonomyNodeCount 0 } $r.FireStats
        $pmi['fire_stats']['claims_iterated'] | Should -Be 0
    }

    It 'shares one key set with the no-claims path (plus its two parse-failure markers)' {
        $failed = (script:Invoke-FireOn 'not json {oops').FireStats
        $noClaims = (script:Invoke-FireOn '{ "pov_summaries": {} }').FireStats
        $noClaims.termination_reason | Should -Be 'no_claims'
        @($failed.Keys | Where-Object { $_ -notin 'parse_failed', 'phase1_only' } | Sort-Object) | Should -Be @($noClaims.Keys | Sort-Object)
        @($noClaims.Keys | Sort-Object) | Should -Be @('claims_confident', 'claims_drifted', 'claims_dropped_verification', 'claims_iterated', 'claims_total', 'confidence_threshold',
            'elapsed_seconds', 'guardrails', 'mode', 'termination_reason', 'total_api_calls', 'total_iterations')
    }
}
