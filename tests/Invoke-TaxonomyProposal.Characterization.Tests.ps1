# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-TaxonomyProposal (t/3910), written BEFORE its complexity
    refactor and required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Invoke-TaxonomyProposal end to end against a fixture tree in $TestDrive and
    compares a full transcript to a golden in tests/fixtures/taxonomy-proposal/<scenario>.json:
      - every host line (text and colour), warning and verbose message;
      - the thrown error's message, if any, and the returned output;
      - every Resolve-AIApiKey, Get-TaxonomyHealthData, Get-Prompt and Invoke-AIApi call (the prompt
        in full);
      - every data write, in order (via the Assert-DataWriteAllowed guard that Write-Utf8NoBom calls);
      - the file tree afterwards: every written file's exact bytes, and a SHA-256 for each input file.
    Invoke-AIApi and Get-TaxonomyHealthData are mocked, so nothing reaches a live backend and no real
    corpus is read. Repair-TruncatedJson runs for real. Get-Date is frozen. $script:TaxonomyData is
    swapped for a fixture for the duration of each scenario. Every scenario passes Model explicitly.
    Normalizations, each forced by the code under test rather than chosen:
      - JSON payload lines (in the prompt and in host output) are re-serialized with sorted keys,
        because the function builds them from plain hashtables whose key order is randomized per
        process (Sage #220);
      - a host line that starts a JSON value but is truncated (the -DryRun 400-char previews) cannot be
        parsed, so it is pinned by its length only, which does not depend on key order.
    "Prompt assembled: N chars" is deliberately NOT masked. The prompt is a here-string whose newlines
    come from the source file, and .gitattributes checks *.ps1 out as eol=crlf on every platform, so N is
    the same on Windows and Linux. An edit that rewrites the cmdlet's line endings (e.g. `sed -i` under
    MSYS) changes N and fails every scenario that assembles a prompt. That is the file changing, not the
    goldens being flaky.
    Regenerate the goldens ONLY for an intended behaviour change: set $env:TAXPROP_REGEN_GOLDEN = '1',
    run once, and check `git diff --stat` lists exactly the goldens that change was meant to change.
#>

