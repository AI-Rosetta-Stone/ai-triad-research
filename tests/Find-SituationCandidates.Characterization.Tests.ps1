# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Find-SituationCandidates (t/3910), written BEFORE its complexity refactor
    and required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Find-SituationCandidates end to end against a fixture taxonomy, embeddings file and
    edges file, and compares a full transcript to a golden in tests/fixtures/situation-candidates/:
      - every host line (colour and text), warning, and the thrown error's message, if any;
      - the returned result object;
      - every NLI call (the pair payload piped to python3, and its arguments), Get-Prompt call,
        Resolve-AIApiKey call, Get-AITierModel call and Invoke-AIApi call (with its prompt);
      - every write (via the Assert-DataWriteAllowed guard that Write-Utf8NoBom calls) and the written
        -OutputFile content.
    Embeddings are built so a pair's cosine similarity is exactly the product of two per-node topic
    weights, which keeps every score distinct (no ties). python3 is replaced by a global function that
    returns NLI labels by node-id pair, so nothing runs a model. Invoke-AIApi is mocked. Get-Date is frozen.

    Canonicalization. Written before t/4074, when the cmdlet walked plain-hashtable keys (random order
    per process), so the transcript normalises order: NLI payloads are sorted per pair and as a list;
    members, povs_represented and the fallback "A / B" label are sorted, as are cluster member lines in
    the AI prompt and on the console; each debate side is sorted and the sides ordered by first id.
    Since t/4074 the cmdlet emits that order itself, which 'emits members in id order without
    canonicalization' checks on the raw result. povs_represented still follows member order.
    Regenerate goldens with $env:SITCAND_REGEN_GOLDEN = '1', only for a deliberate behaviour change, and
    review the diff: each regenerated golden must be one the change intends to move.
#>

