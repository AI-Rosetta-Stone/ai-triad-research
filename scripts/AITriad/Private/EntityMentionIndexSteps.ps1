# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Steps of Update-EntityMentionIndex (t/3910 complexity split; behaviour unchanged). The cmdlet keeps the
# path defaults, the grounding-lock try/finally and the guarded write; everything here is either a pure
# transform or a read. Lists are filled in place or returned inside an object, never returned bare, so an
# empty result can't unroll to $null.

function Get-EmiProp {
    # Safe field read across both shapes: [ordered] dicts (freshly built mentions) and PSCustomObject (parsed
    # from a possibly hand-edited entity_mentions.json). $null for an absent field instead of a StrictMode throw.
    param($o, $k)
    if ($null -eq $o) { return $null }
    if ($o -is [System.Collections.IDictionary]) { if ($o.Contains($k)) { return $o[$k] } else { return $null } }
    if ($o.PSObject.Properties[$k]) { return $o.$k }
    return $null
}

function Test-EmiMentionsEqual {
    # By-value mention-list equality (avoids fragile JSON-string comparison across the ordered-dict vs
    # parsed-PSCustomObject boundary).
    param($a, $b)
    $aa = @($a); $bb = @($b)
    if ($aa.Count -ne $bb.Count) { return $false }
    for ($i = 0; $i -lt $aa.Count; $i++) {
        foreach ($field in @('entity_ref', 'quote', 'offset', 'discovered_by')) {
            if ([string](Get-EmiProp $aa[$i] $field) -ne [string](Get-EmiProp $bb[$i] $field)) { return $false }
        }
    }
    return $true
}

function Get-EmiSummaryFiles {
    # The summary files to scan: the explicit -SummariesPath when bound, else every *.json directly under
    # Get-SummariesDir (sorted by name), else none. Copies: the marked duplicates for the union (default mode only).
    param([bool]$Bound, [string[]]$SummariesPath)
    if ($Bound) { return [pscustomobject]@{ Files = @($SummariesPath); Copies = @() } }
    $SummDir = Get-SummariesDir
    if (Test-Path -LiteralPath $SummDir) {
        # duplicate_of (t/4337): a marked copy's summary gets no summary:<copy> containers and existing
        # summary:<doc_id> keys are never rewritten (spec 6.4). Its distinct items come back through
        # Add-EmiUnionContainers under the canonical's namespace (spec 7.4, TL p/360#661).
        $all = @(Get-ChildItem -LiteralPath $SummDir -Filter '*.json' -File | Sort-Object -Property Name)
        $res = Get-DefaultSourceResolution -Caller 'Update-EntityMentionIndex'
        $kept = Select-SelectableSummaryFile -Files $all -Resolution $res
        $copies = @(Get-MarkedCopySummary -Files $all -Resolution $res -Caller 'Update-EntityMentionIndex')
        return [pscustomobject]@{ Files = @($kept | ForEach-Object { $_.FullName }); Copies = $copies }
    }
    Write-Verbose "Summaries dir not found: $SummDir; skipping summary containers."
    return [pscustomobject]@{ Files = @(); Copies = @() }
}

function Get-EmiEntitySurfaces {
    # An entity's name plus its aliases, or nothing when it is out of the requested statuses. A record without
    # a `status` field is treated as un-indexable (§5 curation contract).
    param($Entity, [string[]]$Status)
    $surfaces = [System.Collections.Generic.List[string]]::new()
    $eStatus = if ($Entity.PSObject.Properties['status']) { [string]$Entity.status } else { '' }
    if ($eStatus -notin $Status) { return , $surfaces }
    if ($Entity.PSObject.Properties['name'] -and $Entity.name) { $surfaces.Add([string]$Entity.name) }
    # aliases is frequently `null` (not []) in live data — @($null) collapses safely.
    if ($Entity.PSObject.Properties['aliases']) {
        foreach ($a in @($Entity.aliases)) { if ($a) { $surfaces.Add([string]$a) } }
    }
    return , $surfaces
}

