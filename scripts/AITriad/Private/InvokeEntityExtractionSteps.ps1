# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Steps of Invoke-EntityExtraction (t/1806), split out for t/3910. Pure refactor: every message,
# collection type and ordering is the original's. tests/Invoke-EntityExtraction.Characterization.Tests.ps1
# pins the cmdlet end to end.
#
# StrictMode: these helpers do not set it. They run inside the cmdlet's scope, which sets
# Set-StrictMode -Version Latest, and inherit it from there. The three item-extraction helpers are
# also re-defined inside each ForEach-Object -Parallel runspace, where (as before the split) no strict
# mode is in force; setting it here would change that path's behaviour.

# ── Preflight ────────────────────────────────────────────────────────────────────────────────────

function Assert-EntityExtractionUsage {
    # Runtime guard (t/1806): the UsageID is local-only until t/1819 lands it in ai-usages.json.
    # Get-UsageConfig's generic "not found" error is accurate but unhelpful here — a premature live
    # run should fail pointing at the real cause.
    param([Parameter(Mandatory)][string]$UsageId)
    $UsageResolves = $false
    try {
        $Registry = Get-UsageRegistry
        $UsageResolves = [bool]$Registry.PSObject.Properties[$UsageId]
    } catch {
        $UsageResolves = $false
    }
    if ($UsageResolves) { return }
    throw (New-ActionableError -PassThru `
        -Goal 'Extract entity proposals from source evidence' `
        -Problem "UsageID '$UsageId' is not registered in ai-usages.json" `
        -Location 'Invoke-EntityExtraction' `
        -NextSteps @(
            'Land t/1819 (enrichment.entity-extraction go-live) to register the UsageID',
            "Verify with: (Get-UsageRegistry).PSObject.Properties.Name | Where-Object { `$_ -eq '$UsageId' }",
            'Do not hand-add the UsageID outside t/1819 — its responseSchema/model choice is that ticket''s design surface'
        ))
}

function Resolve-EntityExtractionSeiPath {
    # The source_evidence_index.json path (the -SourceEvidenceIndexPath override, else the taxonomy
    # dir's copy), or a refusal when it doesn't exist.
    param([Parameter(Mandatory)][string]$TaxDir, [string]$Override)
    $SeiPath = if ($Override) { $Override } else { Join-Path $TaxDir 'source_evidence_index.json' }
    if (Test-Path $SeiPath) { return $SeiPath }
    throw (New-ActionableError -PassThru `
        -Goal 'Extract entity proposals from source evidence' `
        -Problem "source_evidence_index.json not found at $SeiPath" `
        -Location 'Invoke-EntityExtraction' `
        -NextSteps @(
            'Run the summary pipeline first — source_evidence_index.json is a pipeline output',
            'Verify .aitriad.json or $env:AI_TRIAD_DATA_ROOT for a data-root override'
        ))
}

# ── Exact/alias match index ──────────────────────────────────────────────────────────────────────
# Built from entities, organizations, taxonomy node labels, the dictionary and policy actions, in that
# order. First-writer-wins on a normalized-string collision (rare, and any hit is a legitimate reason
# to link-not-mint).

function ConvertTo-EntityMatchKey {
    # Lowercase + trim + collapse whitespace.
    param($Text)
    (([string]$Text).Trim().ToLowerInvariant() -replace '\s+', ' ')
}

function Add-EntityMatch {
    param([hashtable]$Index, $Text, $Kind, $Id, $Label)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $n = ConvertTo-EntityMatchKey $Text
    if ([string]::IsNullOrEmpty($n)) { return }
    if (-not $Index.ContainsKey($n)) {
        $Index[$n] = [PSCustomObject]@{ Kind = $Kind; Id = $Id; Label = $Label }
    }
}

function Add-EntityStoreMatch {
    param([hashtable]$Index, [object[]]$Entities)
    foreach ($e in $Entities) {
        if (-not $e.PSObject.Properties['id']) { continue }
        Add-EntityMatch $Index ([string]$e.name) 'entity' ([string]$e.id) ([string]$e.name)
        if ($e.PSObject.Properties['aliases']) {
            foreach ($a in @($e.aliases)) { Add-EntityMatch $Index ([string]$a) 'entity' ([string]$e.id) ([string]$e.name) }
        }
    }
}

function Add-OrganizationMatch {
    param([hashtable]$Index)
    try {
        $OrgStore = Get-OrganizationsStore
        $Orgs = if ($OrgStore.PSObject.Properties['organizations']) { @($OrgStore.organizations) } else { @() }
        foreach ($o in $Orgs) {
            if (-not $o.PSObject.Properties['id']) { continue }
            Add-EntityMatch $Index ([string]$o.name) 'organization' ([string]$o.id) ([string]$o.name)
            if ($o.PSObject.Properties['short_name']) { Add-EntityMatch $Index ([string]$o.short_name) 'organization' ([string]$o.id) ([string]$o.name) }
        }
    } catch { Write-EntityStoreFallback 'organizations.json' $_ }
}

function Write-EntityStoreFallback {
    # Fallback-Path Logging (docs/error-handling.md, t/4072): a store that fails to load narrows the
    # match index, so proposals mint instead of linking. Say which store and why; the run continues.
    param([string]$Store, $ErrorRecord)
    Write-Warning "Invoke-EntityExtraction: $Store could not be loaded ($($ErrorRecord.Exception.Message)); continuing without it, so proposals it would have linked may be minted as new entities."
}

function Add-TaxonomyLabelMatch {
    param([hashtable]$Index, [string]$TaxDir)
    foreach ($PovKey in @('accelerationist', 'safetyist', 'skeptic', 'situations')) {
        $FilePath = Join-Path $TaxDir "$PovKey.json"
        if (-not (Test-Path $FilePath)) { continue }
        try {
            $FileData = Get-Content -Raw -Path $FilePath | ConvertFrom-Json
            # New entity links go to selectable nodes only, never to a retired one (t/4356).
            foreach ($n in @(Select-SelectableTaxonomyNode -Nodes @($FileData.nodes) -Pov $PovKey)) {
                if (-not $n.PSObject.Properties['id']) { continue }
                $lbl = if ($n.PSObject.Properties['label']) { [string]$n.label } else { '' }
                Add-EntityMatch $Index $lbl 'node' ([string]$n.id) $lbl
            }
        } catch { Write-EntityStoreFallback "$PovKey.json" $_ }
    }
}

