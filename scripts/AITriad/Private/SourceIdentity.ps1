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

    if ($null -eq $Metadata) { return @() }
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
    Returns @{ docId = canonicalDocId } for a set of documents (spec section 4).
.DESCRIPTION
    Each document is @{ Id; Metadata }, where Metadata may carry title, url, resolved_url,
    provenance, content_sha256, same_as and parent_doc_id. Every tier contributes edges; the
    canonical id of a document is the ordinal-smallest id in its connected component.
#>
function Get-SourceCanonicalIdMap {
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][object[]]$Documents)

    $ids = [System.Collections.Generic.List[string]]::new()
    $meta = @{}
    foreach ($d in $Documents) { $ids.Add([string]$d.Id); $meta[[string]$d.Id] = $d.Metadata }
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

    foreach ($id in $ids) {
        $m = $meta[$id]
        foreach ($link in 'parent_doc_id', 'same_as') {                         # 4.1
            $target = & $prop $m $link
            if ($target -and $known.Contains($target)) { & $union $id $target }
        }
        & $addKey 'hash' (& $prop $m 'content_sha256') $id                     # 4.2
        foreach ($u in @(Get-TrustedSourceUrlKey -Metadata $m)) { & $addKey 'url' $u $id }   # 4.3
        $sm = [regex]::Match($id, '^(.+)-(\d+)$')                               # 4.4
        if ($sm.Success -and $known.Contains($sm.Groups[1].Value)) { & $union $id $sm.Groups[1].Value }
        $title = & $prop $m 'title'                                             # 4.5
        & $addKey 'title' (ConvertTo-SourceTitleKey -Title $(if ($title) { $title } else { $id })) $id
    }

    $out = @{}
    foreach ($id in $ids) { $out[$id] = & $find $id }
    $out
}