function Add-EmiAliasEntries {
    <#
    .SYNOPSIS
        Fills $AliasEntries with { EntityRef; Regex } for every in-scope entity surface. Each alias is normalized
        per the D1 parity contract (Get-NormalizedName) and matched against the NFC+lowercased container text,
        tolerating any run of the pinned whitespace set between tokens. No IgnoreCase: the text is pre-lowercased
        with ToLowerInvariant, so casing mirrors D1 exactly. Word boundaries delimit the in-text span.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entities, [string[]]$Status,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$AliasEntries)
    foreach ($e in $Entities) {
        if (-not $e.PSObject.Properties['id']) { continue }
        $ref = [string]$e.id
        foreach ($s in (Get-EmiEntitySurfaces -Entity $e -Status $Status)) {
            $norm = Get-NormalizedName -Name $s
            if (-not $norm) { continue }
            $tokens = $norm -split ' '
            $pattern = (($tokens | ForEach-Object { [regex]::Escape($_) }) -join "$script:PinnedWhitespaceClass+")
            $AliasEntries.Add([PSCustomObject]@{ EntityRef = $ref; Regex = [regex]::new("(?<!\w)$pattern(?!\w)") })
        }
    }
}

function Add-EmiSeiContainers {
    # sei:<key> containers: the entry's facts[].claim joined by newline in file order (READ-ONLY SCAN).
    param([string]$SeiPath, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers)
    if (-not (Test-Path -LiteralPath $SeiPath)) {
        Write-Verbose "SEI not found at $SeiPath; skipping fact containers."
        return
    }
    $Sei = Get-Content -Raw -LiteralPath $SeiPath -Encoding utf8 | ConvertFrom-Json -AsHashtable
    foreach ($key in ($Sei.Keys | Sort-Object)) {
        $entry = $Sei[$key]
        if (-not ($entry -is [System.Collections.IDictionary]) -or -not $entry.ContainsKey('facts')) { continue }
        $claims = @($entry['facts'] | ForEach-Object {
                if ($_ -is [System.Collections.IDictionary] -and $_.ContainsKey('claim')) { [string]$_['claim'] }
            })
        $text = Get-MentionContainerText -Kind 'sei' -Fields $claims
        if ($text -ne '') { $Containers["sei:$key"] = $text }
    }
}

function Add-EmiKeyPointContainers {
    # key_points: POV-SCOPED 0-based index — `summary:<doc_id>#<pov>-kp-<n>` (<pov> ∈ acc/saf/skp), `<n>` reset
    # per POV array (CL ruling p/23#220-221: a single running counter churns unrelated refs on insert/remove).
    param($Summary, [string]$DocId, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers)
    if (-not ($Summary.PSObject.Properties['pov_summaries'] -and $Summary.pov_summaries)) { return }
    $povCode = @{ accelerationist = 'acc'; safetyist = 'saf'; skeptic = 'skp' }
    foreach ($povName in @('accelerationist', 'safetyist', 'skeptic')) {
        if (-not $Summary.pov_summaries.PSObject.Properties[$povName]) { continue }
        $povData = $Summary.pov_summaries.$povName
        if (-not $povData -or -not $povData.PSObject.Properties['key_points'] -or -not $povData.key_points) { continue }
        $code = $povCode[$povName]
        $kpIndex = 0
        foreach ($kp in @($povData.key_points)) {
            $pointVal = if ($kp.PSObject.Properties['point']) { $kp.point } else { $null }
            $text = Get-MentionContainerText -Kind 'kp' -Fields @($pointVal)
            if ($text -ne '') { $Containers["summary:$DocId#$code-kp-$kpIndex"] = $text }
            $kpIndex++
        }
    }
}

