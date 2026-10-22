# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Steps of Repair-PovLineage (t/3910 complexity refactor). Behaviour is pinned by
# tests/Repair-PovLineage.Characterization.Tests.ps1. These helpers run under the caller's
# Set-StrictMode -Version Latest and $ErrorActionPreference = 'Stop' (dynamic scope), and read the
# caller's $WhatIfPreference the same way. Helpers that may write a warning are called as plain
# statements, so the caller's -WarningVariable still collects it (Sage #221).

$script:LineagePovFiles = @('accelerationist', 'safetyist', 'skeptic', 'situations')

# ── Shared ────────────────────────────────────────────────────────────────────


function Get-LineageNodeAttribute {
    # The node's graph_attributes when they carry an intellectual_lineage property, else $null.
    param($Node)
    if (-not $Node.PSObject.Properties['graph_attributes'] -or -not $Node.graph_attributes) { return $null }
    $GA = $Node.graph_attributes
    if (-not $GA.PSObject.Properties['intellectual_lineage']) { return $null }
    $GA
}

function Get-LineageWikipediaUrl {
    # The en.wikipedia.org URL for a lineage name (trailing parenthetical dropped), when it validates.
    param([string]$Name)
    $WikiName = ($Name -replace '\s*\([^)]+\)\s*$', '').Trim() -replace '\s+', '_'
    $WikiUrl = "https://en.wikipedia.org/wiki/$WikiName"
    if (Test-LineageUrl $WikiUrl) { return $WikiUrl }
    return $null
}

