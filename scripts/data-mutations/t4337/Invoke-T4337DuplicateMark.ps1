# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4337 cleanup, option A (mark only): write duplicate_of + duplicate_of_ref on the duplicates of
    the IDENTICAL duplicate groups, and backfill content_sha256 on every source metadata.json.
.DESCRIPTION
    A /data-mutation write to ai-triad-sources. Nothing is deleted and no reference is re-pointed.
    Two separate writes (SO C7, e/344#2), each with its own frozen list and verification:
      -Part Backfill  content_sha256 on every metadata.json that has a hash (frozen-t4337-backfill.json).
                      T2, TL-approved after the SO look and a second-agent recount. Goes first.
      -Part Marks     duplicate_of + duplicate_of_ref (frozen-t4337-marks.json). PI-approved. Its
                      pre-write hashes must be re-frozen AFTER the backfill commit; until then the
                      marks list is "provisional" and Apply refuses it.
      -Mode Freeze   Builds both frozen lists from the corpus: groups by
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
    [ValidateSet('Backfill', 'Marks')][string]$Part = 'Backfill',
    [string]$SourcesDir = 'C:\Users\jsnov\repos\ai-triad-sources',
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [string]$FrozenPath,
    [string]$RefPrefix = 't4337-cleanup-2026-10',
    [switch]$CreateMissingMetadata
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'SourceIdentity.ps1')
$BackfillPath = Join-Path $PSScriptRoot 'frozen-t4337-backfill.json'
$MarksPath    = Join-Path $PSScriptRoot 'frozen-t4337-marks.json'
if (-not $FrozenPath) { $FrozenPath = if ($Part -eq 'Backfill') { $BackfillPath } else { $MarksPath } }

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
    # Every multi-doc identity group is considered, not only all-identical ones (t/4337#29: 16
    # byte-identical sets sat inside mixed groups and were dropped). Spec 4.6 allows one canonical per
    # identity group, so only members byte-identical to the group's C6 canonical are marked; any other
    # identical subset of the same group would be a 'conflict' mark and waits for the review pass.
    $groups = @($groups | Sort-Object { $_[0] })
    $identical = $groups   # name kept for the counts below: groups that contribute at least one mark
    $partial = [System.Collections.Generic.List[object]]::new()

    $marks = [System.Collections.Generic.List[object]]::new(); $missing = [System.Collections.Generic.List[object]]::new(); $n = 0
    $contributing = 0
    $c6 = { param([string[]]$Ids) @($Ids | Sort-Object @{ Expression = { -[int]$hasSum[$_] } }, @{ Expression = { -$refs[$_] } }, @{ Expression = { $_ } }) }
    foreach ($members in $groups) {
        $ranked = & $c6 $members
        $canon = $ranked[0]
        # The marked subset: the C6 canonical's byte-identical twins when it has any; otherwise the
        # group's largest byte-identical subset (ties: the subset holding the best C6-ranked member),
        # targeting that subset's own C6-best member. Only one subset per group can be marked (4.6).
        $subsets = @($members | Where-Object { $byId[$_].SnapshotSha256 } | Group-Object { $byId[$_].SnapshotSha256 } | Where-Object Count -gt 1)
        $ch = $byId[$canon].SnapshotSha256
        if (-not ($ch -and @($subsets | Where-Object Name -ceq $ch).Count) -and $subsets.Count) {
            $best = @($subsets | Sort-Object @{ Expression = { -$_.Count } }, @{ Expression = { $g0 = $_; [array]::IndexOf($ranked, (@(& $c6 ([string[]]@($g0.Group)))[0])) } })[0]
            $canon = @(& $c6 ([string[]]@($best.Group)))[0]; $ch = $best.Name
        }
        $twins = @($members | Where-Object { $_ -cne $canon -and $ch -and $byId[$_].SnapshotSha256 -ceq $ch })
        $others = @($members | Where-Object { $_ -cne $canon -and $twins -notcontains $_ })
        if ($others.Count) { $partial.Add([ordered]@{ canonical = $canon; marked = [string[]]$twins; left_for_review = [string[]]$others }) }
        if ($twins.Count -eq 0) { continue }
        $n++; $contributing++
        if (-not $byId[$canon].HasMeta) { throw "group $n canonical '$canon' has no metadata.json" }
        foreach ($m in $twins) {
            $entry = [ordered]@{ id = $m; duplicate_of = $canon; duplicate_of_ref = ('{0}#g{1:D3}' -f $RefPrefix, $n); group = $n }
            if ($byId[$m].HasMeta) { $marks.Add($entry) }
            else { $entry['content_sha256'] = $byId[$m].SnapshotSha256; $missing.Add($entry) }
        }
    }
    $markIds = [System.Collections.Generic.HashSet[string]]::new([string[]]@($marks | ForEach-Object { $_.id }), [StringComparer]::Ordinal)
    $bfFiles = [ordered]@{}; $mkFiles = [ordered]@{}; $groupInput = [ordered]@{}; $unbackfilled = 0
    foreach ($d in ($docs | Sort-Object Id)) {
        if (-not $d.HasMeta) { continue }
        $bytes = [IO.File]::ReadAllBytes($d.MetaPath); $pre = Get-Sha256Hex $bytes
        $groupInput[$d.Id] = $d.SnapshotSha256
        $hasField = [Text.Encoding]::UTF8.GetString($bytes).Contains('"content_sha256"')
        if ($d.SnapshotSha256 -and -not $hasField) { $bfFiles[$d.Id] = [ordered]@{ pre_sha256 = $pre; content_sha256 = $d.SnapshotSha256 } }
        if ($markIds.Contains($d.Id)) { $mkFiles[$d.Id] = [ordered]@{ pre_sha256 = $pre }; if ($d.SnapshotSha256 -and -not $hasField) { $unbackfilled++ } }
    }
    $common = [ordered]@{
        ticket = 't/4337'; option = 'A (mark only)'; spec = 'docs/specs/source-identity.md v5'
        frozen_at = (Get-Date).ToUniversalTime().ToString('o'); sources_commit = (git -C $SourcesDir rev-parse HEAD)
    }
    $bf = [ordered]@{} + $common
    $bf['part'] = 'Backfill'
    $bf['counts'] = [ordered]@{ docs = $dirs.Count; metadata_files = $groupInput.Count; content_sha256_backfill = $bfFiles.Count }
    $bf['files'] = $bfFiles
    $mk = [ordered]@{} + $common
    $mk['part'] = 'Marks'
    # Provisional while any marked file still lacks its backfilled hash: re-freeze after the backfill commit.
    $mk['provisional'] = ($unbackfilled -gt 0)
    $mk['canonical_rule'] = 'SO C6: has summaries/<id>.json, then most live taxonomy references, then ordinal id'
    $mk['counts'] = [ordered]@{ identity_groups = $groups.Count; groups_with_marks = $contributing; partial_groups = $partial.Count
                                marks = $marks.Count; marks_without_metadata = $missing.Count
                                left_for_review = (@($partial | ForEach-Object { $_.left_for_review.Count }) | Measure-Object -Sum).Sum }
    $mk['partial_groups'] = $partial.ToArray()
    $mk['marks'] = $marks.ToArray(); $mk['marks_without_metadata'] = $missing.ToArray()
    $mk['files'] = $mkFiles; $mk['group_input'] = $groupInput
    foreach ($pair in @(@($BackfillPath, $bf), @($MarksPath, $mk))) {
        [IO.File]::WriteAllText($pair[0], (($pair[1] | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
        "frozen: $($pair[0])"
    }
    "backfill: $($bfFiles.Count) file(s); marks: $($marks.Count) (+$($missing.Count) without metadata), provisional=$($mk['provisional'])"
    return
}

# ── DryRun / Apply / Revert: read ONLY the frozen list ──────────────────────────
$fz = [IO.File]::ReadAllText($FrozenPath) | ConvertFrom-Json -AsHashtable
if ($fz.part -cne $Part) { throw "frozen list $FrozenPath is part '$($fz.part)', not '$Part'" }
$markById = @{}; foreach ($m in @($fz['marks'])) { if ($null -ne $m) { $markById[$m.id] = $m } }
$plan = [System.Collections.Generic.List[object]]::new(); $fail = [System.Collections.Generic.List[string]]::new()
if ($Part -eq 'Marks' -and $fz.provisional -and $Mode -eq 'Apply') { $fail.Add('the marks list is provisional: re-run -Mode Freeze after the backfill commit') }
$targetKey = if ($Part -eq 'Backfill') { '"content_sha256"' } else { '"duplicate_of' }
foreach ($id in @($fz.files.Keys)) {
    $f = $fz.files[$id]; $path = Join-Path (Join-Path $SourcesDir $id) 'metadata.json'
    $keys = [ordered]@{}
    if ($Part -eq 'Backfill') {
        $keys['content_sha256'] = [string]$f.content_sha256
        # Re-derive at apply time too: the frozen hash must still be the spec hash of snapshot.md.
        if ($Mode -ne 'Revert') {
            $now = Get-SourceContentHash -Text ([IO.File]::ReadAllText((Join-Path (Join-Path $SourcesDir $id) 'snapshot.md')))
            if ($now -cne $keys['content_sha256']) { $fail.Add("${id}: snapshot.md no longer hashes to the frozen content_sha256"); continue }
        }
    } else {
        $keys['duplicate_of'] = [string]$markById[$id].duplicate_of; $keys['duplicate_of_ref'] = [string]$markById[$id].duplicate_of_ref
    }
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
    if ($text.Contains($targetKey)) { $fail.Add("${id}: already carries a target key"); continue }
    $r = Add-JsonKeysText -Text $text -Keys $keys
    if ($r.Text.Remove($r.At, $r.Segment.Length) -cne $text) { $fail.Add("${id}: not a pure insertion"); continue }
    $why = Test-InsertionOnly -Old $text -New $r.Text -Keys $keys
    if ($why) { $fail.Add("${id}: $why"); continue }
    if ((Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($r.Text.Remove($r.At, $r.Segment.Length)))) -cne $f.pre_sha256) { $fail.Add("${id}: revert check failed"); continue }
    $plan.Add([pscustomobject]@{ Id = $id; Path = $path; New = $r.Text; Keys = $keys })
}

# Option (a), t/4337#26 decision 2: a minimal metadata.json for a duplicate that has none. Only with
# -CreateMissingMetadata. Created as id + content_sha256 + the mark (2-space JSON, LF, final newline);
# Revert deletes a file only when its bytes are still exactly what was created.
function New-MinimalMetadataText($m) {
    $lines = @('  "id": "' + $m.id + '"')
    if ($m.content_sha256) { $lines += '  "content_sha256": "' + $m.content_sha256 + '"' }
    $lines += '  "duplicate_of": "' + $m.duplicate_of + '"'
    $lines += '  "duplicate_of_ref": "' + $m.duplicate_of_ref + '"'
    "{`n" + ($lines -join ",`n") + "`n}`n"
}
$created = @{}
if ($CreateMissingMetadata -and $Part -eq 'Marks') {
    foreach ($m in @($fz.marks_without_metadata)) {
        $dir = Join-Path $SourcesDir $m.id; $path = Join-Path $dir 'metadata.json'; $text = New-MinimalMetadataText $m
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { $fail.Add("$($m.id): source directory is missing"); continue }
        if ($Mode -eq 'Revert') {
            if (-not (Test-Path -LiteralPath $path)) { continue }
            if ([IO.File]::ReadAllText($path) -cne $text) { $fail.Add("$($m.id): created metadata.json was edited since; not deleted"); continue }
            $plan.Add([pscustomobject]@{ Id = $m.id; Path = $path; New = $null; Delete = $true }); continue
        }
        if (Test-Path -LiteralPath $path) { $fail.Add("$($m.id): metadata.json now exists; not overwritten"); continue }
        $plan.Add([pscustomobject]@{ Id = $m.id; Path = $path; New = $text; Create = $true }); $created[$m.id] = $text
    }
}

if ($Mode -ne 'Revert' -and $Part -eq 'Backfill') {
    # Recorded hashes can veto a -N suffix edge (spec 4.4 rule 3); computed ones can't. Measure how
    # the backfill changes grouping: every doc with metadata, before (computed) vs after (recorded).
    $planById = @{}; foreach ($p in $plan) { $planById[$p.Id] = $p }
    $before = [System.Collections.Generic.List[object]]::new(); $after = [System.Collections.Generic.List[object]]::new()
    foreach ($d in @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })) {
        $mp = Join-Path $d.FullName 'metadata.json'; if (-not (Test-Path -LiteralPath $mp)) { continue }
        $old = [IO.File]::ReadAllText($mp)
        $h = if ($fz.files.ContainsKey($d.Name)) { $fz.files[$d.Name].content_sha256 } else { $null }
        $before.Add([pscustomobject]@{ Id = $d.Name; Metadata = ($old | ConvertFrom-Json); SnapshotSha256 = $h })
        $new = if ($planById.ContainsKey($d.Name)) { $planById[$d.Name].New } else { $old }
        $after.Add([pscustomobject]@{ Id = $d.Name; Metadata = ($new | ConvertFrom-Json); SnapshotSha256 = $null })
    }
    $gb = Get-SourceIdentityGroup -Documents $before.ToArray(); $ga = Get-SourceIdentityGroup -Documents $after.ToArray()
    $partition = { param($g) $m = @{}; foreach ($k in $g.Canonical.Keys) { $c = $g.Canonical[$k]; if (-not $m.ContainsKey($c)) { $m[$c] = [System.Collections.Generic.List[string]]::new() }; $m[$c].Add($k) }
              @($m.Values | Where-Object { $_.Count -gt 1 } | ForEach-Object { $a = [string[]]$_.ToArray(); [Array]::Sort($a, [StringComparer]::Ordinal); $a -join ',' }) }
    $pb = @(& $partition $gb); $pa = @(& $partition $ga)
    $gone = @($pb | Where-Object { $pa -notcontains $_ }); $new = @($pa | Where-Object { $pb -notcontains $_ })
    "grouping before/after backfill: $($pb.Count) -> $($pa.Count) multi-doc groups; changed: $($gone.Count) group(s) split or re-formed into $($new.Count)"
    $gone | Select-Object -First 15 | ForEach-Object { "  BEFORE $_" }
    $new  | Select-Object -First 15 | ForEach-Object { "  AFTER  $_" }
    if (@($ga.DuplicateOfErrors).Count) { $fail.Add("post-backfill resolver reports duplicate_of errors") }
}