BeforeDiscovery {
    $script:Scenarios = @(
        @{ Name = 'rich'; Data = 'rich'; Params = @{ Model = 'gemini-2.5-flash' }; OutputFile = 'out/candidates.json'; Ai = 'rich' }
        @{ Name = 'shared-only'; Data = 'rich'; Params = @{ ShowSharedOnly = $true; TopN = 2; NoAI = $true } }
        @{ Name = 'debates-only'; Data = 'rich'; Params = @{ ShowDebatesOnly = $true; TopN = 2; NoAI = $true } }
        @{ Name = 'topn-8-debate-sparse'; Data = 'rich'; Params = @{ TopN = 8; NoAI = $true } }
        @{ Name = 'topn-4-both-full'; Data = 'rich'; Params = @{ TopN = 4; NoAI = $true } }
        @{ Name = 'no-nli-no-ai-flat-embeddings'; Data = 'rich'; EmbeddingsFormat = 'flat'; NoEdges = $true; Params = @{ NoNLI = $true; NoAI = $true } }
        @{ Name = 'nli-throws'; Data = 'rich'; Nli = 'throw'; Params = @{ NoAI = $true } }
        @{ Name = 'nli-bad-json'; Data = 'rich'; Nli = 'badjson'; Params = @{ NoAI = $true } }
        @{ Name = 'ai-no-key-claude'; Data = 'rich'; NoKey = $true; Params = @{ Model = 'claude-haiku-4-5'; TopN = 2 } }
        @{ Name = 'ai-empty-groq'; Data = 'rich'; Ai = 'empty'; Params = @{ Model = 'groq-openai-gpt-oss-20b'; TopN = 2; ApiKey = 'explicit-key' } }
        @{ Name = 'ai-throws-unknown-prefix'; Data = 'rich'; Ai = 'throw'; Params = @{ Model = 'xai-grok-4-6'; TopN = 2 } }
        @{ Name = 'ai-openai-prefix'; Data = 'rich'; Ai = 'nofence'; Params = @{ Model = 'openai-gpt-4o'; TopN = 2 } }
        @{ Name = 'default-model-tier'; Data = 'rich'; Ai = 'nofence'; Params = @{ TopN = 1 } }
        @{ Name = 'default-model-env'; Data = 'rich'; Ai = 'nofence'; EnvModel = 'claude-haiku-4-5'; Params = @{ TopN = 1 } }
        @{ Name = 'oversized-debate'; Data = 'oversized'; Params = @{ ShowDebatesOnly = $true; TopN = 30; NoAI = $true } }
        @{ Name = 'none-above-threshold'; Data = 'rich'; Params = @{ MinSimilarity = 0.95; Model = 'gemini-2.5-flash' } }
        @{ Name = 'outputfile-write-fails'; Data = 'rich'; OutputFile = 'out/denied.json'; DenyWrite = $true; Params = @{ NoAI = $true; TopN = 1 } }
        @{ Name = 'err-mutually-exclusive'; Data = 'rich'; Params = @{ ShowSharedOnly = $true; ShowDebatesOnly = $true } }
        @{ Name = 'err-no-embeddings'; Data = 'rich'; NoEmbeddings = $true; Params = @{ NoAI = $true } }
        # t/4074: sit-1 already interprets acc-1 and saf-1, so that pair is skipped.
        @{ Name = 'situation-linked'; Data = 'rich'; SitLinked = @('acc-1', 'saf-1'); Params = @{ NoAI = $true } }
        # t/4074: NLI returns fewer results than pairs; the unlabelled pairs are unverified, with a WARN.
        @{ Name = 'nli-partial'; Data = 'rich'; Nli = 'partial'; Params = @{ NoAI = $true } }
    )
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'situation-candidates'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    $script:SavedTaxonomy = InModuleScope AITriad { $script:TaxonomyData }
    $script:SavedAiModel = $env:AI_MODEL

    # ── Fixture data ──────────────────────────────────────────────────────────
    # Node spec: id, pov, topic (null = no embedding), topic weight, extra node fields.
    # Same-topic nodes have cosine = w1 * w2 exactly; different topics have cosine 0.
    function script:Get-NodeSpecs([string]$Kind) {
        if ($Kind -eq 'oversized') {
            # Chosen so all 36 cross products differ by >= 0.0003 after rounding: no score ties.
            $a = @(0.978, 0.866, 0.987, 0.869, 0.886, 0.861)
            $b = @(0.889, 0.961, 0.914, 0.873, 0.941, 0.956)
            $specs = [System.Collections.Generic.List[object]]::new()
            for ($i = 0; $i -lt 6; $i++) { $specs.Add(@{ Id = "acc-o$($i+1)"; Pov = 'accelerationist'; Topic = 'o'; W = $a[$i] }) }
            for ($i = 0; $i -lt 6; $i++) { $specs.Add(@{ Id = "saf-o$($i+1)"; Pov = 'safetyist'; Topic = 'o'; W = $b[$i] }) }
            return $specs.ToArray()
        }
        @(
            @{ Id = 'acc-1'; Pov = 'accelerationist'; Topic = 't1'; W = 0.95; Extra = @{ graph_attributes = [ordered]@{ assumes = @('open weights', 'scaling') } } }
            @{ Id = 'acc-7'; Pov = 'accelerationist'; Topic = 't1'; W = 0.94 }
            @{ Id = 'saf-1'; Pov = 'safetyist'; Topic = 't1'; W = 0.93; Extra = @{ graph_attributes = [ordered]@{ assumes = 'scaling' } } }
            @{ Id = 'skp-1'; Pov = 'skeptic'; Topic = 't1'; W = 0.90 }
            @{ Id = 'acc-2'; Pov = 'accelerationist'; Topic = 't2'; W = 0.92 }
            @{ Id = 'saf-2'; Pov = 'safetyist'; Topic = 't2'; W = 0.90 }
            @{ Id = 'skp-2'; Pov = 'skeptic'; Topic = 't2'; W = 0.88 }
            @{ Id = 'acc-3'; Pov = 'accelerationist'; Topic = 't3'; W = 0.82 }
            @{ Id = 'saf-3'; Pov = 'safetyist'; Topic = 't3'; W = 0.80 }
            @{ Id = 'acc-4'; Pov = 'accelerationist'; Topic = 't4'; W = 0.81 }
            @{ Id = 'skp-4'; Pov = 'skeptic'; Topic = 't4'; W = 0.79 }
            @{ Id = 'acc-5'; Pov = 'accelerationist'; Topic = 't5'; W = 0.91 }
            @{ Id = 'saf-5'; Pov = 'safetyist'; Topic = 't5'; W = 0.89 }
            @{ Id = 'skp-5'; Pov = 'skeptic'; Topic = 't5'; W = 0.87 }
            @{ Id = 'acc-8'; Pov = 'accelerationist'; Topic = 't6'; W = 0.85; Extra = @{ graph_attributes = [ordered]@{ intellectual_lineage = 'Hayek'; assumes = $null } } }
            @{ Id = 'skp-8'; Pov = 'skeptic'; Topic = 't6'; W = 0.84; Extra = @{ description = $null; graph_attributes = [ordered]@{ intellectual_lineage = @('Popper') } } }
            @{ Id = 'saf-9'; Pov = 'safetyist'; Topic = $null; W = 0 }
            @{ Id = 'sit-1'; Pov = 'situations'; Topic = 't1'; W = 0.99 }
        )
    }

    # NLI label by sorted node-id pair; anything unlisted is 'entailment'.
    $global:FscNliLabels = @{
        'acc-2|saf-2' = 'contradiction'; 'acc-2|skp-2' = 'contradiction'
        'acc-3|saf-3' = 'neutral'
        'acc-4|skp-4' = 'contradiction'
        'acc-5|saf-5' = 'contradiction'; 'acc-5|skp-5' = 'contradiction'; 'saf-5|skp-5' = 'contradiction'
    }

    function script:Get-TaxonomyObjects([string]$Kind) {
        $byPov = [ordered]@{}
        foreach ($s in (script:Get-NodeSpecs $Kind)) {
            if (-not $byPov.Contains($s.Pov)) { $byPov[$s.Pov] = [System.Collections.Generic.List[object]]::new() }
            $n = [ordered]@{ id = $s.Id; label = "Label $($s.Id)"; description = "Description of $($s.Id)." }
            if ($s['Extra']) { foreach ($k in $s.Extra.Keys) { if ($null -eq $s.Extra[$k]) { $n.Remove($k) } else { $n[$k] = $s.Extra[$k] } } }
            $byPov[$s.Pov].Add($n)
        }
        $tax = @{}
        foreach ($pov in $byPov.Keys) {
            $json = [ordered]@{ nodes = $byPov[$pov].ToArray() } | ConvertTo-Json -Depth 10
            $tax[$pov] = $json | ConvertFrom-Json
        }
        $tax
    }

    function script:Get-EmbeddingsText([string]$Kind, [string]$Format) {
        $specs = @(script:Get-NodeSpecs $Kind | Where-Object { $_.Topic })
        $topics = @($specs | ForEach-Object { $_.Topic } | Select-Object -Unique)
        $dim = $topics.Count + $specs.Count
        $vectors = [ordered]@{}
        for ($i = 0; $i -lt $specs.Count; $i++) {
            $s = $specs[$i]
            $v = [double[]]::new($dim)
            $v[[array]::IndexOf($topics, $s.Topic)] = $s.W
            $v[$topics.Count + $i] = [Math]::Sqrt(1 - $s.W * $s.W)
            $vectors[$s.Id] = $v
        }
        if ($Format -eq 'flat') {
            $doc = [ordered]@{}; foreach ($k in $vectors.Keys) { $doc[$k] = $vectors[$k] }
        } else {
            $nodes = [ordered]@{}; foreach ($k in $vectors.Keys) { $nodes[$k] = [ordered]@{ vector = $vectors[$k] } }
            $doc = [ordered]@{ model = 'all-MiniLM-L6-v2'; nodes = $nodes }
        }
        ($doc | ConvertTo-Json -Depth 10 -Compress)
    }

    function script:Get-EdgesText {
        $e = @(
            [ordered]@{ source = 'saf-3'; target = 'acc-3'; type = 'TENSION_WITH'; status = 'approved' }
            [ordered]@{ source = 'acc-4'; target = 'skp-4'; type = 'CONTRADICTS'; status = 'proposed' }
            [ordered]@{ source = 'sit-1'; target = 'acc-1'; type = 'INTERPRETS'; status = 'approved' }
            [ordered]@{ source = 'acc-5'; target = 'saf-5'; type = 'CONTRADICTS' }
        )
        [ordered]@{ edges = $e } | ConvertTo-Json -Depth 10
    }

    # ── Fakes ─────────────────────────────────────────────────────────────────
    $global:FscAiResponses = @{
        rich    = "``````json`n" + '{ "candidates": [ { "cluster_id": "cluster-0", "label": "Scaling Path", "description": "Shared view on scaling.", "interpretations": { "accelerationist": "go", "safetyist": "careful" }, "confidence": 0.85, "rationale": "All agree." }, { "cluster_id": "cluster-2", "label": "Middle", "description": "", "interpretations": {}, "confidence": 0.65, "rationale": "r" }, { "cluster_id": "cluster-4", "label": "Contest", "description": "Contested ground.", "interpretations": null, "confidence": 0.55, "rationale": "r4" }, { "cluster_id": "cluster-99", "label": "Ghost" } ] }' + "`n``````"
        nofence = '{ "candidates": [ { "cluster_id": "cluster-0", "label": "Plain JSON", "description": "No fence.", "interpretations": {}, "confidence": 0.9, "rationale": "r" } ] }'
    }

    # A global function, not a Mock: Pester's mock of a native command doesn't receive piped stdin.
    # Runs in the global scope when the module calls it, so all its state is $global:.
    function global:python3 {
        $payload = @($input) -join "`n"
        $global:FscCalls.Add([ordered]@{ call = 'python3'; args = @($args | ForEach-Object { [string]$_ -replace '\\', '/' -replace '^.*/scripts/', '<ROOT>/scripts/' }); pairs = $payload })
        switch ($global:FscScenario['Nli']) {
            'throw'   { throw 'nli-classify: model download failed' }
            'badjson' { return 'Traceback (most recent call last): not json' }
        }
        $out = @(foreach ($p in @($payload | ConvertFrom-Json)) {
            $ids = @(([regex]::Matches("$($p.text_a) $($p.text_b)", 'Label ((?:acc|saf|skp)-\w+)') | ForEach-Object { $_.Groups[1].Value }) | Sort-Object)
            $key = $ids -join '|'
            $label = if ($global:FscNliLabels.ContainsKey($key)) { $global:FscNliLabels[$key] } elseif ($key -like 'acc-o*') { 'contradiction' } else { 'entailment' }
            [ordered]@{ nli_label = $label; nli_entailment = $(if ($label -eq 'entailment') { 0.9 } else { 0.05 }); nli_contradiction = $(if ($label -eq 'contradiction') { 0.9 } else { 0.05 }) }
        })
        # 'partial': the classifier stops early, returning results for all but the last 3 pairs.
        if ($global:FscScenario['Nli'] -eq 'partial') { $out = @($out | Select-Object -First ([Math]::Max(0, $out.Count - 3))) }
        ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
    }

    # ── Canonicalization ──────────────────────────────────────────────────────
    function script:ConvertTo-CanonicalNli([string]$Payload) {
        $pairs = foreach ($p in @($Payload | ConvertFrom-Json)) { (@([string]$p.text_a, [string]$p.text_b) | Sort-Object -CaseSensitive) -join ' <|> ' }
        , @($pairs | Sort-Object -CaseSensitive)
    }

    # Sort each run of consecutive lines matching $Pattern.
    function script:Sort-Runs([string[]]$Lines, [string]$Pattern) {
        $out = [System.Collections.Generic.List[string]]::new()
        $run = [System.Collections.Generic.List[string]]::new()
        foreach ($l in $Lines) {
            if ($l -match $Pattern) { $run.Add($l); continue }
            if ($run.Count) { $out.AddRange([string[]]@($run | Sort-Object -CaseSensitive)); $run.Clear() }
            $out.Add($l)
        }
        if ($run.Count) { $out.AddRange([string[]]@($run | Sort-Object -CaseSensitive)) }
        , $out.ToArray()
    }

    function script:Format-PovList([string]$Line) {
        [regex]::Replace($Line, '(POVs: )([a-z]+(?:, [a-z]+)*)', { param($m) $m.Groups[1].Value + ((@($m.Groups[2].Value -split ', ') | Sort-Object) -join ', ') })
    }

    function script:Format-ClusterText([string]$Text) {
        $lines = @(($Text -replace "`r`n", "`n") -split "`n" | ForEach-Object { script:Format-PovList $_ })
        (script:Sort-Runs $lines '^  - ') -join "`n"
    }

    # Console: member lines sorted; the two blocks around "vs." ordered by their first line.
    # The console's "  cluster-N: A / B" header carries the fallback label in member order.
    function script:Format-FallbackHeader([string]$Line) {
        if ($Line -notmatch '^(  cluster-\d+: )(.+)$') { return $Line }
        $prefix = $Matches[1]
        $parts = @($Matches[2] -split ' / ')
        if ($parts.Count -lt 2 -or @($parts | Where-Object { $_ -notmatch '^Label \S+$' }).Count) { return $Line }
        $prefix + ((@($parts | Sort-Object -CaseSensitive)) -join ' / ')
    }

    function script:Format-HostLines([string[]]$Lines) {
        $lines = @($Lines | ForEach-Object { script:Format-FallbackHeader (script:Format-PovList $_) })
        $memberRx = '^\[(Blue|Green|Yellow|Gray)\]       \['
        $sorted = script:Sort-Runs $lines $memberRx
        $out = [System.Collections.Generic.List[string]]::new()
        $i = 0
        while ($i -lt $sorted.Count) {
            if ($sorted[$i] -match $memberRx) {
                $a = [System.Collections.Generic.List[string]]::new()
                while ($i -lt $sorted.Count -and $sorted[$i] -match $memberRx) { $a.Add($sorted[$i]); $i++ }
                if ($i -lt $sorted.Count -and $sorted[$i] -eq '[DarkYellow]         vs.') {
                    $i++
                    $b = [System.Collections.Generic.List[string]]::new()
                    while ($i -lt $sorted.Count -and $sorted[$i] -match $memberRx) { $b.Add($sorted[$i]); $i++ }
                    $first, $second = if ([string]::CompareOrdinal($a[0], $b[0]) -le 0) { $a, $b } else { $b, $a }
                    $out.AddRange($first); $out.Add('[DarkYellow]         vs.'); $out.AddRange($second)
                } else { $out.AddRange($a) }
                continue
            }
            $out.Add($sorted[$i]); $i++
        }
        , $out.ToArray()
    }

    function script:Get-Prop($Obj, [string]$Name) {
        if ($Obj -is [System.Collections.IDictionary]) { if ($Obj.Contains($Name)) { return $Obj[$Name] } else { return $null } }
        if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name } else { $null }
    }

    # Result candidate: members/povs/sides sorted; the fallback "A / B" label sorted when it is one.
    function script:ConvertTo-CanonicalCandidate($C) {
        $o = [ordered]@{}
        foreach ($p in $C.PSObject.Properties) { $o[$p.Name] = $p.Value }
        $o.members = @(@($o.members) | Sort-Object { [string](script:Get-Prop $_ 'id') } -CaseSensitive)
        $o.povs_represented = @(@($o.povs_represented) | Sort-Object)
        if ($o.Contains('sides')) {
            # The cmdlet's @( @(A) @(B) ) flattens the two sides into one member list (pinned as-is),
            # so canonicalize the shape it actually has: a flat list sorts by id; a nested one (if the
            # sides are ever kept apart) sorts each side, then orders the sides, without unrolling them.
            $sides = @($o.sides)
            $nested = $sides.Count -gt 0 -and @($sides | Where-Object { $_ -is [System.Collections.IDictionary] -or $_ -is [pscustomobject] }).Count -eq 0
            if ($nested) {
                $inner = [System.Collections.Generic.List[object]]::new()
                foreach ($side in $sides) { $inner.Add(@(@($side) | Sort-Object { [string](script:Get-Prop $_ 'id') } -CaseSensitive)) }
                $order = @(0..($inner.Count - 1) | Sort-Object { [string](script:Get-Prop $inner[$_][0] 'id') } -CaseSensitive)
                $o.sides = @(foreach ($i in $order) { , $inner[$i] })
            } else {
                $o.sides = @($sides | Sort-Object { [string](script:Get-Prop $_ 'id') } -CaseSensitive)
            }
        }
        $memberLabels = @($o.members | ForEach-Object { [string](script:Get-Prop $_ 'label') })
        $parts = @(([string]$o.proposed_label) -split ' / ')
        if ($parts.Count -eq $memberLabels.Count -and @($parts | Where-Object { $_ -notin $memberLabels }).Count -eq 0) {
            $o.proposed_label = (@($parts | Sort-Object -CaseSensitive) -join ' / ') + '  (member order canonicalized)'
        }
        $o
    }

    function script:ConvertTo-CanonicalResult($R) {
        if ($null -eq $R) { return $null }
        $o = [ordered]@{}
        foreach ($k in $R.Keys) { $o[$k] = $R[$k] }
        $o.candidates = @(foreach ($c in @($R.candidates)) { script:ConvertTo-CanonicalCandidate ([pscustomobject]$c) })
        $o
    }

    function script:ConvertTo-Plain($Obj) {
        if ($null -eq $Obj) { return $null }
        if ($Obj -is [string] -or $Obj -is [ValueType]) { return $Obj }
        if ($Obj -is [System.Collections.Specialized.OrderedDictionary]) {
            $o = [ordered]@{}; foreach ($k in $Obj.Keys) { $o[[string]$k] = script:ConvertTo-Plain $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IDictionary]) {
            $o = [ordered]@{}; foreach ($k in @($Obj.Keys | Sort-Object)) { $o[[string]$k] = script:ConvertTo-Plain $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IEnumerable]) { return , @(foreach ($i in $Obj) { script:ConvertTo-Plain $i }) }
        if ($Obj -is [pscustomobject]) {
            $o = [ordered]@{}; foreach ($p in $Obj.PSObject.Properties) { $o[$p.Name] = script:ConvertTo-Plain $p.Value }; return $o
        }
        return [string]$Obj
    }

    function script:Invoke-Scenario($S) {
        $global:FscScenario = $S
        $script:FscRawResult = $null
        $global:FscCalls = [System.Collections.Generic.List[object]]::new()
        $script:FscWrites = [System.Collections.Generic.List[object]]::new()
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $taxDir = Join-Path $root 'taxonomy' 'Origin'
        New-Item -ItemType Directory -Path $taxDir -Force | Out-Null
        $script:FscRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:FscTaxDir = $taxDir
        if (-not $S['NoEmbeddings']) {
            [System.IO.File]::WriteAllText((Join-Path $taxDir 'embeddings.json'), (script:Get-EmbeddingsText $S.Data $S['EmbeddingsFormat']), $script:Utf8)
        }
        if (-not $S['NoEdges']) { [System.IO.File]::WriteAllText((Join-Path $taxDir 'edges.json'), (script:Get-EdgesText), $script:Utf8) }
        $tax = script:Get-TaxonomyObjects $S.Data
        if ($S['SitLinked']) {
            foreach ($n in @($tax['situations'].nodes)) { $n | Add-Member -NotePropertyName linked_nodes -NotePropertyValue @($S.SitLinked) -Force }
        }
        InModuleScope AITriad -Parameters @{ Tax = $tax } { param($Tax) $script:TaxonomyData = $Tax }
        if ($S['EnvModel']) { $env:AI_MODEL = $S.EnvModel } else { Remove-Item Env:AI_MODEL -ErrorAction SilentlyContinue }

        Mock Get-Date -ModuleName AITriad {
            $d = [datetime]::new(2026, 1, 2, 3, 4, 5, [System.DateTimeKind]::Utc)
            if (-not [string]::IsNullOrEmpty($Format)) { $d.ToString($Format, [cultureinfo]::InvariantCulture) } else { $d }
        }
        Mock Get-TaxonomyDir -ModuleName AITriad { $script:FscTaxDir }
        Mock Get-AITierModel -ModuleName AITriad {
            $global:FscCalls.Add([ordered]@{ call = 'tierModel'; tier = $Tier })
            'gemini-2.5-flash'
        }
        Mock Resolve-AIApiKey -ModuleName AITriad {
            $global:FscCalls.Add([ordered]@{ call = 'resolveKey'; explicitKey = $ExplicitKey; backend = $Backend })
            if ($global:FscScenario['NoKey']) { '' } else { "resolved-$Backend-key" }
        }
        Mock Get-Prompt -ModuleName AITriad {
            $rep = [ordered]@{}
            if ($Replacements) { foreach ($k in @($Replacements.Keys | Sort-Object)) { $rep[$k] = script:Format-ClusterText ([string]$Replacements[$k]) } }
            $global:FscCalls.Add([ordered]@{ call = 'prompt'; name = $Name; replacements = $rep })
            "<<$Name>>"
        }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:FscRoot.Length + 1).Replace('\', '/')
            $script:FscWrites.Add($rel)
            if ($global:FscScenario['DenyWrite']) { throw "BLOCK: $rel is not writable here" }
        }
        Mock Invoke-AIApi -ModuleName AITriad {
            $global:FscCalls.Add([ordered]@{
                    call = 'ai'; model = $Model; apiKey = $ApiKey; temperature = $Temperature; maxTokens = $MaxTokens
                    jsonMode = [bool]$JsonMode; maxRetries = $MaxRetries; retryDelays = @($RetryDelays); prompt = $Prompt
                })
            switch ($global:FscScenario['Ai']) {
                'throw' { throw '429 Too Many Requests' }
                'empty' { return $null }
            }
            $text = $global:FscAiResponses[$(if ($global:FscScenario['Ai']) { $global:FscScenario.Ai } else { 'nofence' })]
            [pscustomobject]@{ Text = $text; Backend = 'mock-backend' }
        }

        $p = @{} + $S.Params
        $p.RepoRoot = $root
        if ($S['OutputFile']) { $p.OutputFile = Join-Path $root $S.OutputFile }

        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        $result = $null
        try {
            Find-SituationCandidates @p -WarningVariable w -WarningAction SilentlyContinue 6>&1 | ForEach-Object { $records.Add($_) }
        } catch {
            # ActionableError text carries the platform newline (CRLF on Windows): normalise to LF.
            $err = $_.Exception.Message -replace "`r`n", "`n"
        }
        $hostLines = [System.Collections.Generic.List[string]]::new()
        $pending = ''
        foreach ($r in $records) {
            if ($r -isnot [System.Management.Automation.InformationRecord]) { $result = $r; $script:FscRawResult = $r; continue }
            $m = $r.MessageData
            $text = if ($m -is [System.Management.Automation.HostInformationMessage]) { "[$($m.ForegroundColor)] $($m.Message)" } else { "[info] $m" }
            if ($m -is [System.Management.Automation.HostInformationMessage] -and $m.NoNewLine) { $pending += $text + ' + '; continue }
            foreach ($l in (($pending + $text) -replace "`r`n", "`n") -split "`n") { $hostLines.Add($l) }
            $pending = ''
        }

        $written = $null
        if ($S['OutputFile']) {
            $path = Join-Path $root $S.OutputFile
            if (Test-Path -LiteralPath $path) {
                $bytes = [System.IO.File]::ReadAllBytes($path)
                $text = [System.Text.Encoding]::UTF8.GetString($bytes)
                # ConvertTo-Json writes the platform newline (CRLF on Windows, LF on Linux): count LF bytes.
                $written = [ordered]@{
                    bytesLf = [System.Text.Encoding]::UTF8.GetByteCount(($text -replace "`r`n", "`n"))
                    bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
                    content = script:ConvertTo-CanonicalResult ($text | ConvertFrom-Json -AsHashtable)
                }
            }
        }

        # The fixture root is a fresh GUID directory per run; mask it wherever a path is echoed.
        $mask = {
            param([string]$s)
            if ($null -eq $s) { return $null }
            $r = $s
            foreach ($p in @($script:FscRoot, $script:FscRoot.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
            if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
            $r
        }
        $hostMasked = @($hostLines | ForEach-Object { & $mask $_ })
        $hostLines = [System.Collections.Generic.List[string]]::new([string[]]$hostMasked)
        $w = @($w | ForEach-Object { & $mask ([string]$_) })
        $err = & $mask $err

        $calls = @(foreach ($c in $global:FscCalls) {
                if ($c.call -eq 'ai') { $c.prompt = script:Format-ClusterText ([string]$c.prompt) }
                if ($c.call -eq 'python3') { $c.pairs = script:ConvertTo-CanonicalNli ([string]$c.pairs) }
                $c
            })
        $t = [ordered]@{
            scenario = $S.Name
            host     = script:Format-HostLines $hostLines.ToArray()
            warnings = @($w | ForEach-Object { [string]$_ })
            error    = $err
            result   = script:ConvertTo-CanonicalResult $result
            calls    = $calls
            writes   = $script:FscWrites.ToArray()
            written  = $written
        }
        ((script:ConvertTo-Plain $t) | ConvertTo-Json -Depth 30) -replace "`r`n", "`n"
    }
}