# ── Fixture builders (data only; consumed in BeforeAll) ───────────────────────
$script:FullResponse = @'
```json
{
  "proposals": [
    { "action": "NEW", "suggested_id": "acc-beliefs-900", "label": "Compute Abundance Thesis", "pov": "accelerationist", "category": "Beliefs", "target_node_id": null, "rationale": "Many docs cite falling compute cost." },
    { "action": "new", "suggested_id": "saf-desires-901", "label": "Brand New Safety Desire", "pov": "safetyist", "category": "Desires", "target_node_id": null, "rationale": "Lower-case action is accepted." },
    { "action": "NEW", "suggested_id": "saf-beliefs-777", "label": "Duplicate By Id", "pov": "safetyist", "category": "Beliefs", "target_node_id": null, "rationale": "Same suggested_id as an existing proposal." },
    { "action": "NEW", "suggested_id": "skp-beliefs-950", "label": "Regulatory Capture Risk Grows", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "Label words overlap an existing proposal." },
    { "action": "SPLIT", "suggested_id": null, "label": "Split Alignment", "pov": "safetyist", "category": "Beliefs", "target_node_id": "saf-b-1", "rationale": "Too broad.",
      "children": [ { "suggested_id": "saf-b-1a", "label": "Inner Alignment" }, { "suggested_id": "saf-b-1b", "label": "Outer Alignment" } ] },
    { "action": "SPLIT", "suggested_id": null, "label": "Split Again", "pov": "safetyist", "category": "Beliefs", "target_node_id": "saf-b-2", "rationale": "Existing split targets this node.",
      "children": [ { "suggested_id": "x1", "label": "X1" }, { "suggested_id": "x2", "label": "X2" } ] },
    { "action": "MERGE", "suggested_id": null, "label": "Merge Growth", "pov": "accelerationist", "category": "Desires", "target_node_id": null, "rationale": "Overlapping desires.",
      "merge_node_ids": [ "acc-d-1", "acc-d-2" ], "surviving_node_id": "acc-d-1" },
    { "action": "MERGE", "suggested_id": null, "label": "Merge Overlapping", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "Half the ids overlap an existing merge.",
      "merge_node_ids": [ "skp-b-1", "skp-b-2", "skp-b-9" ], "surviving_node_id": "skp-b-1" },
    { "action": "RELABEL", "suggested_id": null, "label": "Clearer Label", "pov": "skeptic", "category": "Intentions", "target_node_id": "skp-i-1", "rationale": "Ambiguous wording." },
    { "action": "RELABEL", "suggested_id": null, "label": "Relabel Dup", "pov": "skeptic", "category": "Intentions", "target_node_id": "skp-i-2", "rationale": "Existing relabel targets this node." },
    { "action": "REORDER", "suggested_id": null, "label": "Move Under Parent", "pov": "accelerationist", "category": "Beliefs", "target_node_id": "acc-b-2", "new_parent_id": "acc-b-1", "rationale": "Belongs under acc-b-1." },
    { "action": "DEPTH_EXPAND", "suggested_id": null, "label": "Deepen", "pov": "situations", "category": null, "target_node_id": "sit-1", "rationale": "Needs sub-situations.",
      "children": [ { "suggested_id": "sit-1a", "label": "A" }, { "suggested_id": "sit-1b", "label": "B" } ] },
    { "action": "WIDTH_EXPAND", "suggested_id": "sit-9", "label": "Sibling Situation", "pov": "situations", "category": null, "target_node_id": null, "rationale": "Coverage gap." },
    { "action": "RENAME", "suggested_id": null, "label": "Bad Action", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "Unknown action type." },
    { "action": "NEW", "suggested_id": null, "label": "No Id New", "pov": "martian", "category": "Feelings", "target_node_id": null, "rationale": "" },
    { "action": "SPLIT", "suggested_id": null, "label": "Thin Split", "pov": "skeptic", "category": "Beliefs", "target_node_id": "", "rationale": "One child.", "children": [ { "suggested_id": "c1", "label": "C1" } ] },
    { "action": "MERGE", "suggested_id": null, "label": "One Id Merge", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "Only one id.", "merge_node_ids": [ "skp-b-1" ], "surviving_node_id": "" },
    { "action": "REORDER", "suggested_id": null, "label": "No Parent", "pov": "skeptic", "category": "Beliefs", "target_node_id": "skp-b-1", "new_parent_id": " ", "rationale": "Missing parent." },
    { "action": "DEPTH_EXPAND", "suggested_id": null, "label": "Shallow", "pov": "skeptic", "category": "Beliefs", "target_node_id": "", "rationale": "No children." },
    { "action": "WIDTH_EXPAND", "suggested_id": "", "label": "", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "Missing id and label." },
    { "action": "RELABEL", "suggested_id": null, "label": "Label That Is Comfortably Longer Than Forty Characters", "pov": "skeptic", "category": "Beliefs", "target_node_id": null, "rationale": "No target." }
  ]
}
```
'@

$script:ExistingProposals = @'
{
  "generated_at": "2025-12-01T00:00:00Z",
  "proposals": [
    { "action": "NEW", "suggested_id": "saf-beliefs-777", "label": "Something Else Entirely", "pov": "safetyist", "category": "Beliefs" },
    { "action": "NEW", "suggested_id": "skp-beliefs-001", "label": "Regulatory Capture Risk Grows Fast", "pov": "skeptic", "category": "Beliefs" },
    { "action": "SPLIT", "target_node_id": "saf-b-2", "label": "Older split" },
    { "action": "MERGE", "merge_node_ids": [ "skp-b-1", "skp-b-2" ], "surviving_node_id": "skp-b-1", "label": "Older merge" },
    { "action": "RELABEL", "target_node_id": "skp-i-2", "label": "Older relabel" },
    { "action": "REORDER", "target_node_id": "acc-b-2", "label": "Older reorder" },
    { "label": "No action key at all" }
  ]
}
'@

