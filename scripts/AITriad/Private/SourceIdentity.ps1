# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Source-document identity keys (t/4337, t/4334). The rules are pinned in
# docs/specs/source-identity.md and checked against tests/fixtures/source-identity-cases.json,
# which the TypeScript side (lib/sourceIndex) runs too. Change the spec and the fixture first,
# then both implementations; never change one implementation alone.

<#
.SYNOPSIS
    Returns the body text that content_sha256 is computed over (spec section 1).
.DESCRIPTION
    Strips a leading BOM, converts CRLF/CR to LF, removes the Add-SnapshotHeader provenance
    header if present, applies Unicode NFC, strips trailing spaces and tabs from every line,
    and drops leading and trailing empty lines.
#>
function Get-SourceContentBody {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $t = $Text
    if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
    $t = $t.Replace("`r`n", "`n").Replace("`r", "`n")

    # Add-SnapshotHeader block: from the opening marker through the first "---" line after "-->".
    if ($t.StartsWith("<!--`n  AI Triad Research Project")) {
        $close = $t.IndexOf("`n-->`n")
        if ($close -ge 0) {
            $rule = $t.IndexOf("`n---`n", $close)
            if ($rule -ge 0) { $t = $t.Substring($rule + 5) }
        }
    }

    $t = $t.Normalize([System.Text.NormalizationForm]::FormC)
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $t.Split("`n")) { $lines.Add($line.TrimEnd([char[]]@(' ', "`t"))) }
    while ($lines.Count -gt 0 -and $lines[0] -eq '') { $lines.RemoveAt(0) }
    while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
    $lines -join "`n"
}

<#
.SYNOPSIS
    Returns content_sha256 (lowercase hex) for snapshot text, or $null for an empty body.
#>
function Get-SourceContentHash {
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $body = Get-SourceContentBody -Text $Text
    if ($body -eq '') { return $null }
    # Extraction-failure placeholders say nothing about the document's content (spec 1.3).
    if ($body.StartsWith('# PDF EXTRACTION FAILED')) { return $null }
    if ($body -match "\A# [^\n]*\n\n\[Binary file — no text extraction available\]\z") { return $null }
    # Body floor (spec 1.3, TL ruling p/801#17): under 100 words, a body is too small to be an
    # identity (cookie walls, paywall stubs, error pages). Words are runs split on ASCII
    # whitespace only, so .NET and JS (whose \s sets differ) count the same.
    $words = 0
    foreach ($tok in [regex]::Split($body, '[ \t\n\r\f\v]+')) { if ($tok -ne '') { $words++ } }
    if ($words -lt 100) { return $null }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($body)
    $sha = [System.Security.Cryptography.SHA256]::HashData($bytes)
    ([System.Convert]::ToHexString($sha)).ToLowerInvariant()
}

<#
.SYNOPSIS
    Returns the normalized URL identity key (spec section 2), or $null if the input is not an
    absolute http(s) URL.
#>
function ConvertTo-SourceUrlKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Url)

    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    $m = [regex]::Match($Url.Trim(), '^(?i:https?)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$')
    if (-not $m.Success) { return $null }

    $authority = $m.Groups[1].Value
    $at = $authority.LastIndexOf('@')
    if ($at -ge 0) { $authority = $authority.Substring($at + 1) }
    $authority = $authority.ToLowerInvariant()
    $authority = [regex]::Replace($authority, ':(80|443)$', '')
    if ($authority.StartsWith('www.')) { $authority = $authority.Substring(4) }
    if ($authority -eq '') { return $null }

    $path = $m.Groups[2].Value.TrimEnd('/')

    $params = [System.Collections.Generic.List[string]]::new()
    if ($m.Groups[3].Success) {
        foreach ($p in $m.Groups[3].Value.Substring(1).Split('&')) {
            if ($p -eq '') { continue }
            $key = ($p.Split('=', 2)[0]).ToLowerInvariant()
            if ($key.StartsWith('utm_') -or $key -in @('fbclid', 'gclid', 'mc_cid', 'mc_eid')) { continue }
            $params.Add($p)
        }
    }
    $params.Sort([System.StringComparer]::Ordinal)

    $key = $authority + $path
    if ($params.Count -gt 0) { $key += '?' + ($params -join '&') }
    $key
}

