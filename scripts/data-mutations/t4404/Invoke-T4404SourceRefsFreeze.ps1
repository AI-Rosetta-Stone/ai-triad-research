# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4404 T2: freeze the per-entity source attribution for the existing entities in entities.json.
.DESCRIPTION
    A /data-mutation write, step 1 (the frozen list). Reads, at the data repo's origin/main (which must equal
    the clean working tree for every input file) and the sources repo's origin/main (clean):
      - entities.json: each entity's name, aliases and CURRENT source_refs (the candidate list);
      - entity_extraction_log.json: the stored supporting quote and the node each entity was proposed from;
      - source_evidence_index.json: that node's facts (doc_id, claim), the node resolved through supersession;
      - each candidate doc's snapshot (Read-SnapshotForModel) and summary.
    Runs Get-EntitySourceAttribution (the merged t/4404 rules, #3743) per entity and writes
    frozen-t4404-source-refs.json: per entity the old and new source_refs, the basis per doc and the status.
    Nothing is written to the data repo here; Invoke-T4404SourceRefsWrite.mjs reads only the frozen list.

    Scope: entities with status 'approved'. Deprecated entities (and merged_into tombstones) are listed under
    skipped, unchanged. Pairs only ever come from the current list; nothing is added from outside it.
#>
[CmdletBinding()]
param(
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [string]$SourcesDir = 'C:\Users\jsnov\repos\ai-triad-sources',
    [string]$FrozenPath = (Join-Path $PSScriptRoot 'frozen-t4404-source-refs.json')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
Import-Module (Join-Path $repo 'scripts' 'AITriad' 'AITriad.psd1') -Force
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
$env:AI_TRIAD_DATA_ROOT = $DataDir

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

function Assert-CleanAtOriginMain([string]$Repo, [string[]]$Paths) {
    $head = (git -C $Repo rev-parse HEAD).Trim()
    $main = (git -C $Repo rev-parse origin/main).Trim()
    if ($head -cne $main) {
        throw (New-ActionableError -PassThru -Goal 'Freeze the t/4404 source attribution' -Problem "$Repo HEAD $head is not origin/main $main" `
            -Location 'Invoke-T4404SourceRefsFreeze' -NextSteps @("Fetch and fast-forward $Repo to origin/main (the freeze reads origin/main only)"))
    }
    $dirty = @(git -C $Repo status --porcelain -- @Paths)
    if ($dirty.Count) {
        throw (New-ActionableError -PassThru -Goal 'Freeze the t/4404 source attribution' -Problem "$Repo has uncommitted changes under the freeze inputs:`n$($dirty -join "`n")" `
            -Location 'Invoke-T4404SourceRefsFreeze' -NextSteps @('Commit or set aside that WIP as its own commit, then freeze again'))
    }
    $head
}

$tax = 'taxonomy/Origin'
$dataSha = Assert-CleanAtOriginMain $DataDir @("$tax", 'summaries')
$srcSha = Assert-CleanAtOriginMain $SourcesDir @('.')

$entPath = Join-Path $DataDir $tax 'entities.json'
# Hashed LF-normalized: the working tree may hold CRLF while the blob is LF (eol=lf); the writer compares the same way.
$entText = [IO.File]::ReadAllText($entPath) -replace "`r`n", "`n"
$entBytes = [Text.Encoding]::UTF8.GetBytes($entText)
$store = $entText | ConvertFrom-Json
$log = Get-Content -Raw -LiteralPath (Join-Path $DataDir $tax 'entity_extraction_log.json') | ConvertFrom-Json
$sei = Get-Content -Raw -LiteralPath (Join-Path $DataDir $tax 'source_evidence_index.json') | ConvertFrom-Json

# entity id -> @{ node; quotes }, from the extraction log (one proposing node per entity on this corpus).
$fromLog = @{}
foreach ($n in @($log.nodes)) {
    if (-not $n.PSObject.Properties['evidence']) { continue }
    foreach ($ev in @($n.evidence)) {
        if (-not $ev -or -not $ev.id) { continue }
        if (-not $fromLog.ContainsKey($ev.id)) { $fromLog[$ev.id] = @{ nodes = [Collections.Generic.List[string]]::new(); quotes = [Collections.Generic.List[string]]::new() } }
        $fromLog[$ev.id].nodes.Add([string]$n.node_id)
        if ($ev.PSObject.Properties['quote'] -and $ev.quote) { $fromLog[$ev.id].quotes.Add([string]$ev.quote) }
    }
}

$result = & (Get-Module AITriad) {
    param($Store, $FromLog, $Sei, $TaxDir)
    Set-StrictMode -Version Latest
    $ids = Get-LiveBeliefNodeIds -TaxonomyDir $TaxDir -Caller 't4404-freeze'
    $readers = New-EntityAttributionReaders
    $entries = [Collections.Generic.List[object]]::new()
    $skipped = [Collections.Generic.List[object]]::new()
    $i = 0
    foreach ($e in @($Store.entities)) {
        $i++
        if ($i % 50 -eq 0) { Write-Host "  $i entities" }
        $merged = $e.PSObject.Properties['merged_into'] -and $e.merged_into
        if ($e.status -cne 'approved' -or $merged) {
            $skipped.Add([ordered]@{ id = $e.id; status = $e.status; merged_into = $(if ($merged) { $e.merged_into } else { $null }) })
            continue
        }
        $oldRefs = [string[]]@($e.source_refs)
        $names = [string[]]@(@($e.name) + @($e.aliases) | Where-Object { $_ })
        $quotes = [string[]]@()
        $facts = [Collections.Generic.List[object]]::new()
        $nodes = [string[]]@()
        if ($FromLog.ContainsKey($e.id)) {
            $quotes = [string[]]@($FromLog[$e.id].quotes)
            $nodes = [string[]]@($FromLog[$e.id].nodes | Select-Object -Unique)
            foreach ($nid in $nodes) {
                $rid = if ($ids.ResolveMap.ContainsKey($nid)) { $ids.ResolveMap[$nid] } else { $nid }
                $entry = $Sei.PSObject.Properties[$rid]
                if (-not $entry -or -not $entry.Value.PSObject.Properties['facts']) { continue }
                foreach ($f in @($entry.Value.facts)) {
                    if ($f -and $f.PSObject.Properties['doc_id'] -and $f.doc_id) { $facts.Add(@{ doc_id = [string]$f.doc_id; claim = [string]$f.claim }) }
                }
            }
        }
        $attr = Get-EntitySourceAttribution -Names $names -Quotes $quotes -Facts $facts.ToArray() -CandidateDocs $oldRefs `
            -GetSnapshotText $readers.Snapshot -GetSummaryText $readers.Summary
        $entries.Add([ordered]@{
            id                 = $e.id
            name               = $e.name
            proposing_nodes    = $nodes
            had_quote          = [bool]$quotes.Count
            old_source_refs    = $oldRefs
            source_refs        = [string[]]@($attr.source_refs)
            source_refs_basis  = $attr.source_refs_basis
            source_refs_status = $attr.source_refs_status
        })
    }
    [pscustomobject]@{ entries = $entries; skipped = $skipped }
} $store $fromLog $sei (Join-Path $DataDir $tax)

$entries = @($result.entries)
$basisCount = [ordered]@{}
foreach ($en in $entries) { foreach ($b in $en.source_refs_basis.Values) { $basisCount[$b] = 1 + [int]$basisCount[$b] } }
$statusCount = [ordered]@{}
foreach ($en in $entries) { $statusCount[$en.source_refs_status] = 1 + [int]$statusCount[$en.source_refs_status] }
$oldPairs = [int]($entries | ForEach-Object { @($_.old_source_refs).Count } | Measure-Object -Sum).Sum
$newPairs = [int]($entries | ForEach-Object { @($_.source_refs).Count } | Measure-Object -Sum).Sum
$distinctOld = @($entries | ForEach-Object { (@($_.old_source_refs) | Sort-Object -CaseSensitive) -join '|' } | Select-Object -Unique).Count
$distinctNew = @($entries | ForEach-Object { (@($_.source_refs) | Sort-Object -CaseSensitive) -join '|' } | Select-Object -Unique).Count

$frozen = [ordered]@{
    _doc     = 't/4404 T2 frozen list: per-entity source attribution for entities.json (Invoke-T4404SourceRefsFreeze.ps1). The write reads only this file.'
    inputs   = [ordered]@{
        data_commit          = $dataSha
        sources_commit       = $srcSha
        code_commit          = (git -C $repo rev-parse HEAD).Trim()
        entities_pre_sha256  = Get-Sha256Hex $entBytes
        entity_count         = @($store.entities).Count
    }
    summary  = [ordered]@{
        rewritten        = $entries.Count
        skipped          = @($result.skipped).Count
        status           = $statusCount
        pairs_basis      = $basisCount
        pairs_old        = $oldPairs
        pairs_new        = $newPairs
        distinct_lists_old = $distinctOld
        distinct_lists_new = $distinctNew
        unchanged_lists  = @($entries | Where-Object { ((@($_.old_source_refs) | Sort-Object -CaseSensitive) -join '|') -ceq ((@($_.source_refs) | Sort-Object -CaseSensitive) -join '|') }).Count
    }
    skipped  = @($result.skipped)
    entities = $entries
}
$json = $frozen | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($FrozenPath, ($json -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))  # sink-guard-allow: writes the frozen list into scripts/data-mutations/t4404/ in this repo, not a data-of-record file; the data write is Invoke-T4404SourceRefsWrite.mjs (t/4452)
$norm = [IO.File]::ReadAllText($FrozenPath) -replace "`r`n", "`n"
"frozen list: $FrozenPath sha256=$(Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($norm)))"
$frozen.summary | ConvertTo-Json -Depth 4