function Add-EmiFactualClaimContainers {
    # factual_claims: `summary:<doc_id>#fc-<n>`, 0-based index into the top-level array.
    param($Summary, [string]$DocId, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers)
    if (-not ($Summary.PSObject.Properties['factual_claims'] -and $Summary.factual_claims)) { return }
    $claims = @($Summary.factual_claims)
    for ($i = 0; $i -lt $claims.Count; $i++) {
        $claimVal = if ($claims[$i].PSObject.Properties['claim']) { $claims[$i].claim } else { $null }
        $text = Get-MentionContainerText -Kind 'fc' -Fields @($claimVal)
        if ($text -ne '') { $Containers["summary:$DocId#fc-$i"] = $text }
    }
}

function Add-EmiSummaryContainers {
    # Summary key points + factual claims (t/3122, §4/R2.2 T2). Absent files and files without doc_id are skipped.
    param([AllowEmptyCollection()][string[]]$SummaryFiles, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers)
    foreach ($summaryFile in $SummaryFiles) {
        if (-not (Test-Path -LiteralPath $summaryFile)) {
            Write-Verbose "Summary file not found: $summaryFile; skipping."
            continue
        }
        $summary = Get-Content -Raw -LiteralPath $summaryFile -Encoding utf8 | ConvertFrom-Json
        if (-not $summary.PSObject.Properties['doc_id'] -or -not $summary.doc_id) { continue }
        $docId = [string]$summary.doc_id
        Add-EmiKeyPointContainers -Summary $summary -DocId $docId -Containers $Containers
        Add-EmiFactualClaimContainers -Summary $summary -DocId $docId -Containers $Containers
    }
}

function Add-EmiUnionContainers {
    <#
    .SYNOPSIS
        The duplicate-group union for summary containers (t/4337, spec 7.4; key form TL p/360#661).
    .DESCRIPTION
        For each marked copy (canonical first, copies in ordinal order: Get-MarkedCopySummary), every key point
        and factual claim whose container text isn't near-equal (spec 7.3) to an item already in the group gets
        a container in the CANONICAL's namespace that names its source:
            summary:<canonical>#via-<copy>-<pov>-kp-<n>     summary:<canonical>#via-<copy>-fc-<n>
        where <n> is the item's index in the copy's own array, so the text is rebuildable from
        summaries/<copy>.json exactly as summary:<doc>#… is from summaries/<doc>.json. No summary:<copy> key
        is made and no existing key changes.
        THESE KEYS ARE DERIVED: they appear or disappear when duplicate_of marks or the union change, so
        nothing may persist a reference to one. Human mentions on them are dropped with a WARN
        (Add-EmiHumanMentions).
    #>
    param([AllowEmptyCollection()][object[]]$Copies, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers)
    if (@($Copies).Count -eq 0) { return }
    # Spec 7.1 group order, applied here so a caller can't change which copy's item survives.
    $ordered = [object[]]@($Copies)
    $sortKeys = [string[]]@(foreach ($c in $ordered) { "$($c.CanonicalId)`u{0001}$($c.CopyId)" })
    [Array]::Sort([Array]$sortKeys, [Array]$ordered, [System.Collections.IComparer][StringComparer]::Ordinal)
    $groupKeys = @{}   # canonical id -> de-dup keys of the container texts already in its group
    foreach ($copy in $ordered) {
        $canon = [string]$copy.CanonicalId
        if (-not $groupKeys.ContainsKey($canon)) {
            $groupKeys[$canon] = [System.Collections.Generic.List[string]]::new()
            $prefix = "summary:$canon#"
            foreach ($cid in @($Containers.Keys)) {
                if ($cid.StartsWith($prefix, [System.StringComparison]::Ordinal)) { $groupKeys[$canon].Add((ConvertTo-EvidenceKey -Quote ([string]$Containers[$cid]))) }
            }
        }
        $own = [ordered]@{}
        Add-EmiKeyPointContainers -Summary $copy.Summary -DocId 'x' -Containers $own
        Add-EmiFactualClaimContainers -Summary $copy.Summary -DocId 'x' -Containers $own
        foreach ($cid in @($own.Keys)) {
            $text = [string]$own[$cid]
            $k = ConvertTo-EvidenceKey -Quote $text
            $dup = $false
            foreach ($kk in $groupKeys[$canon]) { if (Test-EvidenceNearEqual -A $k -B $kk) { $dup = $true; break } }
            if ($dup) { continue }
            $groupKeys[$canon].Add($k)
            $Containers["summary:$canon#via-$($copy.CopyId)-$($cid.Substring('summary:x#'.Length))"] = $text
        }
    }
}

function Test-EmiDerivedContainerKey {
    # A spec 7.4 union container key (summary:<canonical>#via-<copy>-…): derived, never to be persisted against.
    param([string]$Cid)
    return $Cid -match '^summary:[^#]+#via-'
}

function Get-EmiContainerScan {
    <#
    .SYNOPSIS
        Per-container alias scan (READ-ONLY, runs OUTSIDE the grounding lock, t/3163): for each container in key
        order, its NFC text, text_sha256 and the fresh alias-candidate hits. $nfc IS the exact analyzed text;
        $lower mirrors D1's ToLowerInvariant for matching. For the Latin corpus lowercasing is length-preserving,
        so offsets align 1:1 and quote is sliced from $nfc to keep the original casing.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$Containers,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$AliasEntries)
    $ScanByCid = [ordered]@{}
    foreach ($cid in ($Containers.Keys | Sort-Object)) {
        $nfc = [string]$Containers[$cid]
        $lower = $nfc.ToLowerInvariant()
        $sliceable = ($nfc.Length -eq $lower.Length)
        $candidates = [System.Collections.Generic.List[object]]::new()
        foreach ($ae in $AliasEntries) {
            foreach ($mt in $ae.Regex.Matches($lower)) {
                $quote = if ($sliceable) { $nfc.Substring($mt.Index, $mt.Length) } else { $mt.Value }
                $candidates.Add([PSCustomObject]@{ Offset = $mt.Index; Length = $mt.Length; Quote = $quote; EntityRef = $ae.EntityRef; By = 'alias' })
            }
        }
        $ScanByCid[$cid] = [PSCustomObject]@{ Nfc = $nfc; Sha = (Get-TextSha256 -Text $nfc); Candidates = $candidates }
    }
    return $ScanByCid
}

