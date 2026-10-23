# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-EntityExtraction (t/3910), written BEFORE its complexity refactor
    and required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Invoke-EntityExtraction end to end against a fixture data tree in $TestDrive and
    compares a full transcript to a golden in tests/fixtures/entity-extraction/<scenario>.json:
      - every host line, warning and verbose message, and the thrown error's message, if any;
      - every Invoke-AIByUsage, Get-TextEmbedding and Import-Entity call (Import-Entity is wrapped, not
        replaced: the real one still runs, so entities.json is the real output);
      - every data write, in order (via the Assert-DataWriteAllowed guard);
      - the returned object;
      - the full file tree afterwards, with each file's exact bytes.
    The AI step is mocked; nothing can reach a live backend. Get-Date is frozen, which covers the
    sidecar's processed_at (ToString('o')) and last_modified stamps and Import-Entity's dates.
    Determinism (Sage #220): the embedding batch's ids come from a plain hashtable, so the recorded
    Get-TextEmbedding call sorts its (id, text) pairs. Under -Parallel the failed/invalid bags are
    ConcurrentBags, so those two output lists are sorted in that scenario only.
    The 'parallel' scenario runs the real ForEach-Object -Parallel path. Its runspaces re-import the
    module from $script:ModuleRoot, which the test points at a stub module (deterministic
    Invoke-AIByUsage and ConvertFrom-TruncatableJson) for the duration of the call.
    Still pinned (t/4072 item 1, withheld pending a design decision):
      - embeddings-records: a schema-2.0.0 entity_embeddings.json (vectors[id] = { name_vector })
        fails the [double[]] cast and is dropped, so the existing-entity cosine stage never fires on
        the real store shape. Since t/4072 the drop is a WARN rather than a Write-Verbose.
    Fixed in t/4072 (each flipped only its own goldens):
      - rich (node-c, node-k): a response without org_mentions is treated as empty with a WARN; the
        node succeeds (not Failed) and is processed and minted, consistently.
      - store-load fallbacks WARN (was Write-Verbose), which flips every golden whose fixture lacks
        organizations.json; discovered_by is an ordered dictionary, so the harness no longer sorts it.
    Regenerate the goldens ONLY when a behaviour change is intended and reviewed: set
    $env:ENTITYEXTRACTION_REGEN_GOLDEN = '1' and run once.
#>

$script:RichSei = [ordered]@{
    'node-a' = @{ facts = @(@{ claim = 'A1'; doc_id = 'd1' }, @{ claim = 'A2'; doc_id = 'd1' }, @{ claim = 'A3'; doc_id = 'd2' }, 'not-a-fact-object', @{ doc_id = 'd3' }) }
    'node-b' = @{ facts = @(@{ claim = 'B1'; doc_id = 'd4' }) }
    'node-c' = @{ facts = @(@{ claim = 'C1' }) }
    'node-d' = @{ facts = @() }
    'node-e' = @{ other = 1 }
    'node-f' = @{ facts = @(@{ claim = 'F1'; doc_id = 'd5' }) }
    'node-g' = @{ facts = @(@{ claim = 'G1'; doc_id = 'd6' }) }
    'node-h' = @{ facts = @(@{ claim = 'H1'; doc_id = 'd7' }) }
    'node-i' = @{ facts = @(@{ claim = 'I1'; doc_id = 'd8' }) }
    'node-j' = @{ facts = @(@{ claim = 'J1'; doc_id = 'd9' }) }
    'node-k' = @{ facts = @(@{ claim = 'K1'; doc_id = 'd10' }) }
    'node-z' = @{ facts = @(@{ claim = 'Z1'; doc_id = 'd11' }) }
    'string-entry' = 'just a string'
}

$script:RichResponses = @{
    'node-a' = @{ Model = 'model-a'; Text = "``````json`n" + '{"proposals":[' +
            '{"name":"Existing Corp","entity_type":"institution","aliases":[],"quote":"q1","confidence":0.9},' +
            '{"name":"Some Other Name","entity_type":"institution","aliases":["ExistingCo"],"quote":"q2","confidence":0.9},' +
            '{"name":"Frontier Org","entity_type":"institution","quote":"q3","confidence":0.9},' +
            '{"name":"FO","entity_type":"institution","confidence":0.9},' +
            '{"name":"Scaling Hypothesis","entity_type":"event","confidence":0.9},' +
            '{"name":"  Compute   Governance ","entity_type":"legislation","confidence":0.9},' +
            '{"name":"AI Doomer","entity_type":"person","confidence":0.9},' +
            '{"name":"Mandate Audits","entity_type":"legislation","confidence":0.9},' +
            'null,' +
            '{"name":"","entity_type":"person","confidence":0.9},' +
            '{"name":"Bad Type","entity_type":"alien","confidence":0.9},' +
            '{"name":"No Conf","entity_type":"event"},' +
            '{"name":"Str Conf","entity_type":"event","confidence":"high"},' +
            '{"name":"Big Conf","entity_type":"event","confidence":1.5},' +
            '{"name":"Low Thing","entity_type":"artifact","confidence":0.3},' +
            '{"name":"Near Thing","entity_type":"artifact","aliases":"Single Alias","quote":"near","confidence":0.65},' +
            '{"name":"Vector Lab Clone","entity_type":"artifact","confidence":0.9},' +
            '{"name":"Gemini Alpha","entity_type":"artifact","quote":"qa","confidence":0.9}' +
            '],"org_mentions":[{"name":"Mentioned Org"},null,{"name":""},{"noname":1}]}' + "`n``````" }
    'node-b' = @{ Text = '{"proposals":[' +
            '{"name":"Gemini Beta","entity_type":"artifact","confidence":0.9},' +
            '{"name":"Near Thing Two","entity_type":"artifact","aliases":["Single Alias"],"confidence":0.9},' +
            '{"name":"Jane Person","entity_type":"person","quote":"Jane said","confidence":0.95}' +
            '],"org_mentions":[]}' }
    'node-c' = @{ Model = 'model-c'; Text = '{"proposals":[{"name":"C Thing","entity_type":"event","confidence":0.9}]}' }
    'node-f' = @{ Throw = 'rate limited (429)' }
    'node-g' = @{ Model = 'model-g'; Text = '' }
    'node-h' = @{ Model = 'model-h'; Text = '{"proposals":[{"name":"EMBEDFAIL Widget","entity_type":"artifact","confidence":0.9}],"org_mentions":[]}' }
    'node-i' = @{ Null = $true }
    'node-j' = @{ Model = 'model-j'; Text = 'definitely not json' }
    'node-k' = @{ Model = 'model-k'; Text = '{"proposals":[{"name":"Trunc Thing","entity_type":"event","confidence":0.9},{"name":"Cut' }
}

$script:OneNodeSei = [ordered]@{ 'node-1' = @{ facts = @(@{ claim = 'One'; doc_id = 'doc-1' }) } }
$script:OneMint = @{ 'node-1' = @{ Model = 'stub'; Text = '{"proposals":[{"name":"Solo Thing","entity_type":"artifact","aliases":["ST"],"quote":"solo","confidence":0.9}],"org_mentions":[{"name":"Org X"}]}' } }

$script:Batch21 = @{ 'node-1' = @{ Model = 'stub'; Text = '{"proposals":[' + ((1..21 | ForEach-Object { '{"name":"Item ' + $_.ToString('D2') + '","entity_type":"artifact","confidence":0.9}' }) -join ',') + '],"org_mentions":[]}' } }

$script:Scenarios = @(
    @{ Name = 'err-usage-unregistered'; Usage = 'missing' }
    @{ Name = 'err-usage-registry-throws'; Usage = 'throws' }
    @{ Name = 'err-sei-missing'; Sei = $null }
    @{ Name = 'nothing-to-do'; Sei = [ordered]@{ 'node-d' = @{ facts = @() }; 'node-x' = @{ facts = @(@{ claim = 'X' }) } }
       Log = @('node-x'); Params = @{ NodeId = @('node-d', 'node-x', 'node-missing') } }
    @{ Name = 'whatif'; Sei = $script:OneNodeSei; Responses = $script:OneMint; Params = @{ WhatIf = $true } }
    @{ Name = 'rich'; Sei = $script:RichSei; Responses = $script:RichResponses; Seed = $true; Embeddings = 'flat'
       Orgs = 'ok'; Taxonomy = $true; Dictionary = $true; Policy = 'ok'; Embed = $true; Log = @('node-z', 'node-old') }
    @{ Name = 'rich-thresholds'; Sei = $script:RichSei; Responses = $script:RichResponses; Seed = $true; Embeddings = 'flat'
       Orgs = 'ok'; Taxonomy = $true; Dictionary = $true; Policy = 'ok'; Embed = $true
       # Each threshold moves an outcome: 0.5 + 0.45 flags every 0.9 mint near-gate, the 1.0 link
       # threshold still links the identical vector (sim=1), and 0.995 suppresses the 0.9949 pair.
       Params = @{ ConfidenceThreshold = 0.5; NearGateBand = 0.45; LinkSimilarityThreshold = 1.0; WithinRunSimilarityThreshold = 0.995 } }
    @{ Name = 'embeddings-records'; Sei = $script:RichSei; Responses = $script:RichResponses; Seed = $true; Embeddings = 'records'; Embed = $true
       Params = @{ NodeId = @('node-a', 'node-b') } }
    @{ Name = 'stores-degraded'; Sei = $script:OneNodeSei; Responses = $script:OneMint; Embeddings = 'unparseable'; Orgs = 'unparseable'; Policy = 'unparseable' }
    @{ Name = 'force-rerun'; Sei = $script:OneNodeSei; Responses = $script:OneMint; Log = @('node-1', 'node-keep'); Params = @{ Force = $true; NodeId = @('node-1') } }
    @{ Name = 'maxnodes'; Sei = [ordered]@{ 'node-1' = @{ facts = @(@{ claim = 'One' }) }; 'node-2' = @{ facts = @(@{ claim = 'Two' }) }; 'node-3' = @{ facts = @(@{ claim = 'Three' }) } }
       Responses = @{ 'node-1' = $script:OneMint['node-1']; 'node-2' = @{ Model = 'stub'; Text = '{"proposals":[],"org_mentions":[]}' } }
       Params = @{ MaxNodes = 2 } }
    @{ Name = 'all-failed-no-write'; Sei = $script:OneNodeSei; Responses = @{ 'node-1' = @{ Throw = 'backend down' } } }
    @{ Name = 'path-overrides'; Sei = $script:OneNodeSei; Responses = $script:OneMint; Overrides = $true; Params = @{ Model = 'gemini-3.7-flash' } }
    @{ Name = 'batch-21'; Sei = $script:OneNodeSei; Responses = $script:Batch21 }
    @{ Name = 'parallel'; Parallel = $true; Params = @{ Concurrency = 2 }
       Sei = [ordered]@{ 'node-1' = @{ facts = @(@{ claim = 'One'; doc_id = 'doc-1' }) }; 'node-2' = @{ facts = @(@{ claim = 'Two'; doc_id = 'doc-2' }) }
                        'node-3' = @{ facts = @(@{ claim = 'Three' }) }; 'node-4' = @{ facts = @(@{ claim = 'Four' }) } }
       Responses = @{
           'node-1' = @{ Model = 'par-model'; Text = '{"proposals":[{"name":"Par Thing","entity_type":"artifact","aliases":"PT","quote":"pq","confidence":0.9},{"name":"Par Bad","entity_type":"alien","confidence":0.9},{"name":"Par Low","entity_type":"event","confidence":0.1}],"org_mentions":[{"name":"Par Org"}]}' }
           'node-2' = @{ Throw = 'parallel backend down' }
           'node-3' = @{ Model = 'par-model'; Text = '' }
           'node-4' = @{ Text = '{"proposals":[{"name":"","entity_type":"event","confidence":0.9},{"name":"Par Near","entity_type":"event","confidence":0.62}],"org_mentions":[]}' } } }
)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'entity-extraction'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    # Captured before any Mock: the wrapper below records each call, then runs the real function.
    $script:RealImportEntity = Get-Command Import-Entity -Module AITriad

    function script:Write-FixtureFile([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $script:Utf8)
    }
    function script:ConvertTo-FixtureJson($Obj) { ($Obj | ConvertTo-Json -Depth 10) -replace "`r`n", "`n" }

    function script:New-LogNode([string]$Id) {
        [ordered]@{ node_id = $Id; processed_at = '2025-12-01T00:00:00.0000000Z'; model = 'old-model'; proposals_total = 1
                    org_mentions = @(); evidence = @(); dropped = @(); possible_duplicates = @() }
    }

    # Builds the fixture tree for a scenario and returns its root.
    function script:New-EeFixture($S) {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $tax = Join-Path $root 'taxonomy'
        New-Item -ItemType Directory -Path $tax -Force | Out-Null

        if ($S.ContainsKey('Sei') -and $null -ne $S.Sei) {
            $seiPath = if ($S['Overrides']) { Join-Path $root 'custom' 'sei.json' } else { Join-Path $tax 'source_evidence_index.json' }
            # Canonical first: the scenario tables use plain hashtables, whose key order varies per process.
            script:Write-FixtureFile $seiPath (script:ConvertTo-FixtureJson (script:ConvertTo-Canonical $S.Sei))
        }
        elseif (-not $S.ContainsKey('Sei')) {
            # Scenarios that fail before reading the SEI still get one, so only the guard under test fires.
            script:Write-FixtureFile (Join-Path $tax 'source_evidence_index.json') (script:ConvertTo-FixtureJson $script:OneNodeSei)
        }

        if ($S['Log']) {
            $logPath = if ($S['Overrides']) { Join-Path $root 'custom' 'log.json' } else { Join-Path $tax 'entity_extraction_log.json' }
            $nodes = @($S.Log | ForEach-Object { script:New-LogNode $_ })
            script:Write-FixtureFile $logPath (script:ConvertTo-FixtureJson ([ordered]@{ _schema_version = '1.2.0'; _doc = 'seed'; last_modified = '2025-12-01'; node_count = $nodes.Count; nodes = $nodes }))
        }

        switch ($S['Embeddings']) {
            'flat'        { script:Write-FixtureFile (Join-Path $tax 'entity_embeddings.json') '{ "vectors": { "ent-002": [1.0, 0.0, 0.0] } }' }
            'records'     { script:Write-FixtureFile (Join-Path $tax 'entity_embeddings.json') '{ "_schema_version": "2.0.0", "vectors": { "ent-002": { "name_vector": [1.0, 0.0, 0.0] } } }' }
            'unparseable' { script:Write-FixtureFile (Join-Path $tax 'entity_embeddings.json') '{ "vectors": ' }
        }
        switch ($S['Orgs']) {
            'ok' { script:Write-FixtureFile (Join-Path $tax 'organizations.json') '{ "organizations": [ { "id": "org-001", "name": "Frontier Org", "short_name": "FO" }, { "name": "No Id Org" } ] }' }
            'unparseable' { script:Write-FixtureFile (Join-Path $tax 'organizations.json') '{ "organizations": [' }
        }
        if ($S['Taxonomy']) {
            script:Write-FixtureFile (Join-Path $tax 'accelerationist.json') '{ "nodes": [ { "id": "acc-beliefs-001", "label": "Scaling Hypothesis" }, { "id": "acc-x" }, { "label": "no id" } ] }'
            script:Write-FixtureFile (Join-Path $tax 'safetyist.json') '{ "nodes": [ { "id": "saf-desires-001", "label": "Pause Advocacy" } ] }'
            script:Write-FixtureFile (Join-Path $tax 'skeptic.json') '{ "nodes": ['
        }
        if ($S['Dictionary']) {
            script:Write-FixtureFile (Join-Path $root 'dictionary' 'standardized' 'compute-governance.json') '{ "canonical_form": "Compute Governance" }'
            script:Write-FixtureFile (Join-Path $root 'dictionary' 'standardized' 'broken.json') 'not json'
            script:Write-FixtureFile (Join-Path $root 'dictionary' 'colloquial' 'ai-doomer.json') '{ "colloquial_term": "AI Doomer" }'
            script:Write-FixtureFile (Join-Path $root 'dictionary' 'colloquial' 'no-term.json') '{ "other": "x" }'
        }
        switch ($S['Policy']) {
            'ok' { script:Write-FixtureFile (Join-Path $tax 'policy_actions.json') '{ "policies": [ { "id": "pol-001", "action": "Mandate Audits" }, { "action": "no id" } ] }' }
            'unparseable' { script:Write-FixtureFile (Join-Path $tax 'policy_actions.json') '{ "policies": [' }
        }
        $root
    }

    # A stub module the -Parallel runspaces import in place of the real one (they re-import from
    # $script:ModuleRoot, where a Pester mock cannot reach). Returns the directory to use as ModuleRoot.
    function script:New-ParallelStub($Responses) {
        $stubRoot = Join-Path $TestDrive ('stub-' + [guid]::NewGuid().ToString('N'))
        $modDir = Join-Path $stubRoot 'mod'
        New-Item -ItemType Directory -Path $modDir -Force | Out-Null
        $json = ($Responses | ConvertTo-Json -Depth 10 -Compress).Replace("'", "''")
        $code = @"
`$script:R = ConvertFrom-Json -AsHashtable '$json'
function Invoke-AIByUsage {
    param(`$UsageId, `$Values, `$Override, `$ApiKey, `$FallbackModels)
    `$r = `$script:R[[string]`$Values.node_id]
    if (`$null -eq `$r) { return [pscustomobject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub-default' } }
    if (`$r.ContainsKey('Throw')) { throw `$r.Throw }
    if (`$r.ContainsKey('Null')) { return `$null }
    if (`$r.ContainsKey('Model')) { return [pscustomobject]@{ Text = `$r.Text; Model = `$r.Model } }
    [pscustomobject]@{ Text = `$r.Text }
}
function ConvertFrom-TruncatableJson { param([string]`$Text, [string]`$Context) `$Text | ConvertFrom-Json }
Export-ModuleMember -Function Invoke-AIByUsage, ConvertFrom-TruncatableJson
"@
        [System.IO.File]::WriteAllText((Join-Path $modDir 'AITriad.psm1'), $code, $script:Utf8)
        [System.IO.File]::WriteAllText((Join-Path $stubRoot 'AIEnrich.psm1'), "# stub`n", $script:Utf8)
        $modDir
    }

    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r -replace "`r`n", "`n"
    }

    # Canonical, order-stable form: plain-hashtable keys sorted (their order is randomized per
    # process), ordered dictionaries and PSCustomObjects kept in their own order, strings masked.
    function script:ConvertTo-Canonical($Obj) {
        if ($null -eq $Obj) { return $null }
        if ($Obj -is [string]) { return (script:Format-Masked $Obj) }
        if ($Obj -is [System.Collections.Specialized.OrderedDictionary]) {
            $o = [ordered]@{}; foreach ($k in $Obj.Keys) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IDictionary]) {
            $o = [ordered]@{}; foreach ($k in @($Obj.Keys | Sort-Object -CaseSensitive)) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IEnumerable]) { return , @(foreach ($i in $Obj) { script:ConvertTo-Canonical $i }) }
        if ($Obj -is [pscustomobject]) {
            $o = [ordered]@{}; foreach ($p in $Obj.PSObject.Properties) { $o[$p.Name] = script:ConvertTo-Canonical $p.Value }; return $o
        }
        if ($Obj -is [switch]) { return [bool]$Obj }
        return $Obj
    }

    # Sorts the lines inside every "key": { ... } block that holds only scalars. entities.json's
    # discovered_by comes from a plain hashtable the cmdlet builds, so its key order varies per process
    # (pre-existing; t/4072 item 4). Every other byte is compared as written.
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
        $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
                [pscustomobject]@{ Rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/'); Item = $_ } })
        foreach ($e in @($items | Sort-Object { $_.Rel } -CaseSensitive)) {
            if ($e.Item.PSIsContainer) { $tree[$e.Rel + '/'] = '(dir)'; continue }
            $text = [System.IO.File]::ReadAllText($e.Item.FullName) -replace "`r`n", "`n"
            if ($e.Rel -like '*entities.json') { $text = script:Sort-JsonBlock $text 'discovered_by' }
            $tree[$e.Rel] = $text
        }
        $tree
    }

    function script:Invoke-Scenario($S) {
        $script:Calls = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[object]]::new()
        $script:S = $S
        $root = script:New-EeFixture $S
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:RootFixture = $root
        & (Get-Module AITriad) { Clear-EntitiesCache; Clear-OrganizationsCache }

        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
        Mock Get-TaxonomyDir -ModuleName AITriad { Join-Path $script:RootFixture 'taxonomy' }
        Mock Get-DataRoot    -ModuleName AITriad { $script:RootFixture }
        # An empty, existing sources dir (no duplicate_of marks): the transcript is then identical with
        # or without a real ai-triad-sources checkout. Without it, CI (no checkout) adds a "marks are
        # not applied" WARN that a dev machine doesn't (t/4337 C1). It sits outside the fixture root
        # because the transcript records that tree.
        $script:EmptySources = Join-Path $TestDrive ('sources-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:EmptySources -Force | Out-Null
        Mock Get-SourcesDir  -ModuleName AITriad { $script:EmptySources }
        Mock Invoke-AIApi    -ModuleName AITriad { throw 'live AI call attempted in a characterization test' }
        Mock Get-UsageRegistry -ModuleName AITriad {
            switch ($script:S['Usage']) {
                'missing' { [pscustomobject]@{ 'other.usage' = @{} } }
                'throws'  { throw 'ai-usages.json unreadable' }
                default   { [pscustomobject]@{ 'enrichment.entity-extraction' = @{} } }
            }
        }
        Mock Invoke-AIByUsage -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'ai'; usageId = $UsageId; values = $Values; override = $Override })
            $r = if ($script:S['Responses']) { $script:S.Responses[[string]$Values.node_id] } else { $null }
            if ($null -eq $r) { return [pscustomobject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub-default' } }
            if ($r.ContainsKey('Throw')) { throw $r.Throw }
            if ($r.ContainsKey('Null')) { return $null }
            if ($r.ContainsKey('Model')) { return [pscustomobject]@{ Text = $r.Text; Model = $r.Model } }
            [pscustomobject]@{ Text = $r.Text }
        }
        Mock Get-TextEmbedding -ModuleName AITriad {
            $t = @($Texts); $ids = @($Ids)
            # The cmdlet builds the batch from a plain hashtable, so record the pairs in sorted order.
            $pairs = @(for ($k = 0; $k -lt $ids.Count; $k++) { [ordered]@{ id = [string]$ids[$k]; text = [string]$t[$k] } })
            $script:Calls.Add([ordered]@{ call = 'embed'; pairs = @($pairs | Sort-Object { $_.id } -CaseSensitive) })
            $out = @{}
            if (-not $script:S['Embed']) { return $out }
            for ($k = 0; $k -lt $t.Count; $k++) {
                $s = ([string]$t[$k]).ToLowerInvariant()
                if ($s -match 'embedfail') { throw 'embedder offline' }
                $vec = switch -Regex ($s) {
                    'vector lab clone' { @(1.0, 0.0, 0.0) }
                    'gemini alpha'     { @(0.0, 1.0, 0.0) }
                    'gemini beta'      { @(0.0, 0.99, 0.1) }
                    default            { $null }
                }
                if ($null -ne $vec) { $out[[string]$ids[$k]] = $vec }
            }
            $out
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $script:Writes.Add((script:Format-Masked ([System.IO.Path]::GetFullPath($Path))))
        }

        if ($S['Seed']) {
            $entPath = Join-Path $root 'taxonomy' 'entities.json'
            & $script:RealImportEntity -Proposal @(
                @{ name = 'Existing Corp'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object'; aliases = @('ExistingCo') }
                # approved: the fixture gives ent-002 a vector, and only approved records carry one (t/4450).
                @{ name = 'Vector Labs'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; status = 'approved' }
            ) -Path $entPath -SkipEmbedding -Confirm:$false | Out-Null
            $script:Writes.Clear()
        }

        Mock Import-Entity -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'import'; path = $Path; embeddingsPath = $EmbeddingsPath; proposals = @($Proposal) })
            & $script:RealImportEntity @PesterBoundParameters
        }

        $p = @{ Concurrency = 1 }
        if ($S['Params']) { foreach ($k in $S.Params.Keys) { $p[$k] = $S.Params[$k] } }
        if ($S['Overrides']) {
            $p.EntitiesPath = Join-Path $root 'custom' 'entities.json'
            $p.EmbeddingsPath = Join-Path $root 'custom' 'embeddings.json'
            $p.SourceEvidenceIndexPath = Join-Path $root 'custom' 'sei.json'
            $p.OutputPath = Join-Path $root 'custom' 'log.json'
        }
        if (-not $p.ContainsKey('WhatIf')) { $p.Confirm = $false }

        $stubDir = if ($S['Parallel']) { script:New-ParallelStub $S.Responses } else { $null }
        $savedRoot = & (Get-Module AITriad) { $script:ModuleRoot }

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        try {
            if ($stubDir) { & (Get-Module AITriad) { param($d) $script:ModuleRoot = $d } $stubDir }
            Invoke-EntityExtraction @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
        } catch {
            $err = $_.Exception.Message
        } finally {
            & (Get-Module AITriad) { param($d) $script:ModuleRoot = $d } $savedRoot
        }
        $hostLines = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { [string]$_.MessageData })
        $verbose = @($records | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { $_.Message })
        $output  = @($records | Where-Object { $_ -isnot [System.Management.Automation.VerboseRecord] -and $_ -isnot [System.Management.Automation.InformationRecord] })
        if ($S['Parallel']) {
            foreach ($o in $output) {
                foreach ($f in 'FailedItems', 'InvalidItems') {
                    if ($o.PSObject.Properties[$f]) { $o.$f = @($o.$f | Sort-Object -CaseSensitive) }
                }
            }
        }

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