function Add-DictionaryMatch {
    # standardized terms match on canonical_form, colloquial terms on colloquial_term.
    param([hashtable]$Index)
    $DictRoot = Join-Path (Get-DataRoot) 'dictionary'
    $TermField = [ordered]@{ standardized = 'canonical_form'; colloquial = 'colloquial_term' }
    foreach ($SubDir in $TermField.Keys) {
        $D = Join-Path $DictRoot $SubDir
        if (-not (Test-Path $D)) { continue }
        $Field = $TermField[$SubDir]
        foreach ($F in Get-ChildItem -Path $D -Filter '*.json' -ErrorAction SilentlyContinue) {
            try {
                $Term = Get-Content -Raw -Path $F.FullName | ConvertFrom-Json
                if ($Term.PSObject.Properties[$Field]) {
                    Add-EntityMatch $Index ([string]$Term.$Field) 'term' ([string]$Term.$Field) ([string]$Term.$Field)
                }
            } catch { Write-EntityStoreFallback "dictionary/$SubDir/$($F.Name)" $_ }
        }
    }
}

function Add-PolicyActionMatch {
    param([hashtable]$Index, [string]$TaxDir)
    $PolicyPath = Join-Path $TaxDir 'policy_actions.json'
    if (-not (Test-Path $PolicyPath)) { return }
    try {
        $PolicyReg = Get-Content -Raw -Path $PolicyPath | ConvertFrom-Json
        foreach ($p in @($PolicyReg.policies)) {
            if (-not $p.PSObject.Properties['id']) { continue }
            Add-EntityMatch $Index ([string]$p.action) 'policy' ([string]$p.id) ([string]$p.action)
        }
    } catch { Write-EntityStoreFallback 'policy_actions.json' $_ }
}

function Get-EntityNameVector {
    # The NAME vector of one stored value: v1 (schema 1.0.0) is a flat array, v2 (2.0.0) an object
    # with name_vector. Same rule as nameVectorOf in lib/entities/entityVectors.ts. $null when absent.
    param($Stored)
    if ($null -eq $Stored) { return $null }
    if ($Stored -is [System.Collections.IList]) { return ,[double[]]@($Stored) }
    if ($Stored.PSObject.Properties['name_vector'] -and $null -ne $Stored.name_vector) { return ,[double[]]@($Stored.name_vector) }
    return $null
}

function Get-EntityVectorIndex {
    # Existing entity name vectors (entity id -> vector), v1 and v2 (t/4075), plus the store's
    # embedding model for provenance (SO e/280#2 condition 3) and why the store is unusable, if it is.
    # These vectors feed ADVISORY candidates only — never a link (TL p/360#571): name-only cosine puts
    # distinct siblings above any threshold (Claude 3.5 vs 3.7 Sonnet 0.987).
    param([string]$Path)
    $Index = [PSCustomObject]@{ Vectors = @{}; Model = $null; Problem = $null }
    if (-not (Test-Path $Path)) { $Index.Problem = 'entity_embeddings.json not found'; return $Index }
    try {
        $EmbStore = Get-Content -Raw -Path $Path -Encoding utf8 | ConvertFrom-Json
        if ($EmbStore.PSObject.Properties['model'] -and $EmbStore.model) { $Index.Model = [string]$EmbStore.model }
        if ($EmbStore.PSObject.Properties['vectors'] -and $null -ne $EmbStore.vectors) {
            foreach ($prop in $EmbStore.vectors.PSObject.Properties) {
                $vec = Get-EntityNameVector -Stored $prop.Value
                if ($null -ne $vec -and $vec.Length -gt 0) { $Index.Vectors[$prop.Name] = $vec }
            }
        }
        if ($Index.Vectors.Count -eq 0) { $Index.Problem = 'entity_embeddings.json has no entity vectors' }
    } catch {
        Write-EntityStoreFallback 'entity_embeddings.json' $_
        $Index.Problem = 'entity_embeddings.json could not be loaded'
    }
    return $Index
}

function Get-EntityResolutionState {
    # Everything the sequential resolution pass reads and accumulates: the pre-existing match index
    # and entity vectors, plus the within-run mint candidates, dispositions and counters.
    param([string]$TaxDir, [string]$EntPath, [string]$EmbPath)
    $EntitiesStore = Get-EntitiesStore -Path $EntPath -InitIfMissing
    $ExistingEntities = if ($EntitiesStore.PSObject.Properties['entities']) { @($EntitiesStore.entities) } else { @() }

    $MatchIndex = @{}   # normalized string -> PSCustomObject{ Kind; Id; Label }
    Add-EntityStoreMatch -Index $MatchIndex -Entities $ExistingEntities
    Add-OrganizationMatch -Index $MatchIndex
    Add-TaxonomyLabelMatch -Index $MatchIndex -TaxDir $TaxDir
    Add-DictionaryMatch -Index $MatchIndex
    Add-PolicyActionMatch -Index $MatchIndex -TaxDir $TaxDir

    $VectorIndex = Get-EntityVectorIndex -Path $EmbPath
    $EntityNameById = @{}
    foreach ($e in $ExistingEntities) {
        if ($e.PSObject.Properties['id']) { $EntityNameById[[string]$e.id] = [string]$e.name }
    }

    [PSCustomObject]@{
        MatchIndex         = $MatchIndex
        EntityVectors      = $VectorIndex.Vectors
        EmbeddingModel     = $VectorIndex.Model
        EntityVectorProblem = $VectorIndex.Problem
        EntityNameById     = $EntityNameById
        ProposalsTotal     = 0
        DroppedBelowGate   = 0
        NearGateMinted     = 0
        LinkedDispositions = [System.Collections.Generic.List[PSObject]]::new()
        # Below-gate drops captured (not just counted) so gate recall is auditable — did the gate drop
        # anything good? Persisted to the sidecar log per node (t/1830 #3).
        DroppedProposals   = [System.Collections.Generic.List[PSObject]]::new()
        # Mint candidates, deduped WITHIN this run.
        MintCandidates     = [System.Collections.Generic.List[PSObject]]::new()
        # Within-run dedup index: normalized name OR alias -> index into MintCandidates. (t/1880 bullet 1:
        # was name-only, so a proposal whose name equalled an earlier within-run mint's ALIAS — or
        # vice-versa — slipped through. MatchIndex holds only PRE-existing records, so freshly-minted
        # siblings need their own index.)
        MintIndexByKey     = @{}
        # Within-run candidate probe vectors for the near-variant surfacing stage (t/1880#3 Option A):
        # candidate index -> probe vector. Compared candidate<->candidate, so it fires with ZERO approved
        # entities — unlike the existing-entity cosine (step 2), which is inert until an approval writes
        # the first vector into entity_embeddings.json.
        CandidateVectors   = @{}
        # Advisory near-variant pairs (t/1881): within-run cosine hits do NOT link. Name-only cosine
        # false-merges sibling entities (GPT-4/GPT-4o 0.90, Gemini 3.5/3.6 Flash 0.97) that score ABOVE
        # true dups (AI Action Plan 0.75) — the classes interleave, so no threshold separates them, and a
        # false merge DESTROYS a distinct entity. Hits are surfaced in the sidecar's possible_duplicates[].
        PossibleDuplicates = [System.Collections.Generic.List[PSObject]]::new()
        # Advisory existing-entity candidates (t/4075): per new mint candidate, the ranked existing
        # entities its name resembles. Never a link; a human confirms through Import-Entity merged_into.
        ExistingCandidates = [System.Collections.Generic.List[PSObject]]::new()
    }
}

