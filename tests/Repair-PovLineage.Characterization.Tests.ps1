# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Repair-PovLineage (t/3910), written BEFORE its complexity refactor and
    required to pass unchanged after it.
.DESCRIPTION
    Each scenario runs Repair-PovLineage end to end (default enrich mode, -FixUrls, -RegenerateContent)
    against a fixture data tree in $TestDrive and compares a full transcript to a golden in
    tests/fixtures/pov-lineage/<scenario>.json:
      - every host line (text, colour, no-newline flag), warning and verbose message;
      - the thrown error's message, if any;
      - every Resolve-AIApiKey, Get-Prompt, Get-TextEmbedding, Invoke-AIApi, Test-LineageUrl and
        Start-Sleep call, in order;
      - every Set-Content call (path, encoding) and every Assert-DataWriteAllowed guard call, in order;
      - the file tree afterwards, every file's full text.
    Nothing can reach a network or a live AI backend: Invoke-AIApi, Get-TextEmbedding and
    Test-LineageUrl are mocked per scenario. Every scenario passes Model explicitly (through a splat),
    so the goldens do not depend on the basic-tier default.
    Normalizations, each originally forced by the code under test. Since t/4077 the code writes in a fixed
    (ordinal) order and the dedicated raw-order tests below pin it; the normalizations are kept so the
    goldens stay comparable across that change:
      - runs of POV-file writes, "Saved <pov>.json" host lines and the apply loop's verbose lines
        (ShouldProcess + per-node) are sorted ($TaxData, $PovModified);
      - runs of "Sample merges" lines are sorted ($DedupMap);
      - lineage-enrichments.json is compared as canonical JSON (keys sorted);
      - CRLF is folded to LF (ConvertTo-Json and Set-Content emit the platform newline).
    Regenerate the goldens ONLY for an intended behaviour change: set $env:POVLINEAGE_REGEN_GOLDEN = '1',
    run once, and check `git diff --stat` lists exactly the goldens that change was meant to change.
#>

# ── Shared fixture pieces ─────────────────────────────────────────────────────
$script:EnrichResponse = @'
```json
[
  {"name":"Effective Altruism","description":"A philosophical and social movement that uses evidence and reason to work out how to benefit others as much as possible.","url":"https://ea.example/ok","category":"philosophical_movement"},
  {"name":"Utilitarianism","description":"Short.","url":"https://util.example/dead","category":"ethical_framework"},
  {"name":"Longtermism","description":"The view that positively influencing the long-term future is a key moral priority.","url":"https://lt.example/dead","category":"ethical_framework"},
  {"name":"Accelerationism","description":"Speeding up processes of capitalist growth and technological change.","url":"","category":"political_philosophy"},
  {"name":"Effective-Altruism","description":"Near duplicate of an earlier entry.","url":"https://dup.example","category":"philosophical_movement"},
  {"description":"An entry with no name: the StrictMode dereference throws and the batch reports failed.","url":"https://x.example","category":"other"}
]
```
Hope this helps! [1]
'@