function Read-EmiExistingIndex {
    # The existing index (human-mention preservation + idempotency). THE LOST-UPDATE SURFACE: the caller must hold
    # the grounding lock (t/3163 GV condition 1). An unreadable file means "rebuild from scratch".
    param([string]$OutPath)
    $state = [pscustomobject]@{ ById = @{}; LastModified = $null }
    if (-not (Test-Path -LiteralPath $OutPath)) { return $state }
    try {
        $prior = Get-Content -Raw -LiteralPath $OutPath -Encoding utf8 | ConvertFrom-Json
        if ($prior.PSObject.Properties['last_modified']) { $state.LastModified = [string]$prior.last_modified }
        if ($prior.PSObject.Properties['containers'] -and $prior.containers) {
            foreach ($p in $prior.containers.PSObject.Properties) { $state.ById[$p.Name] = $p.Value }
        }
    }
    catch {
        Write-Verbose "Existing $OutPath unreadable ($($_.Exception.Message)); rebuilding from scratch."
    }
    return $state
}

function Add-EmiHumanMentions {
    # Human mentions win (§5), but only on a container whose text is UNCHANGED (matching text_sha256); otherwise
    # they were computed against text that no longer exists and are superseded. Malformed entries are skipped.
    param($Existing, [string]$Sha, [string]$Cid, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Accepted)
    if ($null -eq $Existing) { return }
    if (-not ($Existing.PSObject.Properties['text_sha256'] -and [string]$Existing.text_sha256 -eq $Sha -and $Existing.PSObject.Properties['mentions'])) { return }
    if (Test-EmiDerivedContainerKey -Cid $Cid) {
        # A derived union key (t/4337, TL p/360#661) can vanish when marks change, so a human mention can't be
        # anchored to one. Never kept silently: WARN and drop.
        $n = @($Existing.mentions | Where-Object { [string](Get-EmiProp $_ 'discovered_by') -eq 'human' }).Count
        if ($n -gt 0) { Write-Warning "Update-EntityMentionIndex: dropped $n human mention(s) on derived container '$Cid'. Union keys (summary:<canonical>#via-…) are rebuilt from duplicate_of marks and must not carry curated data; record the mention on the canonical's own container instead." }
        return
    }
    foreach ($m in @($Existing.mentions)) {
        if ([string](Get-EmiProp $m 'discovered_by') -ne 'human') { continue }
        $q = Get-EmiProp $m 'quote'
        $off = Get-EmiProp $m 'offset'
        $eref = Get-EmiProp $m 'entity_ref'
        if ($null -eq $q -or $null -eq $off -or $null -eq $eref) {
            Write-Verbose "Skipping malformed human mention in container '$Cid' (missing offset/quote/entity_ref)."
            continue
        }
        $qs = [string]$q
        $Accepted.Add([PSCustomObject]@{ Offset = [int]$off; Length = $qs.Length; Quote = $qs; EntityRef = [string]$eref; By = 'human' })
    }
}