function Get-LineageFirstJson {
    # The first complete JSON value starting at the first $Open bracket (LLMs sometimes append trailing
    # content). Returns $Text unchanged when there is no $Open bracket or the value never closes.
    param([string]$Text, [char]$Open, [char]$Close)
    $Start = $Text.IndexOf($Open)
    if ($Start -lt 0) { return $Text }
    $Depth = 0; $InStr = $false; $Esc = $false
    for ($jx = $Start; $jx -lt $Text.Length; $jx++) {
        $Ch = $Text[$jx]
        if ($Esc) { $Esc = $false; continue }
        if ($Ch -eq '\' -and $InStr) { $Esc = $true; continue }
        if ($Ch -eq '"') { $InStr = -not $InStr; continue }
        if ($InStr) { continue }
        if ($Ch -eq $Open) { $Depth++ }
        elseif ($Ch -eq $Close) {
            $Depth--
            if ($Depth -eq 0) { return $Text.Substring($Start, $jx - $Start + 1) }
        }
    }
    $Text
}

function ConvertFrom-LineageAiJson {
    # An AI response's JSON: ```json fences stripped, first complete value extracted, then parsed.
    param([string]$Text, [char]$Open, [char]$Close)
    $CleanText = $Text -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
    (Get-LineageFirstJson -Text $CleanText -Open $Open -Close $Close) | ConvertFrom-Json
}

function Get-LineageSortedKey {
    # A dictionary's keys in ordinal order. Output that follows a hashtable's enumeration order (POV write
    # order, "Saved" lines, sampled merges) varies from run to run; ordinal also ignores culture (t/4077).
    param([System.Collections.IDictionary]$Dictionary)
    $Keys = [string[]]@($Dictionary.Keys)
    [Array]::Sort($Keys, [System.StringComparer]::Ordinal)
    $Keys
}

function ConvertTo-LineageSortedCache {
    # The cache with its entries, and each entry's fields, in ordinal key order, so lineage-enrichments.json
    # is byte-stable across runs and processes. Same shape and values; only the key order changes (t/4077).
    # OrderedHashtable, not [ordered]: it is case-sensitive like the loaded cache, so keys that differ only
    # in case stay distinct.
    param([System.Collections.IDictionary]$Cache)
    $Sorted = [System.Management.Automation.OrderedHashtable]::new()
    foreach ($Key in (Get-LineageSortedKey $Cache)) {
        $Value = $Cache[$Key]
        if ($Value -is [System.Collections.IDictionary]) {
            $Fields = [System.Management.Automation.OrderedHashtable]::new()
            foreach ($Field in (Get-LineageSortedKey $Value)) { $Fields[$Field] = $Value[$Field] }
            $Value = $Fields
        }
        $Sorted[$Key] = $Value
    }
    $Sorted
}

function Save-LineageCache {
    # Writes lineage-enrichments.json. It is a tracked data-repo file (calibration/core, Warn tier), so the
    # whole-file rewrite goes through the data-write guard: over someone's uncommitted edits it WARNs, and
    # never blocks (t/4077 item 6). -SameRun marks a later rewrite, in this same run, of a file this run
    # already wrote: the guard's same-sequence exemption (t/2902 condition 4), so the run doesn't warn
    # about its own write.
    param([System.Collections.IDictionary]$Cache, [string]$CachePath, [switch]$SameRun)
    if ($SameRun) { Assert-DataWriteAllowed -Path $CachePath -AllowDirty }
    else { Assert-DataWriteAllowed -Path $CachePath }
    ConvertTo-LineageSortedCache -Cache $Cache | ConvertTo-Json -Depth 5 | Set-Content -Path $CachePath -Encoding UTF8
}

function Get-LineageCacheLookup {
    # Lower-cased cache key → actual key (the AI may return different casing).
    param([System.Collections.IDictionary]$Cache)
    $Lookup = @{}
    foreach ($CKey in $Cache.Keys) { $Lookup[$CKey.ToLower()] = $CKey }
    $Lookup
}

function Resolve-LineageCacheKey {
    # The cache key for a lineage value: an exact match, else a case-insensitive one; $null when uncached.
    # The need-enrichment check and the apply step both resolve through here, so they agree on case
    # (t/4077: a loaded cache is a case-sensitive OrderedHashtable).
    param([string]$Value, [System.Collections.IDictionary]$Cache, [hashtable]$Lookup)
    if ($Cache.Contains($Value)) { return $Value }
    $Lookup[$Value.ToLower()]
}

function Test-LineageCacheStale {
    # A cache entry with no description is stale: it is queued for enrichment, and refreshed when enriched.
    param($Data)
    if ($null -eq $Data) { return $true }
    [string]::IsNullOrWhiteSpace([string]$Data['description'])
}

# ── -FixUrls ──────────────────────────────────────────────────────────────────

function Get-LineageUrlCheckList {
    # Cache entries whose URL needs checking: an error status, no status, or no URL.
    param([System.Collections.IDictionary]$Cache)
    @($Cache.GetEnumerator() | Where-Object {
            $v = $_.Value
            ($v.ContainsKey('url_status') -and $v['url_status'] -ne 200) -or
            (-not $v.ContainsKey('url_status')) -or
            [string]::IsNullOrWhiteSpace($v['url'])
        })
}

function Repair-LineageCacheUrl {
    # Re-checks one cache entry's URL in place, falling back to Wikipedia. Returns valid, wiki or cleared.
    param([string]$Name, [System.Collections.IDictionary]$Data)
    $Url = $Data['url']
    if (-not [string]::IsNullOrWhiteSpace($Url) -and (Test-LineageUrl $Url)) {
        $Data['url_status'] = 200
        return 'valid'
    }
    $WikiUrl = Get-LineageWikipediaUrl $Name
    if ($WikiUrl) {
        $Data['url'] = $WikiUrl
        $Data['url_status'] = 200
        Write-Verbose "  Wiki fallback: $Name → $WikiUrl"
        return 'wiki'
    }
    $Data['url'] = $null
    $Data['url_status'] = 'cleared'
    Write-Verbose "  Cleared: $Name (no valid URL found)"
    'cleared'
}

function Sync-LineageEntryUrl {
    # Copies cached URLs onto the rich lineage entries of $Nodes. Returns how many entries changed.
    param($Nodes, [System.Collections.IDictionary]$Cache)
    $Changed = 0
    foreach ($Node in $Nodes) {
        $GA = Get-LineageNodeAttribute $Node
        if ($null -eq $GA) { continue }
        foreach ($LinEntry in @($GA.intellectual_lineage)) {
            if ($LinEntry -is [string] -or -not $LinEntry.PSObject.Properties['name'] -or -not $Cache.ContainsKey($LinEntry.name)) { continue }
            $Cached = $Cache[$LinEntry.name]
            $NewUrl = if ($Cached['url']) { $Cached['url'] } else { $null }
            if ($LinEntry.url -ne $NewUrl) {
                $LinEntry.url = $NewUrl
                $Changed++
            }
        }
    }
    $Changed
}

function Sync-LineageTaxonomyUrl {
    # Writes the fixed URLs into every POV file that has a changed entry. Returns the entries changed.
    param([string]$TaxDir, [System.Collections.IDictionary]$Cache)
    $TaxUpdated = 0
    foreach ($PovName in $script:LineagePovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $TaxFileData = Get-Content $FilePath -Raw | ConvertFrom-Json
        $Changed = Sync-LineageEntryUrl -Nodes $TaxFileData.nodes -Cache $Cache
        if ($Changed -gt 0) {
            Assert-DataWriteAllowed -Path $FilePath  # t/2902
            $TaxFileData | ConvertTo-Json -Depth 20 | Set-Content -Path $FilePath -Encoding UTF8
            Write-Host "  Saved $PovName.json" -ForegroundColor Green
        }
        $TaxUpdated += $Changed
    }
    $TaxUpdated
}

function Invoke-LineageUrlFix {
    # -FixUrls: validate cached URLs via GET with a Wikipedia fallback, then push them into the POV files.
    param([System.Collections.IDictionary]$Cache, [string]$CachePath, [string]$TaxDir)
    if ($Cache.Count -eq 0) {
        Write-Warning 'Cache is empty — run Repair-PovLineage first to populate it'
        return
    }

    Write-Host '=== Fix Broken URLs ===' -ForegroundColor Cyan
    $ToCheck = @(Get-LineageUrlCheckList -Cache $Cache)
    Write-Host "  Entries to check: $($ToCheck.Count) / $($Cache.Count)"

    if ($WhatIfPreference) {
        Write-Host "`nWhatIf: Would validate $($ToCheck.Count) URLs via GET with Wikipedia fallback"
        $ToCheck | Select-Object -First 10 | ForEach-Object {
            Write-Host "  $($_.Key): $($_.Value['url'])" -ForegroundColor DarkGray
        }
        return
    }

    $Tally = @{ valid = 0; wiki = 0; cleared = 0 }
    foreach ($Entry in $ToCheck) { $Tally[(Repair-LineageCacheUrl -Name $Entry.Key -Data $Entry.Value)]++ }
    Write-Host "  Already valid: $($Tally.valid) | Wikipedia fallback: $($Tally.wiki) | Cleared: $($Tally.cleared)"

    Save-LineageCache -Cache $Cache -CachePath $CachePath
    Write-Host "Cache saved" -ForegroundColor Green

    $TaxUpdated = Sync-LineageTaxonomyUrl -TaxDir $TaxDir -Cache $Cache
    Write-Host "Updated $TaxUpdated lineage entries in taxonomy files" -ForegroundColor Green
}

# ── -RegenerateContent ────────────────────────────────────────────────────────

function ConvertTo-LineageRegenItem {
    # One -RegenerateContent work item (the node's rich lineage entries plus prompt context), or $null.
    param($Node, [string]$PovName)
    $GA = Get-LineageNodeAttribute $Node
    if ($null -eq $GA) { return $null }
    $LinEntries = @($GA.intellectual_lineage)
    if ($LinEntries.Count -eq 0) { return $null }

    # Only process rich entries (have a name property)
    $RichEntries = @($LinEntries | Where-Object { $_ -isnot [string] -and $_.PSObject.Properties['name'] })
    if ($RichEntries.Count -eq 0) { return $null }

    $NodeCategory = if ($Node.PSObject.Properties['category']) { $Node.category } else { 'Situation' }
    $NodeDesc = if ($Node.PSObject.Properties['description']) { $Node.description } else { '' }
    @{
        pov      = $PovName
        node_id  = $Node.id
        label    = $Node.label
        desc     = $NodeDesc
        category = $NodeCategory
        entries  = $RichEntries
    }
}

function Get-LineageRegenNode {
    # Every node in $PovFiles (optionally filtered) with at least one rich lineage entry.
    param([string]$TaxDir, [string[]]$PovFiles, $FilterNodeIds)
    $NodesToProcess = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($PovName in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $Data = Get-Content $FilePath -Raw | ConvertFrom-Json
        foreach ($Node in $Data.nodes) {
            if ($FilterNodeIds -and -not $FilterNodeIds.Contains($Node.id)) { continue }
            if (Test-TaxonomyNodeSuperseded $Node) { continue }   # no AI regeneration for a retired node (t/4356)
            $Item = ConvertTo-LineageRegenItem -Node $Node -PovName $PovName
            if ($null -ne $Item) { $NodesToProcess.Add($Item) }
        }
    }
    , $NodesToProcess
}

function Format-LineageRegenPrompt {
    # The user prompt for one batch of -RegenerateContent nodes.
    param([object[]]$Batch)
    $NodesJson = @(foreach ($Item in $Batch) {
            $EntryNames = @($Item.entries | ForEach-Object { $_.name })
            $ExistingEntries = @(foreach ($E in $Item.entries) {
                    [ordered]@{
                        name     = $E.name
                        url      = if ($E.PSObject.Properties['url']) { $E.url } else { $null }
                        category = if ($E.PSObject.Properties['category']) { $E.category } else { $null }
                    }
                })
            [ordered]@{
                node_id           = $Item.node_id
                label             = $Item.label
                description       = $Item.desc
                category          = $Item.category
                pov               = $Item.pov
                lineage_entries   = $ExistingEntries
                other_entry_names = $EntryNames
            }
        }) | ConvertTo-Json -Depth 5

    @"
Regenerate the description field for each lineage entry on each node below.
Keep name, url, and category fields EXACTLY as provided. Only replace the description.

NODES:
$NodesJson

Return a JSON object mapping node_id to an array of updated lineage entries:
{
  "node_id_1": [
    {"name": "...", "description": "2-4 paragraphs...", "url": "...", "category": "..."},
    ...
  ],
  ...
}
"@
}

function Merge-LineageRegenNode {
    # Applies one node's regenerated descriptions (over 100 chars) in place. Returns updated, unchanged or failed.
    param([hashtable]$Item, $Regenerated, [hashtable]$PovModified)
    $NodeId = $Item.node_id
    if (-not $Regenerated.PSObject.Properties[$NodeId]) {
        Write-Verbose "  $NodeId — not in response, skipping"
        return 'failed'
    }
    $NewEntries = @($Regenerated.$NodeId)
    if ($NewEntries.Count -eq 0) {
        Write-Verbose "  $NodeId — empty entries in response"
        return 'failed'
    }

    # Build lookup: name → new description
    $DescLookup = @{}
    foreach ($NE in $NewEntries) {
        if ($NE.PSObject.Properties['name'] -and $NE.PSObject.Properties['description']) {
            $DescLookup[$NE.name] = $NE.description
        }
    }

    # Apply to original entries (preserve url/category from source)
    $Updated = 0
    foreach ($OrigEntry in $Item.entries) {
        if (-not $DescLookup.ContainsKey($OrigEntry.name)) { continue }
        $NewDesc = $DescLookup[$OrigEntry.name]
        if ($NewDesc.Length -gt 100) {
            $OrigEntry.description = $NewDesc
            $Updated++
        }
    }
    if ($Updated -eq 0) { return 'unchanged' }
    $PovModified[$Item.pov] = $true
    Write-Verbose "  $NodeId — $Updated/$($Item.entries.Count) entries updated"
    'updated'
}

function Invoke-LineageRegenBatch {
    # One AI call for a batch of nodes. Returns { Updated; Failed; NoResponse }.
    param([object[]]$Batch, [string]$SystemPrompt, [string]$Model, [string]$ApiKey, [hashtable]$PovModified)
    $Outcome = @{ Updated = 0; Failed = 0; NoResponse = $false }
    try {
        $Result = Invoke-AIApi -Prompt (Format-LineageRegenPrompt -Batch $Batch) -SystemInstruction $SystemPrompt `
            -Model $Model -ApiKey $ApiKey `
            -Temperature 0.3 -MaxTokens 16384 -JsonMode

        if (-not $Result -or -not $Result.Text) {
            Write-Host " no response" -ForegroundColor Red
            $Outcome.Failed += $Batch.Count
            $Outcome.NoResponse = $true
            return $Outcome
        }

        $Regenerated = ConvertFrom-LineageAiJson -Text $Result.Text -Open '{' -Close '}'
        foreach ($Item in $Batch) {
            switch (Merge-LineageRegenNode -Item $Item -Regenerated $Regenerated -PovModified $PovModified) {
                'updated' { $Outcome.Updated++ }
                'failed'  { $Outcome.Failed++ }
            }
        }
        Write-Host " done ($($Batch.Count) nodes)" -ForegroundColor Green
    }
    catch {
        Write-Host " failed: $($_.Exception.Message)" -ForegroundColor Red
        $Outcome.Failed += $Batch.Count
    }
    $Outcome
}

function Save-LineageRegenFile {
    # Re-reads each modified POV file, swaps in the regenerated entries, and writes it.
    param([string]$TaxDir, [hashtable]$PovModified, $NodesToProcess)
    foreach ($PovName in (Get-LineageSortedKey $PovModified)) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        $Data = Get-Content $FilePath -Raw | ConvertFrom-Json

        # Re-apply the updated entries from NodesToProcess back to the file data
        $NodeLookup = @{}
        foreach ($Item in $NodesToProcess) {
            if ($Item.pov -eq $PovName) { $NodeLookup[$Item.node_id] = $Item }
        }
        foreach ($Node in $Data.nodes) {
            if ($NodeLookup.ContainsKey($Node.id)) {
                $Node.graph_attributes.intellectual_lineage = @($NodeLookup[$Node.id].entries)
            }
        }

        Assert-DataWriteAllowed -Path $FilePath  # t/2902
        $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $FilePath -Encoding UTF8
        Write-Host "  Saved $PovName.json" -ForegroundColor Green
    }
}

