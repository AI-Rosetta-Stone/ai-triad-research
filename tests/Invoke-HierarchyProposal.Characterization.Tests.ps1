# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-HierarchyProposal (t/3910), written BEFORE its complexity
    refactor and required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Invoke-HierarchyProposal end to end against a fixture data tree in $TestDrive
    and compares a full transcript to a golden in tests/fixtures/hierarchy-proposal/<scenario>.json:
      - every host line (text and colour), warning and verbose message;
      - the thrown error's message, if any, and the returned object;
      - every Resolve-AIApiKey, Get-Prompt and Invoke-AIApi call (the prompt in full, or its length
        and SHA-256 when it is over 6000 characters);
      - every data write, in order (via the Assert-DataWriteAllowed guard that Write-Utf8NoBom calls);
      - the file tree afterwards: every written file's exact bytes, and a SHA-256 for each input file.
    Invoke-AIApi is mocked per bucket (keyed by the prompt's POV and Category lines), so nothing can
    reach a live backend. Get-EmbeddingClusters and Repair-TruncatedJson run for real. Get-Date is
    frozen. Every scenario passes Model explicitly, so the goldens do not depend on the basic-tier default.
    Normalizations, each forced by the code under test rather than chosen:
      - the "<pov>: N nodes" load lines are sorted, because they follow a plain hashtable's key order;
      - "intra_edges" blocks in prompts are sorted for the same reason;
      - "Response in N.Ns" (a Stopwatch reading) is masked;
      - the validation catch's "at <script>:<line>" is masked, since a refactor moves the code;
      - the -DryRun "total N chars" is masked, since it counts ConvertTo-Json's platform newline.
    t/4071 fixed the bugs these goldens first pinned: the review Markdown now degrades on an off-schema
    parent (md-parent-missing-promoted-from), -DryRun and the no-proposal paths create no directory
    and -DryRun needs no API key, a multi-line description is a full blockquote (rich), and cycle
    detection walks roots in sorted order (cycle-long).
    Regenerate the goldens ONLY for an intended behaviour change: set $env:HIERPROP_REGEN_GOLDEN = '1',
    run once, and check `git diff --stat` lists exactly the goldens that change was meant to change.
#>

# ── AI responses (by "<pov>/<category line>") ─────────────────────────────────
$script:RichAccBeliefs = @'
```json
{
  "pov": "accelerationist",
  "category": "Beliefs",
  "parents": [
    { "promoted_from": null, "label": "Scaling Optimism", "description": "Line one.\nLine two.",
      "children": [
        { "node_id": "acc-b-1", "relationship": "is_a", "rationale": "Pipes | and\nnewlines." },
        { "node_id": "acc-b-2" },
        null,
        { "relationship": "is_a", "rationale": "No node id." }
      ] },
    { "promoted_from": "acc-b-3", "label": null, "description": null,
      "children": [
        { "node_id": "acc-b-4", "relationship": "part_of", "rationale": "Under the promoted node." },
        { "node_id": "acc-b-3", "relationship": "is_a", "rationale": "Self loop." },
        { "node_id": "acc-b-1", "relationship": "is_a", "rationale": "Duplicate." }
      ] },
    { "promoted_from": "acc-unknown-9", "label": null, "description": "Promoted from an id no file has.", "children": null }
  ],
  "outliers": []
}
```
'@

# Truncated: Repair-TruncatedJson has to close it.
$script:RichSafBeliefs = '{"pov":"safetyist","category":"Beliefs","parents":[],"outliers":[{"node_id":"saf-b-1","reason":"Lone | idea\nsecond line"}'

$script:RichSituations = @'
{ "pov": "situations", "category": null,
  "parents": [ { "promoted_from": "sit-1", "label": null, "description": null,
    "children": [ { "node_id": "sit-2", "relationship": "part_of", "rationale": "r2" },
                  { "node_id": "sit-ghost", "relationship": "is_a", "rationale": "Unknown child id." } ] } ],
  "outliers": [ { "node_id": "sit-3", "reason": "Stands alone." } ] }
'@

$script:MissingPromotedFrom = @'
{ "pov": "accelerationist", "category": "Beliefs",
  "parents": [ { "label": "New parent", "description": "No promoted_from key.",
    "children": [ { "node_id": "acc-b-1", "relationship": "is_a", "rationale": "r1" },
                  { "node_id": "acc-b-2", "relationship": "is_a", "rationale": "r2" } ] } ],
  "outliers": [] }
'@

# A three-node cycle (cyc-a -> cyc-b -> cyc-c -> cyc-a). Which back edge gets reported depends on the
# DFS start root, so this only has one right answer when roots are walked in a fixed order (t/4071).
$script:LongCycle = @'
{ "pov": "accelerationist", "category": "Beliefs",
  "parents": [ { "promoted_from": "cyc-a", "label": null, "description": null, "children": [ { "node_id": "cyc-b", "relationship": "is_a", "rationale": "a-b" } ] },
               { "promoted_from": "cyc-b", "label": null, "description": null, "children": [ { "node_id": "cyc-c", "relationship": "is_a", "rationale": "b-c" } ] },
               { "promoted_from": "cyc-c", "label": null, "description": null, "children": [ { "node_id": "cyc-a", "relationship": "is_a", "rationale": "c-a" } ] } ],
  "outliers": [ { "node_id": "acc-b-1" } ] }
'@

$script:Scenarios = @(
    @{ Name = 'rich'; Tax = 'rich'; Embeddings = 'rich'; Edges = 'rich'
       Params = @{ Model = 'gemini-2.5-flash' }
       Responses = @{ 'accelerationist/Beliefs' = $script:RichAccBeliefs; 'safetyist/Beliefs' = $script:RichSafBeliefs
                      'situations/(none — situations)' = $script:RichSituations } }
    @{ Name = 'sizes'; Tax = 'sizes'; Embeddings = 'sizes'
       Params = @{ Model = 'groq-openai-gpt-oss-20b'; Temperature = 0.7; MinSimilarity = 0.5; ApiKey = 'explicit-key' } }
    @{ Name = 'dryrun'; Tax = 'small'; Embeddings = 'small'; Params = @{ Model = 'gemini-2.5-flash'; DryRun = $true } }
    @{ Name = 'whatif'; Tax = 'small'; Embeddings = 'small'; OutputDir = 'out/custom'
       Params = @{ Model = 'gemini-2.5-flash'; WhatIf = $true } }
    @{ Name = 'explicit-output-dir'; Tax = 'small'; Embeddings = 'small'; OutputDir = 'out/custom'; Params = @{ Model = 'gemini-2.5-flash' } }
    @{ Name = 'err-no-key-claude'; Tax = 'small'; NoKey = $true; Params = @{ Model = 'claude-haiku-4-5'; ApiKey = 'explicit-key' } }
    @{ Name = 'err-no-key-unknown-prefix'; Tax = 'small'; NoKey = $true; Params = @{ Model = 'xai-grok-4-6' } }
    @{ Name = 'no-buckets'; Tax = 'none'; Params = @{ Model = 'gemini-2.5-flash' } }
    @{ Name = 'bad-inputs-api-throws'; Tax = 'skeptic'; Embeddings = 'invalid'; Edges = 'invalid'
       Params = @{ Model = 'claude-haiku-4-5'; POV = 'skeptic'; Category = 'Desires' }
       Responses = @{ 'skeptic/Desires' = 'THROW:503 Service Unavailable' } }
    @{ Name = 'situations-with-category'; Tax = 'rich'; Params = @{ Model = 'gemini-2.5-flash'; POV = 'situations'; Category = 'Beliefs' } }
    @{ Name = 'parse-fail-and-validation-throw'; Tax = 'small'; Embeddings = 'small'
       Params = @{ Model = 'gemini-2.5-flash' }
       Responses = @{ 'accelerationist/Beliefs' = 'this is not json at all'
                      'safetyist/Beliefs' = '{"pov":"safetyist","category":"Beliefs","parents":[],"outliers":[{"reason":"no node id"}]}' } }
    @{ Name = 'md-parent-missing-promoted-from'; Tax = 'small'; Embeddings = 'small'
       Params = @{ Model = 'gemini-2.5-flash'; POV = 'accelerationist' }
       Responses = @{ 'accelerationist/Beliefs' = $script:MissingPromotedFrom } }
    @{ Name = 'cycle-long'; Tax = 'small'; Embeddings = 'small'
       Params = @{ Model = 'gemini-2.5-flash'; POV = 'accelerationist' }
       Responses = @{ 'accelerationist/Beliefs' = $script:LongCycle } }
)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    . (Join-Path $PSScriptRoot 'HostCapture.ps1')
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'hierarchy-proposal'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)

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

    function script:New-Node([string]$Id, [string]$Category, [hashtable]$Extra) {
        $n = [ordered]@{ id = $Id }
        if ($Category) { $n.category = $Category }
        $n.label = "Label $Id"
        $n.description = "Description of $Id."
        if ($Extra) { foreach ($k in $Extra.Keys) { if ($null -eq $Extra[$k]) { $n.Remove($k) } else { $n[$k] = $Extra[$k] } } }
        $n
    }

    function script:Get-TaxonomyFiles([string]$Kind) {
        switch ($Kind) {
            'rich' {
                @{
                    'accelerationist.json' = @{ nodes = @(
                            (script:New-Node 'acc-b-1' 'Beliefs' @{ graph_attributes = [ordered]@{
                                    epistemic_type = 'empirical'; rhetorical_strategy = 'appeal_to_evidence, techno_optimism'
                                    intellectual_lineage = 'Moore'; audience = 'policymakers'; emotional_register = 'confident'; extra_attr = 'not sent' } })
                            (script:New-Node 'acc-b-2' 'Beliefs' @{ graph_attributes = [ordered]@{ epistemic_type = 'empirical'; rhetorical_strategy = 'techno_optimism'; audience = $null } })
                            (script:New-Node 'acc-b-3' 'Beliefs' @{ graph_attributes = [ordered]@{ epistemic_type = 'normative'; rhetorical_strategy = '' }; description = $null })
                            (script:New-Node 'acc-b-4' 'Beliefs' @{ graph_attributes = $null })
                            (script:New-Node 'acc-d-1' 'Desires' @{})
                        ) }
                    'safetyist.json' = @{ nodes = @(
                            (script:New-Node 'saf-b-1' 'Beliefs' @{})
                            (script:New-Node 'saf-b-2' 'Beliefs' @{})
                        ) }
                    'situations.json' = @{ nodes = @(
                            (script:New-Node 'sit-1' $null @{ interpretations = [ordered]@{ accelerationist = 'Opportunity'; safetyist = 'Risk' } })
                            (script:New-Node 'sit-2' $null @{})
                            (script:New-Node 'sit-3' $null @{ graph_attributes = [ordered]@{ epistemic_type = 'empirical' } })
                        ) }
                }
            }
            'sizes' {
                $acc = @(1..9 | ForEach-Object { script:New-Node "acc-b-$_" 'Beliefs' @{} }) +
                       @(1..10 | ForEach-Object { script:New-Node "acc-d-$_" 'Desires' @{} }) +
                       @(1..20 | ForEach-Object { script:New-Node "acc-i-$_" 'Intentions' @{} })
                @{
                    'accelerationist.json' = @{ nodes = $acc }
                    'safetyist.json'       = @{ nodes = @(1..40 | ForEach-Object { script:New-Node "saf-b-$_" 'Beliefs' @{} }) }
                }
            }
            'small' {
                @{
                    'accelerationist.json' = @{ nodes = @((script:New-Node 'acc-b-1' 'Beliefs' @{}), (script:New-Node 'acc-b-2' 'Beliefs' @{})) }
                    'safetyist.json'       = @{ nodes = @((script:New-Node 'saf-b-1' 'Beliefs' @{}), (script:New-Node 'saf-b-2' 'Beliefs' @{})) }
                }
            }
            'skeptic' {
                @{
                    'skeptic.json' = @{ nodes = @(
                            (script:New-Node 'skp-d-1' 'Desires' @{})
                            (script:New-Node 'skp-d-2' 'Desires' @{})
                            (script:New-Node 'skp-b-1' 'Beliefs' @{})
                        ) }
                }
            }
            default { @{} }
        }
    }

    function script:Get-EmbeddingsText([string]$Kind, $TaxFiles) {
        switch ($Kind) {
            'rich' {
                $v = [ordered]@{
                    'acc-b-1' = @(1.0, 0.0, 0.0); 'acc-b-2' = @(0.9, 0.1, 0.0); 'acc-b-3' = @(0.0, 1.0, 0.0); 'acc-b-4' = @(0.2, 0.8, 0.0)
                    'sit-1' = @(0.0, 0.0, 1.0); 'sit-2' = @(0.0, 0.1, 1.0); 'sit-3' = @(1.0, 0.0, 0.1); 'unrelated-9' = @(0.5, 0.5, 0.5)
                }
            }
            'invalid' { return '{ "nodes": { "broken": ' }
            default {
                # $TaxFiles is a plain hashtable (random key order per process); walk it in sorted order.
                $v = [ordered]@{}
                foreach ($name in @($TaxFiles.Keys | Sort-Object)) { foreach ($n in $TaxFiles[$name].nodes) { $v[$n.id] = @(1.0, 0.0) } }
            }
        }
        $nodes = [ordered]@{}
        foreach ($k in $v.Keys) { $nodes[$k] = [ordered]@{ vector = $v[$k] } }
        script:ConvertTo-FixtureJson ([ordered]@{ model = 'all-MiniLM-L6-v2'; nodes = $nodes })
    }

    function script:Get-EdgesText([string]$Kind) {
        if ($Kind -eq 'invalid') { return '{ "edges": [ ' }
        $e = @(
            [ordered]@{ source = 'acc-b-1'; target = 'acc-b-2'; type = 'SUPPORTS'; status = 'approved' }
            [ordered]@{ source = 'acc-b-2'; target = 'acc-b-1'; type = 'ASSUMES'; status = 'approved' }
            [ordered]@{ source = 'acc-b-1'; target = 'acc-b-2'; type = 'SUPPORTED_BY'; status = 'approved' }
            [ordered]@{ source = 'ACC-B-2'; target = 'acc-b-1'; type = 'CONTRADICTS'; status = 'approved' }
            [ordered]@{ source = 'acc-b-3'; target = 'acc-b-4'; type = 'SUPPORTS'; status = 'proposed' }
            [ordered]@{ source = 'acc-b-1'; target = 'acc-b-3'; type = 'SUPPORTS'; status = 'approved' }
            [ordered]@{ source = 'sit-1'; target = 'sit-2'; type = 'SUPPORTS'; status = 'approved' }
        )
        script:ConvertTo-FixtureJson ([ordered]@{ edges = $e })
    }

    # Builds the fixture tree for a scenario and returns its root.
    function script:New-HierFixture($S) {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $tax = Join-Path $root 'taxonomy' 'Origin'
        New-Item -ItemType Directory -Path $tax -Force | Out-Null
        $files = script:Get-TaxonomyFiles $S['Tax']
        foreach ($name in @($files.Keys | Sort-Object)) { script:Write-FixtureFile (Join-Path $tax $name) (script:ConvertTo-FixtureJson $files[$name]) }
        if ($S['Embeddings']) { script:Write-FixtureFile (Join-Path $tax 'embeddings.json') (script:Get-EmbeddingsText $S.Embeddings $files) }
        if ($S['Edges']) { script:Write-FixtureFile (Join-Path $tax 'edges.json') (script:Get-EdgesText $S.Edges) }
        $root
    }

    function script:Sort-JsonBlock([string]$Text, [string]$Key) {
        $rx = [regex]::new('("' + [regex]::Escape($Key) + '":\s*\{\n)([^{}]*?)(\n\s*\})')
        $rx.Replace($Text, {
                param($m)
                $lines = @($m.Groups[2].Value -split "`n" | ForEach-Object { $_.TrimEnd(',') } | Sort-Object -CaseSensitive)
                $m.Groups[1].Value + ($lines -join ",`n") + $m.Groups[3].Value
            })
    }

    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s -replace "`r`n", "`n"
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r = $r -replace 'Response in \d+(\.\d+)?s', 'Response in <elapsed>s'
        $r = $r -replace ' at [^\n]*?:\d+ — skipping bucket', ' at <location> — skipping bucket'
        # The -DryRun prompt length counts ConvertTo-Json's platform newline (CRLF on Windows, LF on Linux).
        $r = $r -replace '\(truncated, total \d+ chars\)', '(truncated, total <platform-dependent> chars)'
        script:Sort-JsonBlock $r 'intra_edges'
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

    # Written files in full; input files (everything under taxonomy/Origin) as a hash.
    function script:Get-Tree([string]$Root) {
        $tree = [ordered]@{}
        if (-not (Test-Path -LiteralPath $Root)) { return $tree }
        $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
                [pscustomobject]@{ Rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/'); Item = $_ } })
        foreach ($e in @($items | Sort-Object { $_.Rel } -CaseSensitive)) {
            if ($e.Item.PSIsContainer) { $tree[$e.Rel + '/'] = '(dir)'; continue }
            $text = [System.IO.File]::ReadAllText($e.Item.FullName)
            $tree[$e.Rel] = if ($e.Rel -like 'taxonomy/Origin/*') { "sha256:$(script:Get-Sha $text) ($($text.Length) chars)" } else { $text }
        }
        $tree
    }

    # The "<pov>: N nodes" load lines follow a plain hashtable's key order; sort each contiguous run.
    function script:Sort-LoadLines([string[]]$Lines) {
        $out = [System.Collections.Generic.List[string]]::new()
        $run = [System.Collections.Generic.List[string]]::new()
        $rx = '^\[Green\]    ✓  (accelerationist|safetyist|skeptic|situations): \d+ nodes$'
        foreach ($l in $Lines) {
            if ($l -match $rx) { $run.Add($l); continue }
            if ($run.Count) { $out.AddRange([string[]]@($run | Sort-Object -CaseSensitive)); $run.Clear() }
            $out.Add($l)
        }
        if ($run.Count) { $out.AddRange([string[]]@($run | Sort-Object -CaseSensitive)) }
        , $out.ToArray()
    }

    function script:Invoke-Scenario($S) {
        $script:Calls = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[object]]::new()
        $script:S = $S
        $root = script:New-HierFixture $S
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:RootFixture = $root

        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
        Mock Get-TaxonomyDir -ModuleName AITriad { Join-Path $script:RootFixture 'taxonomy' 'Origin' }
        Mock Get-DataRoot    -ModuleName AITriad { $script:RootFixture }
        Mock Resolve-AIApiKey -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'resolveKey'; explicitKey = $ExplicitKey; backend = $Backend })
            if ($script:S['NoKey']) { '' } else { "resolved-$Backend-key" }
        }
        Mock Get-Prompt -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'prompt'; name = $Name })
            "<<$Name>>"
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            $script:Writes.Add($rel)
        }
        Mock Invoke-AIApi -ModuleName AITriad {
            $norm = script:Format-Masked $Prompt
            $pov = if ($Prompt -match '(?m)^POV: (\S+)') { $Matches[1] } else { '?' }
            $cat = if ($Prompt -match '(?m)^Category: (.+?)\r?$') { $Matches[1] } else { '?' }
            $key = "$pov/$cat"
            $script:Calls.Add([ordered]@{
                    call = 'ai'; bucket = $key; model = $Model; apiKey = $ApiKey; temperature = $Temperature
                    maxTokens = $MaxTokens; jsonMode = [bool]$JsonMode; timeoutSec = $TimeoutSec
                    prompt = if ($norm.Length -gt 6000) { "<$($norm.Length) chars> sha256:$(script:Get-Sha $norm)" } else { $norm }
                })
            $responses = if ($script:S['Responses']) { $script:S.Responses } else { @{} }
            $text = if ($responses.ContainsKey($key)) { $responses[$key] }
                    else { '{"pov":"' + $pov + '","category":"' + $cat + '","parents":[],"outliers":[]}' }
            if ($text -like 'THROW:*') { throw $text.Substring(6) }
            [pscustomobject]@{ Text = $text; Backend = 'mock-backend' }
        }

        $p = @{} + $(if ($S['Params']) { $S.Params } else { @{} })
        if ($S['OutputDir']) { $p.OutputDir = Join-Path $root $S.OutputDir }

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        Register-HostCaptureMock
        try {
            Invoke-HierarchyProposal @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
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
            host     = script:Sort-LoadLines $hostLines
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

Describe 'Invoke-HierarchyProposal characterization (t/3910)' -Tag 'taxonomy' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:HIERPROP_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: pin the discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name>' -ForEach @(
        @{ Name = 'rich';                            Text = 'Cycle detected in hierarchy: acc-b-3 -> acc-b-3' }
        @{ Name = 'rich';                            Text = 'Duplicate assignment: acc-b-1' }
        @{ Name = 'rich';                            Text = 'JSON parse failed, attempting repair' }
        @{ Name = 'rich';                            Text = 'Only 0 nodes have embeddings' }
        @{ Name = 'sizes';                           Text = 'Clustering produced 8 clusters' }
        @{ Name = 'sizes';                           Text = 'Clustering produced 6 clusters' }
        @{ Name = 'sizes';                           Text = 'Clustering produced 4 clusters' }
        @{ Name = 'sizes';                           Text = 'Clustering produced 2 clusters' }
        @{ Name = 'dryrun';                          Text = 'DryRun — showing prompt for first bucket only' }
        @{ Name = 'err-no-key-claude';               Text = "No API key found for backend 'claude'" }
        @{ Name = 'err-no-key-unknown-prefix';       Text = "No API key found for backend 'xai'" }   # registry backend, not a gemini guess (t/4087)
        @{ Name = 'no-buckets';                      Text = 'No proposals generated' }
        @{ Name = 'bad-inputs-api-throws';           Text = 'API call failed for skeptic/Desires: 503 Service Unavailable' }
        @{ Name = 'bad-inputs-api-throws';           Text = 'Could not load embeddings' }
        @{ Name = 'bad-inputs-api-throws';           Text = 'Could not load edges' }
        @{ Name = 'situations-with-category';        Text = '0 buckets to process' }
        @{ Name = 'parse-fail-and-validation-throw'; Text = 'Validation failed for safetyist/Beliefs' }
        @{ Name = 'md-parent-missing-promoted-from'; Text = "Review Markdown: parent 1 in accelerationist / Beliefs has no 'promoted_from' field" }
        @{ Name = 'rich';                            Text = '> Line one.\n> Line two.' }
        @{ Name = 'cycle-long';                      Text = 'Cycle detected in hierarchy: cyc-c -> cyc-a' }
        @{ Name = 'cycle-long';                      Text = "Review Markdown: outlier acc-b-1 in accelerationist / Beliefs has no 'reason' field" }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json"))
        $g.Contains($Text) | Should -BeTrue -Because "golden $Name should show: $Text"
    }

    It 'writes the proposal JSON, then the review Markdown, once each, under the default output dir (rich)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json')) | ConvertFrom-Json
        @($g.writes) | Should -Be @(
            'taxonomy/hierarchy-proposals/hierarchy-proposal-2026-01-02-030405.json'
            'taxonomy/hierarchy-proposals/hierarchy-review-2026-01-02-030405.md'
        )
    }

    It '<Name> writes nothing and leaves every input file byte-identical' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'dryrun', 'whatif', 'no-buckets', 'err-no-key-claude' }
    ) {
        $s = $_
        $pristine = script:New-HierFixture $s
        $script:RootCurrent = [System.IO.Path]::GetFullPath($pristine).TrimEnd('\', '/')
        $before = script:Get-Tree $pristine
        $null = script:Invoke-Scenario $s
        $after = script:Get-Tree $script:RootFixture
        @($script:Writes).Count | Should -Be 0
        foreach ($k in @($before.Keys)) { $after[$k] | Should -BeExactly $before[$k] -Because "$k must be untouched" }
        @($after.Keys | Where-Object { $_ -notlike '*/' }).Count | Should -Be @($before.Keys | Where-Object { $_ -notlike '*/' }).Count
    }

    # t/4071: no run that writes nothing may create the output directory either.
    It '<Name> creates no output directory' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'dryrun', 'whatif', 'no-buckets', 'err-no-key-claude',
            'situations-with-category', 'parse-fail-and-validation-throw', 'bad-inputs-api-throws' }
    ) {
        $null = script:Invoke-Scenario $_
        @(Get-ChildItem -LiteralPath $script:RootFixture -Recurse -Directory |
            Where-Object { $_.Name -in 'hierarchy-proposals', 'custom' }).Count | Should -Be 0
    }

    It '-DryRun resolves no API key and succeeds without one (t/4071)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'dryrun' }
    ) {
        $s = @{} + $_
        $s.NoKey = $true
        $null = script:Invoke-Scenario $s
        @($script:Calls | Where-Object { $_.call -eq 'resolveKey' }).Count | Should -Be 0
        @($script:Calls | Where-Object { $_.call -eq 'ai' }).Count | Should -Be 0
    }
}