# ── Work list ────────────────────────────────────────────────────────────────────────────────────

function Read-EntityExtractionLog {
    # The idempotence sidecar: node ids already processed, plus its existing node rows.
    param([string]$Path)
    $ProcessedNodeIds = @{}
    $ExistingLogNodes = [System.Collections.Generic.List[PSObject]]::new()
    if (Test-Path $Path) {
        $PrevLog = Get-Content -Raw -Path $Path | ConvertFrom-Json
        if ($PrevLog.PSObject.Properties['nodes']) {
            foreach ($n in @($PrevLog.nodes)) {
                $ExistingLogNodes.Add($n)
                if ($n.PSObject.Properties['node_id']) { $ProcessedNodeIds[[string]$n.node_id] = 1 }
            }
        }
    }
    [PSCustomObject]@{ ProcessedNodeIds = $ProcessedNodeIds; ExistingLogNodes = $ExistingLogNodes }
}

function ConvertTo-EntityExtractionWorkItem {
    # One SEI entry as a work item ({ NodeId; FactsText; DocIds }), or $null when it has no claims.
    # duplicate_of (t/4337): a fact from a marked copy is skipped, so the AI sees each claim once
    # and the entity's source_refs name only resolved docs (spec 6.3). Two ways a fact is a copy's:
    # its doc_id is a marked id (today's index), or it carries `via` (an index built with the spec 7
    # union re-attributes doc_id to the canonical). This is via's one branching reader (spec 7.6;
    # TL e/347#7: no paid re-extraction of byte-identical text; the loss is tracked in t/4401).
    param([string]$NodeId, $Entry, [pscustomobject]$Resolution)
    $Facts = if ($Entry -is [hashtable] -and $Entry.ContainsKey('facts') -and $Entry['facts']) { @($Entry['facts']) } else { @() }
    $Claims = [System.Collections.Generic.List[string]]::new()
    $DocIds = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $Facts) {
        if ($f -isnot [hashtable]) { continue }
        if ($f.ContainsKey('via') -and $f['via']) { continue }
        if ($Resolution -and $f.ContainsKey('doc_id') -and $f['doc_id'] -and -not (Test-SourceSelectable -Resolution $Resolution -Id ([string]$f['doc_id']))) { continue }
        if ($f.ContainsKey('claim') -and $f['claim']) { $Claims.Add([string]$f['claim']) }
        if ($f.ContainsKey('doc_id') -and $f['doc_id']) { $DocIds.Add([string]$f['doc_id']) }
    }
    if ($Claims.Count -eq 0) { return $null }

    $FactsText = ($Claims | ForEach-Object { "- $_" }) -join "`n"
    [PSCustomObject]@{
        NodeId    = $NodeId
        FactsText = $FactsText
        DocIds    = @($DocIds | Select-Object -Unique)
    }
}

function Get-EntityExtractionWorkList {
    # The ordered work list plus the two skip counts.
    param([hashtable]$Sei, [string[]]$NodeId, [bool]$Force, [hashtable]$ProcessedNodeIds, [int]$MaxNodes, [pscustomobject]$Resolution)
    $WantedNodes = if ($NodeId) { [System.Collections.Generic.HashSet[string]]::new([string[]]$NodeId) } else { $null }
    $WorkItems = [System.Collections.Generic.List[PSObject]]::new()
    $SkippedNoFacts = 0
    $SkippedAlreadyDone = 0

    foreach ($Nid in ($Sei.Keys | Sort-Object)) {
        if ($WantedNodes -and -not $WantedNodes.Contains($Nid)) { continue }
        if (-not $Force -and $ProcessedNodeIds.ContainsKey($Nid)) { $SkippedAlreadyDone++; continue }
        $Item = ConvertTo-EntityExtractionWorkItem -NodeId $Nid -Entry $Sei[$Nid] -Resolution $Resolution
        if ($null -eq $Item) { $SkippedNoFacts++; continue }
        $WorkItems.Add($Item)
    }

    if ($MaxNodes -and $WorkItems.Count -gt $MaxNodes) {
        $WorkItems = [System.Collections.Generic.List[PSObject]]($WorkItems | Select-Object -First $MaxNodes)
    }
    [PSCustomObject]@{ Items = $WorkItems; SkippedNoFacts = $SkippedNoFacts; SkippedAlreadyDone = $SkippedAlreadyDone }
}

# ── Extraction: AI call + shape validation ONLY ─────────────────────────────────────────────────
# The next four helpers are re-defined inside each ForEach-Object -Parallel runspace (Private helpers
# aren't visible there — same class of bug as t/1550/t/1553), so they may call only exported commands.