function Invoke-LineageRegenerate {
    # -RegenerateContent: per-node 2-4 paragraph descriptions for existing rich lineage entries.
    param([string]$TaxDir, [string[]]$PovFiles, $FilterNodeIds, [string]$Model, [string]$ApiKey, [int]$NodeBatchSize)
    $SystemPrompt = Get-Prompt -Name 'lineage-regenerate'

    # Backend from ai-models.json, never guessed; only the user's -ApiKey is forwarded (t/4099, t/4087).
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        throw (New-ActionableError `
            -Goal 'Regenerate lineage content' `
            -Problem "No API key available for the $($KeyStatus.Backend) backend" `
            -Location 'Repair-PovLineage -RegenerateContent' `
            -NextSteps @("Set the $($KeyStatus.EnvHint) environment variable", 'Pass -ApiKey parameter') `
            -AsErrorRecord)
    }

    $NodesToProcess = Get-LineageRegenNode -TaxDir $TaxDir -PovFiles $PovFiles -FilterNodeIds $FilterNodeIds

    Write-Host "=== Regenerate Lineage Content ===" -ForegroundColor Cyan
    Write-Host "  Nodes to process: $($NodesToProcess.Count)"
    Write-Host "  Batch size: $NodeBatchSize nodes/batch"
    Write-Host "  Model: $Model"

    $TotalBatches = [Math]::Ceiling($NodesToProcess.Count / $NodeBatchSize)
    Write-Host "  Total batches: $TotalBatches"

    if ($WhatIfPreference) {
        Write-Host "`nWhatIf: Would regenerate $($NodesToProcess.Count) nodes in $TotalBatches batches"
        $NodesToProcess | Select-Object -First 5 | ForEach-Object {
            Write-Host "  $($_.node_id): $($_.label) ($($_.entries.Count) entries)" -ForegroundColor DarkGray
        }
        return
    }

    # Track which POV files need saving
    $PovModified = @{}
    $BatchNum = 0
    $TotalUpdated = 0
    $TotalFailed = 0

    for ($i = 0; $i -lt $NodesToProcess.Count; $i += $NodeBatchSize) {
        $BatchNum++
        $BatchEnd = [Math]::Min($i + $NodeBatchSize - 1, $NodesToProcess.Count - 1)
        $Batch = @($NodesToProcess[$i..$BatchEnd])
        $BatchNodeIds = ($Batch | ForEach-Object { $_.node_id }) -join ', '
        Write-Host "  Batch $BatchNum/$TotalBatches ($($Batch.Count) nodes: $BatchNodeIds)..." -ForegroundColor Gray -NoNewline

        $Outcome = Invoke-LineageRegenBatch -Batch $Batch -SystemPrompt $SystemPrompt -Model $Model -ApiKey $ApiKey -PovModified $PovModified
        $TotalUpdated += $Outcome.Updated
        $TotalFailed += $Outcome.Failed

        # A batch with no response skips the pause, as it always has.
        if (-not $Outcome.NoResponse -and $BatchNum -lt $TotalBatches) { Start-Sleep -Seconds 1 }
    }

    Save-LineageRegenFile -TaxDir $TaxDir -PovModified $PovModified -NodesToProcess $NodesToProcess

    Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
    Write-Host "  Nodes updated: $TotalUpdated"
    Write-Host "  Nodes failed: $TotalFailed"
    Write-Host "  POV files saved: $((Get-LineageSortedKey $PovModified) -join ', ')"
}