<#
.SYNOPSIS
    Returns the trusted URL keys of one source metadata object (spec section 3): url, then
    resolved_url, normalized and de-duplicated, minus any that came from a search-confidence
    provenance guess.
#>
function Get-TrustedSourceUrlKey {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)][AllowNull()]$Metadata)

    if ($null -eq $Metadata) { return , [string[]]@() }
    $untrusted = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    if ($Metadata.PSObject.Properties['provenance']) {
        foreach ($p in @($Metadata.provenance)) {
            if ($null -eq $p) { continue }
            $scheme = if ($p.PSObject.Properties['scheme']) { [string]$p.scheme } else { '' }
            $conf   = if ($p.PSObject.Properties['confidence']) { [string]$p.confidence } else { '' }
            $id     = if ($p.PSObject.Properties['id']) { [string]$p.id } else { '' }
            if ($scheme -eq 'url' -and $conf -eq 'search') {
                $k = ConvertTo-SourceUrlKey -Url $id
                if ($k) { [void]$untrusted.Add($k) }
            }
        }
    }
    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($field in 'url', 'resolved_url') {
        if (-not $Metadata.PSObject.Properties[$field]) { continue }
        $k = ConvertTo-SourceUrlKey -Url ([string]$Metadata.$field)
        if ($k -and -not $untrusted.Contains($k) -and -not $keys.Contains($k)) { $keys.Add($k) }
    }
    , $keys.ToArray()
}

<#
.SYNOPSIS
    Returns the normalized title key (spec section 4.4): lowercase, '+' to space, keep only
    ASCII [a-z0-9_] and ASCII whitespace, collapse whitespace, trim. ASCII-only by design, so
    .NET (Unicode \w) and JS (ASCII \w) cannot diverge.
#>
function ConvertTo-SourceTitleKey {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Title)

    if ([string]::IsNullOrEmpty($Title)) { return '' }
    $t = $Title.ToLowerInvariant().Replace('+', ' ')
    $t = [regex]::Replace($t, '[^a-z0-9_ \t\n\r\f\v]', '')
    $t = [regex]::Replace($t, '[ \t\n\r\f\v]+', ' ')
    $t.Trim()
}

<#
.SYNOPSIS
    Groups source documents (spec section 4): returns Canonical (docId -> canonical id) and
    TitleCollisions (equal titles across different groups, a report, never a merge), plus the
    section 6 duplicate-mark results: Resolved (docId -> resolved id), Selectable (sorted ids)
    and DuplicateOfErrors.
.DESCRIPTION
    Each document is @{ Id; Metadata; SnapshotSha256 }. Metadata may carry title, url,
    resolved_url, provenance, content_sha256 (recorded), same_as, parent_doc_id and duplicate_of.
    SnapshotSha256 is the hash computed from snapshot.md for a document with no recorded one; it
    makes a hash edge but never vetoes. Strong edges (link, hash, trusted URL) are unioned; the
    -N suffix edge is conditional (4.4); titles add no edge (4.5).