$script:Scenarios = @(
    # Fixture text travels in the scenario data: a script variable set here (discovery) is $null in BeforeAll (run).
    @{ Name = 'rich'; Health = 'rich'; PassHealth = $true; Dictionary = 'rich'; HarvestQueue = 'mixed'; Existing = 'rich'; ExistingText = $script:ExistingProposals
       Params = @{ Model = 'gemini-2.5-flash'; IncludeHarvestQueue = $true }; Response = $script:FullResponse }
    @{ Name = 'fresh-health-fallback-unmapped'; Health = 'sparse'
       Params = @{ Model = 'claude-haiku-4-5'; ApiKey = 'explicit-key'; Temperature = 0.9 }
       Response = '{"proposals":[{"action":"NEW","suggested_id":"acc-intentions-901","label":"Open Weights","pov":"accelerationist","category":"Intentions","target_node_id":null,"rationale":"r"}]}' }
    @{ Name = 'dryrun'; Health = 'rich'; PassHealth = $true; Dictionary = 'rich'; HarvestQueue = 'none-queued'; LongSystemPrompt = $true
       Params = @{ Model = 'gemini-2.5-flash'; DryRun = $true; IncludeHarvestQueue = $true } }
    @{ Name = 'whatif'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash'; WhatIf = $true }
       Response = '{"proposals":[{"action":"NEW","suggested_id":"acc-beliefs-902","label":"WhatIf New","pov":"accelerationist","category":"Beliefs","target_node_id":null,"rationale":"r"}]}' }
    @{ Name = 'explicit-output-file'; Health = 'rich'; PassHealth = $true; Dictionary = 'std-only'; OutputFile = 'out/custom/my-proposal.json'; Existing = 'empty-dir'
       Params = @{ Model = 'groq-openai-gpt-oss-20b' }
       Response = '{"proposals":[]}' }
    @{ Name = 'err-no-key-claude'; Health = 'rich'; PassHealth = $true; NoKey = $true; Params = @{ Model = 'claude-haiku-4-5' } }
    @{ Name = 'err-no-key-groq'; Health = 'rich'; PassHealth = $true; NoKey = $true; Params = @{ Model = 'groq-openai-gpt-oss-20b' } }
    @{ Name = 'err-no-key-unknown-prefix'; Health = 'rich'; PassHealth = $true; NoKey = $true; Params = @{ Model = 'xai-grok-4-6' } }
    @{ Name = 'err-repo-root-missing'; Health = 'rich'; PassHealth = $true; MissingRepoRoot = $true; Params = @{ Model = 'gemini-2.5-flash' } }
    @{ Name = 'parse-repair'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash' }
       Response = '{"proposals":[{"action":"RELABEL","suggested_id":null,"label":"Repaired","pov":"skeptic","category":"Beliefs","target_node_id":"skp-b-1","rationale":"cut off"}' }
    @{ Name = 'parse-fail-debug-file'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash' }; Response = 'this is not json at all' }
    @{ Name = 'api-returns-null'; Health = 'rich'; PassHealth = $true; Params = @{ Model = 'gemini-2.5-flash' }; Response = 'NULL' }
    @{ Name = 'api-throws'; Health = 'rich'; PassHealth = $true; Params = @{ Model = 'gemini-2.5-flash' }; Response = 'THROW:503 Service Unavailable' }
    @{ Name = 'missing-proposals-array'; Health = 'rich'; PassHealth = $true; Params = @{ Model = 'gemini-2.5-flash' }; Response = '{"notes":"nothing to propose"}' }
    @{ Name = 'write-fails'; Health = 'rich'; PassHealth = $true; FailWrite = $true
       Params = @{ Model = 'gemini-2.5-flash' }; Response = '{"proposals":[]}' }
    # Formerly pinned defects, fixed in t/4076 (the names are kept so the goldens' history stays readable).
    @{ Name = 'bug-proposal-missing-pov'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash' }
       Response = '{"proposals":[{"action":"NEW","suggested_id":"x-1","label":"No pov key","category":"Beliefs","rationale":"r"}]}' }
    @{ Name = 'bug-display-merge-without-suggested-id'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash' }
       Response = '{"proposals":[{"action":"MERGE","label":"Merge","pov":"skeptic","category":"Beliefs","rationale":"r","merge_node_ids":["skp-b-1","skp-b-2"],"surviving_node_id":"skp-b-1"}]}' }
    @{ Name = 'bug-dictionary-term-missing-field'; Health = 'rich'; PassHealth = $true; Dictionary = 'std-missing-field'
       Params = @{ Model = 'gemini-2.5-flash'; DryRun = $true } }
    # t/4076: crash paths no earlier golden reached.
    @{ Name = 'merge-without-label-with-existing'; Health = 'rich'; PassHealth = $true; Existing = 'rich'; ExistingText = $script:ExistingProposals
       Params = @{ Model = 'gemini-2.5-flash' }
       Response = '{"proposals":[{"action":"MERGE","pov":"accelerationist","rationale":"r","merge_node_ids":["acc-d-1","acc-d-9"],"surviving_node_id":"acc-d-1"}]}' }
    @{ Name = 'proposal-missing-action'; Health = 'rich'; PassHealth = $true
       Params = @{ Model = 'gemini-2.5-flash' }
       Response = '{"proposals":[{"label":"No action key","pov":"skeptic","category":"Beliefs","rationale":"r"},{"action":"NEW","suggested_id":"skp-beliefs-903","label":"Kept","pov":"skeptic","category":"Beliefs","rationale":"r"}]}' }
    # Not named proposals-*: .gitignore ignores proposals-*.json, which would drop the golden.
    @{ Name = 'null-proposals-key'; Health = 'rich'; PassHealth = $true; Params = @{ Model = 'gemini-2.5-flash' }; Response = '{"proposals":null}' }
    @{ Name = 'colloquial-term-missing-status'; Health = 'rich'; PassHealth = $true; Dictionary = 'col-missing-status'
       Params = @{ Model = 'gemini-2.5-flash'; DryRun = $true } }
)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    . (Join-Path $PSScriptRoot 'HostCapture.ps1')
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'taxonomy-proposal'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    $script:OriginalTaxonomyData = InModuleScope AITriad { $script:TaxonomyData }

    function script:Write-FixtureFile([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $script:Utf8)
    }
    function script:ConvertTo-FixtureJson($Obj) { ($Obj | ConvertTo-Json -Depth 10) -replace "`r`n", "`n" }
    function script:Get-Sha([string]$Text) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        ([System.Security.Cryptography.SHA256]::HashData($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    }

    # The module's in-memory taxonomy: one entry per POV, each with a nodes list (as loaded from JSON).
    function script:Get-TaxonomyFixture {
        $node = { param($id, $desc) if ($null -eq $desc) { [ordered]@{ id = $id; label = "Label $id" } } else { [ordered]@{ id = $id; label = "Label $id"; description = $desc } } }
        $tax = [ordered]@{
            accelerationist = [ordered]@{ nodes = @((& $node 'acc-b-1' 'Compute keeps getting cheaper.'), (& $node 'acc-b-2' $null), (& $node 'acc-d-1' 'Growth.')) }
            safetyist       = [ordered]@{ nodes = @((& $node 'saf-b-1' 'Alignment is hard.'), (& $node 'saf-b-2' 'Oversight.')) }
            situations      = [ordered]@{ nodes = @((& $node 'sit-1' 'A frontier lab release.')) }
        }
        # Round-trip through JSON so nodes are PSCustomObjects, as the module loads them. skeptic is absent.
        $out = @{}
        foreach ($k in $tax.Keys) { $out[$k] = (script:ConvertTo-FixtureJson $tax[$k]) | ConvertFrom-Json }
        $out
    }

    function script:New-Unmapped([string]$Concept, [int]$Freq, [string]$Key, [int]$Docs) {
        [pscustomobject]@{
            Concept = $Concept; Frequency = $Freq; SuggestedPov = 'safetyist'; SuggestedCategory = 'Beliefs'
            ContributingDocs = @(1..$Docs | ForEach-Object { "doc-$_" }); NormalizedKey = $Key
        }
    }

    function script:Get-HealthFixture([string]$Kind) {
        switch ($Kind) {
            'rich' {
                $nearest = @{
                    'compute overhang' = @(
                        [pscustomobject]@{ NodeId = 'acc-b-1'; Similarity = 0.81 }
                        [pscustomobject]@{ NodeId = 'acc-unknown'; Similarity = 0.55 }
                    )
                }
                @{
                    TaxonomyVersion  = '9.9.9'
                    SummaryCount     = 42
                    NearestNodeMap   = $nearest
                    UnmappedConcepts = @(
                        (script:New-Unmapped 'Compute overhang' 3 'compute overhang' 2)
                        (script:New-Unmapped 'Model welfare' 2 'model welfare' 1)
                        (script:New-Unmapped 'One-off idea' 1 'one-off idea' 1)
                    )
                    OrphanNodes      = @(1..52 | ForEach-Object { [pscustomobject]@{ Id = "orph-$_"; Label = "Orphan $_" } })
                    MostCited        = @(1..12 | ForEach-Object { [pscustomobject]@{ Id = "cited-$_"; Label = "Cited $_"; Citations = 100 - $_ } })
                    HighVarianceNodes = @([pscustomobject]@{ Id = 'saf-b-1'; Label = 'Alignment is hard'; TotalStances = 9 })
                    CoverageBalance  = [ordered]@{ accelerationist = [ordered]@{ Beliefs = 2; Desires = 1 }; safetyist = [ordered]@{ Beliefs = 2 } }
                }
            }
            'sparse' {
                @{
                    TaxonomyVersion  = '1.0.0'
                    SummaryCount     = 7
                    NearestNodeMap   = $null
                    UnmappedConcepts = @(1..32 | ForEach-Object { script:New-Unmapped "Rare $_" 1 "rare $_" 1 })
                    OrphanNodes      = @()
                    MostCited        = @()
                    HighVarianceNodes = @()
                    CoverageBalance  = [ordered]@{}
                }
            }
        }
    }

    # Builds the fixture tree for a scenario and returns its root.
    function script:New-TaxPropFixture($S) {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $dict = Join-Path $root 'dictionary'
        switch ($S['Dictionary']) {
            { $_ -in 'rich', 'std-only' } {
                script:Write-FixtureFile (Join-Path $dict 'standardized' 'b-term.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            canonical_form = 'b_term'; display_form = 'B term'; definition = 'Second.'; primary_camp_origin = 'skeptic' }))
                script:Write-FixtureFile (Join-Path $dict 'standardized' 'a-term.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            canonical_form = 'a_term'; display_form = 'A term'; definition = 'First.'; primary_camp_origin = 'safetyist'
                            used_by_nodes = @('saf-b-1'); do_not_confuse_with = @([ordered]@{ term = 'b_term'; note = 'different camp' }) }))
            }
            'rich' {
                script:Write-FixtureFile (Join-Path $dict 'colloquial' 'alignment.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            colloquial_term = 'alignment'; status = 'ambiguous'
                            resolves_to = @([ordered]@{ standardized_term = 'a_term'; default_for_camp = 'safetyist' }) }))
                script:Write-FixtureFile (Join-Path $dict 'colloquial' 'safety.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            colloquial_term = 'safety'; status = 'retired' }))
            }
            'std-missing-field' {
                script:Write-FixtureFile (Join-Path $dict 'standardized' 'thin.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            canonical_form = 'thin'; definition = 'No display_form or primary_camp_origin.' }))
            }
            'col-missing-status' {
                script:Write-FixtureFile (Join-Path $dict 'colloquial' 'risk.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            colloquial_term = 'risk' }))
                script:Write-FixtureFile (Join-Path $dict 'colloquial' 'safety.json') (script:ConvertTo-FixtureJson ([ordered]@{
                            colloquial_term = 'safety'; status = 'retired' }))
            }
        }
        switch ($S['HarvestQueue']) {
            'mixed' {
                script:Write-FixtureFile (Join-Path $root 'harvest-queue.json') (script:ConvertTo-FixtureJson ([ordered]@{ items = @(
                                [ordered]@{ label = 'Queued One'; suggested_pov = 'skeptic'; suggested_category = 'Beliefs'; description = 'From debate 1.'; status = 'queued' }
                                [ordered]@{ label = 'Already Done'; suggested_pov = 'safetyist'; suggested_category = 'Desires'; description = 'Skip me.'; status = 'harvested' }
                                [ordered]@{ label = 'Queued Two'; suggested_pov = 'accelerationist'; suggested_category = 'Intentions'; description = 'From debate 2.'; status = 'queued' }
                            ) }))
            }
            'none-queued' {
                script:Write-FixtureFile (Join-Path $root 'harvest-queue.json') (script:ConvertTo-FixtureJson ([ordered]@{ items = @(
                                [ordered]@{ label = 'Done'; suggested_pov = 'skeptic'; suggested_category = 'Beliefs'; description = 'd'; status = 'harvested' }) }))
            }
        }
        $proposals = Join-Path $root 'taxonomy' 'proposals'
        switch ($S['Existing']) {
            'rich' {
                if ([string]::IsNullOrEmpty($S['ExistingText'])) { throw 'rich Existing fixture needs ExistingText' }
                script:Write-FixtureFile (Join-Path $proposals 'proposal-20251201-000000.json') $S.ExistingText
                script:Write-FixtureFile (Join-Path $proposals 'proposal-20251202-000000.json') '{ "proposals": [ '
                script:Write-FixtureFile (Join-Path $proposals 'notes.json') '{ "proposals": [ { "action": "NEW", "suggested_id": "acc-beliefs-900" } ] }'
            }
            'empty-dir' { New-Item -ItemType Directory -Path $proposals -Force | Out-Null }
        }
        $root
    }

    # Sorts dictionary keys recursively so JSON built from plain hashtables serializes the same in every process.
    function script:ConvertTo-SortedKeys($Obj) {
        if ($null -eq $Obj) { return $null }
        if ($Obj -is [System.Collections.IDictionary]) {
            $o = [ordered]@{}; foreach ($k in @($Obj.Keys | Sort-Object -CaseSensitive)) { $o[[string]$k] = script:ConvertTo-SortedKeys $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IList]) { return , @(foreach ($i in $Obj) { script:ConvertTo-SortedKeys $i }) }
        return $Obj
    }

    # A line that is a whole JSON value is re-serialized with sorted keys; a line that only starts like
    # one (a truncated preview) is pinned by its length.
    function script:Format-JsonLine([string]$Line) {
        $t = $Line.Trim()
        # Only a real JSON opening ([{  ["  []  {"  {}) — not a display line such as "[NEW] (2)".
        if ($t -notmatch '^(\[\s*[\[{"\]]|\{\s*["}])') { return $Line }
        try {
            $parsed = ConvertFrom-Json -InputObject $t -AsHashtable -NoEnumerate -Depth 50
            return 'JSON:' + (ConvertTo-Json -InputObject (script:ConvertTo-SortedKeys $parsed) -Depth 50 -Compress)
        } catch {
            return "<truncated JSON preview: $($t.Length) chars>"
        }
    }

    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s -replace "`r`n", "`n"
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r
    }

    # Masked text whose JSON payload lines are canonicalized: used for prompts and host message text only.
    function script:Format-Payload([string]$s) {
        if ($null -eq $s) { return $null }
        (@((script:Format-Masked $s) -split "`n" | ForEach-Object { script:Format-JsonLine $_ })) -join "`n"
    }

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

    # Written files in full (under taxonomy/proposals and out/); input files as a hash.
    function script:Get-Tree([string]$Root) {
        $tree = [ordered]@{}
        if (-not (Test-Path -LiteralPath $Root)) { return $tree }
        $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
                [pscustomobject]@{ Rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/'); Item = $_ } })
        foreach ($e in @($items | Sort-Object { $_.Rel } -CaseSensitive)) {
            if ($e.Item.PSIsContainer) { $tree[$e.Rel + '/'] = '(dir)'; continue }
            $text = [System.IO.File]::ReadAllText($e.Item.FullName)
            $isOutput = $script:InitialFiles -notcontains $e.Rel
            $tree[$e.Rel] = if ($isOutput) { $text -replace "`r`n", "`n" } else { "sha256:$(script:Get-Sha $text) ($($text.Length) chars)" }
        }
        $tree
    }

    function script:Invoke-Scenario($S) {
        $script:Calls = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[object]]::new()
        $script:S = $S
        $root = script:New-TaxPropFixture $S
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:RootFixture = $root
        $script:InitialFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
                $_.FullName.Substring($script:RootCurrent.Length + 1).Replace('\', '/') })
        $script:HealthFixture = script:Get-HealthFixture $S['Health']

        $tax = script:Get-TaxonomyFixture
        InModuleScope AITriad -Parameters @{ T = $tax } { param($T) $script:TaxonomyData = $T }

        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
        Mock Get-DataRoot -ModuleName AITriad { $script:RootFixture }
        Mock Get-TaxonomyHealthData -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'healthData'; repoRoot = $RepoRoot })
            $script:HealthFixture
        }
        Mock Resolve-AIApiKey -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'resolveKey'; explicitKey = $ExplicitKey; backend = $Backend })
            if ($script:S['NoKey']) { '' } else { "resolved-$Backend-key" }
        }
        Mock Get-Prompt -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'prompt'; name = $Name; replacements = $Replacements })
            $text = "<<$Name v=$($Replacements.TAXONOMY_VERSION) n=$($Replacements.SUMMARY_COUNT)>>"
            if ($script:S['LongSystemPrompt']) { $text += ' ' + ('system-prompt-filler ' * 50) }
            $text
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            $script:Writes.Add($rel)
            if ($script:S['FailWrite']) { throw "Write refused for $rel" }
        }
        Mock Invoke-AIApi -ModuleName AITriad {
            $script:Calls.Add([ordered]@{
                    call = 'ai'; model = $Model; apiKey = $ApiKey; temperature = $Temperature
                    maxTokens = $MaxTokens; jsonMode = [bool]$JsonMode; timeoutSec = $TimeoutSec
                    prompt = script:Format-Payload $Prompt
                })
            $text = if ($script:S['Response']) { $script:S.Response } else { '{"proposals":[]}' }
            if ($text -eq 'NULL') { return $null }
            if ($text -like 'THROW:*') { throw $text.Substring(6) }
            [pscustomobject]@{ Text = $text; Backend = 'mock-backend' }
        }

        $p = @{ RepoRoot = $root } + $(if ($S['Params']) { $S.Params } else { @{} })
        if ($S['MissingRepoRoot']) { $p.RepoRoot = Join-Path $root 'does-not-exist' }
        if ($S['PassHealth']) { $p.HealthData = $script:HealthFixture }
        if ($S['OutputFile']) { $p.OutputFile = Join-Path $root $S.OutputFile }

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        Register-HostCaptureMock
        try {
            Invoke-TaxonomyProposal @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
        } catch {
            $err = $_.Exception.Message
        } finally {
            InModuleScope AITriad -Parameters @{ T = $script:OriginalTaxonomyData } { param($T) $script:TaxonomyData = $T }
        }
        $hostLines = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object {
                $m = $_.MessageData
                $h = Get-HostCaptureParts $m
                $text = script:Format-Payload ([string]$(if ($h) { $h.Message } else { $m }))
                if ($h) { "[$($h.Color)] $text" } else { "[info] $text" }
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

AfterAll {
    InModuleScope AITriad -Parameters @{ T = $script:OriginalTaxonomyData } { param($T) $script:TaxonomyData = $T }
}

Describe 'Invoke-TaxonomyProposal characterization (t/3910)' -Tag 'taxonomy' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:TAXPROP_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: pin the discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name>' -ForEach @(
        @{ Name = 'rich';                           Text = 'Duplicate proposal skipped: [NEW] Duplicate By Id' }
        @{ Name = 'rich';                           Text = 'Duplicate proposal skipped: [NEW] Regulatory Capture Risk Grows' }
        @{ Name = 'rich';                           Text = 'Duplicate proposal skipped: [SPLIT] Split Again' }
        @{ Name = 'rich';                           Text = 'Duplicate proposal skipped: [MERGE] Merge Overlapping' }
        @{ Name = 'rich';                           Text = 'Duplicate proposal skipped: [RELABEL] Relabel Dup' }
        @{ Name = 'rich';                           Text = '8 proposal(s) rejected by schema validation' }
        @{ Name = 'rich';                           Text = 'Included 2 harvest queue items' }
        @{ Name = 'rich';                           Text = 'Orphan nodes        : 50' }
        @{ Name = 'fresh-health-fallback-unmapped'; Text = 'Computed fresh health data (7 summaries)' }
        @{ Name = 'fresh-health-fallback-unmapped'; Text = 'Unmapped for prompt : 30' }
        @{ Name = 'fresh-health-fallback-unmapped'; Text = 'Dictionary not found at' }
        @{ Name = 'dryrun';                         Text = 'DRY RUN complete. No API call made. No files written.' }
        @{ Name = 'dryrun';                         Text = '... (truncated for display)' }
        @{ Name = 'err-no-key-claude';              Text = 'Set ANTHROPIC_API_KEY, or pass -ApiKey.' }   # no AI_API_KEY: gemini-only fallback (t/4102)
        @{ Name = 'err-no-key-groq';                Text = 'Set GROQ_API_KEY, or pass -ApiKey.' }
        @{ Name = 'err-no-key-unknown-prefix';      Text = 'Set XAI_API_KEY, or pass -ApiKey.' }   # registry backend, not a gemini guess (t/4087)
        @{ Name = 'err-repo-root-missing';          Text = 'Repo root not found' }
        @{ Name = 'parse-repair';                   Text = 'JSON repaired successfully' }
        @{ Name = 'api-returns-null';               Text = 'AI API call returned null' }
        @{ Name = 'write-fails';                    Text = 'Proposal data was generated but NOT saved' }
        # t/4076: each formerly-crashing path now completes, rejects or warns.
        @{ Name = 'bug-proposal-missing-pov';       Text = "rejected: invalid or missing pov ''" }
        @{ Name = 'bug-display-merge-without-suggested-id'; Text = 'Merging: skp-b-1, skp-b-2' }
        @{ Name = 'bug-dictionary-term-missing-field';      Text = "Dictionary term 'thin' skipped: missing display_form, primary_camp_origin" }
        @{ Name = 'colloquial-term-missing-status';         Text = "Dictionary term 'risk' skipped: missing status" }
        @{ Name = 'parse-fail-debug-file';          Text = 'AI returned invalid JSON for taxonomy proposal, and repair failed' }
        @{ Name = 'parse-fail-debug-file';          Text = 'Inspect the raw response saved at' }
        @{ Name = 'missing-proposals-array';        Text = "Response missing 'proposals' array" }
        @{ Name = 'null-proposals-key';             Text = "Response missing 'proposals' array" }
        @{ Name = 'proposal-missing-action';        Text = "rejected: invalid or missing action type ''" }
        @{ Name = 'merge-without-label-with-existing'; Text = '[MERGE] (1)' }
        @{ Name = 'rich';                           Text = '[REORDER] (1)' }
        @{ Name = 'rich';                           Text = '[DEPTH_EXPAND] (1)' }
        @{ Name = 'rich';                           Text = '[WIDTH_EXPAND] (1)' }
        @{ Name = 'rich';                           Text = 'New parent: acc-b-1' }
        @{ Name = 'whatif';                         Text = 'Proposal file not written (WhatIf): 1 proposal(s) would go to' }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json"))
        $g.Contains(($Text | ConvertTo-Json).Trim('"')) | Should -BeTrue -Because "golden $Name should show: $Text"
    }

    It 'writes the proposal file once, under taxonomy/proposals (rich)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json')) | ConvertFrom-Json
        @($g.writes) | Should -Be @('taxonomy/proposals/proposal-20260102-030405.json')
    }

    It 'writes the proposal file to -OutputFile (explicit-output-file)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'explicit-output-file.json')) | ConvertFrom-Json
        @($g.writes) | Should -Be @('out/custom/my-proposal.json')
    }

    # bug-proposal-missing-pov left this list in t/4076: its one proposal is now rejected and the run
    # writes an empty proposal file, as any all-rejected response does.
    It '<Name> writes nothing and leaves every input file byte-identical' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'dryrun', 'err-no-key-claude', 'err-repo-root-missing', 'api-throws', 'api-returns-null', 'whatif' }
    ) {
        $s = $_
        $pristine = script:New-TaxPropFixture $s
        $before = @(Get-ChildItem -LiteralPath $pristine -Recurse -Force | ForEach-Object {
                $rel = $_.FullName.Substring($pristine.Length + 1).Replace('\', '/')
                if ($_.PSIsContainer) { "$rel/" } else { "$rel $((Get-FileHash -LiteralPath $_.FullName).Hash)" } } | Sort-Object)
        $null = script:Invoke-Scenario $s
        $after = @(Get-ChildItem -LiteralPath $script:RootFixture -Recurse -Force | ForEach-Object {
                $rel = $_.FullName.Substring($script:RootFixture.Length + 1).Replace('\', '/')
                if ($_.PSIsContainer) { "$rel/" } else { "$rel $((Get-FileHash -LiteralPath $_.FullName).Hash)" } } | Sort-Object)
        @($script:Writes).Count | Should -Be 0
        $after | Should -Be $before
    }

    # Scenarios reach It bodies through -ForEach: $script:Scenarios is set at discovery and is $null at run time.
    # t/4076: -WhatIf now stops at ShouldProcess, before the write guard (it was consulted before).
    It '<Name> creates nothing on disk and never reaches the write guard' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'whatif' }
    ) {
        $null = script:Invoke-Scenario $_
        @(Get-ChildItem -LiteralPath $script:RootFixture -Recurse -Force).Count | Should -Be 0
        @($script:Writes).Count | Should -Be 0
    }

    It 'dictionary list fields stay JSON arrays in the prompt (t/4076 item 7)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'rich' }
    ) {
        $null = script:Invoke-Scenario $_
        $prompt = [string](@($script:Calls | Where-Object { $_.call -eq 'ai' })[0].prompt)
        $prompt | Should -Match '"used_by_nodes":\["saf-b-1"\]'
        $prompt | Should -Match '"used_by_nodes":\[\]'
        $prompt | Should -Match '"resolves_to":\["a_term \(safetyist\)"\]'
        $prompt | Should -Match '"resolves_to":\[\]'
        $prompt | Should -Not -Match '"used_by_nodes":(null|")'
    }

    It '-DryRun resolves no API key and calls no AI (<Name>)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'dryrun' }
    ) {
        $s = @{} + $_
        $s.NoKey = $true
        $null = script:Invoke-Scenario $s
        @($script:Calls | Where-Object { $_.call -in 'resolveKey', 'ai' }).Count | Should -Be 0
    }
}