# ── Default mode: enrich bare-string lineage entries ──────────────────────────

$script:LineageDedupThreshold = 0.85

function Convert-LineageRichToBare {
    # -Force: turns rich lineage objects with a name back into bare strings, in place.
    param($GA)
    $Converted = 0
    $NewLin = @(foreach ($Entry in @($GA.intellectual_lineage)) {
            if ($Entry -is [string]) { $Entry }
            elseif ($Entry.PSObject.Properties['name'] -and $Entry.name) {
                $Converted++
                [string]$Entry.name
            }
            else { $Entry }
        })
    if ($Converted -gt 0) { $GA.intellectual_lineage = $NewLin }
}

function Get-LineageBareValue {
    # Loads $PovFiles and collects the unique bare-string lineage values. Returns { UniqueValues; TaxData }.
    param([string]$TaxDir, [string[]]$PovFiles, $FilterNodeIds, [switch]$Force)
    $UniqueValues = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $TaxData = @{}

    foreach ($PovName in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $Data = Get-Content $FilePath -Raw | ConvertFrom-Json
        $TaxData[$PovName] = $Data

        foreach ($Node in $Data.nodes) {
            if ($FilterNodeIds -and -not $FilterNodeIds.Contains($Node.id)) { continue }
            $GA = Get-LineageNodeAttribute $Node
            if ($null -eq $GA) { continue }

            # -Force: convert rich objects back to bare strings for re-enrichment
            if ($Force) { Convert-LineageRichToBare -GA $GA }

            foreach ($Entry in @($GA.intellectual_lineage)) {
                if ($Entry -is [string] -and -not [string]::IsNullOrWhiteSpace($Entry)) {
                    [void]$UniqueValues.Add($Entry)
                }
            }
        }
    }
    [pscustomobject]@{ UniqueValues = $UniqueValues; TaxData = $TaxData }
}

function Get-LineageValueFrequency {
    # How many times each bare-string value occurs across all loaded nodes.
    param([hashtable]$TaxData)
    $FreqMap = @{}
    foreach ($PovName in $TaxData.Keys) {
        foreach ($Node in $TaxData[$PovName].nodes) {
            $GA = Get-LineageNodeAttribute $Node
            if ($null -eq $GA) { continue }
            foreach ($Entry in @($GA.intellectual_lineage)) {
                if ($Entry -is [string]) {
                    $FreqMap[$Entry] = ($FreqMap[$Entry] ?? 0) + 1
                }
            }
        }
    }
    $FreqMap
}

function Get-LineageMergeBase {
    # Parenthetical variants merge to the base name:
    # "Asimov's Laws (conceptual)" + "Asimov's Laws (implicit)" → "Asimov's Laws". $null when not variants.
    param([string]$Val, [string]$CanName)
    # Case 1: one is qualified, other is the bare base
    if ($Val -match '^(.+?)\s*\(' -and $CanName -eq $Matches[1].Trim()) { return $CanName }
    if ($CanName -match '^(.+?)\s*\(' -and $Val -eq $Matches[1].Trim()) { return $Val }
    # Case 2: both are qualified variants of the same base
    if ($Val -match '^(.+?)\s*\(' -and $CanName -match '^(.+?)\s*\(') {
        $ValBase = ($Val -replace '\s*\([^)]+\)\s*$', '').Trim()
        $CanBase = ($CanName -replace '\s*\([^)]+\)\s*$', '').Trim()
        if ($ValBase -eq $CanBase) { return $ValBase }
    }
    $null
}

function Find-LineageCanonicalIndex {
    # Index of the first canonical whose vector is within $Threshold cosine of $Vec, or -1.
    param([double[]]$Vec, $CanonicalVecs, [double]$Threshold)
    for ($j = 0; $j -lt $CanonicalVecs.Count; $j++) {
        $CanVec = $CanonicalVecs[$j]
        if ($null -eq $CanVec) { continue }  # no embedding for this canonical
        # Cosine similarity (vectors are normalized)
        $Dot = 0.0
        for ($k = 0; $k -lt $Vec.Count; $k++) { $Dot += $Vec[$k] * $CanVec[$k] }
        if ($Dot -ge $Threshold) { return $j }
    }
    -1
}

function Merge-LineageCanonical {
    # Folds $Val into canonical $Index: parenthetical variants merge to their base name, otherwise the
    # more frequent value wins. Updates $State.Canonicals, $State.CanonicalVecs and $State.DedupMap.
    param([int]$Index, [string]$Val, [double[]]$Vec, $State, $Embeddings, [hashtable]$FreqMap)
    $CanName = $State.Canonicals[$Index]
    $BaseName = Get-LineageMergeBase -Val $Val -CanName $CanName
    if ($BaseName) {
        # Merge both to the base name
        if ($CanName -ne $BaseName) { $State.DedupMap[$CanName] = $BaseName }
        $State.DedupMap[$Val] = $BaseName
        $State.Canonicals[$Index] = $BaseName
        # Re-fetch base embedding if available, otherwise keep canonical's
        if ($Embeddings.ContainsKey($BaseName)) { $State.CanonicalVecs[$Index] = $Embeddings[$BaseName] }
        return
    }
    # Non-parenthetical merge: pick the one with higher frequency
    $CanFreq = $FreqMap[$CanName] ?? 0
    $ValFreq = $FreqMap[$Val] ?? 0
    if ($ValFreq -gt $CanFreq) {
        $State.DedupMap[$CanName] = $Val
        $State.Canonicals[$Index] = $Val
        $State.CanonicalVecs[$Index] = $Vec
    }
    else {
        $State.DedupMap[$Val] = $CanName
    }
}

function Get-LineageDedupCluster {
    # Greedy clustering: each value joins the first canonical within the threshold, else becomes one.
    # Returns { Canonicals; CanonicalVecs; DedupMap (non-canonical → canonical); Merged }.
    param([object[]]$UniqueList, $Embeddings, [hashtable]$FreqMap, [double]$Threshold)
    $State = [pscustomobject]@{
        Canonicals    = [System.Collections.Generic.List[string]]::new()
        CanonicalVecs = [System.Collections.Generic.List[double[]]]::new()
        DedupMap      = @{}
        Merged        = 0
    }
    foreach ($Val in $UniqueList) {
        if (-not $Embeddings.ContainsKey($Val)) {
            # No embedding — add as canonical but skip similarity checks.
            # Use a null vector so Canonicals and CanonicalVecs stay in sync.
            $State.Canonicals.Add($Val)
            $State.CanonicalVecs.Add($null)
            continue
        }
        $Vec = $Embeddings[$Val]
        $Index = Find-LineageCanonicalIndex -Vec $Vec -CanonicalVecs $State.CanonicalVecs -Threshold $Threshold
        if ($Index -lt 0) {
            $State.Canonicals.Add($Val)
            $State.CanonicalVecs.Add($Vec)
            continue
        }
        Merge-LineageCanonical -Index $Index -Val $Val -Vec $Vec -State $State -Embeddings $Embeddings -FreqMap $FreqMap
        $State.Merged++
    }
    $State
}