function Get-EntityProposalShapeError {
    # Why a parsed proposal is malformed, or $null when it is valid. Confidence is parsed here, so a
    # valid proposal's numeric confidence comes back in the second slot.
    param($Proposal, [string[]]$KnownTypes)
    $name = if ($Proposal.PSObject.Properties['name']) { [string]$Proposal.name } else { '' }
    $etype = if ($Proposal.PSObject.Properties['entity_type']) { [string]$Proposal.entity_type } else { '' }
    if ([string]::IsNullOrWhiteSpace($name)) { return 'missing name' }
    if ($etype -notin $KnownTypes) { return "entity_type '$etype' not in {$($KnownTypes -join ', ')}" }
    if (-not $Proposal.PSObject.Properties['confidence']) { return 'missing confidence' }
    $conf = 0.0
    try { $conf = [double]$Proposal.confidence } catch { return 'confidence not numeric' }
    if ($conf -lt 0.0 -or $conf -gt 1.0) { return "confidence $conf out of [0,1]" }
    return $null
}

function ConvertTo-EntityProposalRecord {
    # A proposal that passed Get-EntityProposalShapeError, in the record shape the resolver reads.
    param($Proposal)
    $aliases = if ($Proposal.PSObject.Properties['aliases'] -and $Proposal.aliases) { @($Proposal.aliases | ForEach-Object { [string]$_ }) } else { @() }
    $quote   = if ($Proposal.PSObject.Properties['quote']) { [string]$Proposal.quote } else { '' }
    [PSCustomObject]@{
        name        = [string]$Proposal.name
        entity_type = [string]$Proposal.entity_type
        aliases     = $aliases
        quote       = $quote
        confidence  = [double]$Proposal.confidence
    }
}

function Get-EntityResponseList {
    # A list field of the parsed response, or @() when the response omits it (t/4072). An omitted
    # field reads as empty, matching how an explicit [] is handled and how t/3195 keeps a truncated
    # response's valid prefix: the node succeeds with what it has rather than failing after its
    # proposals were already accepted. The omission is a fallback, so it WARNs.
    param($Parsed, [string]$Field, [string]$NodeId)
    if ($null -ne $Parsed -and $Parsed.PSObject.Properties[$Field]) { return @($Parsed.$Field) }
    Write-Warning "Invoke-EntityExtraction: ${NodeId}: response has no '$Field'; treating it as empty."
    return @()
}

function ConvertTo-EntityExtractionNode {
    # One work item through the AI: returns the node result; malformed proposals and failures are
    # added to the bags rather than thrown. A node is ParseOk once its response parses.
    param($Item, $UsageId, $KnownTypes, $InvBag, $FailBag, $Model)
    $Node = [PSCustomObject]@{ NodeId = $Item.NodeId; DocIds = $Item.DocIds; Proposals = @(); OrgMentions = @(); Model = $null; ParseOk = $false }
    try {
        # t/3123: only override the usage's configured model when -Model was explicitly passed
        # ($Model is '' by default). Otherwise the usage's model (claude-sonnet-4-6) wins — a
        # gemini-flash default here sent the Claude-shaped schema to Gemini → HTTP 400.
        $ModelOverride = if ($Model) { @{ model = $Model } } else { @{} }
        $ai = Invoke-AIByUsage -UsageId $UsageId -Values @{ node_id = $Item.NodeId; facts = $Item.FactsText } -Override $ModelOverride
        if ($null -eq $ai -or -not $ai.Text) {
            $FailBag.Add("$($Item.NodeId): empty AI response")
            return $Node
        }
        $body = [string]$ai.Text
        $body = $body -replace '^\s*```(json)?\s*', ''
        $body = $body -replace '\s*```\s*$', ''
        # t/3195: recover the valid prefix when a dense node's structured output truncates mid-JSON,
        # instead of failing the whole node.
        $parsed = ConvertFrom-TruncatableJson -Text $body.Trim() -Context $Item.NodeId
        $Node.Model = if ($ai.PSObject.Properties['Model']) { $ai.Model } else { $Model }
        $Node.ParseOk = $true

        $validProps = [System.Collections.Generic.List[object]]::new()
        foreach ($p in (Get-EntityResponseList $parsed 'proposals' $Item.NodeId)) {
            if ($null -eq $p) { continue }
            $reason = Get-EntityProposalShapeError -Proposal $p -KnownTypes $KnownTypes
            if ($reason) {
                $InvBag.Add("$($Item.NodeId): $reason")
                continue
            }
            $validProps.Add((ConvertTo-EntityProposalRecord -Proposal $p))
        }
        $Node.Proposals = @($validProps)
        # A plain statement, not the head of a pipeline: a caller's -WarningVariable doesn't collect a
        # warning written by the first command of a nested pipeline.
        $OrgList = Get-EntityResponseList $parsed 'org_mentions' $Item.NodeId
        $Node.OrgMentions = @(
            @($OrgList) | Where-Object { $_ -and $_.PSObject.Properties['name'] -and $_.name } | ForEach-Object { [string]$_.name }
        )
    } catch {
        $FailBag.Add("$($Item.NodeId): $($_.Exception.Message)")
    }
    return $Node
}