function Add-EmiNonOverlappingCandidates {
    # Longest-most-specific overlap resolution: candidates ordered by length desc, offset asc, entity_ref asc;
    # a candidate is accepted only if it overlaps nothing already accepted (seeded human intervals win).
    param([AllowEmptyCollection()][System.Collections.Generic.List[object]]$Candidates,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Accepted)
    $ordered = @($Candidates | Sort-Object -Property @{Expression = 'Length'; Descending = $true },
        @{Expression = 'Offset'; Descending = $false },
        @{Expression = 'EntityRef'; Descending = $false })
    foreach ($c in $ordered) {
        $cEnd = $c.Offset + $c.Length
        $overlaps = $false
        foreach ($a in $Accepted) {
            if ($c.Offset -lt ($a.Offset + $a.Length) -and $a.Offset -lt $cEnd) { $overlaps = $true; break }
        }
        if (-not $overlaps) { $Accepted.Add($c) }
    }
}

function ConvertTo-EmiMentionRecords {
    # Accepted intervals -> mention records, ordered by offset then entity_ref.
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Accepted)
    return [pscustomobject]@{ Mentions = @($Accepted |
                Sort-Object -Property @{Expression = 'Offset'; Descending = $false }, @{Expression = 'EntityRef'; Descending = $false } |
                ForEach-Object { [ordered]@{ entity_ref = $_.EntityRef; quote = $_.Quote; offset = [int]$_.Offset; discovered_by = $_.By } })
    }
}

function Get-EmiReusedExtractedAt {
    # The existing extracted_at when this container's text AND mentions are unchanged, else $null (new/changed).
    param($Existing, [string]$Sha, [object[]]$Mentions)
    if ($null -eq $Existing) { return $null }
    $exMentions = if ($Existing.PSObject.Properties['mentions']) { @($Existing.mentions) } else { @() }
    if ($Existing.PSObject.Properties['text_sha256'] -and [string]$Existing.text_sha256 -eq $Sha -and
        (Test-EmiMentionsEqual $exMentions $Mentions) -and $Existing.PSObject.Properties['extracted_at']) {
        return [string]$Existing.extracted_at
    }
    return $null
}

