# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4337 cleanup, option A (mark only): write duplicate_of + duplicate_of_ref on the duplicates of
    the IDENTICAL duplicate groups, and backfill content_sha256 on every source metadata.json.
.DESCRIPTION
    A /data-mutation write to ai-triad-sources. Nothing is deleted and no reference is re-pointed.
      -Mode Freeze   Builds the frozen list (frozen-t4337-marks.json) from the corpus: groups by
                     docs/specs/source-identity.md (Get-SourceIdentityGroup), keeps only groups whose
                     members all share one content hash, picks each group's canonical by the SO C6
                     rule (has a summary, then most live taxonomy references, then ordinal id), and
                     records every target file's pre-write sha256.
      -Mode DryRun   (default) Reads ONLY the frozen list. Builds every new file in memory and proves:
                     each file's bytes are unchanged since the freeze; the change is a pure insertion
                     of exactly the frozen keys; parsed old == parsed new minus those keys (deep
                     equal, key order kept); reverting reproduces the original bytes; and the resolver
                     run on the post-write corpus reports 0 duplicate_of errors and the frozen canonicals.
      -Mode Apply    The same checks, then writes. Refuses if any check fails for any file.
      -Mode Revert   Removes exactly the frozen keys from each file, and checks the result's sha256
                     equals the frozen pre-write hash.
    The write is a textual insertion before the root object's closing brace, in the file's own line
    ending, so a file's other bytes never change.
#>
[CmdletBinding()]
param(
    [ValidateSet('Freeze', 'DryRun', 'Apply', 'Revert')][string]$Mode = 'DryRun',
    [string]$SourcesDir = 'C:\Users\jsnov\repos\ai-triad-sources',
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [string]$FrozenPath = (Join-Path $PSScriptRoot 'frozen-t4337-marks.json'),
    [string]$RefPrefix = 't4337-cleanup-2026-10',
    [switch]$CreateMissingMetadata
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'SourceIdentity.ps1')

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