function Write-LineageMergeSample {
    # The first ten merges in ordinal key order (a fixed sample, t/4077), and a count of the rest.
    param([hashtable]$DedupMap)
    $SampleKeys = @(Get-LineageSortedKey $DedupMap | Select-Object -First 10)
    Write-Host "  Sample merges:" -ForegroundColor Gray
    foreach ($Key in $SampleKeys) {
        Write-Host "    '$Key' → '$($DedupMap[$Key])'" -ForegroundColor DarkGray
    }
    if ($DedupMap.Count -gt 10) {
        Write-Host "    ... and $($DedupMap.Count - 10) more" -ForegroundColor DarkGray
    }
}

function Rename-LineageDedupEntry {
    # Replaces non-canonical bare strings on one node's lineage. Returns $true when anything changed.
    param($GA, [hashtable]$DedupMap)
    $Changed = $false
    $NewLin = @(foreach ($Entry in @($GA.intellectual_lineage)) {
            if ($Entry -is [string] -and $DedupMap.ContainsKey($Entry)) {
                $Changed = $true
                $DedupMap[$Entry]
            } else { $Entry }
        })
    if ($Changed) { $GA.intellectual_lineage = $NewLin }
    $Changed
}

function Sync-LineageDedupReference {
    # Applies the dedup map to every loaded POV file and writes the files that changed.
    param([hashtable]$TaxData, [hashtable]$DedupMap, [string]$TaxDir)
    foreach ($PovName in (Get-LineageSortedKey $TaxData)) {
        $Data = $TaxData[$PovName]
        $PovModified = $false
        foreach ($Node in $Data.nodes) {
            $GA = Get-LineageNodeAttribute $Node
            if ($null -eq $GA) { continue }
            if (Rename-LineageDedupEntry -GA $GA -DedupMap $DedupMap) { $PovModified = $true }
        }
        if ($PovModified) {
            $FilePath = Join-Path $TaxDir "$PovName.json"
            Assert-DataWriteAllowed -Path $FilePath  # t/2902
            $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $FilePath -Encoding UTF8
        }
    }
    Write-Host "  Dedup references updated in taxonomy files" -ForegroundColor Green
}

function Invoke-LineageEmbeddingDedup {
    # Phase 0: cluster near-duplicates (cosine ≥ 0.85), pick a canonical representative, and replace
    # references to non-canonical members. Returns { UniqueValues; DedupMap; ClustersMerged }.
    param($UniqueValues, [hashtable]$TaxData, [string]$TaxDir)
    $UniqueList = @($UniqueValues)
    $Result = [pscustomobject]@{ UniqueValues = $UniqueValues; DedupMap = @{}; ClustersMerged = 0 }

    # Count frequency of each value across all nodes
    $FreqMap = Get-LineageValueFrequency -TaxData $TaxData

    Write-Host "Computing embeddings for dedup..." -ForegroundColor Gray
    $Embeddings = Get-TextEmbedding -Texts $UniqueList -Ids $UniqueList
    if ($null -eq $Embeddings -or $Embeddings.Count -eq 0) {
        Write-Host "  Embedding unavailable — skipping dedup" -ForegroundColor Yellow
        return $Result
    }

    Write-Host "Clustering at cosine >= $($script:LineageDedupThreshold)..." -ForegroundColor Gray
    $Clusters = Get-LineageDedupCluster -UniqueList $UniqueList -Embeddings $Embeddings -FreqMap $FreqMap -Threshold $script:LineageDedupThreshold
    Write-Host "Dedup: $($UniqueList.Count) → $($Clusters.Canonicals.Count) canonical values ($($Clusters.Merged) merged)" -ForegroundColor Green
    $Result.DedupMap = $Clusters.DedupMap
    $Result.ClustersMerged = $Clusters.Merged
    if ($Clusters.Merged -eq 0) { return $Result }

    Write-LineageMergeSample -DedupMap $Clusters.DedupMap
    # Apply dedup to taxonomy files (replace non-canonical references)
    if (-not $WhatIfPreference) { Sync-LineageDedupReference -TaxData $TaxData -DedupMap $Clusters.DedupMap -TaxDir $TaxDir }

    # Update UniqueValues to canonicals only
    $Result.UniqueValues = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]@($Clusters.Canonicals), [System.StringComparer]::OrdinalIgnoreCase)
    $Result
}

function Write-LineagePovBreakdown {
    # WhatIf plan: nodes and bare entries per POV file.
    param([string]$TaxDir, [string[]]$PovFiles)
    Write-Host "`n── Per-POV Breakdown ───────────────────────────" -ForegroundColor Yellow
    foreach ($PovName in $PovFiles) {
        $FilePath = Join-Path $TaxDir "$PovName.json"
        if (-not (Test-Path $FilePath)) { continue }
        $Data = (Get-Content $FilePath -Raw | ConvertFrom-Json).nodes
        $NodesWithLin = 0
        $EntryCount = 0
        foreach ($N in $Data) {
            $GA = Get-LineageNodeAttribute $N
            if ($null -eq $GA) { continue }
            $Lin = @($GA.intellectual_lineage)
            $Bare = @($Lin | Where-Object { $_ -is [string] })
            if ($Bare.Count -gt 0) { $NodesWithLin++; $EntryCount += $Bare.Count }
        }
        Write-Host "  $PovName`: $NodesWithLin nodes, $EntryCount bare entries"
    }
}

function Write-LineageEnrichPlan {
    # -WhatIf for the default mode: what would be enriched, validated and written.
    param([object[]]$NeedEnrichment, [int]$BatchSize, [int]$ClustersMerged, [int]$UniqueCount,
          [string[]]$PovFiles, [string]$TaxDir, [string]$CachePath, [string]$Model)
    $Batches = [Math]::Ceiling($NeedEnrichment.Count / $BatchSize)
    Write-Host "`n── Plan ────────────────────────────────────────" -ForegroundColor Yellow
    if ($ClustersMerged -gt 0) {
        Write-Host "  Dedup: $ClustersMerged near-duplicates merged (cosine >= $($script:LineageDedupThreshold))"
    }
    Write-Host "  Enrich: $($NeedEnrichment.Count) values in $Batches AI batches ($BatchSize/batch)"
    Write-Host "  Validate: $UniqueCount URLs via HTTP HEAD"
    Write-Host "  Update: $($PovFiles.Count) taxonomy files"
    Write-Host "  Cache: $CachePath"
    Write-Host "  Model: $Model | Temperature: 0.2"
    Write-Host "  Est. cost: ~`$$([Math]::Round($Batches * 0.02, 2)) (Gemini free tier)"

    Write-LineagePovBreakdown -TaxDir $TaxDir -PovFiles $PovFiles

    # Sample values
    Write-Host "`n── Sample Values (first 15) ────────────────────" -ForegroundColor Yellow
    $NeedEnrichment | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    if ($NeedEnrichment.Count -gt 15) { Write-Host "  ... and $($NeedEnrichment.Count - 15) more" -ForegroundColor DarkGray }

    # Target format example
    Write-Host "`n── Target Format ───────────────────────────────" -ForegroundColor Yellow
    Write-Host '  "Effective Altruism (long-termism)"  →' -ForegroundColor DarkGray
    Write-Host '  {' -ForegroundColor Gray
    Write-Host '    "name": "Effective Altruism (long-termism)",' -ForegroundColor Gray
    Write-Host '    "description": "A philosophical movement applying evidence-based...",' -ForegroundColor Gray
    Write-Host '    "url": "https://en.wikipedia.org/wiki/Effective_altruism",' -ForegroundColor Gray
    Write-Host '    "category": "philosophical_movement"' -ForegroundColor Gray
    Write-Host '  }' -ForegroundColor Gray
}

