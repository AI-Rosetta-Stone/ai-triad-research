# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Build-NodeSourceIndex {
    <#
    .SYNOPSIS
        Build the derived belief-node → primary-source index (t/3596). Inverts the
        summaries' existing node-citation links into a per-node source list.
    .DESCRIPTION
        Provenance today runs source→belief only (summaries carry the links). This
        materializes the inverse as a standalone, regenerable sidecar
        `taxonomy/Origin/source_index.json` — a map `node_id → sources[]` — so
        "trace this belief to its primary sources" is a one-hop, node-local lookup.

        Design is SO-cleared (schema/data-model class, t/3361; e/192) and CL-locked
        (t/3596#2/#4). It is an AGGREGATION of existing data, not new annotation, and
        a SIDECAR (nodes stay hand-authored; this file is derived). Cross-toolchain
        (PS writes, TS/metric reads) → ADR-0002: `schemaVersion` header + tolerant reads.

        Sources are inverted from both link surfaces, against LIVE node ids only
        (dead links are the companion cleanup t/3595 — this builder simply ignores
        any link whose node id is not live):
          - pov_summaries.{pov}.key_points[].taxonomy_node_id  (link_source=key_point)
          - factual_claims[].linked_taxonomy_nodes[]           (link_source=factual_claim)

        Entry shape (required link_source makes the nullable fields interpretable):
          { source_id, link_source, quote, doc_position, evidence_level, extraction_confidence }
          - source_id ← summary doc_id (resolves to ../ai-triad-sources/<id>/metadata.json;
            NOT denormalized — that file is the citation source of truth).
          - key_point   → quote=verbatim, doc_position=$null, evidence_level=$null
          - factual_claim → quote=claim, doc_position, evidence_level=evidence_criteria

        Determinism (SO conditions 1 & 3): the file is BYTE-IDENTICAL across runs over
        identical inputs — NO wall-clock timestamp anywhere; all ordering via ordinal
        collation ([string]::CompareOrdinal), never culture-aware Sort-Object. A
        self-describing header carries schemaVersion, builder+version, an inputHash
        (sha256 over the inverted summaries), and count totals, so staleness (t/3598)
        is a hash compare and the count-reconcile checks the file's own totals.

        Dedup (SO condition 2, CL t/3596#4): collapse on the 4-tuple
        (source_id, quote, link_source, doc_position). doc_position is semantically
        distinguishing (same source quoting the same text to support vs contest a node
        is two grounding stances). On a residual collision (same 4-tuple, differing
        quality fields) the survivor is max extraction_confidence, carrying its paired
        evidence_level; ties broken by the total ordinal sort.

        All live belief nodes appear as keys (SO condition 4), zero-source nodes with
        an explicit empty array, so the index is self-describing for coverage (t/3597
        denominator = key count) and a missing key is unambiguously an error.

        DATA WRITE: producing the file mutates the data repo; it runs under the
        /data-mutation discipline (clean tree — enforced by the Write-Utf8NoBom guard —
        app-quiesce, second-agent count-reconcile) and must invert the CLEANED, live-id
        corpus (gated on t/3595). Use -WhatIf to preview without writing; -PassThru
        returns the built index in addition to writing it.
    .PARAMETER SummariesDir
        Directory of summary JSON files to invert. Default: Get-SummariesDir.
    .PARAMETER TaxonomyDir
        Directory holding the POV node files (accelerationist/safetyist/skeptic.json).
        Default: Get-TaxonomyDir.
    .PARAMETER OutputPath
        Where to write the index. Default: <TaxonomyDir>/source_index.json.
    .PARAMETER PassThru
        Return the built index object (ordered) instead of only writing it.
    .OUTPUTS
        [pscustomobject] the index (with -PassThru).
    .EXAMPLE
        Build-NodeSourceIndex -WhatIf
        # Preview: reports node/entry totals without writing.
    .EXAMPLE
        $ix = Build-NodeSourceIndex -PassThru
        $ix.index.'saf-beliefs-201'   # sources grounding that belief
    .LINK
        Get-TaxonomyHealth
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$SummariesDir,

        [Parameter()]
        [string]$TaxonomyDir,

        [Parameter()]
        [string]$OutputPath,

        [Parameter()]
        [string]$SourcesDir,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $SchemaVersion = 1
    $BuilderVersion = '1.1.0'   # bump on any output-shape/serialization change (NOT per run); 1.1.0: marksHash (t/4337)

    if (-not $SummariesDir) { $SummariesDir = Get-SummariesDir }
    if (-not $TaxonomyDir)  { $TaxonomyDir  = Get-TaxonomyDir }
    if (-not $OutputPath)   { $OutputPath   = Join-Path $TaxonomyDir 'source_index.json' }
    if (-not $SourcesDir) {
        try { $SourcesDir = Get-SourcesDir }
        catch { Write-Warning "Build-NodeSourceIndex: no sources directory resolved ($($_.Exception.Message)); duplicate_of marks are not applied."; $SourcesDir = '' }
    }

    if (-not (Test-Path -LiteralPath $SummariesDir)) {
        throw (New-ActionableError -PassThru `
            -Goal 'Build the node→source index' `
            -Problem "Summaries directory not found: $SummariesDir" `
            -Location 'Build-NodeSourceIndex' `
            -NextSteps @('Confirm the data root resolves (Get-SummariesDir)', 'Pass -SummariesDir explicitly'))
    }

    # ── Live belief-node id set (acc/saf/skp) ───────────────────────────────────
    $Live = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($f in @('accelerationist.json', 'safetyist.json', 'skeptic.json')) {
        $p = Join-Path $TaxonomyDir $f
        if (-not (Test-Path -LiteralPath $p)) {
            throw (New-ActionableError -PassThru `
                -Goal 'Build the node→source index' `
                -Problem "POV node file not found: $p" `
                -Location 'Build-NodeSourceIndex' `
                -NextSteps @('Confirm the taxonomy dir (Get-TaxonomyDir) holds the three POV files'))
        }
        $doc = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json
        if ($doc.PSObject.Properties['nodes']) {
            foreach ($n in @($doc.nodes)) {
                if ($n.PSObject.Properties['id'] -and $n.id) { [void]$Live.Add([string]$n.id) }
            }
        }
    }
    if ($Live.Count -eq 0) {
        throw (New-ActionableError -PassThru `
            -Goal 'Build the node→source index' `
            -Problem 'No live belief-node ids loaded from the POV files' `
            -Location 'Build-NodeSourceIndex' `
            -NextSteps @('Confirm the POV node files are valid JSON with a nodes[] array'))
    }

    # ── Collect (per node) source entries ───────────────────────────────────────
    # inputHash (self-describing header, SO cond 1) is computed by the shared
    # Get-SummariesInputHash so the t/3598 staleness gate can never drift from the builder.
    $byNode = @{}   # node_id -> List[entry]
    foreach ($id in $Live) { $byNode[$id] = [System.Collections.Generic.List[object]]::new() }
    $nKp = 0; $nFc = 0

    # duplicate_of (spec section 6, t/4337 C1): a marked copy's summary is skipped, so each
    # resolved doc contributes one set of entries. Stored source ids are never rewritten.
    $resolution = Get-SourceResolution -SourcesDir $SourcesDir
    $files = @(Get-ChildItem -LiteralPath $SummariesDir -Filter '*.json' -File | Sort-Object Name)
    $files = @(Select-SelectableSummaryFile -Files $files -Resolution $resolution)
    foreach ($file in $files) {
        $raw = [System.IO.File]::ReadAllBytes($file.FullName)
        $s = [System.Text.Encoding]::UTF8.GetString($raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if (-not $s.PSObject.Properties['doc_id'] -or -not $s.doc_id) { continue }
        $sourceId = [string]$s.doc_id
        if (-not (Test-SourceSelectable -Resolution $resolution -Id $sourceId)) { continue }   # file named differently from its doc_id

        if ($s.PSObject.Properties['pov_summaries'] -and $s.pov_summaries) {
            foreach ($pov in $s.pov_summaries.PSObject.Properties.Name) {
                $block = $s.pov_summaries.$pov
                if (-not ($block.PSObject.Properties['key_points'])) { continue }
                foreach ($kp in @($block.key_points)) {
                    if (-not $kp.PSObject.Properties['taxonomy_node_id']) { continue }
                    $nid = [string]$kp.taxonomy_node_id
                    if (-not $nid -or -not $Live.Contains($nid)) { continue }
                    $ec = if ($kp.PSObject.Properties['extraction_confidence']) { $kp.extraction_confidence } else { $null }
                    $q  = if ($kp.PSObject.Properties['verbatim']) { [string]$kp.verbatim } else { '' }
                    $byNode[$nid].Add([pscustomobject]@{
                        source_id = $sourceId; link_source = 'key_point'; quote = $q
                        doc_position = $null; evidence_level = $null; extraction_confidence = $ec
                    })
                }
            }
        }

        if ($s.PSObject.Properties['factual_claims'] -and $s.factual_claims) {
            foreach ($fc in @($s.factual_claims)) {
                if (-not $fc.PSObject.Properties['linked_taxonomy_nodes']) { continue }
                $dp = if ($fc.PSObject.Properties['doc_position']) { $fc.doc_position } else { $null }
                $el = if ($fc.PSObject.Properties['evidence_criteria']) { $fc.evidence_criteria } else { $null }
                $ec = if ($fc.PSObject.Properties['extraction_confidence']) { $fc.extraction_confidence } else { $null }
                $q  = if ($fc.PSObject.Properties['claim']) { [string]$fc.claim } else { '' }
                foreach ($nid in @($fc.linked_taxonomy_nodes)) {
                    $nid = [string]$nid
                    if (-not $nid -or -not $Live.Contains($nid)) { continue }
                    $byNode[$nid].Add([pscustomobject]@{
                        source_id = $sourceId; link_source = 'factual_claim'; quote = $q
                        doc_position = $dp; evidence_level = $el; extraction_confidence = $ec
                    })
                }
            }
        }
    }

    $inputHash = Get-SummariesInputHash -SummariesDir $SummariesDir
    # Separate from inputHash so the citation gate can still check summaries when no sources
    # checkout exists (-SkipSourceResolution); it compares marksHash only when sources resolve.
    $marksHash = Get-SourceMarksHash -Resolution $resolution

    # ── Dedup + ordinal sort per node ───────────────────────────────────────────
    # Dedup key: source_id | quote | link_source | doc_position (SO cond 2 / CL #4).
    # Collision survivor: max extraction_confidence (carry paired evidence_level).
    $dpKey = { param($v) if ($null -eq $v) { "`u{0000}" } else { [string]$v } }   # null sorts/keys distinctly
    function script:EntrySortKey($e) {
        # ordinal composite: source_id, doc_position (nulls last via high sentinel), quote, link_source
        $dp = if ($null -eq $e.doc_position) { "`u{FFFF}" } else { [string]$e.doc_position }
        "{0}`u{0001}{1}`u{0001}{2}`u{0001}{3}" -f $e.source_id, $dp, $e.quote, $e.link_source
    }
    $ordinalEntry = [System.Comparison[object]] {
        param($a, $b) [string]::CompareOrdinal((script:EntrySortKey $a), (script:EntrySortKey $b))
    }

    $index = [ordered]@{}
    $nodeIds = [System.Collections.Generic.List[string]]::new()
    foreach ($id in $Live) { $nodeIds.Add($id) }
    $nodeIds.Sort([System.StringComparer]::Ordinal)

    $totalEntries = 0
    foreach ($id in $nodeIds) {
        $raw = $byNode[$id]
        # dedup
        $seen = @{}
        $keep = [System.Collections.Generic.List[object]]::new()
        foreach ($e in $raw) {
            $k = '{0}|{1}|{2}|{3}' -f $e.source_id, $e.quote, $e.link_source, (& $dpKey $e.doc_position)
            if (-not $seen.ContainsKey($k)) {
                $seen[$k] = $keep.Count; $keep.Add($e)
            } else {
                $ix = $seen[$k]; $cur = $keep[$ix]
                $newC = if ($null -eq $e.extraction_confidence) { -1 } else { [double]$e.extraction_confidence }
                $curC = if ($null -eq $cur.extraction_confidence) { -1 } else { [double]$cur.extraction_confidence }
                if ($newC -gt $curC) { $keep[$ix] = $e }   # survivor = max extraction_confidence (carries its evidence_level)
            }
        }
        $arr = $keep.ToArray()
        [System.Array]::Sort($arr, $ordinalEntry)
        $index[$id] = $arr
        $totalEntries += $arr.Count
        # byLinkSource is counted POST-dedup (t/3596#8 fix — CL reconcile): the per-class
        # split must match `entries`, so it counts the kept entries, not raw pre-dedup links.
        foreach ($e in $arr) { if ($e.link_source -eq 'key_point') { $nKp++ } else { $nFc++ } }
    }

    $result = [ordered]@{
        schemaVersion = $SchemaVersion
        builder       = 'Build-NodeSourceIndex'
        builderVersion = $BuilderVersion
        inputHash     = $inputHash
        marksHash     = $marksHash
        totals        = [ordered]@{
            nodes   = $nodeIds.Count
            entries = $totalEntries
            byLinkSource = [ordered]@{ key_point = $nKp; factual_claim = $nFc }
        }
        index = $index
    }

    Write-Host "Build-NodeSourceIndex: $($nodeIds.Count) live nodes, $totalEntries entries (key_point=$nKp, factual_claim=$nFc), inputHash=$($inputHash.Substring(0,12))…"

    # -Depth must exceed the deepest nesting (index → node → entry).
    $json = $result | ConvertTo-Json -Depth 8
    if ($PSCmdlet.ShouldProcess($OutputPath, "Write node→source index ($($nodeIds.Count) nodes, $totalEntries entries)")) {
        Write-Utf8NoBom -Path $OutputPath -Value $json
        Write-Host "Wrote $OutputPath"
    }
    # -PassThru returns the ON-DISK shape (parsed back), so a consumer sees the same
    # structure whether they read the file or -PassThru — the index's node ids are
    # object properties, not an in-memory OrderedDictionary's .NET members.
    if ($PassThru) { $json | ConvertFrom-Json }
}