#>
function Get-SourceIdentityGroup {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][object[]]$Documents)

    $ids = [System.Collections.Generic.List[string]]::new()
    $meta = @{}
    $snapHash = @{}
    foreach ($d in $Documents) {
        $ids.Add([string]$d.Id); $meta[[string]$d.Id] = $d.Metadata
        $snapHash[[string]$d.Id] = if ($d.PSObject.Properties['SnapshotSha256'] -and $d.SnapshotSha256) { [string]$d.SnapshotSha256 } else { $null }
    }
    $known = [System.Collections.Generic.HashSet[string]]::new([string[]]$ids, [System.StringComparer]::Ordinal)

    $parent = @{}
    foreach ($id in $ids) { $parent[$id] = $id }
    $find = {
        param($x)
        while ($parent[$x] -ne $x) { $parent[$x] = $parent[$parent[$x]]; $x = $parent[$x] }
        $x
    }
    $union = {
        param($a, $b)
        $ra = & $find $a; $rb = & $find $b
        if ($ra -eq $rb) { return }
        if ([string]::CompareOrdinal($ra, $rb) -lt 0) { $parent[$rb] = $ra } else { $parent[$ra] = $rb }
    }
    $prop = {
        param($m, $name)
        if ($null -ne $m -and $m.PSObject.Properties[$name] -and -not [string]::IsNullOrEmpty([string]$m.$name)) { [string]$m.$name } else { $null }
    }

    $byKey = @{}
    $addKey = {
        param($tier, $key, $id)
        if ([string]::IsNullOrEmpty($key)) { return }
        $k = "$tier`0$key"
        if ($byKey.ContainsKey($k)) { & $union $byKey[$k] $id } else { $byKey[$k] = $id }
    }

    $titleKey = @{}; $urlKeys = @{}; $recorded = @{}; $urlMembers = @{}
    foreach ($id in $ids) {
        $titleKey[$id] = ConvertTo-SourceTitleKey -Title (& $prop $meta[$id] 'title')
        # No @(): the function returns its array whole (leading comma), and @() would wrap an
        # empty result as one '' element, a phantom URL that vetoes suffix edges.
        # Plain assignment, not an if-expression: pipeline output would unroll an empty array to $null.
        $k = Get-TrustedSourceUrlKey -Metadata $meta[$id]
        if ($null -eq $k) { $k = [string[]]::new(0) }
        $urlKeys[$id] = [string[]]$k
        $recorded[$id] = & $prop $meta[$id] 'content_sha256'
    }

    foreach ($id in $ids) {
        $m = $meta[$id]
        foreach ($link in 'parent_doc_id', 'same_as', 'duplicate_of') {         # 4.1 strong
            $target = & $prop $m $link
            if ($target -and $known.Contains($target)) { & $union $id $target }
        }
        $hash = if ($recorded[$id]) { $recorded[$id] } else { $snapHash[$id] }   # 4.2 strong
        & $addKey 'hash' $hash $id
        foreach ($u in $urlKeys[$id]) {                                         # 4.3: collected, paired below
            if (-not $urlMembers.ContainsKey($u)) { $urlMembers[$u] = [System.Collections.Generic.List[string]]::new() }
            $urlMembers[$u].Add($id)
        }

        $sm = [regex]::Match($id, '^(.+)-(\d+)$')                               # 4.4 conditional
        if ($sm.Success -and $known.Contains($sm.Groups[1].Value)) {
            $base = $sm.Groups[1].Value
            $sameTitle = $titleKey[$id] -ne '' -and $titleKey[$id] -ceq $titleKey[$base]
            $a = $urlKeys[$id]; $b = $urlKeys[$base]
            $urlConflict = $a.Count -gt 0 -and $b.Count -gt 0 -and -not @($a | Where-Object { $b -ccontains $_ }).Count
            $hashConflict = $recorded[$id] -and $recorded[$base] -and ($recorded[$id] -cne $recorded[$base])
            if ($sameTitle -and -not $urlConflict -and -not $hashConflict) { & $union $id $base }
        }
    }

    # 4.3 URL edges are pairwise, so the conflict veto can drop one pair: two documents sharing a
    # trusted URL key do NOT join when their effective hashes (recorded, else computed) both exist
    # and differ AND their title keys are both non-empty and differ. That pair is reported as a
    # url_conflict instead (TL ruling t/4337#8: a truncated DOI shared by two different papers).
    $urlConflicts = [System.Collections.Generic.List[object]]::new()
    $urlKeyList = [string[]]@($urlMembers.Keys); [Array]::Sort($urlKeyList, [System.StringComparer]::Ordinal)
    foreach ($u in $urlKeyList) {
        $members = [string[]]$urlMembers[$u].ToArray(); [Array]::Sort($members, [System.StringComparer]::Ordinal)
        for ($i = 0; $i -lt $members.Count; $i++) {
            for ($j = $i + 1; $j -lt $members.Count; $j++) {
                $a = $members[$i]; $b = $members[$j]
                $ha = if ($recorded[$a]) { $recorded[$a] } else { $snapHash[$a] }
                $hb = if ($recorded[$b]) { $recorded[$b] } else { $snapHash[$b] }
                $hashesDiffer = $ha -and $hb -and ($ha -cne $hb)
                $titlesDiffer = $titleKey[$a] -ne '' -and $titleKey[$b] -ne '' -and ($titleKey[$a] -cne $titleKey[$b])
                if ($hashesDiffer -and $titlesDiffer) {
                    $urlConflicts.Add([pscustomobject]@{ url_key = $u; ids = [string[]]@($a, $b) })
                } else {
                    & $union $a $b
                }
            }
        }
    }

    $canonical = @{}
    foreach ($id in $ids) { $canonical[$id] = & $find $id }

    # Section 6 duplicate marks. A mark is valid when its target is another document in the set that
    # carries no mark of its own (one hop, so no chains or cycles). The group's canonical is the
    # ordinal-smallest valid target in it; a valid mark naming any other target is a 'conflict' and,
    # like every invalid mark, is treated as absent by the resolver and selection.
    $mark = @{}; $kind = @{}
    foreach ($id in $ids) {
        $target = & $prop $meta[$id] 'duplicate_of'
        if (-not $target) { continue }
        $mark[$id] = $target
        $kind[$id] = if ($target -ceq $id) { 'self' }
                     elseif (-not $known.Contains($target)) { 'missing_target' }
                     elseif (& $prop $meta[$target] 'duplicate_of') { 'chain' }
                     else { $null }
    }
    $groupTarget = @{}
    foreach ($id in $mark.Keys) {
        if ($kind[$id]) { continue }
        $root = $canonical[$id]
        if (-not $groupTarget.ContainsKey($root) -or [string]::CompareOrdinal($mark[$id], $groupTarget[$root]) -lt 0) { $groupTarget[$root] = $mark[$id] }
    }
    foreach ($id in $mark.Keys) {
        if (-not $kind[$id] -and $mark[$id] -cne $groupTarget[$canonical[$id]]) { $kind[$id] = 'conflict' }
    }
    foreach ($id in $ids) {
        if ($groupTarget.ContainsKey($canonical[$id])) { $canonical[$id] = $groupTarget[$canonical[$id]] }
    }
    $resolved = @{}
    $selectable = [System.Collections.Generic.List[string]]::new()
    $markErrors = [System.Collections.Generic.List[object]]::new()
    $sortedIds = [string[]]$ids.ToArray(); [Array]::Sort($sortedIds, [System.StringComparer]::Ordinal)
    foreach ($id in $sortedIds) {
        $valid = $mark.ContainsKey($id) -and -not $kind[$id]
        $resolved[$id] = if ($valid) { $mark[$id] } else { $id }
        if (-not $valid) { $selectable.Add($id) }
        if ($mark.ContainsKey($id) -and $kind[$id]) {
            $markErrors.Add([pscustomobject]@{ id = $id; target = $mark[$id]; kind = $kind[$id] })
        }
    }

    # 4.5 title collisions: an equal non-empty title key across two or more groups (report only).
    $collisions = [System.Collections.Generic.List[object]]::new()
    $byTitle = @{}
    foreach ($id in $ids) {
        if ($titleKey[$id] -eq '') { continue }
        if (-not $byTitle.ContainsKey($titleKey[$id])) { $byTitle[$titleKey[$id]] = [System.Collections.Generic.List[string]]::new() }
        $byTitle[$titleKey[$id]].Add($id)
    }
    foreach ($members in $byTitle.Values) {
        if (@($members | ForEach-Object { $canonical[$_] } | Sort-Object -Unique).Count -lt 2) { continue }
        $sorted = [string[]]@($members); [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
        $collisions.Add($sorted)
    }
    $ordered = [object[]]@($collisions.ToArray())
    [Array]::Sort($ordered, [System.Comparison[object]] { param($x, $y) [string]::CompareOrdinal($x[0], $y[0]) })

    [pscustomobject]@{
        Canonical = $canonical; TitleCollisions = $ordered; UrlConflicts = [object[]]$urlConflicts.ToArray()
        Resolved = $resolved; Selectable = [string[]]$selectable.ToArray(); DuplicateOfErrors = [object[]]$markErrors.ToArray()
    }
}