function Build-EmiOwnContainers {
    <#
    .SYNOPSIS
        Merges the out-of-lock scan against the FRESH in-lock existing index (GV guardrail 1): human mentions,
        overlap resolution, extracted_at reuse. Returns { Containers; TotalMentions; AnyContentChanged }.
        Containers with no resulting mentions are omitted (absence == "no links yet").
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$ScanByCid, [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$ExistingById)
    $result = [pscustomobject]@{ Containers = [ordered]@{}; TotalMentions = 0; AnyContentChanged = $false }
    foreach ($cid in $ScanByCid.Keys) {   # already key-sorted at build time (outside the lock)
        $scan = $ScanByCid[$cid]
        $existing = if ($ExistingById.ContainsKey($cid)) { $ExistingById[$cid] } else { $null }
        $accepted = [System.Collections.Generic.List[object]]::new()
        Add-EmiHumanMentions -Existing $existing -Sha $scan.Sha -Cid $cid -Accepted $accepted
        Add-EmiNonOverlappingCandidates -Candidates $scan.Candidates -Accepted $accepted
        if (@($accepted).Count -eq 0) { continue }
        $mentions = (ConvertTo-EmiMentionRecords -Accepted $accepted).Mentions
        $result.TotalMentions += @($mentions).Count
        $extractedAt = Get-EmiReusedExtractedAt -Existing $existing -Sha $scan.Sha -Mentions $mentions
        if (-not $extractedAt) {
            $extractedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            $result.AnyContentChanged = $true
        }
        $result.Containers[$cid] = [ordered]@{ text_sha256 = $scan.Sha; extracted_at = $extractedAt; mentions = $mentions }
    }
    return $result
}

function Test-EmiOwnedKey {
    # This cmdlet owns {sei:*, summary:*}; node:* belongs to CL's reconciler (t/3160 G7).
    param([string]$Key)
    return ($Key -like 'sei:*') -or ($Key -like 'summary:*')
}

function Assert-EmiOwnedScope {
    # Defensive disjoint-scope guard: this cmdlet must never itself BUILD a non-owned key.
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$NewContainers)
    $ownBuiltForeign = @($NewContainers.Keys | Where-Object { -not (Test-EmiOwnedKey $_) })
    if ($ownBuiltForeign.Count -gt 0) {
        throw (New-ActionableError `
                -Goal     'Rebuild the entity mention index within its {sei:*, summary:*} scope' `
                -Problem  "Built container key(s) outside scope: $($ownBuiltForeign -join ', '). node:* grounding is owned by the CL reconciler (t/3160 G7)." `
                -Location 'Update-EntityMentionIndex' `
                -NextSteps @('Disjoint-scope regression — the cmdlet must only produce sei:*/summary:* keys. Check the container-collection blocks.') `
                -AsErrorRecord)
    }
}

function Merge-EmiContainers {
    # Final map = preserved foreign containers (verbatim — never clobber reconciler-owned node:*) + freshly built
    # own containers, key-sorted for a stable file. Returns { Containers; PreservedForeign }.
    param([Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$ExistingById, [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$NewContainers)
    $merged = [pscustomobject]@{ Containers = [ordered]@{}; PreservedForeign = 0 }
    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($k in $ExistingById.Keys) { if (-not (Test-EmiOwnedKey $k)) { $keys.Add([string]$k); $merged.PreservedForeign++ } }
    foreach ($k in $NewContainers.Keys) { $keys.Add([string]$k) }
    foreach ($cid in ($keys | Sort-Object)) {
        $merged.Containers[$cid] = if ($NewContainers.Contains($cid)) { $NewContainers[$cid] } else { $ExistingById[$cid] }
    }
    return $merged
}

function Test-EmiIndexUnchanged {
    # Unchanged iff the FINAL container key-set equals the existing file's AND no own content changed. Preserved
    # foreign containers are verbatim and never drive a rewrite; the key-set check catches own add/remove.
    param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Specialized.OrderedDictionary]$FinalContainers, [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$ExistingById, [bool]$AnyContentChanged)
    $newKeys = @($FinalContainers.Keys | Sort-Object)
    $oldKeys = @($ExistingById.Keys | Sort-Object)
    return (($newKeys -join "`n") -eq ($oldKeys -join "`n")) -and (-not $AnyContentChanged)
}