AfterAll {
    InModuleScope AITriad -Parameters @{ Saved = $script:SavedTaxonomy } { param($Saved) $script:TaxonomyData = $Saved }
    if ($null -ne $script:SavedAiModel) { $env:AI_MODEL = $script:SavedAiModel } else { Remove-Item Env:AI_MODEL -ErrorAction SilentlyContinue }
    Remove-Item function:global:python3 -ErrorAction SilentlyContinue
    Remove-Variable -Scope Global -Name FscCalls, FscScenario, FscNliLabels, FscAiResponses -ErrorAction SilentlyContinue
}

Describe 'Find-SituationCandidates characterization (t/3910)' -Tag 'taxonomy' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:SITCAND_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: pin the discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name> shows <Text>' -ForEach @(
        @{ Name = 'rich';                         Text = 'NLI: 7 entailment, 1 neutral, 6 contradiction' }
        @{ Name = 'rich';                         Text = 'AI proposed 4 situation concepts (mock-backend)' }
        @{ Name = 'rich';                         Text = '         vs.' }
        @{ Name = 'rich';                         Text = 'Exported to' }
        @{ Name = 'nli-throws';                   Text = 'NLI classification failed: nli-classify: model download failed' }
        @{ Name = 'nli-bad-json';                 Text = 'NLI classification failed:' }
        @{ Name = 'ai-no-key-claude';             Text = 'No API key found for claude' }
        @{ Name = 'ai-empty-groq';                Text = 'AI returned no result' }
        @{ Name = 'ai-throws-unknown-prefix';     Text = 'AI labeling failed: 429 Too Many Requests' }
        @{ Name = 'ai-openai-prefix';             Text = '"backend": "openai"' }
        @{ Name = 'default-model-tier';           Text = '"tier": "basic"' }
        @{ Name = 'default-model-env';            Text = '"backend": "claude"' }
        @{ Name = 'outputfile-write-fails';       Text = 'Failed to write' }
        @{ Name = 'err-mutually-exclusive';       Text = '-ShowSharedOnly and -ShowDebatesOnly are mutually exclusive.' }
        @{ Name = 'err-no-embeddings';            Text = 'embeddings.json required for situation candidate discovery' }
        @{ Name = 'none-above-threshold';         Text = 'CROSS-CUTTING CANDIDATES — 0 found' }
        @{ Name = 'no-nli-no-ai-flat-embeddings'; Text = 'CROSS-CUTTING CANDIDATES — ' }
        @{ Name = 'nli-partial';                  Text = 'are treated as unverified' }
        @{ Name = 'err-mutually-exclusive';       Text = 'Resolve:' }
        @{ Name = 'err-no-embeddings';            Text = 'Resolve:' }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json"))
        $g.Contains($Text) | Should -BeTrue -Because "golden $Name should show: $Text"
    }

    # t/4074: a contested cluster's "sides" is two arrays of members, [[acc-2], [saf-2, skp-2]], not one
    # flat list (the @( @(A) @(B) ) form flattened it). Checked on the written -OutputFile as well, since
    # that is the export readers consume.
    It 'keeps the two sides of a 3-member contested cluster apart (rich cluster-4)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'rich.json')) | ConvertFrom-Json
        foreach ($cands in @(, @($g.result.candidates)) + @(, @($g.written.content.candidates))) {
            $c4 = @($cands | Where-Object cluster_id -eq 'cluster-4')[0]
            @($c4.sides).Count | Should -Be 2
            @(@($c4.sides)[0] | ForEach-Object { $_.id }) | Should -Be @('acc-2')
            @(@($c4.sides)[1] | ForEach-Object { $_.id }) | Should -Be @('saf-2', 'skp-2')
        }
        $g.host | Should -Contain '[DarkYellow]         vs.'
    }

    # t/4074: output order no longer depends on hashtable key order. The transcripts canonicalize order, so
    # this checks the raw result instead: members are sorted by id, and each pair's NLI payload is
    # oriented (smaller id first). Determinism across processes is additionally checked by running the
    # suite in several pwsh processes.
    It 'emits members in id order without canonicalization: <Name>' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in @('rich', 'topn-4-both-full', 'situation-linked', 'oversized-debate') }
    ) {
        $null = script:Invoke-Scenario $_
        $raw = $script:FscRawResult
        @($raw.candidates).Count | Should -BeGreaterThan 0
        foreach ($c in @($raw.candidates)) {
            $ids = @($c.members | ForEach-Object { $_.id })
            $ids | Should -Be @($ids | Sort-Object)
            if ($c.PSObject.Properties['sides']) {
                $sides = @($c.sides)
                $sides.Count | Should -Be 2
                foreach ($side in $sides) { $sideIds = @($side | ForEach-Object { $_.id }); $sideIds | Should -Be @($sideIds | Sort-Object) }
                [string]@($sides[0])[0].id | Should -BeLessThan ([string]@($sides[1])[0].id)
            }
        }
    }

    It 'oversized debate cluster (>10 nodes) falls back to its constituent pairs' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'oversized-debate.json')) | ConvertFrom-Json
        @($g.result.candidates).Count | Should -Be 30
        @($g.result.candidates | Where-Object { @($_.members).Count -ne 2 }).Count | Should -Be 0
    }

    It 'writes only -OutputFile, once: <Name>' -ForEach $script:Scenarios {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$($_.Name).json")) | ConvertFrom-Json
        $expected = if ($_['OutputFile']) { @($_.OutputFile) } else { @() }
        @($g.writes) | Should -Be $expected
    }
}
