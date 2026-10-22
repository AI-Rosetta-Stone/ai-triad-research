# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/4405: write duplicate_of + duplicate_of_ref for the t/4398 review groups (R1 same-raw, R2 PI-approved,
    t/4402 human-reviewed) in ai-triad-sources. Marks only: no metadata fixes (TL p/360#670; those are a
    separate list), nothing deleted, nothing re-pointed.
.DESCRIPTION
    A /data-mutation write, built on Invoke-T4337DuplicateMark.ps1.
      -Mode Freeze   Reads the sources git tree at origin/main (which must equal the clean working tree)
                     and the t/4337 frozen list's 29 review groups, computes every guard input, and runs
                     Get-T4405MarkPlan (the SO e/348#2 guards as accepted by the TL). Writes
                     frozen-t4405-marks.json: marks, review, the 3+ blob record, each target file's
                     pre-write sha256, and the resolver input for the whole corpus.
      -Mode DryRun   (default) Reads ONLY the frozen list. Per file: bytes unchanged since the freeze; a
                     pure insertion of exactly the frozen keys; old == new minus those keys; revert
                     restores the bytes. Then BOTH resolvers on the simulated post-write corpus (PS
                     Get-SourceIdentityGroup, TS groupSourceIdentities): 0 duplicate_of errors, no
                     chains, and for every mark resolve == group canonical == frozen target, the same
                     under both.
      -Mode Apply    The same checks, then writes. Needs -ApprovedFrozenSha256 (the PI's sign-off) and
                     -UnionLiveEvidence (PI t/4398#5: no marks until the e/347 union is live in prod).
      -Mode Revert   Removes exactly the frozen keys, checking the frozen pre-write hash.
#>
[CmdletBinding()]
param(
    [ValidateSet('Freeze', 'DryRun', 'Apply', 'Revert')][string]$Mode = 'DryRun',
    [string]$SourcesDir = 'C:\Users\jsnov\repos\ai-triad-sources',
    # The data repo, read at its origin/main for the C9 union-support evidence (summaries).
    [string]$DataDir = 'C:\Users\jsnov\repos\ai-triad-data',
    [string]$FrozenPath = (Join-Path $PSScriptRoot 'frozen-t4405-marks.json'),
    [string]$RefPrefix = 't4405-review-2026-10',
    [string]$ApprovedFrozenSha256,
    # Where the e/347 evidence union was verified live in prod (a deploy run, a URL, a ticket comment).
    [string]$UnionLiveEvidence
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' '..')).Path
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'SourceIdentity.ps1')
. (Join-Path $repo 'scripts' 'AITriad' 'Private' 'Repair-SnapshotMojibake.ps1')
. (Join-Path $PSScriptRoot 'T4405MarkPlan.ps1')

# ── PI-approved decisions (t/4398#4, approved t/4398#5) and the t/4402 human review ─────────────────────
$R2 = @(
    @{ member = '2025-foundation-model-transparency-index-2026-1'; canonical = '2025-foundation-model-transparency-index-2026' }               # 1
    @{ member = 'epistemic-boundaries-macroeconomic-realities-technical-2026'; canonical = 'epistemic-boundaries-macroeconomic-realities-technical-2026-1' }  # 2
    @{ member = 'from-assistance-execution-how-enterprises-put-ai-work-2026-1'; canonical = 'from-assistance-execution-how-enterprises-put-ai-work-2026' }  # 3
    @{ member = 'from-assistance-execution-how-enterprises-put-ai-work-2026-2'; canonical = 'from-assistance-execution-how-enterprises-put-ai-work-2026' }  # 4
    @{ member = 'genai-skepticism-reflections-beginning-2026-2026'; canonical = 'genai-skepticism-reflections-beginning-2026-2026-1' }        # 5
    @{ member = 'governor-newsom-issues-executive-order-accelerate-2026-2'; canonical = 'governor-newsom-issues-executive-order-accelerate-2026' }  # 6
    @{ member = 'how-existing-liability-frameworks-can-handle-agentic-ai-2026-1'; canonical = 'how-existing-liability-frameworks-can-handle-agentic-ai-2026' }  # 7
    @{ member = 'how-existing-liability-frameworks-can-handle-agentic-ai-2026-2'; canonical = 'how-existing-liability-frameworks-can-handle-agentic-ai-2026' }  # 8
    @{ member = 'international-ai-safety-report-2026-2026-1'; canonical = 'international-ai-safety-report-2026-2026' }                      # 9
    @{ member = 'law-following-ai-designing-ai-agents-obey-human-laws-2026-1'; canonical = 'law-following-ai-designing-ai-agents-obey-human-laws-2026' }  # 10
    @{ member = 'rethinking-ai-agents-principal-agent-perspective-2026-1'; canonical = 'rethinking-ai-agents-principal-agent-perspective-2026' }  # 11
    # 12: PMLR camera-ready vs arXiv v1 are different editions: no mark. 13: the two arXiv-v1 copies pair up.
    @{ member = 'scaling-laws-differentially-private-language-models-2026-2'; canonical = 'scaling-laws-differentially-private-language-models-2026' }  # 13
)
# t/4402: text-2026 and text-2026-1 are the IMF World Economic Outlook PDF.
$Human = @{
    'text-2026'   = 'world-economic-outlook-update-global-economy-steady-amid-2026-2'
    'text-2026-1' = 'world-economic-outlook-update-global-economy-steady-amid-2026-2'
}
# Recorded canonical decisions for a guard-flagged canonical (SO condition 3: an override needs a decision).
# "keep" clears the hold: the C6 canonical stays and its same-raw twins are marked to it.
$CanonicalDecisions = [ordered]@{
    'how-brussels-effect-hinders-innovation-global-south-2026-3' = 'keep: no override (CL content check t/4405#10)'
}
$JunkRx = '(^|/)\.|thumbs\.db$|desktop\.ini$'

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}

# Same insertion and proof as t/4337 (Invoke-T4337DuplicateMark.ps1).
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

function Get-GitText([string]$Rev, [string]$RelPath, [string]$Repo = $SourcesDir) {
    $p = Start-Process -FilePath git -ArgumentList @('-C', $Repo, 'show', "${Rev}:$RelPath") -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput ($o = [IO.Path]::GetTempFileName()) -RedirectStandardError ($e = [IO.Path]::GetTempFileName())
    try { if ($p.ExitCode -ne 0) { return $null }; [IO.File]::ReadAllText($o, [Text.UTF8Encoding]::new($false)) }
    finally { Remove-Item -LiteralPath $o, $e -Force -ErrorAction SilentlyContinue }
}

# The node ids a summary links, over the four C9 link fields (t/4337 c9-link-fields.json, SO e/344#13).
function Get-SummaryLinkedNodes($Summary) {
    $ids = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    if ($null -eq $Summary) { return , $ids }
    if ($Summary.PSObject.Properties['pov_summaries'] -and $Summary.pov_summaries) {
        foreach ($pov in $Summary.pov_summaries.PSObject.Properties) {
            if ($null -eq $pov.Value -or -not $pov.Value.PSObject.Properties['key_points']) { continue }
            foreach ($kp in @($pov.Value.key_points)) { if ($kp -and $kp.PSObject.Properties['taxonomy_node_id'] -and $kp.taxonomy_node_id) { [void]$ids.Add([string]$kp.taxonomy_node_id) } }
        }
    }
    if ($Summary.PSObject.Properties['factual_claims']) {
        foreach ($fc in @($Summary.factual_claims)) {
            if (-not $fc) { continue }
            foreach ($f in 'linked_taxonomy_nodes', 'potential_taxonomy_nodes') {
                if ($fc.PSObject.Properties[$f]) { foreach ($n in @($fc.$f)) { if ($n) { [void]$ids.Add([string]$n) } } }
            }
        }
    }
    if ($Summary.PSObject.Properties['unmapped_concepts']) {
        foreach ($uc in @($Summary.unmapped_concepts)) { if ($uc -and $uc.PSObject.Properties['resolved_node_id'] -and $uc.resolved_node_id) { [void]$ids.Add([string]$uc.resolved_node_id) } }
    }
    , $ids
}

# The whole-corpus resolver input (as t/4337): id -> computed snapshot hash, for every doc with metadata.
function Get-CorpusDocs {
    $dirs = @(Get-ChildItem -LiteralPath $SourcesDir -Directory -Force | Where-Object { $_.Name -notmatch '^[._]' })
    foreach ($d in $dirs) {
        $mp = Join-Path $d.FullName 'metadata.json'; $sp = Join-Path $d.FullName 'snapshot.md'
        if (-not (Test-Path -LiteralPath $mp)) { continue }
        [pscustomobject]@{
            Id = $d.Name; MetaText = [IO.File]::ReadAllText($mp)
            SnapshotSha256 = if (Test-Path -LiteralPath $sp) { Get-SourceContentHash -Text ([IO.File]::ReadAllText($sp)) } else { $null }
        }
    }
}

if ($Mode -eq 'Freeze') {
    $rev = (git -C $SourcesDir rev-parse origin/main).Trim()
    if ((git -C $SourcesDir rev-parse HEAD).Trim() -cne $rev) { throw "Freeze refused: the sources checkout is not at origin/main ($rev)" }
    if (@(git -C $SourcesDir status --porcelain).Count) { throw 'Freeze refused: the sources working tree is not clean' }

    # Substantive raw sets from the git tree: no dotfiles, Thumbs.db, desktop.ini, or files under 1 KB.
    $raw = @{}; $sharers = @{}
    foreach ($line in @(git -C $SourcesDir ls-tree -r -l $rev)) {
        $meta, $path = $line -split "`t", 2
        $parts = $path -split '/'
        if ($parts.Count -lt 3 -or $parts[1] -cne 'raw') { continue }
        if ($path.Substring($parts[0].Length + 5) -match $JunkRx) { continue }
        $f = $meta -split '\s+'
        if ($f[3] -eq '-' -or [long]$f[3] -lt 1024) { continue }
        if (-not $raw.ContainsKey($parts[0])) { $raw[$parts[0]] = [System.Collections.Generic.List[string]]::new() }
        $raw[$parts[0]].Add($f[2])
        if (-not $sharers.ContainsKey($f[2])) { $sharers[$f[2]] = [System.Collections.Generic.List[string]]::new() }
        if (-not $sharers[$f[2]].Contains($parts[0])) { $sharers[$f[2]].Add($parts[0]) }
    }

    $t4337 = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..' 't4337' 'frozen-t4337-marks.json')) | ConvertFrom-Json
    $groups = @($t4337.review | Where-Object { $_.reason -notlike 'c9-*' } | ForEach-Object { @{ canonical = [string]$_.canonical; members = [string[]]@($_.members) } })
    if ($groups.Count -ne 29) { throw "expected the 29 t/4398 review groups, found $($groups.Count)" }

    # The 15 t/4337 C9 deferrals (TL e/348#10, t/4405#4): marked once every reference the copy alone supported
    # is supported by the group under the e/347 union. Evidence recorded per doc, per ref (TL p/360#676).
    $dataRev = (git -C $DataDir rev-parse origin/main).Trim()
    $deferred = @(([IO.File]::ReadAllText((Join-Path $PSScriptRoot '..' 't4337' 'deferred-t4337-c9.json')) | ConvertFrom-Json).deferred)
    if ($deferred.Count -ne 15) { throw "expected the 15 t/4337 C9 deferrals, found $($deferred.Count)" }
    $c9Support = [System.Collections.Generic.List[object]]::new(); $c9Pairs = [System.Collections.Generic.List[object]]::new(); $c9Unsupported = [System.Collections.Generic.List[object]]::new()
    foreach ($d in $deferred) {
        $members = @([string]$d.canonical, [string]$d.id)
        $links = @{}
        foreach ($m in $members) {
            $st = Get-GitText $dataRev "summaries/$m.json" $DataDir
            $links[$m] = Get-SummaryLinkedNodes $(if ($st) { $st | ConvertFrom-Json } else { $null })
        }
        $refs = foreach ($n in @($d.references)) {
            [ordered]@{ node = [string]$n; supported_by = [string[]]@($members | Where-Object { $links[$_].Contains([string]$n) }) }
        }
        $refs = @($refs)
        $ok = @($refs | Where-Object { $_.supported_by.Count -eq 0 }).Count -eq 0
        $c9Support.Add([ordered]@{ id = [string]$d.id; canonical = [string]$d.canonical; all_supported = $ok; references = $refs })
        if ($ok) { $c9Pairs.Add(@{ member = [string]$d.id; canonical = [string]$d.canonical; basis = 'c9-deferred-t4337' }) }
        else { $c9Unsupported.Add([string]$d.id) }
    }

    # Every doc a guard looks at: group docs, R2/human ids, and every doc sharing one of their raw blobs.
    $interest = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($g in $groups) { [void]$interest.Add($g.canonical); foreach ($m in $g.members) { [void]$interest.Add($m) } }
    foreach ($p in @($R2) + @($c9Pairs)) { [void]$interest.Add($p.member); [void]$interest.Add($p.canonical) }
    foreach ($k in $Human.Keys) { [void]$interest.Add($k); [void]$interest.Add($Human[$k]) }
    foreach ($id in @($interest)) { if ($raw.ContainsKey($id)) { foreach ($b in $raw[$id]) { foreach ($s in $sharers[$b]) { [void]$interest.Add($s) } } } }

    $titleKey = @{}; $weak = @{}; $urlKey = @{}; $snap = @{}; $marked = @{}; $hasMeta = @{}
    foreach ($id in ($interest | Sort-Object)) {
        $mt = Get-GitText $rev "$id/metadata.json"
        $hasMeta[$id] = $null -ne $mt
        $m = if ($mt) { $mt | ConvertFrom-Json } else { [pscustomobject]@{} }
        $title = if ($m.PSObject.Properties['title']) { [string]$m.title } else { '' }
        $titleKey[$id] = ConvertTo-T4405TitleKey $title
        $weak[$id] = Test-T4405WeakTitle $titleKey[$id]
        $urlKey[$id] = ConvertTo-T4405UrlKey $(if ($m.PSObject.Properties['url']) { [string]$m.url } else { '' })
        if ($m.PSObject.Properties['duplicate_of'] -and $m.duplicate_of) { $marked[$id] = [string]$m.duplicate_of }
        $st = Get-GitText $rev "$id/snapshot.md"
        $snap[$id] = if ($null -ne $st) {
            $r = Repair-SnapshotMojibake -Text $st
            [pscustomobject]@{ Variant = $r.Variant; Length = $r.Text.Length; Hash = (Get-SourceContentHash -Text $r.Text) }
        } else { $null }
    }

    # Second signal for a weak-title pair: the same normalized URL, or the same repaired snapshot.
    $signal = @{}; $suspect = @{}
    foreach ($g in $groups) {
        $c = $g.canonical
        foreach ($mbr in @($g.members | Where-Object { $_ -cne $c })) {
            $sameUrl = $urlKey[$c] -and ($urlKey[$c] -ceq $urlKey[$mbr])
            $sameSnap = $snap[$c] -and $snap[$mbr] -and ($snap[$c].Hash -ceq $snap[$mbr].Hash)
            if ($sameUrl -or $sameSnap) { $signal["$c|$mbr"] = $true }
        }
        # Canonical override needs a decision (SO condition 3): its snapshot is cp437-damaged while a same-raw
        # twin's is clean, or it is under 80% of the longest same-raw twin.
        $cs = $snap[$c]
        $twins = @($g.members | Where-Object { $_ -cne $c -and $raw.ContainsKey($_) -and $raw.ContainsKey($c) -and
                (([string[]]$raw[$_] | Sort-Object) -join ',') -ceq (([string[]]$raw[$c] | Sort-Object) -join ',') -and $snap[$_] })
        if ($cs -and $twins.Count) {
            if ($cs.Variant -ne 'none' -and @($twins | Where-Object { $snap[$_].Variant -eq 'none' }).Count) { $suspect[$c] = "cp437-damaged ($($cs.Variant))" }
            else {
                $longest = ($twins | ForEach-Object { $snap[$_].Length } | Measure-Object -Maximum).Maximum
                if ($cs.Length -lt 0.8 * $longest) { $suspect[$c] = "materially-shorter ($($cs.Length) vs $longest chars)" }
            }
        }
    }

    # Apply the recorded canonical decisions: a "keep" removes the hold, and the decision goes into the list.
    $decisions = [System.Collections.Generic.List[object]]::new()
    foreach ($c in @($CanonicalDecisions.Keys)) {
        if (-not $suspect.ContainsKey($c)) { throw "canonical decision for $c, but the guards no longer flag it; remove the decision" }
        $decisions.Add([ordered]@{ canonical = $c; flagged = $suspect[$c]; decision = $CanonicalDecisions[$c] })
        if ($CanonicalDecisions[$c] -like 'keep*') { $suspect.Remove($c) }
    }

    $rawArr = @{}; foreach ($k in $raw.Keys) { $rawArr[$k] = [string[]]$raw[$k] }
    $shArr = @{}; foreach ($k in $sharers.Keys) { $shArr[$k] = [string[]]$sharers[$k] }
    $plan = Get-T4405MarkPlan -Groups $groups -Raw $rawArr -Sharers $shArr -TitleKey $titleKey -TitleWeak $weak `
        -SecondSignal $signal -CanonicalSuspect $suspect -Marked $marked -R2 (@($R2) + @($c9Pairs)) -Human $Human

    $files = [ordered]@{}; $marks = [System.Collections.Generic.List[object]]::new(); $noMeta = [System.Collections.Generic.List[object]]::new()
    foreach ($mk in $plan.Marks) {
        $entry = [ordered]@{ id = $mk.id; duplicate_of = $mk.duplicate_of; duplicate_of_ref = "$RefPrefix#$($mk.basis)"; basis = $mk.basis; group = $mk.group }
        if ($hasMeta[$mk.id]) {
            $marks.Add($entry)
            $files[$mk.id] = [ordered]@{ pre_sha256 = (Get-Sha256Hex ([IO.File]::ReadAllBytes((Join-Path (Join-Path $SourcesDir $mk.id) 'metadata.json')))) }
        } else { $noMeta.Add($entry) }
    }
    $groupInput = [ordered]@{}; foreach ($d in (Get-CorpusDocs | Sort-Object Id)) { $groupInput[$d.Id] = $d.SnapshotSha256 }

    $frozen = [ordered]@{
        ticket = 't/4405'; scope = 'marks only: R1 same-raw, R2 PI-approved (t/4398#4-5), t/4402 human-reviewed; metadata fixes are a separate list (TL p/360#670)'
        guards = 'SO e/348#2 conditions 1-7 as accepted by the TL (e/348#3, #10); 3+ blob: review unless every sharer is in the group and their non-weak titles agree'
        frozen_at = (Get-Date).ToUniversalTime().ToString('o'); sources_commit = $rev; data_commit = $dataRev
        counts = [ordered]@{
            review_groups = $groups.Count
            marks = $marks.Count
            marks_by_basis = [ordered]@{
                'r1-same-raw' = @($marks | Where-Object { $_.basis -eq 'r1-same-raw' }).Count
                'r2-pi-approved' = @($marks | Where-Object { $_.basis -eq 'r2-pi-approved' }).Count
                'human-reviewed-t4402' = @($marks | Where-Object { $_.basis -eq 'human-reviewed-t4402' }).Count
                'c9-deferred-t4337' = @($marks | Where-Object { $_.basis -eq 'c9-deferred-t4337' }).Count }
            c9_deferred = $deferred.Count
            c9_unsupported_left_deferred = $c9Unsupported.Count
            marks_without_metadata = $noMeta.Count
            review = @($plan.Review).Count
            blobs_3plus = @($plan.Blobs).Count
            blobs_3plus_accepted = @($plan.Blobs | Where-Object accepted).Count
        }
        marks = $marks.ToArray(); marks_without_metadata = $noMeta.ToArray()
        review = @($plan.Review | ForEach-Object { [ordered]@{ canonical = $_.canonical; member = $_.member; reason = $_.reason } })
        blobs_3plus = @($plan.Blobs | ForEach-Object { [ordered]@{ blob = $_.blob; group = $_.group; accepted = $_.accepted; docs = @($_.docs); titles = @($_.titles) } })
        canonical_decisions = $decisions.ToArray()
        c9_union_support = $c9Support.ToArray()
        files = $files; group_input = $groupInput
    }
    [IO.File]::WriteAllText($FrozenPath, (($frozen | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
    "frozen: $FrozenPath"; [pscustomobject]$frozen.counts | Format-List | Out-String
    return
}

# ── DryRun / Apply / Revert: read ONLY the frozen list ──────────────────────────
$frozenBytes = [IO.File]::ReadAllBytes($FrozenPath)
$frozenSha = Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes(([Text.Encoding]::UTF8.GetString($frozenBytes) -replace "`r`n", "`n")))
"frozen list: $FrozenPath sha256=$frozenSha"
if ($Mode -eq 'Apply') {
    if (-not $ApprovedFrozenSha256) { throw 'Apply refused: pass -ApprovedFrozenSha256 with the frozen-list hash the PI signed off' }
    if ($ApprovedFrozenSha256.ToLowerInvariant() -cne $frozenSha) { throw "Apply refused: the frozen list's sha256 $frozenSha is not the approved $ApprovedFrozenSha256" }
    if (-not $UnionLiveEvidence) { throw 'Apply refused: PI t/4398#5 allows no marks until the e/347 union is live in prod; pass -UnionLiveEvidence naming where that was verified' }
}
$fz = [Text.Encoding]::UTF8.GetString($frozenBytes) | ConvertFrom-Json -AsHashtable
if ((git -C $SourcesDir rev-parse HEAD).Trim() -cne $fz.sources_commit -and $Mode -ne 'Revert') { throw "the sources checkout is not at the frozen commit $($fz.sources_commit)" }
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

if ($Mode -ne 'Revert') {
    # Both resolvers on the simulated post-write corpus.
    $planById = @{}; foreach ($p in $plan) { $planById[$p.Id] = $p }
    $docs = [System.Collections.Generic.List[object]]::new()
    foreach ($id in @($fz.group_input.Keys)) {
        $text = if ($planById.ContainsKey($id)) { $planById[$id].New } else { [IO.File]::ReadAllText((Join-Path (Join-Path $SourcesDir $id) 'metadata.json')) }
        $docs.Add([pscustomobject]@{ Id = $id; Metadata = ($text | ConvertFrom-Json); SnapshotSha256 = $fz.group_input[$id] })
    }
    $g = Get-SourceIdentityGroup -Documents $docs.ToArray()
    if (@($g.DuplicateOfErrors).Count) { $fail.Add("PS resolver: $(@($g.DuplicateOfErrors).Count) duplicate_of error(s)") }

    $tsIn = Join-Path ([IO.Path]::GetTempPath()) "t4405-docs-$PID.json"; $tsOut = Join-Path ([IO.Path]::GetTempPath()) "t4405-ts-$PID.json"
    try {
        $tsDocs = foreach ($d in $docs) { [ordered]@{ id = $d.Id; metadata = $d.Metadata; snapshotSha256 = $d.SnapshotSha256 } }
        [IO.File]::WriteAllText($tsIn, (ConvertTo-Json -InputObject @($tsDocs) -Depth 20 -Compress), [Text.UTF8Encoding]::new($false))
        # The nearest node_modules/.bin/tsx at or above the repo (a worktree uses the main checkout's install).
        $tsxName = if ($IsWindows) { 'tsx.cmd' } else { 'tsx' }
        $tsx = $null; $dir = $repo
        while ($dir -and -not $tsx) {
            $cand = Join-Path $dir 'node_modules' '.bin' $tsxName
            if (Test-Path -LiteralPath $cand) { $tsx = $cand } else { $dir = Split-Path -Parent $dir }
        }
        if (-not $tsx) { throw "tsx not found in any node_modules/.bin at or above $repo; run pnpm install" }
        & $tsx (Join-Path $PSScriptRoot 'ts-resolver-check.ts') $tsIn $tsOut
        if ($LASTEXITCODE -ne 0) { throw "TS resolver check exited $LASTEXITCODE" }
        $ts = [IO.File]::ReadAllText($tsOut) | ConvertFrom-Json -AsHashtable
    }
    finally { Remove-Item -LiteralPath $tsIn, $tsOut -Force -ErrorAction SilentlyContinue }
    if (@($ts.duplicateOfErrors).Count) { $fail.Add("TS resolver: $(@($ts.duplicateOfErrors).Count) duplicate_of error(s)") }

    foreach ($m in @($fz.marks)) {
        $r = $g.Resolved[$m.id]; $c = $g.Canonical[$m.id]; $tr = $ts.resolved[$m.id]; $tc = $ts.canonical[$m.id]
        if ($r -cne $m.duplicate_of -or $c -cne $m.duplicate_of) { $fail.Add("PS single-id: $($m.id) resolves to '$r', group canonical '$c', frozen '$($m.duplicate_of)'") }
        if ($tr -cne $m.duplicate_of -or $tc -cne $m.duplicate_of) { $fail.Add("TS single-id: $($m.id) resolves to '$tr', group canonical '$tc', frozen '$($m.duplicate_of)'") }
    }
    $marked = [System.Collections.Generic.HashSet[string]]::new([string[]]@($fz.marks | ForEach-Object { $_.id }), [StringComparer]::Ordinal)
    $chained = @($fz.marks | Where-Object { $marked.Contains($_.duplicate_of) })
    if ($chained.Count) { $fail.Add("no-chain check: $($chained.Count) mark(s) target a marked doc") }
}

"mode=$Mode files_planned=$($plan.Count) marks=$(@($fz.marks).Count) failures=$($fail.Count)"
$fail | Select-Object -First 30 | ForEach-Object { "  FAIL $_" }
if ($Mode -in 'Apply', 'Revert') {
    if ($fail.Count) { throw "$Mode refused: $($fail.Count) check(s) failed; nothing written" }
    foreach ($p in $plan) { [IO.File]::WriteAllBytes($p.Path, [Text.Encoding]::UTF8.GetBytes($p.New)) }
    "wrote $($plan.Count) file(s)"
}
