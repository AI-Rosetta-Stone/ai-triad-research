# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4337 cleanup, option A (mark only): write duplicate_of + duplicate_of_ref on the byte-identical
    twins of each duplicate group's canonical doc, in ai-triad-sources.
.DESCRIPTION
    A /data-mutation write. Nothing is deleted and no reference is re-pointed. There is no
    content_sha256 backfill: TL ruling t/4337#32 (option (i)), because recorded hashes would switch on
    spec 4.4's suffix veto for legacy docs.
      -Mode Freeze   Builds frozen-t4337-marks.json from the corpus. Groups by
                     docs/specs/source-identity.md (Get-SourceIdentityGroup); the mark plan comes from
                     Get-T4337MarkPlan (T4337MarkPlan.ps1: canonical by SO C6 over the whole group, mark
                     only its byte-identical twins, everything else to review). Records every target
                     file's pre-write sha256.
      -Mode DryRun   (default) Reads ONLY the frozen list and proves, for every file: bytes unchanged
                     since the freeze; a pure insertion of exactly the frozen keys; parsed old == parsed
                     new minus those keys (deep equal, key order kept); revert reproduces the original
                     bytes. Then runs the resolver on the post-write corpus and requires 0
                     duplicate_of errors, no chains, and the SO C8 invariant for every marked doc:
                     resolve(doc) == group canonical (canonicalDocId) == the frozen C6 canonical.
      -Mode Apply    The same checks, then writes. Refuses if any check fails for any file.
      -Mode Revert   Removes exactly the frozen keys from each file, checking the frozen pre-write hash.
    -CreateMissingMetadata adds a minimal metadata.json for a marked twin that has none. Off, and NOT
    to be used for this write: SO C10 (e/344#10) found no reader sees those 20 partial ingests, so they
    are left alone for a quarantine/completion pass. Revert deletes such a file only if it is unchanged.
    Marks listed in deferred-t4337-c9.json are left unmarked until their references are settled (SO C9).
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
. (Join-Path $PSScriptRoot 'T4337MarkPlan.ps1')

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

# The insertion: ,<NL>  "k": "v" for each key, after the last property, before the whitespace that
# precedes the root closing brace, in the file's own line ending. Values are ASCII ids and refs.
function Add-JsonKeysText([string]$Text, [System.Collections.Specialized.OrderedDictionary]$Keys) {
    $nl = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $close = $Text.LastIndexOf('}')
    if ($close -lt 0) { throw "no root closing brace" }
    $head = $Text.Substring(0, $close)
    $at = $head.Length - [regex]::Match($head, '\s*$').Value.Length
    if ($head.Substring(0, $at).TrimEnd().EndsWith('{')) { throw "empty root object; not supported" }
    $seg = -join ($Keys.GetEnumerator() | ForEach-Object {
        if ($_.Value -notmatch '^[\x20-\x7E]+$' -or $_.Value.Contains('"') -or $_.Value.Contains('\')) { throw "value for $($_.Key) is not plain ASCII" }
        ',' + $nl + '  "' + $_.Key + '": "' + $_.Value + '"' })
    [pscustomobject]@{ Text = $Text.Substring(0, $at) + $seg + $Text.Substring($at); Segment = $seg; At = $at }
}

function Test-InsertionOnly([string]$Old, [string]$New, [System.Collections.Specialized.OrderedDictionary]$Keys) {
    $o = [System.Text.Json.Nodes.JsonNode]::Parse($Old)
    $n = [System.Text.Json.Nodes.JsonNode]::Parse($New)
    $expect = @($o.AsObject() | ForEach-Object Key) + @($Keys.Keys)
    if ((@($n.AsObject() | ForEach-Object Key) -join "`n") -cne ($expect -join "`n")) { return "key order/set differs" }
    foreach ($k in $Keys.Keys) { if ([string]$n[$k].GetValue[string]() -cne $Keys[$k]) { return "value of $k differs" } }
    foreach ($k in @($Keys.Keys)) { [void]$n.AsObject().Remove($k) }
    if (-not [System.Text.Json.Nodes.JsonNode]::DeepEquals($o, $n)) { return "existing content differs" }
    $null
}

function New-MinimalMetadataText($m) {
    # Parenthesised elements: in an array literal ',' binds tighter than '+'.
    $lines = @(('  "id": "' + $m.id + '"'), ('  "duplicate_of": "' + $m.duplicate_of + '"'), ('  "duplicate_of_ref": "' + $m.duplicate_of_ref + '"'))
    "{`n" + ($lines -join ",`n") + "`n}`n"
}

if ($Mode -eq 'Freeze') {
    $dirs = @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })
    $docs = foreach ($d in $dirs) {
        $mp = Join-Path $d.FullName 'metadata.json'; $sp = Join-Path $d.FullName 'snapshot.md'
        $m = if (Test-Path -LiteralPath $mp) { [IO.File]::ReadAllText($mp) | ConvertFrom-Json } else { [pscustomobject]@{} }
        $h = if (Test-Path -LiteralPath $sp) { Get-SourceContentHash -Text ([IO.File]::ReadAllText($sp)) } else { $null }
        [pscustomobject]@{ Id = $d.Name; Metadata = $m; SnapshotSha256 = $h; MetaPath = $mp; HasMeta = (Test-Path -LiteralPath $mp) }
    }
    $g = Get-SourceIdentityGroup -Documents @($docs)
    if (@($g.DuplicateOfErrors).Count) { throw "the corpus already has duplicate_of errors; freeze refused" }

    $ids = [System.Collections.Generic.HashSet[string]]::new([string[]]@($docs.Id), [StringComparer]::Ordinal)
    $refs = @{}; foreach ($id in $ids) { $refs[$id] = 0 }
    foreach ($f in @(Get-ChildItem (Join-Path $DataDir 'taxonomy') -Recurse -File -Include *.json | Where-Object { $_.FullName -notmatch '\\\.worktrees\\' })) {
        foreach ($mm in [regex]::Matches([IO.File]::ReadAllText($f.FullName), '"([a-z0-9][a-z0-9-]*[a-z0-9])"')) { $v = $mm.Groups[1].Value; if ($ids.Contains($v)) { $refs[$v]++ } }
    }
    $hasSum = @{}; $hash = @{}; $hasMeta = @{}
    foreach ($d in $docs) { $hasSum[$d.Id] = Test-Path (Join-Path $DataDir "summaries\$($d.Id).json"); $hash[$d.Id] = $d.SnapshotSha256; $hasMeta[$d.Id] = $d.HasMeta }
    $groups = @($g.Canonical.GetEnumerator() | Group-Object Value | Where-Object Count -gt 1 | ForEach-Object { , [string[]]@($_.Group | ForEach-Object Key) })
    # SO C9 deferrals (deferred-t4337-c9.json): twins left unmarked until their references are settled.
    $deferFile = Join-Path $PSScriptRoot 'deferred-t4337-c9.json'
    $defer = if (Test-Path -LiteralPath $deferFile) { [string[]]@((Get-Content -LiteralPath $deferFile -Raw | ConvertFrom-Json).deferred | ForEach-Object id) } else { [string[]]@() }
    $plan = Get-T4337MarkPlan -Groups $groups -Hash $hash -HasSummary $hasSum -LiveRefs $refs -HasMetadata $hasMeta -RefPrefix $RefPrefix -Defer $defer
    $unplaced = @($defer | Where-Object { $d = $_; -not @($plan.Review | Where-Object { $_.reason -like 'c9-*' -and $_.members -contains $d }).Count })
    if ($unplaced.Count) { throw "deferred id(s) not found among marked twins: $($unplaced -join ', ')" }

    $files = [ordered]@{}; $groupInput = [ordered]@{}
    foreach ($d in ($docs | Sort-Object Id)) { if ($d.HasMeta) { $groupInput[$d.Id] = $d.SnapshotSha256 } }
    foreach ($m in @($plan.Marks | Where-Object has_metadata | Sort-Object id)) {
        $files[$m.id] = [ordered]@{ pre_sha256 = (Get-Sha256Hex ([IO.File]::ReadAllBytes((Join-Path (Join-Path $SourcesDir $m.id) 'metadata.json')))) }
    }
    $strip = { param($m) [ordered]@{ id = $m.id; duplicate_of = $m.duplicate_of; duplicate_of_ref = $m.duplicate_of_ref; group = $m.group } }
    $noTwin = @($plan.Review | Where-Object reason -eq 'canonical-has-no-identical-twin')
    $frozen = [ordered]@{
        ticket = 't/4337'; option = 'A (mark only, no backfill)'; spec = 'docs/specs/source-identity.md v5'
        frozen_at = (Get-Date).ToUniversalTime().ToString('o'); sources_commit = (git -C $SourcesDir rev-parse HEAD)
        canonical_rule = 'SO C6 over the whole group; mark only the canonical''s byte-identical twins (SO e/344#5)'
        counts = [ordered]@{
            identity_groups = $groups.Count; groups_with_marks = $plan.GroupsWithMarks
            marks = @($plan.Marks | Where-Object has_metadata).Count; marks_without_metadata = @($plan.Marks | Where-Object { -not $_.has_metadata }).Count
            review_groups_whole = $noTwin.Count
            review_groups_remainder = @($plan.Review | Where-Object reason -eq 'differs-from-canonical-or-second-identical-subset').Count
            deferred_c9 = @($plan.Review | Where-Object reason -like 'c9-*' | ForEach-Object { $_.members.Count } | Measure-Object -Sum).Sum
            review_docs = (@($plan.Review | Where-Object reason -notlike 'c9-*' | ForEach-Object { $_.members.Count }) | Measure-Object -Sum).Sum }
        marks = @($plan.Marks | Where-Object has_metadata | ForEach-Object { & $strip $_ })
        marks_without_metadata = @($plan.Marks | Where-Object { -not $_.has_metadata } | ForEach-Object { & $strip $_ })
        review = @($plan.Review | ForEach-Object { [ordered]@{ canonical = $_.canonical; reason = $_.reason; members = $_.members } })
        files = $files; group_input = $groupInput
    }
    [IO.File]::WriteAllText($FrozenPath, (($frozen | ConvertTo-Json -Depth 6) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
    "frozen: $FrozenPath"; [pscustomobject]$frozen.counts | Format-List | Out-String
    return
}

# ── DryRun / Apply / Revert: read ONLY the frozen list ──────────────────────────
$fz = [IO.File]::ReadAllText($FrozenPath) | ConvertFrom-Json -AsHashtable
$markById = @{}; foreach ($m in @($fz.marks)) { $markById[$m.id] = $m }
$plan = [System.Collections.Generic.List[object]]::new(); $fail = [System.Collections.Generic.List[string]]::new()
foreach ($id in @($fz.files.Keys)) {
    $f = $fz.files[$id]; $path = Join-Path (Join-Path $SourcesDir $id) 'metadata.json'
    $keys = [ordered]@{ duplicate_of = [string]$markById[$id].duplicate_of; duplicate_of_ref = [string]$markById[$id].duplicate_of_ref }
    $bytes = [IO.File]::ReadAllBytes($path); $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($Mode -eq 'Revert') {
        $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $seg = -join ($keys.GetEnumerator() | ForEach-Object { ',' + $nl + '  "' + $_.Key + '": "' + $_.Value + '"' })
        $i = $text.LastIndexOf($seg)
        if ($i -lt 0) { $fail.Add("${id}: inserted keys not found; not reverted"); continue }
        $orig = $text.Remove($i, $seg.Length)
        if ((Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($orig))) -cne $f.pre_sha256) { $fail.Add("${id}: revert would not restore the frozen bytes"); continue }
        $plan.Add([pscustomobject]@{ Id = $id; Path = $path; New = $orig }); continue
    }
    if ((Get-Sha256Hex $bytes) -cne $f.pre_sha256) { $fail.Add("${id}: metadata.json changed since the freeze"); continue }
    if ($text.Contains('"duplicate_of')) { $fail.Add("${id}: already carries a duplicate_of key"); continue }
    $r = Add-JsonKeysText -Text $text -Keys $keys
    if ($r.Text.Remove($r.At, $r.Segment.Length) -cne $text) { $fail.Add("${id}: not a pure insertion"); continue }
    $why = Test-InsertionOnly -Old $text -New $r.Text -Keys $keys
    if ($why) { $fail.Add("${id}: $why"); continue }
    $plan.Add([pscustomobject]@{ Id = $id; Path = $path; New = $r.Text })
}

$created = @{}
if ($CreateMissingMetadata) {
    foreach ($m in @($fz.marks_without_metadata)) {
        $dir = Join-Path $SourcesDir $m.id; $path = Join-Path $dir 'metadata.json'; $text = New-MinimalMetadataText $m
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { $fail.Add("$($m.id): source directory is missing"); continue }
        if ($Mode -eq 'Revert') {
            if (-not (Test-Path -LiteralPath $path)) { continue }
            if ([IO.File]::ReadAllText($path) -cne $text) { $fail.Add("$($m.id): created metadata.json was edited since; not deleted"); continue }
            $plan.Add([pscustomobject]@{ Id = $m.id; Path = $path; New = $null; Delete = $true }); continue
        }
        if (Test-Path -LiteralPath $path) { $fail.Add("$($m.id): metadata.json now exists; not overwritten"); continue }
        $plan.Add([pscustomobject]@{ Id = $m.id; Path = $path; New = $text }); $created[$m.id] = $text
    }
}

if ($Mode -ne 'Revert') {
    # The resolver on the simulated post-write corpus: 0 errors, no chains, and the SO C8 invariant.
    $planById = @{}; foreach ($p in $plan) { $planById[$p.Id] = $p }
    $docs = [System.Collections.Generic.List[object]]::new()
    foreach ($id in @($fz.group_input.Keys)) {
        $text = if ($planById.ContainsKey($id)) { $planById[$id].New } else { [IO.File]::ReadAllText((Join-Path (Join-Path $SourcesDir $id) 'metadata.json')) }
        $docs.Add([pscustomobject]@{ Id = $id; Metadata = ($text | ConvertFrom-Json); SnapshotSha256 = $fz.group_input[$id] })
    }
    foreach ($m in @($fz.marks_without_metadata)) {
        $snap = Join-Path (Join-Path $SourcesDir $m.id) 'snapshot.md'
        $h = if (Test-Path -LiteralPath $snap) { Get-SourceContentHash -Text ([IO.File]::ReadAllText($snap)) } else { $null }
        $meta = if ($created.ContainsKey($m.id)) { $created[$m.id] | ConvertFrom-Json } else { [pscustomobject]@{} }
        $docs.Add([pscustomobject]@{ Id = $m.id; Metadata = $meta; SnapshotSha256 = $h })
    }
    $g = Get-SourceIdentityGroup -Documents $docs.ToArray()
    if (@($g.DuplicateOfErrors).Count) { $fail.Add("post-write resolver reports $(@($g.DuplicateOfErrors).Count) duplicate_of error(s)") }
    $allMarks = @($fz.marks) + @($fz.marks_without_metadata | Where-Object { $created.ContainsKey($_.id) })
    foreach ($m in $allMarks) {
        $r = $g.Resolved[$m.id]; $c = $g.Canonical[$m.id]
        if ($r -cne $m.duplicate_of -or $c -cne $m.duplicate_of) { $fail.Add("C8 invariant: $($m.id) resolves to '$r', group canonical '$c', frozen canonical '$($m.duplicate_of)'") }
    }
    $marked = [System.Collections.Generic.HashSet[string]]::new([string[]]@($allMarks | ForEach-Object { $_.id }), [StringComparer]::Ordinal)
    $chained = @($allMarks | Where-Object { $marked.Contains($_.duplicate_of) })
    if ($chained.Count) { $fail.Add("no-chain check: $($chained.Count) mark(s) target a marked doc") }
}

"mode=$Mode files_planned=$($plan.Count) marks=$(@($fz.marks).Count) failures=$($fail.Count)"
$fail | Select-Object -First 20 | ForEach-Object { "  FAIL $_" }
if (@($fz.marks_without_metadata).Count) {
    "  marks_without_metadata: $(@($fz.marks_without_metadata).Count) (" + $(if ($CreateMissingMetadata) { "minimal metadata.json planned: $($created.Count)" } else { 'left alone per SO C10 (no reader; quarantine/completion list)' }) + ")"
}
if ($Mode -in 'Apply', 'Revert') {
    if ($fail.Count) { throw "$Mode refused: $($fail.Count) check(s) failed; nothing written" }
    foreach ($p in $plan) {
        if ($p.PSObject.Properties['Delete'] -and $p.Delete) { Remove-Item -LiteralPath $p.Path; continue }
        [IO.File]::WriteAllBytes($p.Path, [Text.Encoding]::UTF8.GetBytes($p.New))
    }
    "wrote $($plan.Count) file(s)"
}