function Test-LineageEnrichKey {
    # True when the model's REGISTRY backend has a key; false (with a warning) when none is configured.
    # Backend from ai-models.json, never guessed; the key itself is not returned (t/4099, t/4087).
    param([string]$Model, [string]$ApiKey)
    $KeyStatus = Get-AIModelKeyStatus -Model $Model -ApiKey $ApiKey
    if (-not $KeyStatus.HasKey) {
        Write-Warning "No API key — can only apply cached enrichments"
        return $false
    }
    $true
}

function Find-LineageCacheMatch {
    # Dedup guard: an existing cache key in the same category whose words (over 2 chars) overlap the
    # enriched name with Jaccard > 0.75, or $null. Prevents duplicate lineage entries (t/330).
    # Names that differ only by a version token ('Doctrine 2' vs 'Doctrine 1') are distinct entries,
    # never a match: tokens of 2 chars or fewer are dropped below, so Jaccard alone scores them 1.0 (t/4077).
    param($Entry, [System.Collections.IDictionary]$Cache)
    foreach ($CKey in @($Cache.Keys)) {
        if ($Cache[$CKey].category -ne $Entry.category) { continue }
        if (Test-EntityVersionSibling -A $Entry.name -B $CKey) { continue }
        # Quick string similarity check (Jaccard on words)
        $W1 = @($Entry.name.ToLower() -split '\W+' | Where-Object { $_.Length -gt 2 })
        $W2 = @($CKey.ToLower() -split '\W+' | Where-Object { $_.Length -gt 2 })
        if ($W1.Count -eq 0 -or $W2.Count -eq 0) { continue }
        $Inter = @($W1 | Where-Object { $_ -in $W2 }).Count
        $Union = @($W1 + $W2 | Select-Object -Unique).Count
        if ($Union -gt 0 -and ($Inter / $Union) -gt 0.75) { return $CKey }
    }
    $null
}

function Resolve-LineageEnrichUrl {
    # Validates an enriched URL before it is cached (never store hallucinated URLs): falls back to
    # Wikipedia, else clears it. Parameters are untyped on purpose: a [string] would turn $null into ''.
    param($Url, $Name, [switch]$SkipUrlValidation)
    if ($SkipUrlValidation -or [string]::IsNullOrWhiteSpace($Url)) { return $Url }
    if (Test-LineageUrl $Url) { return $Url }
    $WikiFallback = Get-LineageWikipediaUrl $Name
    if ($WikiFallback) {
        Write-Verbose "  URL fallback: '$Name' → Wikipedia"
        return $WikiFallback
    }
    Write-Verbose "  URL cleared: '$Name' (invalid, no Wikipedia)"
    $null
}

function Get-LineageEntryField {
    # One field of an AI-returned entry, or $null when absent: under StrictMode a bare dereference of a
    # missing property throws, and one bad entry would fail its whole batch (t/4077).
    param($Entry, [string]$Field)
    if ($null -eq $Entry) { return $null }
    if ($Entry -is [System.Collections.IDictionary]) { return $Entry[$Field] }
    $Prop = $Entry.PSObject.Properties[$Field]
    if ($Prop) { $Prop.Value } else { $null }
}

function ConvertTo-LineageEnrichEntry {
    # The AI's enriched entry with every field presence-guarded, or $null when it has no name: such an
    # entry can't be matched to a lineage value, so it is skipped with a WARN and the batch continues.
    param($Entry)
    $Name = [string](Get-LineageEntryField $Entry 'name')
    $Description = Get-LineageEntryField $Entry 'description'
    if ([string]::IsNullOrWhiteSpace($Name)) {
        $Hint = [string]$Description
        if ($Hint.Length -gt 60) { $Hint = $Hint.Substring(0, 60) + '...' }
        Write-Warning "Lineage enrichment: skipped an AI entry with no 'name' (description: '$Hint'), because it can't be matched to a lineage value; the rest of the batch is kept (t/4077)."
        return $null
    }
    [pscustomobject]@{
        name        = $Name
        description = $Description
        url         = Get-LineageEntryField $Entry 'url'
        category    = Get-LineageEntryField $Entry 'category'
    }
}

function Add-LineageCacheAlias {
    # Maps an enriched name onto an existing cache key, and adds the name to the cache so the bare-string
    # lookup succeeds. Nothing to do when the names are the same.
    param([string]$Name, [string]$Existing, [System.Collections.IDictionary]$Cache, [hashtable]$DedupMap)
    if ($Name -eq $Existing) { return }
    $DedupMap[$Name] = $Existing
    $Cache[$Name] = $Cache[$Existing]  # alias to same data
    Write-Verbose "  Dedup guard: '$Name' → existing '$Existing'"
}

function Add-LineageEnrichedEntry {
    # Caches one enriched entry, aliases it to a near-duplicate cache key, or refreshes a stale one.
    # Returns $true when the entry was used, $false when it was skipped.
    param($Entry, [System.Collections.IDictionary]$Cache, [hashtable]$DedupMap, [switch]$SkipUrlValidation)
    $Entry = ConvertTo-LineageEnrichEntry -Entry $Entry
    if ($null -eq $Entry) { return $false }
    # Dedup guard: if enriched name is a near-duplicate of an existing cache key (same category), reuse
    # the existing key instead of creating a new entry (prevents duplicate lineage entries — t/330)
    $ExistingMatch = Find-LineageCacheMatch -Entry $Entry -Cache $Cache
    if ($ExistingMatch -and -not (Test-LineageCacheStale $Cache[$ExistingMatch])) {
        Add-LineageCacheAlias -Name $Entry.name -Existing $ExistingMatch -Cache $Cache -DedupMap $DedupMap
        return $true
    }
    # A stale match (no description) is refreshed under its existing key. It was queued for enrichment
    # for exactly that, and a re-enriched value usually matches its own key (t/4077).
    $Key = if ($ExistingMatch) { $ExistingMatch } else { $Entry.name }
    $ValidatedUrl = Resolve-LineageEnrichUrl -Url $Entry.url -Name $Entry.name -SkipUrlValidation:$SkipUrlValidation
    $Cache[$Key] = @{
        description = $Entry.description
        url         = $ValidatedUrl
        url_status  = if ($ValidatedUrl) { 200 } else { 'cleared' }
        category    = $Entry.category
    }
    if ($ExistingMatch) {
        Write-Verbose "  Refreshed stale cache entry: '$Key'"
        Add-LineageCacheAlias -Name $Entry.name -Existing $Key -Cache $Cache -DedupMap $DedupMap
        return $true
    }
    $DescPreview = if ($Entry.description.Length -gt 60) { $Entry.description.Substring(0, 60) + '...' } else { $Entry.description }
    Write-Verbose "  Enriched: '$($Entry.name)' [$($Entry.category)] → $DescPreview"
    $true
}