Describe 'Invoke-EntityExtraction characterization (t/3910)' -Tag 'unit' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:ENTITYEXTRACTION_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: each golden is only as good as the branch it exercised, so pin the
    # discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name>' -ForEach @(
        @{ Name = 'err-usage-unregistered';    Text = "UsageID 'enrichment.entity-extraction' is not registered" }
        @{ Name = 'err-usage-registry-throws'; Text = "UsageID 'enrichment.entity-extraction' is not registered" }
        @{ Name = 'err-sei-missing';           Text = 'source_evidence_index.json not found at' }
        @{ Name = 'nothing-to-do';             Text = 'Nothing to extract' }
        @{ Name = 'whatif';                    Text = '"WouldProcess": 1' }
        @{ Name = 'rich';                      Text = 'within-run embedding batch failed for node node-h' }
        @{ Name = 'rich-thresholds';           Text = '"entity_name": "Vector Labs"' }
        @{ Name = 'embeddings-records';        Text = '"entity_id": "ent-002"' }
        @{ Name = 'stores-degraded';           Text = 'organizations.json could not be loaded' }
        @{ Name = 'force-rerun';               Text = '\"node_id\": \"node-keep\"' }
        @{ Name = 'maxnodes';                  Text = 'Work items: 2' }
        @{ Name = 'all-failed-no-write';       Text = 'node-1: backend down' }
        @{ Name = 'path-overrides';            Text = 'custom/log.json' }
        @{ Name = 'batch-21';                  Text = 'Item 21' }
        @{ Name = 'parallel';                  Text = 'node-2: parallel backend down' }
    ) {
        $golden = Join-Path $script:GoldenDir "$Name.json"
        [System.IO.File]::ReadAllText($golden) | Should -Match ([regex]::Escape($Text))
    }

    It 'the rich golden links by every exact match source and pins both ADVISORY cosine stages' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json'))
        foreach ($kind in '"matched_kind": "entity"', '"matched_kind": "organization"', '"matched_kind": "node"', '"matched_kind": "term"', '"matched_kind": "policy"') {
            $g | Should -Match ([regex]::Escape($kind))
        }
        $g | Should -Not -Match 'cosine>=' -Because 'the existing-entity cosine stage never links (t/4075)'
        $g | Should -Match '"proposal_name": "Gemini Beta"'
        $g | Should -Match '"reason": "within-run-dedup"'
        $o = @(($g | ConvertFrom-Json).output)[0]
        @($o.LinkedDispositions | Where-Object { $_.proposal_name -eq 'Vector Lab Clone' }).Count | Should -Be 0
        @($o.MintedEntities | Where-Object { $_.name -eq 'Vector Lab Clone' }).Count | Should -Be 1
        $c = @($o.ExistingEntityCandidates | Where-Object { $_.proposal_name -eq 'Vector Lab Clone' })
        $c.Count | Should -Be 1
        $c[0].entity_name | Should -Be 'Vector Labs'
        $c[0].version_sibling | Should -BeFalse
    }

    It 't/4075: a schema-2.0.0 store is read (name_vector) for advisory candidates and still never links' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'embeddings-records.json')) | ConvertFrom-Json
        @($g.warnings | Where-Object { $_ -match 'entity_embeddings\.json could not be loaded' }).Count | Should -Be 0
        $o = @($g.output)[0]
        @($o.LinkedDispositions | Where-Object { $_.proposal_name -eq 'Vector Lab Clone' }).Count | Should -Be 0
        @($o.ExistingEntityCandidates | Where-Object { $_.entity_id -eq 'ent-002' }).Count | Should -Be 1
        $g.tree.'taxonomy/entity_extraction_log.json' | Should -Match '"_schema_version": "1\.3\.0"'
    }

    It 't/4072: a response without org_mentions succeeds with a WARN and is processed' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json')) | ConvertFrom-Json
        $o = @($g.output)[0]
        @($o.FailedItems | Where-Object { $_ -match '^node-(c|k):' }).Count | Should -Be 0
        @($g.warnings) | Should -Contain "Invoke-EntityExtraction: node-c: response has no 'org_mentions'; treating it as empty."
        @($g.warnings) | Should -Contain "Invoke-EntityExtraction: node-k: response has no 'org_mentions'; treating it as empty."
        $g.tree.'taxonomy/entity_extraction_log.json' | Should -Match '"node_id": "node-c"'
    }

    It 't/4072: discovered_by is written in a fixed key order' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json')) | ConvertFrom-Json
        $g.tree.'taxonomy/entities.json' | Should -Match '"discovered_by": \{\s*"model": "[^"]*",\s*"usage_id": '
    }

    It 'batch-21 mints in two Import-Entity calls (20 + 1)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'batch-21.json')) | ConvertFrom-Json
        $imports = @($g.calls | Where-Object { $_.call -eq 'import' })
        $imports.Count | Should -Be 2
        @($imports[0].proposals).Count | Should -Be 20
        @($imports[1].proposals).Count | Should -Be 1
    }

    It 'whatif, all-failed-no-write and nothing-to-do make no data write' -ForEach @(
        @{ Name = 'whatif'; NoLog = $true }, @{ Name = 'all-failed-no-write'; NoLog = $true }, @{ Name = 'nothing-to-do'; NoLog = $false }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json")) | ConvertFrom-Json
        @($g.writes).Count | Should -Be 0
        @($g.calls | Where-Object { $_.call -eq 'import' }).Count | Should -Be 0
        # nothing-to-do seeds a log; it must survive untouched (its processed_at keeps the seed's text).
        if ($NoLog) { $g.tree.PSObject.Properties.Name | Should -Not -Contain 'taxonomy/entity_extraction_log.json' }
        else { $g.tree.'taxonomy/entity_extraction_log.json' | Should -Match '2025-12-01T00:00:00\.0000000Z' }
    }
}