function Invoke-EntityProposalExtraction {
    # Runs every work item through ConvertTo-EntityExtractionNode, sequentially or in parallel.
    # Resolution/minting is sequential, after this (see the cmdlet).
    param([System.Collections.Generic.List[PSObject]]$WorkItems, [string]$UsageId, [string]$Model, [int]$Concurrency)
    $RawResults = [System.Collections.Concurrent.ConcurrentBag[PSObject]]::new()
    $Failed     = [System.Collections.Concurrent.ConcurrentBag[string]]::new()
    $Invalid    = [System.Collections.Concurrent.ConcurrentBag[string]]::new()

    $ModulePath = Join-Path $script:ModuleRoot 'AITriad.psm1'
    $EnrichPath = Join-Path $script:ModuleRoot '..' 'AIEnrich.psm1'
    if (-not (Test-Path $EnrichPath)) { $EnrichPath = Join-Path $script:ModuleRoot 'AIEnrich.psm1' }
    $KnownTypes = @('person', 'artifact', 'event', 'legislation', 'institution')
    $Total      = $WorkItems.Count
    $ProgressId = 2
    $Completed  = [ref]0

    Write-Progress -Id $ProgressId -Activity 'Extracting entity proposals' -Status "0 / $Total" -PercentComplete 0

    if ($Concurrency -eq 1) {
        foreach ($Item in $WorkItems) {
            $Node = ConvertTo-EntityExtractionNode $Item $UsageId $KnownTypes $Invalid $Failed $Model
            $RawResults.Add($Node)
            $Done = [System.Threading.Interlocked]::Increment($Completed)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $Total) * 100))
            Write-Progress -Id $ProgressId -Activity 'Extracting entity proposals' -Status "$Done / $Total" -PercentComplete $Pct
        }
    } else {
        $FnDefs = @{}
        foreach ($fn in 'ConvertTo-EntityExtractionNode', 'Get-EntityProposalShapeError', 'ConvertTo-EntityProposalRecord', 'Get-EntityResponseList') {
            $FnDefs[$fn] = (Get-Command $fn -CommandType Function).ScriptBlock.ToString()
        }
        $WorkItems | ForEach-Object -Parallel {
            Import-Module $using:ModulePath -Force -WarningAction SilentlyContinue
            Import-Module $using:EnrichPath -Force -WarningAction SilentlyContinue
            $Defs = $using:FnDefs
            foreach ($fn in $Defs.Keys) { Set-Item -Path "function:global:$fn" -Value ([scriptblock]::Create($Defs[$fn])) }
            $RawBag   = $using:RawResults
            $CompRef  = $using:Completed
            $TotalCnt = $using:Total
            $ProgId   = $using:ProgressId

            $Node = ConvertTo-EntityExtractionNode $_ $using:UsageId $using:KnownTypes $using:Invalid $using:Failed $using:Model
            $RawBag.Add($Node)

            $Done = [System.Threading.Interlocked]::Increment($CompRef)
            $Pct  = [math]::Min(100, [math]::Round(($Done / $TotalCnt) * 100))
            Write-Progress -Id $ProgId -Activity 'Extracting entity proposals' -Status "$Done / $TotalCnt" -PercentComplete $Pct
        } -ThrottleLimit $Concurrency
    }

    Write-Progress -Id $ProgressId -Activity 'Extracting entity proposals' -Completed
    [PSCustomObject]@{ RawResults = $RawResults; Failed = $Failed; Invalid = $Invalid }
}

# ── Sequential resolution ───────────────────────────────────────────────────────────────────────

function Get-NodeProbeVectorMap {
    # Batch-encodes a node's above-gate proposal names in ONE embedding call (t/1880#3: per-node batch
    # encode, not per-proposal cold-starts). Feeds BOTH the existing-entity cosine (step 2) and the
    # within-run cosine (step 4). Best-effort: if the embedder is unavailable the map stays empty and
    # both cosine stages no-op (surfaced via Write-Warning, not silent) — exact/alias dedup still runs.
    # Keyed by normalized name (intra-node same-name collapses).
    param($Node, [double]$ConfidenceThreshold)
    $NodeProbeVecByNorm = @{}
    $NodeEncodeNames = @{}
    foreach ($pp in @($Node.Proposals)) {
        if ($pp.confidence -ge $ConfidenceThreshold) {
            $ppNorm = ConvertTo-EntityMatchKey $pp.name
            if (-not [string]::IsNullOrEmpty($ppNorm)) { $NodeEncodeNames[$ppNorm] = [string]$pp.name }
        }
    }
    if ($NodeEncodeNames.Count -eq 0) { return $NodeProbeVecByNorm }
    try {
        $encIds   = @($NodeEncodeNames.Keys)
        $encTexts = @($encIds | ForEach-Object { $NodeEncodeNames[$_] })
        $encMap = Get-TextEmbedding -Texts $encTexts -Ids $encIds
        if ($encMap) {
            foreach ($k in $encIds) {
                if ($encMap.ContainsKey($k) -and @($encMap[$k]).Count -gt 0) {
                    $NodeProbeVecByNorm[$k] = [double[]]@($encMap[$k])
                }
            }
        }
    } catch {
        Write-Warning "Invoke-EntityExtraction: within-run embedding batch failed for node $($Node.NodeId) — cosine dedup skipped for its proposals ($($_.Exception.Message))"
    }
    return $NodeProbeVecByNorm
}

function Find-BestCosineMatch {
    # The key in $Vectors most similar to $Probe as { Key; Sim }, or $null when $Vectors is empty.
    # Strict -gt, so the first-enumerated key wins a tie.
    param([double[]]$Probe, [hashtable]$Vectors)
    $bestSim = -1.0; $bestKey = $null
    foreach ($k in $Vectors.Keys) {
        $sim = Get-CosineSimilarity -A $Probe -B $Vectors[$k]
        if ($sim -gt $bestSim) { $bestSim = $sim; $bestKey = $k }
    }
    if ($null -eq $bestKey) { return $null }
    [PSCustomObject]@{ Key = $bestKey; Sim = $bestSim }
}

function Find-EntityExactMatch {
    # Step 1: exact/alias match against the pre-existing stores (name first, then aliases).
    param([hashtable]$MatchIndex, [string]$NormName, [string[]]$NormAliases)
    if ($MatchIndex.ContainsKey($NormName)) { return $MatchIndex[$NormName] }
    foreach ($na in $NormAliases) {
        if ($MatchIndex.ContainsKey($na)) { return $MatchIndex[$na] }
    }
    return $null
}