function Invoke-LineageEnrichBatch {
    # One AI call that enriches a batch of bare values into the cache.
    param([object[]]$Batch, [string]$Model, [string]$ApiKey, [System.Collections.IDictionary]$Cache,
          [hashtable]$DedupMap, [switch]$SkipUrlValidation)
    $BatchList = ($Batch | ForEach-Object { "- $_" }) -join "`n"
    $Prompt = @"
Enrich each intellectual lineage entry with a description, URL, and category.

For each entry, provide:
- name: the original name (verbatim)
- description: 1-3 paragraphs about the topic, accessible to a policy audience. Cover what it is, its historical origins and key proponents, and why it matters for AI governance discourse. Go beyond a dictionary definition — provide enough context that a reader unfamiliar with the topic can understand its significance and how it connects to AI policy debates.
- url: Wikipedia or authoritative URL (prefer Wikipedia when available)
- category: one of: philosophical_movement, economic_theory, political_philosophy, social_theory, scientific_paradigm, legal_framework, technology_movement, ethical_framework, academic_discipline, cultural_movement, other

Entries to enrich:
$BatchList

Return a JSON array of objects. No markdown fences, no explanation.
Example: [{"name":"Effective Altruism","description":"A philosophical movement...","url":"https://en.wikipedia.org/wiki/Effective_altruism","category":"philosophical_movement"}]
"@

    try {
        $Result = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ApiKey `
            -Temperature 0.2 -MaxTokens 8192 -JsonMode -TimeoutSec 60
        if (-not ($Result -and $Result.Text)) {
            Write-Host " no response" -ForegroundColor Red
            return
        }
        $Enriched = ConvertFrom-LineageAiJson -Text $Result.Text -Open '[' -Close ']'
        $Used = 0
        foreach ($E in @($Enriched)) {
            # Plain statement, not a pipeline: keeps the skipped-entry WARN visible to -WarningVariable (Sage #221).
            $Ok = Add-LineageEnrichedEntry -Entry $E -Cache $Cache -DedupMap $DedupMap -SkipUrlValidation:$SkipUrlValidation
            if ($Ok) { $Used++ }
        }
        Write-Host " $Used enriched" -ForegroundColor Green
    }
    catch {
        Write-Host " failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

function Invoke-LineageEnrichment {
    # Batch AI enrichment of every value in $NeedEnrichment, pausing between batches.
    param([object[]]$NeedEnrichment, [int]$BatchSize, [string]$Model, [string]$ApiKey,
          [System.Collections.IDictionary]$Cache, [hashtable]$DedupMap, [switch]$SkipUrlValidation)
    $BatchNum = 0
    $TotalBatches = [Math]::Ceiling($NeedEnrichment.Count / $BatchSize)

    for ($i = 0; $i -lt $NeedEnrichment.Count; $i += $BatchSize) {
        $BatchNum++
        $Batch = @($NeedEnrichment[$i..[Math]::Min($i + $BatchSize - 1, $NeedEnrichment.Count - 1)])
        Write-Verbose "Batch ${BatchNum}/${TotalBatches}: $($Batch -join ', ')"
        Write-Host "  Batch $BatchNum/$TotalBatches ($($Batch.Count) values)..." -ForegroundColor Gray -NoNewline

        Invoke-LineageEnrichBatch -Batch $Batch -Model $Model -ApiKey $ApiKey -Cache $Cache `
            -DedupMap $DedupMap -SkipUrlValidation:$SkipUrlValidation

        # Brief pause between batches to avoid rate limits
        if ($BatchNum -lt $TotalBatches) { Start-Sleep -Seconds 2 }
    }
}

function Confirm-LineageCacheUrl {
    # Validates one cache entry's URL in place (GET, soft-404 detection, Wikipedia fallback).
    # Returns Valid, Wiki, Invalid or Skipped.
    param([string]$Name, [System.Collections.IDictionary]$Entry)
    if (-not $Entry['url'] -or $Entry['url'] -notmatch '^https?://') {
        $Entry['url_status'] = 'cleared'
        return 'Skipped'
    }
    if (Test-LineageUrl $Entry['url']) {
        $Entry['url_status'] = 200
        return 'Valid'
    }
    # Try Wikipedia fallback
    $WikiUrl = Get-LineageWikipediaUrl $Name
    if ($WikiUrl) {
        $Entry['url'] = $WikiUrl
        $Entry['url_status'] = 200
        return 'Wiki'
    }
    $Entry['url'] = $null
    $Entry['url_status'] = 'cleared'
    'Invalid'
}

function Invoke-LineageUrlValidation {
    # Validates every cache entry not already checked in this run, and re-saves the cache.
    # Returns the tally { Valid; Wiki; Invalid; Skipped }.
    param([System.Collections.IDictionary]$Cache, [string]$CachePath)
    $Tally = @{ Valid = 0; Wiki = 0; Invalid = 0; Skipped = 0 }
    $ToValidate = @($Cache.GetEnumerator() | Where-Object { -not $_.Value.ContainsKey('url_status') })
    if ($ToValidate.Count -eq 0) { return $Tally }

    Write-Host "`nValidating $($ToValidate.Count) URLs (GET)..." -ForegroundColor Cyan
    foreach ($KV in $ToValidate) { $Tally[(Confirm-LineageCacheUrl -Name $KV.Key -Entry $KV.Value)]++ }
    Write-Host "  Valid: $($Tally.Valid) | Wiki fallback: $($Tally.Wiki) | Cleared: $($Tally.Invalid) | Skipped: $($Tally.Skipped)"

    # Re-save cache with url_status. This run already wrote it after enrichment, so this is a same-run rewrite.
    Save-LineageCache -Cache $Cache -CachePath $CachePath -SameRun
    $Tally
}

function ConvertTo-LineageRichEntry {
    # A bare string with a cache hit (case-insensitive) becomes a rich object; anything else is unchanged.
    param($Entry, [System.Collections.IDictionary]$Cache, [hashtable]$CacheLookup)
    if ($Entry -isnot [string]) { return $Entry }  # already a rich object
    $CacheKey = Resolve-LineageCacheKey -Value $Entry -Cache $Cache -Lookup $CacheLookup
    if (-not $CacheKey) { return $Entry }  # no cache hit: keep as bare string
    $Cached = $Cache[$CacheKey]
    [ordered]@{
        name        = $Entry
        description = $Cached.description
        url         = $Cached.url
        category    = $Cached.category
    }
}

function Sync-LineageNodeEnrichment {
    # Replaces one node's cached bare strings with rich objects. Returns $true when the node was updated.
    param($Node, [string]$PovName, [System.Collections.IDictionary]$Cache, [hashtable]$CacheLookup, $Cmdlet)
    $GA = Get-LineageNodeAttribute $Node
    if ($null -eq $GA) { return $false }
    $Lin = @($GA.intellectual_lineage)
    $NeedUpdate = $false
    foreach ($Entry in $Lin) {
        if ($Entry -is [string] -and (Resolve-LineageCacheKey -Value $Entry -Cache $Cache -Lookup $CacheLookup)) { $NeedUpdate = $true; break }
    }
    if (-not $NeedUpdate) { return $false }

    # Replace bare strings with rich objects
    $NewLin = @(foreach ($Entry in $Lin) { ConvertTo-LineageRichEntry -Entry $Entry -Cache $Cache -CacheLookup $CacheLookup })
    if (-not $Cmdlet.ShouldProcess("$($Node.id) ($($NewLin.Count) lineage entries)", 'Enrich lineage')) { return $false }

    $BareFixed = @($Lin | Where-Object { $_ -is [string] }).Count
    $RichKept = @($Lin | Where-Object { $_ -isnot [string] }).Count
    Write-Verbose "  $($Node.id) [$PovName]: $BareFixed bare → enriched, $RichKept already rich"
    $GA.intellectual_lineage = $NewLin
    $true
}