if ($Mode -ne 'Revert' -and $Part -eq 'Marks') {
    # Simulate the resolver on the post-write corpus (playbook check B / TL no-chain condition).
    $docs = @(foreach ($id in @($fz.group_input.Keys)) {
        $p = @($plan | Where-Object Id -eq $id)
        $text = if ($p.Count) { $p[0].New } else { [IO.File]::ReadAllText((Join-Path (Join-Path $SourcesDir $id) 'metadata.json')) }
        [pscustomobject]@{ Id = $id; Metadata = ($text | ConvertFrom-Json); SnapshotSha256 = $fz.group_input[$id] }
    })
    foreach ($m in @($fz.marks_without_metadata)) {
        $meta = if ($created.ContainsKey($m.id)) { $created[$m.id] | ConvertFrom-Json } else { [pscustomobject]@{} }
        $docs += [pscustomobject]@{ Id = $m.id; Metadata = $meta; SnapshotSha256 = $m.content_sha256 }
    }
    $allMarks = @($fz.marks) + @($fz.marks_without_metadata | Where-Object { $created.ContainsKey($_.id) })
    foreach ($m in $allMarks) { $markById[$m.id] = $m }
    $g = Get-SourceIdentityGroup -Documents @($docs)
    if (@($g.DuplicateOfErrors).Count) { $fail.Add("post-write resolver reports $(@($g.DuplicateOfErrors).Count) duplicate_of error(s)") }
    foreach ($m in $allMarks) {
        if ($g.Resolved[$m.id] -cne $m.duplicate_of) { $fail.Add("$($m.id): resolves to '$($g.Resolved[$m.id])', not '$($m.duplicate_of)'") }
        if ($g.Canonical[$m.id] -cne $m.duplicate_of) { $fail.Add("$($m.id): group canonical '$($g.Canonical[$m.id])', not '$($m.duplicate_of)'") }
    }
    $targets = @($allMarks | ForEach-Object { $_.duplicate_of } | Sort-Object -Unique)
    $chained = @($targets | Where-Object { $markById.ContainsKey($_) })
    if ($chained.Count) { $fail.Add("no-chain check: $($chained.Count) target(s) are themselves marked") }
}

"part=$Part mode=$Mode files_planned=$($plan.Count) failures=$($fail.Count)" + $(if ($Part -eq 'Marks') { " marks=$(@($fz.marks).Count) provisional=$($fz.provisional)" } else { '' })
$fail | Select-Object -First 20 | ForEach-Object { "  FAIL $_" }
if ($Part -eq 'Marks' -and @($fz.marks_without_metadata).Count) {
    "  marks_without_metadata: $(@($fz.marks_without_metadata).Count) (" + $(if ($CreateMissingMetadata) { "minimal metadata.json planned: $($created.Count)" } else { 'skipped: pass -CreateMissingMetadata for option (a), t/4337#26' }) + ")"
}
if ($Mode -in 'Apply', 'Revert') {
    if ($fail.Count) { throw "$Mode refused: $($fail.Count) check(s) failed; nothing written" }
    foreach ($p in $plan) {
        if ($p.PSObject.Properties['Delete'] -and $p.Delete) { Remove-Item -LiteralPath $p.Path; continue }
        [IO.File]::WriteAllBytes($p.Path, [Text.Encoding]::UTF8.GetBytes($p.New))
    }
    "wrote $($plan.Count) file(s)"
}