function Add-ExistingEntityCandidate {
    # Step 2 (ADVISORY, t/4075): the existing entities a new mint candidate's name resembles, ranked
    # (up to K non-version-sibling candidates plus every flagged version sibling) and queued for the
    # sidecar's existing_entity_candidates[]. It NEVER links: name-only cosine scores distinct siblings
    # (Claude 3.5 vs 3.7 Sonnet 0.987) above true duplicates, so a human confirms any merge through
    # Import-Entity merged_into (TL p/360#571, SO e/280#2, TL e/280#3).
    param($State, $Node, $Proposal, [int]$NewIndex, $ProbeVec, [double]$Floor)
    if ($State.EntityVectors.Count -eq 0) { return }
    if ($null -eq $ProbeVec) {
        Write-Verbose "Invoke-EntityExtraction: embedding unavailable for '$($Proposal.name)' — existing-entity cosine check skipped"
        return
    }
    $scored = @(Get-EntityCandidateScoreSet -Probe $ProbeVec -Vectors $State.EntityVectors -NameById $State.EntityNameById `
        -ProposalName ([string]$Proposal.name) -Floor $Floor)
    foreach ($c in @(Select-EntityCandidateRanking -Scored $scored -K 3)) {
        $State.ExistingCandidates.Add([PSCustomObject]@{
            NodeId         = $Node.NodeId
            NewIndex       = $NewIndex
            ProposalName   = $Proposal.name
            EntityId       = $c.EntityId
            EntityName     = $c.EntityName
            Similarity     = $c.Similarity
            Rank           = $c.Rank
            VersionSibling = [bool]$c.VersionSibling
        })
    }
}

function Find-WithinRunDuplicate {
    # Step 3: within-run EXACT dedup — the proposal's normalized name OR any alias collides with an
    # already-minted within-run candidate's name/alias (t/1880 bullet 1). First matching key wins
    # (name before aliases). Returns the candidate index, or $null.
    param([hashtable]$MintIndexByKey, [string[]]$Keys)
    foreach ($key in $Keys) {
        if (-not [string]::IsNullOrEmpty($key) -and $MintIndexByKey.ContainsKey($key)) { return $MintIndexByKey[$key] }
    }
    return $null
}

function Add-EntityMintCandidate {
    # Queues an unmatched proposal for minting and registers its keys (first-writer-wins) and probe
    # vector for the within-run stages. Step 4 (ADVISORY near-variant surfacing, t/1881) is recorded
    # here: a resemblance to an earlier within-run candidate above the threshold is surfaced as a
    # pair for curation, never linked (name-only cosine false-merges siblings — GPT-4/GPT-4o 0.90,
    # Gemini 3.5/3.6 Flash 0.97 — that score ABOVE true dups, so auto-linking would destroy a distinct
    # entity). The pair is resolved to minted ids after the mint pass.
    param($State, $Node, $Proposal, [string[]]$Keys, $ProbeVec, [string]$Dolce, [bool]$NearGate,
        [double]$WithinRunSimilarityThreshold, [double]$LinkSimilarityThreshold)
    $surfaced = if ($null -ne $ProbeVec -and $State.CandidateVectors.Count -gt 0) { Find-BestCosineMatch -Probe $ProbeVec -Vectors $State.CandidateVectors } else { $null }

    $docIdSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($d in $Node.DocIds) { [void]$docIdSet.Add($d) }

    $candidate = [PSCustomObject]@{
        NodeId            = $Node.NodeId
        Name              = $Proposal.name
        EntityType        = $Proposal.entity_type
        Dolce             = $Dolce
        Aliases           = @($Proposal.aliases)
        Confidence        = $Proposal.confidence
        NearGate          = $NearGate
        Quote             = $Proposal.quote
        Model             = $Node.Model
        DocIdSet          = $docIdSet
        OtherOccurrences  = [System.Collections.Generic.List[object]]::new()
        MintedId          = $null
    }
    $newIdx = $State.MintCandidates.Count
    $State.MintCandidates.Add($candidate)
    Add-ExistingEntityCandidate -State $State -Node $Node -Proposal $Proposal -NewIndex $newIdx -ProbeVec $ProbeVec -Floor $LinkSimilarityThreshold
    foreach ($key in $Keys) {
        if (-not [string]::IsNullOrEmpty($key) -and -not $State.MintIndexByKey.ContainsKey($key)) { $State.MintIndexByKey[$key] = $newIdx }
    }
    if ($null -ne $ProbeVec) { $State.CandidateVectors[$newIdx] = $ProbeVec }
    if ($null -ne $surfaced -and $null -ne $surfaced.Key -and $surfaced.Sim -ge $WithinRunSimilarityThreshold) {
        $State.PossibleDuplicates.Add([PSCustomObject]@{
            NodeId       = $Node.NodeId
            NewIndex     = $newIdx
            MatchedIndex = $surfaced.Key
            ProposalName = $Proposal.name
            MatchedName  = $State.MintCandidates[$surfaced.Key].Name
            Similarity   = [math]::Round($surfaced.Sim, 4)
        })
    }
    if ($NearGate) { $State.NearGateMinted++ }
}

function Resolve-EntityProposal {
    # One proposal through the gate and the four resolution steps: dropped, linked, folded into an
    # earlier within-run candidate, or queued for minting.
    param($State, $Node, $Proposal, $ProbeVecByNorm, [hashtable]$DolceMap, [double]$ConfidenceThreshold,
        [double]$NearGateBand, [double]$LinkSimilarityThreshold, [double]$WithinRunSimilarityThreshold)
    $State.ProposalsTotal++
    if ($Proposal.confidence -lt $ConfidenceThreshold) {
        $State.DroppedBelowGate++
        $State.DroppedProposals.Add([PSCustomObject]@{
            node_id     = $Node.NodeId
            name        = $Proposal.name
            entity_type = $Proposal.entity_type
            confidence  = $Proposal.confidence
        })
        return
    }
    $nearGate = ($Proposal.confidence -lt ($ConfidenceThreshold + $NearGateBand))
    $normName = ConvertTo-EntityMatchKey $Proposal.name
    $normAliases = @($Proposal.aliases | ForEach-Object { ConvertTo-EntityMatchKey $_ })

    $hit = Find-EntityExactMatch -MatchIndex $State.MatchIndex -NormName $normName -NormAliases $normAliases
    if ($hit) {
        $State.LinkedDispositions.Add([PSCustomObject]@{
            node_id        = $Node.NodeId
            proposal_name  = $Proposal.name
            matched_kind   = $hit.Kind
            matched_id     = $hit.Id
            matched_label  = $hit.Label
            reason         = 'exact-or-alias-match'
        })
        return
    }

    # Shared per-node probe vector, reused by BOTH cosine stages so a proposal is encoded at most once.
    # Neither cosine stage links (t/1881, t/4075): both only surface candidates for a human.
    $probeVec = if ($ProbeVecByNorm.ContainsKey($normName)) { $ProbeVecByNorm[$normName] } else { $null }

    $keys = @($normName) + $normAliases
    $wrIdx = Find-WithinRunDuplicate -MintIndexByKey $State.MintIndexByKey -Keys $keys
    if ($null -ne $wrIdx) {
        $existingCandidate = $State.MintCandidates[$wrIdx]
        $existingCandidate.OtherOccurrences.Add([PSCustomObject]@{ NodeId = $Node.NodeId; ProposalName = $Proposal.name; Reason = 'within-run-dedup' })
        foreach ($d in $Node.DocIds) { [void]$existingCandidate.DocIdSet.Add($d) }
        # NearGateMinted counts distinct MINTED entities, not raw occurrences — a dedup'd duplicate is
        # linked, not minted, so it is not counted again here.
        return
    }

    Add-EntityMintCandidate -State $State -Node $Node -Proposal $Proposal -Keys $keys -ProbeVec $probeVec `
        -Dolce $DolceMap[$Proposal.entity_type] -NearGate $nearGate -WithinRunSimilarityThreshold $WithinRunSimilarityThreshold `
        -LinkSimilarityThreshold $LinkSimilarityThreshold
}

# ── Minting and dispositions ────────────────────────────────────────────────────────────────────

function Invoke-EntityCandidateMint {
    # Mints in sub-batches of <= 20 (Import-Entity's ValidateCount ceiling) and records each minted id.
    param([System.Collections.Generic.List[PSObject]]$MintCandidates, [string]$UsageId, [string]$EntPath, [string]$EmbPath)
    $BatchSize = 20
    for ($i = 0; $i -lt $MintCandidates.Count; $i += $BatchSize) {
        $Slice = @($MintCandidates | Select-Object -Skip $i -First $BatchSize)
        $Proposals = @($Slice | ForEach-Object {
            # PERSON EXCEPTION (and, per design, every entity_type in Phase 1): NO `description` key is
            # ever passed — the LLM never authors one.
            @{
                name           = $_.Name
                entity_type    = $_.EntityType
                dolce_category = $_.Dolce
                aliases        = @($_.Aliases)
                source_refs    = @($_.DocIdSet)
                confidence     = $_.Confidence
                # Ordered so entities.json is byte-stable across processes (t/4072); alphabetical.
                discovered_by  = [ordered]@{ model = $_.Model; usage_id = $UsageId }
                status         = 'proposed'
            }
        })
        $MintResults = @(Import-Entity -Proposal $Proposals -Path $EntPath -EmbeddingsPath $EmbPath -Confirm:$false)
        for ($j = 0; $j -lt $Slice.Count; $j++) {
            $Slice[$j].MintedId = $MintResults[$j].Id
        }
    }
}

function Add-WithinRunOccurrenceLink {
    # Occurrences beyond the first (within-run dedup) link to the freshly minted id.
    param($State)
    foreach ($candidate in $State.MintCandidates) {
        foreach ($occ in $candidate.OtherOccurrences) {
            $occReason = if ($occ.PSObject.Properties['Reason'] -and $occ.Reason) { [string]$occ.Reason } else { 'within-run-dedup' }
            $State.LinkedDispositions.Add([PSCustomObject]@{
                node_id        = $occ.NodeId
                proposal_name  = $occ.ProposalName
                matched_kind   = 'entity'
                matched_id     = $candidate.MintedId
                matched_label  = $candidate.Name
                reason         = $occReason
            })
        }
    }
}

function Get-EntityPossibleDuplicateRowSet {
    # The advisory near-variant pairs (t/1881) resolved to minted ids: both entities were minted, and
    # curation reviews via the merge/redirect path.
    param($State)
    $Rows = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($pd in $State.PossibleDuplicates) {
        $Rows.Add([PSCustomObject]@{
            node_id       = $pd.NodeId
            candidate_id  = $State.MintCandidates[$pd.NewIndex].MintedId
            proposal_name = $pd.ProposalName
            matched_id    = $State.MintCandidates[$pd.MatchedIndex].MintedId
            matched_name  = $pd.MatchedName
            similarity    = $pd.Similarity
        })
    }
    return , $Rows
}

function Get-EntityExistingCandidateRowSet {
    # The advisory existing-entity candidates (t/4075) resolved to the newly minted ids. Advisory only:
    # a confirmed match is recorded through Import-Entity merged_into, never in this log (TL e/280#3).
    param($State)
    $Rows = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($ec in $State.ExistingCandidates) {
        $Rows.Add([PSCustomObject]@{
            node_id         = $ec.NodeId
            candidate_id    = $State.MintCandidates[$ec.NewIndex].MintedId
            proposal_name   = $ec.ProposalName
            entity_id       = $ec.EntityId
            entity_name     = $ec.EntityName
            similarity      = $ec.Similarity
            rank            = $ec.Rank
            version_sibling = $ec.VersionSibling
        })
    }
    return , $Rows
}

function Write-ExistingCandidateStageStatus {
    # Never silent (TL p/360#571): WARN when the existing-entity candidate stage could not run, or ran
    # and found nothing at or above the floor. Says nothing when no proposal was minted.
    param($State, [int]$CandidateRowCount, [double]$Floor)
    $minted = @($State.MintCandidates).Count
    if ($minted -eq 0) { return }
    if ($State.EntityVectors.Count -eq 0) {
        $why = if ($State.EntityVectorProblem) { $State.EntityVectorProblem } else { 'no entity vectors' }
        Write-Warning "Invoke-EntityExtraction: existing-entity candidate stage skipped ($why); $minted minted proposal(s) were not compared with existing entities."
        return
    }
    if ($CandidateRowCount -eq 0) {
        Write-Warning "Invoke-EntityExtraction: existing-entity candidate stage found no candidate at or above $Floor for $minted minted proposal(s)."
    }
}

# ── Sidecar log ──────────────────────────────────────────────────────────────────────────────────

function Group-EntityRowsByNode {
    # Rows grouped into a node id -> List map, keyed by the row's node id property.
    param($Rows, [string]$KeyProperty)
    $ByNode = @{}
    foreach ($r in $Rows) {
        $k = $r.$KeyProperty
        if (-not $ByNode.ContainsKey($k)) { $ByNode[$k] = [System.Collections.Generic.List[PSObject]]::new() }
        $ByNode[$k].Add($r)
    }
    return $ByNode
}

function Get-EntityExtractionLogNodeSet {
    # The sidecar row per node whose AI call/parse succeeded (a failure is retried next run). Each row
    # carries the per-node audit rows, keyed by node_id so they ride the -Force remove/re-add path:
    #   evidence[]            — supporting quote per MINTED entity (curation's person-exception review, t/1830 #2);
    #   dropped[]             — below-gate proposals, so gate recall is auditable (t/1830 #3);
    #   possible_duplicates[] — advisory near-variant pairs, grouped by the NEW proposal's node (t/1881);
    #   existing_entity_candidates[] — advisory ranked existing-entity matches per minted proposal (t/4075),
    #     with embedding_model recording which model produced their similarities (SO e/280#2 condition 3).
    #     Stamped on the node row because the log merges runs: the row IS the run-level record.
    param([object[]]$SortedResults, $State, $PossibleDuplicateRows, $ExistingCandidateRows)
    $Evidence = @($State.MintCandidates | ForEach-Object { [PSCustomObject]@{ node_id = $_.NodeId; id = $_.MintedId; name = $_.Name; quote = $_.Quote } })
    $EvidenceByNode = Group-EntityRowsByNode -Rows $Evidence -KeyProperty 'node_id'
    $DroppedByNode = Group-EntityRowsByNode -Rows $State.DroppedProposals -KeyProperty 'node_id'
    $PossibleDupByNode = Group-EntityRowsByNode -Rows $PossibleDuplicateRows -KeyProperty 'node_id'
    $CandidatesByNode = Group-EntityRowsByNode -Rows $ExistingCandidateRows -KeyProperty 'node_id'

    $NewlyProcessed = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($Node in $SortedResults) {
        if (-not $Node.ParseOk) { continue }
        $nodeEvidence = if ($EvidenceByNode.ContainsKey($Node.NodeId)) { @($EvidenceByNode[$Node.NodeId] | ForEach-Object { [PSCustomObject]@{ id = $_.id; name = $_.name; quote = $_.quote } }) } else { @() }
        $nodeDropped  = if ($DroppedByNode.ContainsKey($Node.NodeId)) { @($DroppedByNode[$Node.NodeId]) } else { @() }
        $nodePossibleDup = if ($PossibleDupByNode.ContainsKey($Node.NodeId)) { @($PossibleDupByNode[$Node.NodeId]) } else { @() }
        $nodeCandidates = if ($CandidatesByNode.ContainsKey($Node.NodeId)) { @($CandidatesByNode[$Node.NodeId] | Select-Object -Property * -ExcludeProperty node_id) } else { @() }
        $NewlyProcessed.Add([PSCustomObject]@{
            node_id                    = $Node.NodeId
            processed_at               = (Get-Date).ToString('o')
            model                      = $Node.Model
            proposals_total            = @($Node.Proposals).Count
            org_mentions               = @($Node.OrgMentions)
            evidence                   = @($nodeEvidence)
            dropped                    = @($nodeDropped)
            possible_duplicates        = @($nodePossibleDup)
            embedding_model            = $State.EmbeddingModel
            existing_entity_candidates = @($nodeCandidates)
        })
    }
    return , $NewlyProcessed
}

function Write-EntityExtractionLog {
    # Merges the newly processed rows into the existing log (-Force replaces a refreshed node's old
    # row) and writes the sidecar atomically. Nothing is written when no node was processed.
    param([string]$Path, [System.Collections.Generic.List[PSObject]]$ExistingLogNodes, $NewlyProcessed, [bool]$Force)
    if ($Force) {
        $refreshedIdList = @($NewlyProcessed | ForEach-Object { [string]$_.node_id })
        $refreshedIds = [System.Collections.Generic.HashSet[string]]::new([string[]]$refreshedIdList)
        $ExistingLogNodes = [System.Collections.Generic.List[PSObject]](
            @($ExistingLogNodes | Where-Object { -not $refreshedIds.Contains([string]$_.node_id) })
        )
    }
    foreach ($n in $NewlyProcessed) { $ExistingLogNodes.Add($n) }
    if ($NewlyProcessed.Count -eq 0) { return }

    $LogStore = [PSCustomObject]@{
        _schema_version = '1.3.0'
        _doc            = 'Entity extraction idempotence log (t/1806 Phase 1). Feeds -Force replay decisions; not a data-of-record store (entities.json is). Each node carries evidence[] (supporting quote per minted entity id, for curation) and dropped[] (below-gate proposals, for gate-recall audit) — added t/1830 — and possible_duplicates[] (advisory near-variant pairs {candidate_id, proposal_name, matched_id, matched_name, similarity}: both entities were minted, curation reviews via merge/redirect; name-only cosine cannot safely auto-link siblings) — added t/1881. 1.3.0 (t/4075) adds embedding_model and existing_entity_candidates[] (advisory, ranked existing entities each minted proposal resembles {candidate_id, proposal_name, entity_id, entity_name, similarity, rank, version_sibling}: never a link; up to 3 non-sibling candidates plus every version sibling at or above -LinkSimilarityThreshold; version_sibling=false means only that no version difference was detected, NOT that the pair is safe to merge; a confirmed match is recorded via Import-Entity merged_into, never here). Review with Get-EntityExtractionCandidates.'
        last_modified   = (Get-Date).ToString('yyyy-MM-dd')
        node_count      = @($ExistingLogNodes).Count
        nodes           = @($ExistingLogNodes)
    }
    Assert-DataWriteAllowed -Path $Path  # t/2902
    $Temp = "$Path.tmp"
    $Json = $LogStore | ConvertTo-Json -Depth 8
    Set-Content -Path $Temp -Value $Json -Encoding utf8NoBOM
    [System.IO.File]::Move($Temp, $Path, $true)
}