function Sync-LineageEnrichment {
    # Applies the cached enrichments to every loaded POV file. Returns the number of nodes updated.
    param([hashtable]$TaxData, [System.Collections.IDictionary]$Cache, [string]$TaxDir, $Cmdlet)
    Write-Host "`nApplying enrichments to taxonomy files..." -ForegroundColor Cyan
    $TotalUpdated = 0

    # Build case-insensitive lookup for cache keys (AI may return different casing)
    $CacheLookup = Get-LineageCacheLookup -Cache $Cache

    foreach ($PovName in (Get-LineageSortedKey $TaxData)) {
        $Data = $TaxData[$PovName]
        $Updated = 0
        foreach ($Node in $Data.nodes) {
            if (Sync-LineageNodeEnrichment -Node $Node -PovName $PovName -Cache $Cache -CacheLookup $CacheLookup -Cmdlet $Cmdlet) { $Updated++ }
        }
        $TotalUpdated += $Updated
        if ($Updated -gt 0) {
            $FilePath = Join-Path $TaxDir "$PovName.json"
            Assert-DataWriteAllowed -Path $FilePath  # t/2902
            $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $FilePath -Encoding UTF8
            Write-Host "  Saved $PovName.json" -ForegroundColor Green
        }
    }
    $TotalUpdated
}

function Get-LineageNeedEnrichment {
    # Values with no cache entry, or a stale one. A value resolves to its cache key the same way the apply
    # step resolves it (exact, then case-insensitive), so a value cached under different casing is not
    # sent for enrichment again (t/4077).
    param($UniqueValues, [System.Collections.IDictionary]$Cache)
    $Lookup = Get-LineageCacheLookup -Cache $Cache
    foreach ($Value in $UniqueValues) {
        $Key = Resolve-LineageCacheKey -Value $Value -Cache $Cache -Lookup $Lookup
        if (-not $Key -or (Test-LineageCacheStale $Cache[$Key])) { $Value }
    }
}

function Invoke-LineageEnrich {
    # Default mode: collect bare-string lineage values, dedup them by embedding, enrich the uncached ones
    # in AI batches, validate URLs, and replace the bare strings with rich objects in the POV files.
    param([string]$TaxDir, [string[]]$PovFiles, $FilterNodeIds, $CollectedIds,
          [System.Collections.IDictionary]$Cache, [string]$CachePath, [string]$Model, [string]$ApiKey,
          [int]$BatchSize, [switch]$SkipUrlValidation, [switch]$Force, $Cmdlet)

    # ── Collect unique bare-string lineage values ─────────────────────────────
    $Collected = Get-LineageBareValue -TaxDir $TaxDir -PovFiles $PovFiles -FilterNodeIds $FilterNodeIds -Force:$Force
    $UniqueValues = $Collected.UniqueValues
    $TaxData = $Collected.TaxData

    if ($Force) {
        Write-Info 'Force mode: rich lineage objects converted to bare strings for re-enrichment'
    }
    if ($null -ne $FilterNodeIds -and $FilterNodeIds.Count -gt 0) {
        Write-Verbose "Filtering to $($CollectedIds.Count) node ID(s): $($CollectedIds[0..([Math]::Min(4, $CollectedIds.Count - 1))] -join ', ')"
    }
    Write-Verbose "UniqueValues type: $($UniqueValues.GetType().Name), count: $($UniqueValues.Count)"
    Write-Host "Unique lineage values: $($UniqueValues.Count)" -ForegroundColor Cyan

    if ($UniqueValues.Count -eq 0) {
        Write-Host 'No bare-string lineage entries to process.' -ForegroundColor Green
        return
    }

    # ── Phase 0: Dedup via embedding similarity ───────────────────────────────
    $Dedup = Invoke-LineageEmbeddingDedup -UniqueValues $UniqueValues -TaxData $TaxData -TaxDir $TaxDir
    $UniqueValues = $Dedup.UniqueValues

    $NeedEnrichment = @(Get-LineageNeedEnrichment -UniqueValues $UniqueValues -Cache $Cache)
    $AlreadyCached = $UniqueValues.Count - $NeedEnrichment.Count

    Write-Host "Post-dedup unique: $($UniqueValues.Count)"
    Write-Host "Already cached: $AlreadyCached"
    Write-Host "Need enrichment: $($NeedEnrichment.Count)"

    if ($WhatIfPreference) {
        Write-LineageEnrichPlan -NeedEnrichment $NeedEnrichment -BatchSize $BatchSize -ClustersMerged $Dedup.ClustersMerged `
            -UniqueCount $UniqueValues.Count -PovFiles $PovFiles -TaxDir $TaxDir -CachePath $CachePath -Model $Model
        return
    }

    # ── Check the API key (registry backend; only the user's -ApiKey is forwarded) ──
    if ($NeedEnrichment.Count -gt 0) {
        if (-not (Test-LineageEnrichKey -Model $Model -ApiKey $ApiKey)) { $NeedEnrichment = @() }
    }

    # ── Batch AI enrichment ───────────────────────────────────────────────────
    Invoke-LineageEnrichment -NeedEnrichment $NeedEnrichment -BatchSize $BatchSize -Model $Model -ApiKey $ApiKey `
        -Cache $Cache -DedupMap $Dedup.DedupMap -SkipUrlValidation:$SkipUrlValidation

    # ── Save cache ────────────────────────────────────────────────────────────
    if ($Cache.Count -gt 0) {
        Save-LineageCache -Cache $Cache -CachePath $CachePath
        Write-Host "Cache saved: $($Cache.Count) entries → $CachePath" -ForegroundColor Green
    }

    # ── URL validation (GET-based, soft 404 detection, Wikipedia fallback) ───
    $Urls = @{ Valid = 0; Invalid = 0 }
    if (-not $SkipUrlValidation) { $Urls = Invoke-LineageUrlValidation -Cache $Cache -CachePath $CachePath }

    # ── Apply enrichments to taxonomy files ───────────────────────────────────
    $TotalUpdated = Sync-LineageEnrichment -TaxData $TaxData -Cache $Cache -TaxDir $TaxDir -Cmdlet $Cmdlet

    Write-Host "`n=== SUMMARY ===" -ForegroundColor Cyan
    Write-Host "  Unique values: $($UniqueValues.Count)"
    Write-Host "  Enriched (new): $($NeedEnrichment.Count)"
    Write-Host "  From cache: $AlreadyCached"
    Write-Host "  Nodes updated: $TotalUpdated"
    if (-not $SkipUrlValidation) {
        Write-Host "  URLs valid: $($Urls.Valid) | invalid: $($Urls.Invalid)"
    }
}