# The insertion: ,<NL>  "k": "v" for each key, placed after the last property, before the trailing
# whitespace that precedes the root closing brace. Values are ASCII ids, hex and refs: no escaping.
function Add-JsonKeysText([string]$Text, [System.Collections.Specialized.OrderedDictionary]$Keys) {
    $nl = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $close = $Text.LastIndexOf('}')
    if ($close -lt 0) { throw "no root closing brace" }
    $head = $Text.Substring(0, $close)
    $ws = [regex]::Match($head, '\s*$').Value
    $at = $head.Length - $ws.Length
    if ($head.Substring(0, $at).TrimEnd().EndsWith('{')) { throw "empty root object; not supported" }
    $seg = -join ($Keys.GetEnumerator() | ForEach-Object {
        if ($_.Value -notmatch '^[\x20-\x7E]+$' -or $_.Value.Contains('"') -or $_.Value.Contains('\')) { throw "value for $($_.Key) is not plain ASCII" }
        ',' + $nl + '  "' + $_.Key + '": "' + $_.Value + '"' })
    [pscustomobject]@{ Text = $Text.Substring(0, $at) + $seg + $Text.Substring($at); Segment = $seg; At = $at }
}

function Test-InsertionOnly([string]$Old, [string]$New, [System.Collections.Specialized.OrderedDictionary]$Keys) {
    $o = [System.Text.Json.Nodes.JsonNode]::Parse($Old)
    $n = [System.Text.Json.Nodes.JsonNode]::Parse($New)
    $oNames = @($o.AsObject() | ForEach-Object Key)
    $nNames = @($n.AsObject() | ForEach-Object Key)
    $expectNames = $oNames + @($Keys.Keys)
    if (($nNames -join "`n") -cne ($expectNames -join "`n")) { return "key order/set differs" }
    foreach ($k in $Keys.Keys) { if ([string]$n[$k].GetValue[string]() -cne $Keys[$k]) { return "value of $k differs" } }
    foreach ($k in @($Keys.Keys)) { [void]$n.AsObject().Remove($k) }
    if (-not [System.Text.Json.Nodes.JsonNode]::DeepEquals($o, $n)) { return "existing content differs" }
    $null
}

if ($Mode -eq 'Freeze') {
    $dirs = @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })
    $docs = foreach ($d in $dirs) {
        $mp = Join-Path $d.FullName 'metadata.json'; $sp = Join-Path $d.FullName 'snapshot.md'
        $m = if (Test-Path -LiteralPath $mp) { [IO.File]::ReadAllText($mp) | ConvertFrom-Json } else { [pscustomobject]@{} }
        $h = if (Test-Path -LiteralPath $sp) { Get-SourceContentHash -Text ([IO.File]::ReadAllText($sp)) } else { $null }
        [pscustomobject]@{ Id = $d.Name; Metadata = $m; SnapshotSha256 = $h; MetaPath = $mp; HasMeta = (Test-Path -LiteralPath $mp) }
    }
    $byId = @{}; foreach ($d in $docs) { $byId[$d.Id] = $d }
    $g = Get-SourceIdentityGroup -Documents @($docs)
    if (@($g.DuplicateOfErrors).Count) { throw "the corpus already has duplicate_of errors; freeze refused" }

    # C6 canonical inputs: summaries/<id>.json and quoted ids in live taxonomy files.
    $ids = [System.Collections.Generic.HashSet[string]]::new([string[]]@($docs.Id), [System.StringComparer]::Ordinal)
    $refs = @{}; foreach ($id in $ids) { $refs[$id] = 0 }
    foreach ($f in @(Get-ChildItem (Join-Path $DataDir 'taxonomy') -Recurse -File -Include *.json | Where-Object { $_.FullName -notmatch '\\\.worktrees\\' })) {
        foreach ($mm in [regex]::Matches([IO.File]::ReadAllText($f.FullName), '"([a-z0-9][a-z0-9-]*[a-z0-9])"')) { $v = $mm.Groups[1].Value; if ($ids.Contains($v)) { $refs[$v]++ } }
    }
    $hasSum = @{}; foreach ($id in $ids) { $hasSum[$id] = Test-Path (Join-Path $DataDir "summaries\$id.json") }

    $groups = @($g.Canonical.GetEnumerator() | Group-Object Value | Where-Object Count -gt 1 | ForEach-Object {
        $members = [string[]]@($_.Group | ForEach-Object Key); [Array]::Sort($members, [StringComparer]::Ordinal); , $members })
    $identical = @($groups | Where-Object {
        $hs = @($_ | ForEach-Object { $byId[$_].SnapshotSha256 })
        @($hs | Where-Object { -not $_ }).Count -eq 0 -and @($hs | Sort-Object -Unique).Count -eq 1 })
    $identical = @($identical | Sort-Object { $_[0] })

    $marks = [System.Collections.Generic.List[object]]::new(); $missing = [System.Collections.Generic.List[object]]::new(); $n = 0
    foreach ($members in $identical) {
        $n++
        $canon = @($members | Sort-Object @{ Expression = { -[int]$hasSum[$_] } }, @{ Expression = { -$refs[$_] } }, @{ Expression = { $_ } })[0]
        if (-not $byId[$canon].HasMeta) { throw "group $n canonical '$canon' has no metadata.json" }
        foreach ($m in $members) {
            if ($m -ceq $canon) { continue }
            $entry = [ordered]@{ id = $m; duplicate_of = $canon; duplicate_of_ref = ('{0}#g{1:D3}' -f $RefPrefix, $n); group = $n }
            if ($byId[$m].HasMeta) { $marks.Add($entry) } else { $missing.Add($entry) }
        }
    }
    $files = [ordered]@{}
    foreach ($d in ($docs | Sort-Object Id)) {
        if (-not $d.HasMeta) { continue }
        $files[$d.Id] = [ordered]@{ pre_sha256 = (Get-Sha256Hex ([IO.File]::ReadAllBytes($d.MetaPath))); content_sha256 = $d.SnapshotSha256 }
    }
    $frozen = [ordered]@{
        ticket = 't/4337'; option = 'A (mark only)'; spec = 'docs/specs/source-identity.md v5'
        frozen_at = (Get-Date).ToUniversalTime().ToString('o')
        sources_commit = (git -C $SourcesDir rev-parse HEAD)
        canonical_rule = 'SO C6: has summaries/<id>.json, then most live taxonomy references, then ordinal id'
        counts = [ordered]@{ docs = $dirs.Count; metadata_files = $files.Count; identical_groups = $identical.Count; marks = $marks.Count
                             marks_needing_new_metadata = $missing.Count; content_sha256_backfill = @($files.Values | Where-Object { $_.content_sha256 }).Count }
        marks = $marks.ToArray(); marks_without_metadata = $missing.ToArray(); files = $files
    }
    [IO.File]::WriteAllText($FrozenPath, (($frozen | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
    "frozen: $FrozenPath"; $frozen.counts | Format-List | Out-String
    return
}

# ── DryRun / Apply / Revert: read ONLY the frozen list ──────────────────────────
$fz = [IO.File]::ReadAllText($FrozenPath) | ConvertFrom-Json -AsHashtable
$markById = @{}; foreach ($m in @($fz.marks)) { $markById[$m.id] = $m }
$plan = [System.Collections.Generic.List[object]]::new(); $fail = [System.Collections.Generic.List[string]]::new()
foreach ($id in @($fz.files.Keys)) {
    $f = $fz.files[$id]; $path = Join-Path (Join-Path $SourcesDir $id) 'metadata.json'
    $keys = [ordered]@{}
    if ($f.content_sha256) { $keys['content_sha256'] = [string]$f.content_sha256 }
    if ($markById.ContainsKey($id)) { $keys['duplicate_of'] = [string]$markById[$id].duplicate_of; $keys['duplicate_of_ref'] = [string]$markById[$id].duplicate_of_ref }
    if ($keys.Count -eq 0) { continue }
    $bytes = [IO.File]::ReadAllBytes($path); $cur = Get-Sha256Hex $bytes; $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($Mode -eq 'Revert') {
        $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $seg = -join ($keys.GetEnumerator() | ForEach-Object { ',' + $nl + '  "' + $_.Key + '": "' + $_.Value + '"' })
        $i = $text.LastIndexOf($seg)
        if ($i -lt 0) { $fail.Add("${id}: inserted keys not found; not reverted"); continue }
        $orig = $text.Remove($i, $seg.Length)
        if ((Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($orig))) -cne $f.pre_sha256) { $fail.Add("${id}: revert would not restore the frozen bytes"); continue }
        $plan.Add([pscustomobject]@{ Id = $id; Path = $path; New = $orig }); continue
    }
    if ($cur -cne $f.pre_sha256) { $fail.Add("${id}: metadata.json changed since the freeze"); continue }
    if ($text.Contains('"content_sha256"') -or $text.Contains('"duplicate_of')) { $fail.Add("${id}: already carries a target key"); continue }
    $r = Add-JsonKeysText -Text $text -Keys $keys
    if ($r.Text.Remove($r.At, $r.Segment.Length) -cne $text) { $fail.Add("${id}: not a pure insertion"); continue }
    $why = Test-InsertionOnly -Old $text -New $r.Text -Keys $keys
    if ($why) { $fail.Add("${id}: $why"); continue }
    if ((Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($r.Text.Remove($r.At, $r.Segment.Length)))) -cne $f.pre_sha256) { $fail.Add("${id}: revert check failed"); continue }
    $plan.Add([pscustomobject]@{ Id = $id; Path = $path; New = $r.Text; Keys = $keys })
}

if ($Mode -ne 'Revert') {
    # Simulate the resolver on the post-write corpus (playbook check B / TL no-chain condition).
    $docs = foreach ($id in @($fz.files.Keys)) {
        $p = @($plan | Where-Object Id -eq $id)
        $text = if ($p.Count) { $p[0].New } else { [IO.File]::ReadAllText((Join-Path (Join-Path $SourcesDir $id) 'metadata.json')) }
        [pscustomobject]@{ Id = $id; Metadata = ($text | ConvertFrom-Json); SnapshotSha256 = $fz.files[$id].content_sha256 }
    }
    $g = Get-SourceIdentityGroup -Documents @($docs)
    if (@($g.DuplicateOfErrors).Count) { $fail.Add("post-write resolver reports $(@($g.DuplicateOfErrors).Count) duplicate_of error(s)") }
    foreach ($m in @($fz.marks)) {
        if ($g.Resolved[$m.id] -cne $m.duplicate_of) { $fail.Add("$($m.id): resolves to '$($g.Resolved[$m.id])', not '$($m.duplicate_of)'") }
        if ($g.Canonical[$m.id] -cne $m.duplicate_of) { $fail.Add("$($m.id): group canonical '$($g.Canonical[$m.id])', not '$($m.duplicate_of)'") }
    }
    $targets = @($fz.marks | ForEach-Object { $_.duplicate_of } | Sort-Object -Unique)
    $chained = @($targets | Where-Object { $markById.ContainsKey($_) })
    if ($chained.Count) { $fail.Add("no-chain check: $($chained.Count) target(s) are themselves marked") }
}

"mode=$Mode files_planned=$($plan.Count) marks=$(@($fz.marks).Count) failures=$($fail.Count)"
$fail | Select-Object -First 20 | ForEach-Object { "  FAIL $_" }
if (@($fz.marks_without_metadata).Count) {
    "  marks_without_metadata: $(@($fz.marks_without_metadata).Count) (" + $(if ($CreateMissingMetadata) { 'not yet supported here; decision pending' } else { 'skipped: PI/TL decision pending, t/4337#20' }) + ")"
}
if ($Mode -in 'Apply', 'Revert') {
    if ($fail.Count) { throw "$Mode refused: $($fail.Count) check(s) failed; nothing written" }
    foreach ($p in $plan) { [IO.File]::WriteAllBytes($p.Path, [Text.Encoding]::UTF8.GetBytes($p.New)) }
    "wrote $($plan.Count) file(s)"
}