$script:Scenarios = @(
    # Default mode: one AI batch, fenced response with trailing text, URL validation with Wikipedia
    # fallback and clearing, the Jaccard dedup guard, whitespace and rich entries left alone.
    @{ Name = 'enrich'; Tax = 'basic'
       Params = @{ Model = 'gemini-2.5-flash' }
       Ai = @($script:EnrichResponse)
       ValidUrls = @('https://ea.example/ok', 'https://en.wikipedia.org/wiki/Utilitarianism') }

    # Three batches (BatchSize 5): ok without fences, no response, throw. Claude backend, cached stale
    # entry (empty description), no URL validation.
    @{ Name = 'batches'; Tax = 'eleven'; Cache = 'stale'
       Params = @{ Model = 'claude-haiku-4-5'; BatchSize = 5; SkipUrlValidation = $true; ApiKey = 'explicit-key' }
       Ai = @('BATCH1', 'NULL', 'THROW:429 Too Many Requests') }

    # No API key: warns and applies cached enrichments only. Unknown model prefix resolves as gemini.
    @{ Name = 'no-key'; Tax = 'basic'; Cache = 'partial'; NoKey = $true
       Params = @{ Model = 'groq-openai-gpt-oss-20b'; SkipUrlValidation = $true } }

    # The separate URL-validation pass over cache entries that have no url_status yet.
    @{ Name = 'url-phase'; Tax = 'urlphase'; Cache = 'nostatus'
       Params = @{ Model = 'gemini-2.5-flash' }
       ValidUrls = @('https://c.example/ok', 'https://en.wikipedia.org/wiki/Dee') }

    # -Force turns rich entries back into bare strings, then re-applies them from the cache.
    @{ Name = 'force'; Tax = 'rich'; Cache = 'rich'
       Params = @{ Model = 'gemini-2.5-flash'; Force = $true; SkipUrlValidation = $true } }

    # Node filter from the pipeline (Id property, a blank id dropped). The apply step is not filtered.
    @{ Name = 'node-filter'; Tax = 'basic'; Cache = 'full'; Pipe = @('acc-2', ' ')
       Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true } }

    # Embedding dedup: base-then-qualified merge, frequency merge, a value with no embedding.
    @{ Name = 'dedup-a'; Tax = 'dedupA'; Cache = 'dedupA'; Embeddings = 'dedupA'
       Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true } }

    # Embedding dedup: qualified-then-base (self map) and two qualified variants of one base.
    @{ Name = 'dedup-b'; Tax = 'dedupB'; Cache = 'dedupB'; Embeddings = 'dedupB'
       Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true } }

    # Two POV files both get rewritten (write order follows a hashtable; see normalizations).
    @{ Name = 'multi-pov'; Tax = 'multi'; Cache = 'multi'
       Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true } }

    # -POV restricts collection; another POV's bare strings stay bare.
    @{ Name = 'pov-filter'; Tax = 'multi'; Cache = 'multi'
       Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true; POV = 'skeptic' } }

    @{ Name = 'whatif'; Tax = 'many'; Cache = 'partial'; Embeddings = 'many'
       Params = @{ Model = 'gemini-2.5-flash'; WhatIf = $true } }
    @{ Name = 'no-values'; Tax = 'none'; Params = @{ Model = 'gemini-2.5-flash' } }

    @{ Name = 'fixurls-empty-cache'; Tax = 'basic'; Params = @{ Model = 'gemini-2.5-flash'; FixUrls = $true } }
    @{ Name = 'fixurls'; Tax = 'fixurls'; Cache = 'fixurls'
       Params = @{ Model = 'gemini-2.5-flash'; FixUrls = $true }
       ValidUrls = @('https://gt.example/now-ok', 'https://en.wikipedia.org/wiki/Longtermism') }
    @{ Name = 'fixurls-whatif'; Tax = 'fixurls'; Cache = 'fixurls'
       Params = @{ Model = 'gemini-2.5-flash'; FixUrls = $true; WhatIf = $true } }

    # -RegenerateContent: two batches; one long description replaces, one short does not, a node
    # with an empty array and a node missing from the response count as failed.
    @{ Name = 'regen'; Tax = 'regen'
       Params = @{ Model = 'gemini-2.5-flash'; RegenerateContent = $true; POV = 'accelerationist'; NodeBatchSize = 2 }
       Ai = @('REGEN1', 'REGEN2') }
    # -RegenerateContent failure arms: no response, throw, then success. Claude backend.
    @{ Name = 'regen-failures'; Tax = 'regen'
       Params = @{ Model = 'claude-haiku-4-5'; RegenerateContent = $true; NodeBatchSize = 1 }
       Ai = @('NULL', 'THROW:500 Internal Server Error', 'REGEN-R5') }
    @{ Name = 'regen-no-key'; Tax = 'regen'; NoKey = $true
       Params = @{ Model = 'gemini-2.5-flash'; RegenerateContent = $true } }
    @{ Name = 'regen-whatif'; Tax = 'regen6'
       Params = @{ Model = 'gemini-2.5-flash'; RegenerateContent = $true; WhatIf = $true } }
)

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    . (Join-Path $PSScriptRoot 'HostCapture.ps1')
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'pov-lineage'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    $script:CacheRel = 'calibration/core/lineage-enrichments.json'
    $script:LongDesc = 'A long, multi-sentence description that is comfortably over one hundred characters, so the regenerate path accepts it as a replacement.'

    function script:Write-FixtureFile([string]$Path, [string]$Text) {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $script:Utf8)
    }
    function script:ConvertTo-FixtureJson($Obj) { ($Obj | ConvertTo-Json -Depth 20) -replace "`r`n", "`n" }

    function script:Rich([string]$Name, [string]$Url, [string]$Category = 'other') {
        [ordered]@{ name = $Name; description = "Old description of $Name."; url = $Url; category = $Category }
    }
    function script:LinNode([string]$Id, [object[]]$Lineage, [hashtable]$Extra) {
        $n = [ordered]@{ id = $Id; label = "Label $Id"; description = "Description of $Id."
                         graph_attributes = [ordered]@{ epistemic_type = 'normative'; intellectual_lineage = @($Lineage) } }
        if ($Extra) { foreach ($k in $Extra.Keys) { if ($null -eq $Extra[$k]) { $n.Remove($k) } else { $n[$k] = $Extra[$k] } } }
        $n
    }
    function script:CacheEntry([string]$Desc, [string]$Url, $Status, [string]$Category = 'other', [switch]$NoStatus) {
        $e = [ordered]@{ description = $Desc; url = $Url }
        if (-not $NoStatus) { $e.url_status = $Status }
        $e.category = $Category
        $e
    }

    function script:Get-TaxonomyFiles([string]$Kind) {
        switch ($Kind) {
            'basic' {
                [ordered]@{
                    'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @('Effective Altruism', 'Utilitarianism', 'Longtermism'))
                            (script:LinNode 'acc-2' @('effective altruism', (script:Rich 'Cybernetics' 'https://old.example/cyb' 'scientific_paradigm'), '  ', 'Accelerationism'))
                            [ordered]@{ id = 'acc-3'; label = 'No attributes' }
                            [ordered]@{ id = 'acc-4'; label = 'Null attributes'; graph_attributes = $null }
                            [ordered]@{ id = 'acc-5'; label = 'No lineage'; graph_attributes = [ordered]@{ epistemic_type = 'empirical' } }
                        ) }
                    'safetyist.json' = @{ nodes = @(
                            (script:LinNode 'saf-1' @())
                            [ordered]@{ id = 'saf-2'; label = 'No attributes' }
                        ) }
                }
            }
            'eleven' {
                $vals = @('Stale Thing', 'Cached Thing') + @(1..10 | ForEach-Object { "Doctrine $_" })
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' $vals[0..5])
                            (script:LinNode 'acc-2' $vals[6..11])
                        ) } }
            }
            'urlphase' {
                [ordered]@{ 'skeptic.json' = @{ nodes = @( (script:LinNode 'skp-1' @('Ay', 'Bee', 'Cee', 'Dee', 'Eee')) ) } }
            }
            'rich' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @((script:Rich 'Cybernetics' 'https://old.example/cyb'), 'Game Theory', [ordered]@{ note = 'no name property' }))
                            (script:LinNode 'acc-2' @([ordered]@{ name = ''; description = 'empty name' }))
                        ) } }
            }
            'dedupA' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @("Asimov's Laws", "Asimov's Laws (conceptual)", 'Techno-optimism'))
                            (script:LinNode 'acc-2' @('Techno Optimism', 'Obscure Doctrine'))
                            (script:LinNode 'acc-3' @('Techno Optimism', 'Game Theory'))
                        ) } }
            }
            'dedupB' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @('Marxism (classical)', 'Realism (international relations)'))
                            (script:LinNode 'acc-2' @('Marxism', 'Realism (philosophy)'))
                        ) } }
            }
            'multi' {
                [ordered]@{
                    'accelerationist.json' = @{ nodes = @( (script:LinNode 'acc-1' @('Game Theory', 'Cybernetics')) ) }
                    'skeptic.json'         = @{ nodes = @( (script:LinNode 'skp-1' @('Cybernetics', 'Luddism')) ) }
                }
            }
            'many' {
                $vals = @(1..18 | ForEach-Object { "Value $_" }) + @("Asimov's Laws", "Asimov's Laws (conceptual)")
                [ordered]@{
                    'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' $vals[0..9])
                            (script:LinNode 'acc-2' $vals[10..19])
                            [ordered]@{ id = 'acc-3'; label = 'No attributes' }
                        ) }
                    'safetyist.json' = @{ nodes = @( (script:LinNode 'saf-1' @('Value 1', (script:Rich 'Cybernetics' 'https://old.example/cyb'))) ) }
                }
            }
            'none' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @((script:Rich 'Cybernetics' 'https://old.example/cyb')))
                            (script:LinNode 'acc-2' @('   '))
                        ) } }
            }
            'fixurls' {
                [ordered]@{
                    'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'acc-1' @((script:Rich 'Game Theory' 'https://gt.example/now-ok'), (script:Rich 'Longtermism' 'https://lt.example/dead'), 'Bare Value'))
                            (script:LinNode 'acc-2' @((script:Rich 'Obscure (doctrine)' ''), (script:Rich 'Not Cached' 'https://nc.example')))
                            [ordered]@{ id = 'acc-3'; label = 'No attributes' }
                        ) }
                    'skeptic.json' = @{ nodes = @( (script:LinNode 'skp-1' @((script:Rich 'Cybernetics' 'https://stale.example/cyb'))) ) }
                }
            }
            'regen' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(
                            (script:LinNode 'r-1' @((script:Rich 'Alpha' 'https://a.example' 'social_theory'), (script:Rich 'Beta' 'https://b.example'), 'bare Gamma') @{ category = 'Beliefs' })
                            (script:LinNode 'r-2' @((script:Rich 'Delta' $null)) @{ description = $null })
                            (script:LinNode 'r-3' @('bare only'))
                            (script:LinNode 'r-4' @())
                            (script:LinNode 'r-5' @((script:Rich 'Epsilon' 'https://e.example')) @{ category = 'Desires' })
                        ) } }
            }
            'regen6' {
                [ordered]@{ 'accelerationist.json' = @{ nodes = @(1..6 | ForEach-Object {
                                script:LinNode "r-$_" @((script:Rich "Name $_" "https://n$_.example")) @{ category = 'Beliefs' } }) } }
            }
            default { [ordered]@{} }
        }
    }

    function script:Get-CacheData([string]$Kind) {
        switch ($Kind) {
            'stale' {
                [ordered]@{
                    'Stale Thing'  = (script:CacheEntry '' 'https://stale.example' 200)
                    'Cached Thing' = (script:CacheEntry 'Already enriched.' 'https://cached.example' 200 'social_theory')
                }
            }
            'partial' {
                [ordered]@{
                    'Effective Altruism' = (script:CacheEntry 'Cached EA description.' 'https://ea.example/ok' 200 'philosophical_movement')
                    'Value 1'            = (script:CacheEntry 'Cached value one.' $null 'cleared')
                }
            }
            'full' {
                [ordered]@{
                    'Effective Altruism' = (script:CacheEntry 'Cached EA.' 'https://ea.example/ok' 200 'philosophical_movement')
                    'Utilitarianism'     = (script:CacheEntry 'Cached U.' 'https://u.example' 200 'ethical_framework')
                    'Longtermism'        = (script:CacheEntry 'Cached L.' $null 'cleared' 'ethical_framework')
                    'Accelerationism'    = (script:CacheEntry 'Cached A.' 'https://acc.example' 200 'political_philosophy')
                }
            }
            'nostatus' {
                [ordered]@{
                    'Ay'  = (script:CacheEntry 'No url at all.' $null $null -NoStatus)
                    'Bee' = (script:CacheEntry 'Not http.' 'ftp://bee.example' $null -NoStatus)
                    'Cee' = (script:CacheEntry 'Valid url.' 'https://c.example/ok' $null -NoStatus)
                    'Dee' = (script:CacheEntry 'Dead url, wiki ok.' 'https://d.example/dead' $null -NoStatus)
                    'Eee' = (script:CacheEntry 'Dead url, no wiki.' 'https://e.example/dead' $null -NoStatus)
                }
            }
            'rich' {
                [ordered]@{
                    'Cybernetics' = (script:CacheEntry 'Cached cybernetics.' 'https://cyb.example' 200 'scientific_paradigm')
                    'game theory' = (script:CacheEntry 'Cached game theory (lower-case key).' 'https://gt.example' 200 'academic_discipline')
                }
            }
            'dedupA' {
                [ordered]@{
                    "Asimov's Laws"    = (script:CacheEntry 'Laws of robotics.' 'https://asimov.example' 200)
                    'Techno Optimism'  = (script:CacheEntry 'Optimism about technology.' 'https://to.example' 200)
                    'Obscure Doctrine' = (script:CacheEntry 'Rare.' $null 'cleared')
                    'Game Theory'      = (script:CacheEntry 'Strategic interaction.' 'https://gt.example' 200)
                }
            }
            'dedupB' {
                [ordered]@{
                    'Marxism' = (script:CacheEntry 'Marx.' 'https://marx.example' 200)
                    'Realism' = (script:CacheEntry 'Realism base.' 'https://realism.example' 200)
                }
            }
            'multi' {
                [ordered]@{
                    'Game Theory' = (script:CacheEntry 'GT.' 'https://gt.example' 200)
                    'Cybernetics' = (script:CacheEntry 'Cyb.' 'https://cyb.example' 200)
                    'Luddism'     = (script:CacheEntry 'Lud.' $null 'cleared')
                }
            }
            'fixurls' {
                [ordered]@{
                    'Cybernetics'        = (script:CacheEntry 'Cyb.' 'https://cyb.example/ok' 200)
                    'Game Theory'        = (script:CacheEntry 'GT.' 'https://gt.example/now-ok' 404)
                    'Longtermism'        = (script:CacheEntry 'LT.' 'https://lt.example/dead' $null -NoStatus)
                    'Obscure (doctrine)' = (script:CacheEntry 'Ob.' '' $null -NoStatus)
                }
            }
            default { $null }
        }
    }

    # Unit vectors in 4 dimensions; cosine is the dot product (the code assumes normalized vectors).
    function script:Get-EmbeddingSpec([string]$Kind) {
        $x = [double[]]@(1, 0, 0, 0); $y = [double[]]@(0, 1, 0, 0); $z = [double[]]@(0, 0, 1, 0); $w = [double[]]@(0, 0, 0, 1)
        $nearX = [double[]]@(0.95, 0.3122498999, 0, 0); $nearY = [double[]]@(0.3122498999, 0.95, 0, 0)
        switch ($Kind) {
            'dedupA' { @{ "Asimov's Laws" = $x; "Asimov's Laws (conceptual)" = $nearX; 'Techno-optimism' = $y; 'Techno Optimism' = $nearY; 'Game Theory' = $z } }
            'dedupB' { @{ 'Marxism (classical)' = $x; 'Marxism' = $nearX; 'Realism (international relations)' = $y; 'Realism (philosophy)' = $nearY } }
            'many'   { @{ "Asimov's Laws" = $x; "Asimov's Laws (conceptual)" = $nearX; 'Value 1' = $w } }
            default  { $null }
        }
    }

    function script:Get-AiText([string]$Token, [string]$Prompt) {
        switch ($Token) {
            'BATCH1' {
                $list = ($Prompt -split 'Entries to enrich:', 2)[1] -split "`r?`n`r?`n", 2 | Select-Object -First 1
                $names = @([regex]::Matches($list, '(?m)^- (.+?)\r?$') | ForEach-Object { $_.Groups[1].Value })
                ConvertTo-Json -Compress -InputObject @($names | ForEach-Object {
                        [ordered]@{ name = $_; description = "Enriched $_ with a description that runs past sixty characters easily."; url = "https://w.example/$($_ -replace ' ', '_')"; category = 'other' } })
            }
            'REGEN1' {
                @"
``````json
{"r-1":[{"name":"Alpha","description":"$($script:LongDesc)","url":"ignored","category":"ignored"},{"name":"Beta","description":"Too short."},{"name":"Zeta","description":"$($script:LongDesc)"}],"r-2":[]}
``````
trailing words
"@
            }
            'REGEN2'   { '{"someone-else":[]}' }
            'REGEN-R5' { '{"r-5":[{"name":"Epsilon","description":"' + $script:LongDesc + '"}]}' }
            default    { $Token }
        }
    }

    # Builds the fixture tree for a scenario and returns its root.
    function script:New-LineageFixture($S) {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $tax = Join-Path $root 'taxonomy' 'Origin'
        New-Item -ItemType Directory -Path $tax -Force | Out-Null
        $files = script:Get-TaxonomyFiles $S['Tax']
        foreach ($name in @($files.Keys)) { script:Write-FixtureFile (Join-Path $tax $name) (script:ConvertTo-FixtureJson $files[$name]) }
        if ($S['Cache']) {
            script:Write-FixtureFile (Join-Path $root $script:CacheRel) (script:ConvertTo-FixtureJson (script:Get-CacheData $S.Cache))
        }
        $root
    }

    function script:Format-Masked([string]$s) {
        if ($null -eq $s) { return $null }
        $r = $s -replace "`r`n", "`n"
        foreach ($p in @($script:RootCurrent, $script:RootCurrent.Replace('\', '/'))) { $r = $r.Replace($p, '<ROOT>') }
        if ($r.Contains('<ROOT>')) { $r = $r.Replace('\', '/') }
        $r
    }

    function script:ConvertTo-Canonical($Obj, [switch]$SortAll) {
        if ($null -eq $Obj) { return $null }
        if ($Obj -is [string]) { return (script:Format-Masked $Obj) }
        if (-not $SortAll -and $Obj -is [System.Collections.Specialized.OrderedDictionary]) {
            $o = [ordered]@{}; foreach ($k in $Obj.Keys) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] }; return $o
        }
        if ($Obj -is [System.Collections.IDictionary]) {
            $o = [ordered]@{}; foreach ($k in @($Obj.Keys | Sort-Object -CaseSensitive)) { $o[[string]$k] = script:ConvertTo-Canonical $Obj[$k] -SortAll:$SortAll }; return $o
        }
        if ($Obj -is [System.Collections.IEnumerable]) { return , @(foreach ($i in $Obj) { script:ConvertTo-Canonical $i -SortAll:$SortAll }) }
        if ($Obj -is [pscustomobject]) {
            $o = [ordered]@{}; foreach ($p in $Obj.PSObject.Properties) { $o[$p.Name] = script:ConvertTo-Canonical $p.Value -SortAll:$SortAll }; return $o
        }
        if ($Obj -is [switch]) { return [bool]$Obj }
        return $Obj
    }

    # Every file's text. The cache is compared as canonical JSON: its new entries are plain hashtables
    # whose serialized key order varies per process.
    function script:Get-Tree([string]$Root) {
        $tree = [ordered]@{}
        if (-not (Test-Path -LiteralPath $Root)) { return $tree }
        $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | ForEach-Object {
                [pscustomobject]@{ Rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/'); Item = $_ } })
        foreach ($e in @($items | Sort-Object { $_.Rel } -CaseSensitive)) {
            if ($e.Item.PSIsContainer) { $tree[$e.Rel + '/'] = '(dir)'; continue }
            $text = [System.IO.File]::ReadAllText($e.Item.FullName) -replace "`r`n", "`n"
            if ($e.Rel -eq $script:CacheRel) {
                $parsed = $text | ConvertFrom-Json -AsHashtable
                $text = 'canonical: ' + ((script:ConvertTo-Canonical $parsed -SortAll | ConvertTo-Json -Depth 10 -Compress) -replace "`r`n", "`n")
            }
            $tree[$e.Rel] = $text
        }
        $tree
    }

    # Sorts each contiguous run of lines matching $Pattern (order-only nondeterminism in the code).
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

    function script:Invoke-Scenario($S) {
        $script:Calls  = [System.Collections.Generic.List[object]]::new()
        $script:Writes = [System.Collections.Generic.List[string]]::new()
        $script:Guards = [System.Collections.Generic.List[string]]::new()
        $script:AiIndex = 0
        $script:S = $S
        $root = script:New-LineageFixture $S
        $script:RootCurrent = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $script:RootFixture = $root

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
        Mock Get-TextEmbedding -ModuleName AITriad {
            $script:Calls.Add([ordered]@{ call = 'embed'; texts = @($Texts); ids = @($Ids) })
            $spec = script:Get-EmbeddingSpec $script:S['Embeddings']
            if ($null -eq $spec) { return $null }
            $h = @{}
            foreach ($id in @($Ids)) { if ($spec.ContainsKey($id)) { $h[$id] = $spec[$id] } }
            $h
        }
        Mock Test-LineageUrl -ModuleName AITriad {
            $ok = $script:S['ValidUrls'] -and ($Url -in $script:S.ValidUrls)
            $script:Calls.Add([ordered]@{ call = 'testUrl'; url = [string]$Url; result = [bool]$ok })
            [bool]$ok
        }
        Mock Start-Sleep -ModuleName AITriad { $script:Calls.Add([ordered]@{ call = 'sleep'; seconds = $Seconds }) }
        Mock Assert-DataWriteAllowed -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            # A same-run rewrite of the lineage cache passes -AllowDirty (t/4077 item 6); record it.
            if ($AllowDirty) { $rel += ' [AllowDirty]' }
            $script:Guards.Add($rel)
        }
        Mock Set-Content -ModuleName AITriad {
            $rel = ([System.IO.Path]::GetFullPath($Path)).Substring($script:RootCurrent.Length + 1).Replace('\', '/')
            $enc = if ($Encoding -is [System.Text.Encoding]) { "$($Encoding.WebName), bom=$($Encoding.GetPreamble().Length -gt 0)" } else { [string]$Encoding }
            $script:Writes.Add("$rel (encoding=$enc)")
            $text = (@($Value) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
            [System.IO.File]::WriteAllText($Path, $text + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
        }
        Mock Invoke-AIApi -ModuleName AITriad {
            $script:AiIndex++
            $script:Calls.Add([ordered]@{
                    call = 'ai'; index = $script:AiIndex; model = $Model; apiKey = $ApiKey; temperature = $Temperature
                    maxTokens = $MaxTokens; jsonMode = [bool]$JsonMode; timeoutSec = $TimeoutSec
                    system = $SystemInstruction; prompt = script:Format-Masked $Prompt
                })
            $tokens = @($script:S['Ai'])
            $token = if ($script:AiIndex -le $tokens.Count) { $tokens[$script:AiIndex - 1] } else { 'NULL' }
            if ($token -like 'THROW:*') { throw $token.Substring(6) }
            if ($token -eq 'NULL') { return $null }
            [pscustomobject]@{ Text = (script:Get-AiText $token $Prompt); Backend = 'mock-backend' }
        }

        $p = @{} + $S.Params
        $records = [System.Collections.Generic.List[object]]::new()
        $err = $null
        $w = $null
        Register-HostCaptureMock
        try {
            if ($S['Pipe']) {
                @($S.Pipe | ForEach-Object { [pscustomobject]@{ Id = $_ } }) |
                    Repair-PovLineage @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
            }
            else {
                Repair-PovLineage @p -Verbose -WarningVariable w -WarningAction SilentlyContinue 4>&1 6>&1 | ForEach-Object { $records.Add($_) }
            }
        }
        catch {
            $err = $_.Exception.Message
        }
        $hostLines = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object {
                $m = $_.MessageData
                $h = Get-HostCaptureParts $m
                if ($h) {
                    $nn = if ($h.NoNewLine) { '[nn]' } else { '' }
                    "[$($h.Color)]$nn $(script:Format-Masked $h.Message)"
                } else { "[info] $m" }
            })
        $hostLines = script:Sort-Runs $hostLines '^\[Green\] +Saved \w+\.json$'
        $hostLines = script:Sort-Runs $hostLines "^\[DarkGray\]     '"
        $verbose = @($records | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object { script:Format-Masked $_.Message })
        # The apply loop's ShouldProcess line and per-node line interleave, both in $TaxData order.
        $verbose = script:Sort-Runs $verbose '^(  \S+ \[(accelerationist|safetyist|skeptic|situations)\]: |Performing the operation "Enrich lineage" on target )'
        $output  = @($records | Where-Object { $_ -isnot [System.Management.Automation.VerboseRecord] -and $_ -isnot [System.Management.Automation.InformationRecord] })

        $t = [ordered]@{
            scenario = $S.Name
            host     = $hostLines
            warnings = @($w | ForEach-Object { [string]$_ })
            verbose  = $verbose
            error    = $err
            output   = $output
            calls    = $script:Calls.ToArray()
            guards   = script:Sort-Runs $script:Guards.ToArray() '^taxonomy/Origin/\w+\.json$'
            writes   = script:Sort-Runs $script:Writes.ToArray() '^taxonomy/Origin/\w+\.json '
            tree     = script:Get-Tree $root
        }
        ((script:ConvertTo-Canonical $t) | ConvertTo-Json -Depth 30) -replace "`r`n", "`n"
    }
}

Describe 'Repair-PovLineage characterization (t/3910)' -Tag 'taxonomy' {

    It 'matches the golden transcript: <Name>' -ForEach $script:Scenarios {
        $actual = script:Invoke-Scenario $_
        $golden = Join-Path $script:GoldenDir "$($_.Name).json"
        if ($env:POVLINEAGE_REGEN_GOLDEN -eq '1') {
            New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
            [System.IO.File]::WriteAllText($golden, $actual + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
        $actual | Should -BeExactly $expected
    }

    # Branch witnesses: pin the discriminating fact per scenario independently of the golden text.
    It 'exercises the intended branch: <Name> shows <Text>' -ForEach @(
        @{ Name = 'enrich';              Text = "Dedup guard: 'Effective-Altruism' → existing 'Effective Altruism'" }
        @{ Name = 'enrich';              Text = "URL fallback: 'Utilitarianism' → Wikipedia" }
        @{ Name = 'enrich';              Text = "URL cleared: 'Longtermism' (invalid, no Wikipedia)" }
        @{ Name = 'enrich';              Text = "Lineage enrichment: skipped an AI entry with no 'name'" }      # t/4077 item 1
        @{ Name = 'enrich';              Text = '  5 enriched' }                                                  # t/4077 item 1
        @{ Name = 'batches';             Text = "Refreshed stale cache entry: 'Stale Thing'" }                     # t/4077 item 3
        @{ Name = 'force';               Text = 'Need enrichment: 0' }                                             # t/4077 item 4
        @{ Name = 'node-filter';         Text = 'Need enrichment: 0' }                                             # t/4077 item 4
        @{ Name = 'batches';             Text = "'Doctrine 2'" }                                                  # t/4077 item 2: cached as its own entry
        @{ Name = 'batches';             Text = ' failed: 429 Too Many Requests' }
        @{ Name = 'batches';             Text = ' no response' }
        @{ Name = 'no-key';              Text = 'No API key — can only apply cached enrichments' }
        @{ Name = 'url-phase';           Text = 'Valid: 1 | Wiki fallback: 1 | Cleared: 1 | Skipped: 2' }
        @{ Name = 'force';               Text = 'Force mode: rich lineage objects converted to bare strings for re-enrichment' }
        @{ Name = 'node-filter';         Text = 'Filtering to 1 node ID(s): acc-2' }
        @{ Name = 'dedup-a';             Text = 'Dedup: 6 → 4 canonical values (2 merged)' }
        @{ Name = 'dedup-b';             Text = "'Marxism' → 'Marxism'" }
        @{ Name = 'whatif';              Text = '... and 3 more' }
        @{ Name = 'no-values';           Text = 'No bare-string lineage entries to process.' }
        @{ Name = 'fixurls-empty-cache'; Text = 'Cache is empty — run Repair-PovLineage first to populate it' }
        @{ Name = 'fixurls';             Text = 'Already valid: 1 | Wikipedia fallback: 1 | Cleared: 1' }
        @{ Name = 'fixurls-whatif';      Text = 'WhatIf: Would validate 3 URLs via GET with Wikipedia fallback' }
        @{ Name = 'regen';               Text = 'r-2 — empty entries in response' }
        @{ Name = 'regen';               Text = 'r-5 — not in response, skipping' }
        @{ Name = 'regen-failures';      Text = ' failed: 500 Internal Server Error' }
        @{ Name = 'regen-no-key';        Text = 'No API key available' }
        @{ Name = 'regen-whatif';        Text = 'WhatIf: Would regenerate 6 nodes in 2 batches' }
    ) {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir "$Name.json"))
        $g.Contains($Text) | Should -BeTrue -Because "golden $Name should show: $Text"
    }

    It 'never dedups version-numbered names into one another (t/4077 item 2)' {
        $g = [System.IO.File]::ReadAllText((Join-Path $script:GoldenDir 'batches.json'))
        $g | Should -Not -Match "Dedup guard: 'Doctrine \d+' → existing 'Doctrine \d+'"
    }

    It '<Name> writes nothing and leaves every file byte-identical' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'whatif', 'fixurls-whatif', 'regen-whatif', 'regen-no-key', 'fixurls-empty-cache' }
    ) {
        $s = $_
        $pristine = script:New-LineageFixture $s
        $script:RootCurrent = [System.IO.Path]::GetFullPath($pristine).TrimEnd('\', '/')
        $before = script:Get-Tree $pristine
        $null = script:Invoke-Scenario $s
        $after = script:Get-Tree $script:RootFixture
        @($script:Writes).Count | Should -Be 0
        @($script:Guards).Count | Should -Be 0
        foreach ($k in @($before.Keys)) { $after[$k] | Should -BeExactly $before[$k] -Because "$k must be untouched" }
        @($after.Keys | Where-Object { $_ -notlike '*/' }).Count | Should -Be @($before.Keys | Where-Object { $_ -notlike '*/' }).Count
    }

    It 'guards every data-file write (POV files and the lineage cache) with Assert-DataWriteAllowed, one per write (<Name>)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -in 'enrich', 'multi-pov', 'fixurls', 'regen', 'dedup-a', 'url-phase' }
    ) {
        $null = script:Invoke-Scenario $_
        $writes = @($script:Writes | ForEach-Object { ($_ -split ' ')[0] })
        @($script:Guards | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object) | Should -Be @($writes | Sort-Object)
        $writes.Count | Should -BeGreaterThan 0
    }

    # t/4077 item 6: the cache is a tracked data-repo file, so its first write in a run is guarded, and the
    # URL-validation re-save in the same run takes the same-sequence exemption (-AllowDirty, t/2902 cond. 4).
    It 'guards the lineage cache, and marks its same-run rewrite -AllowDirty (t/4077)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'url-phase' }
    ) {
        $null = script:Invoke-Scenario $_
        @($script:Guards | Where-Object { $_ -like 'calibration/*' }) |
            Should -Be @('calibration/core/lineage-enrichments.json', 'calibration/core/lineage-enrichments.json [AllowDirty]')
    }

    # t/4077 item 5: the harness above sorts write runs and canonicalizes the cache, so these read the RAW
    # order the code produces.
    It 'writes lineage-enrichments.json with keys in ordinal order at both levels (t/4077)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'enrich' }
    ) {
        $null = script:Invoke-Scenario $_
        $text = [System.IO.File]::ReadAllText((Join-Path $script:RootFixture $script:CacheRel))
        $cache = $text | ConvertFrom-Json -AsHashtable   # an OrderedHashtable: keeps the file's key order
        $keys = [string[]]@($cache.Keys)
        $sorted = [string[]]@($keys); [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
        $keys | Should -Be $sorted
        $keys.Count | Should -BeGreaterThan 2
        foreach ($k in $keys) {
            $fields = [string[]]@($cache[$k].Keys)
            $fsorted = [string[]]@($fields); [Array]::Sort($fsorted, [System.StringComparer]::Ordinal)
            $fields | Should -Be $fsorted -Because "entry '$k' fields are written in ordinal order"
        }
    }

    It 'writes the POV files in ordinal order (t/4077)' -ForEach @(
        $script:Scenarios | Where-Object { $_.Name -eq 'multi-pov' }
    ) {
        $null = script:Invoke-Scenario $_
        $pov = [string[]]@($script:Writes | Where-Object { $_ -like 'taxonomy/Origin/*' } | ForEach-Object { ($_ -split ' ')[0] })
        $sorted = [string[]]@($pov); [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
        $pov.Count | Should -BeGreaterThan 1
        $pov | Should -Be $sorted
    }

    # More than ten dedup merges: the sample is the first ten keys of $DedupMap in ordinal order (t/4077;
    # before, which ten followed the hashtable).
    It 'samples the first ten dedup merges in ordinal key order and counts the rest' {
        $vals = @(1..12 | ForEach-Object { "Thing $_" }) + @(1..12 | ForEach-Object { "Thing $_ (variant)" })
        $vec = @{}
        for ($i = 1; $i -le 12; $i++) {
            $v = [double[]]::new(24); $v[$i - 1] = 1.0; $vec["Thing $i"] = $v
            $u = [double[]]::new(24); $u[$i - 1] = 0.95; $u[$i + 11] = 0.3122498999; $vec["Thing $i (variant)"] = $u
        }
        $script:ManySpec = $vec
        $s = @{ Name = 'dedup-many'; Tax = 'none'; Params = @{ Model = 'gemini-2.5-flash'; SkipUrlValidation = $true; WhatIf = $true } }
        $root = script:New-LineageFixture $s
        script:Write-FixtureFile (Join-Path $root 'taxonomy' 'Origin' 'accelerationist.json') (script:ConvertTo-FixtureJson @{ nodes = @( (script:LinNode 'acc-1' $vals) ) })
        Mock Get-TaxonomyDir -ModuleName AITriad { Join-Path $root 'taxonomy' 'Origin' }
        Mock Get-DataRoot -ModuleName AITriad { $root }
        Mock Get-TextEmbedding -ModuleName AITriad { $h = @{}; foreach ($id in @($Ids)) { if ($script:ManySpec.ContainsKey($id)) { $h[$id] = $script:ManySpec[$id] } }; $h }
        $lines = @(Repair-PovLineage -Model $s.Params.Model -WhatIf 6>&1 | ForEach-Object { [string]$_.MessageData.Message })
        @($lines | Where-Object { $_ -like "    '*' → '*'" }).Count | Should -Be 10
        $sampled = @($lines | Where-Object { $_ -like "    '*' → '*'" } | ForEach-Object { ($_ -split "'")[1] })
        $sampled | Should -Be @(1, 10, 11, 12, 2, 3, 4, 5, 6, 7 | ForEach-Object { "Thing $_ (variant)" })
        $lines | Should -Contain '    ... and 2 more'
        $lines | Should -Contain 'Dedup: 24 → 12 canonical values (12 merged)'
    }
}
