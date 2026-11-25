# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Evidence union across a duplicate group: docs/specs/source-identity.md section 7, fixture
# tests/fixtures/evidence-union-cases.json (t/4337#60, SO e/347#2). Pure functions with no I/O.
# The TS implementation in lib/ asserts the same fixture; change the spec and fixture first.

# 7.2 step 1, applied before NFKC (NFKC turns U+00AA into 'a'). Variant B sequences before the
# variant A singles, because the sequences contain U+00F4 and U+00F6. Ordered (from, to) pairs, not
# hashtables: PowerShell hashtable keys are case-insensitive, so 'ΓÇÖ' (U+00D6) and 'ΓÇö' (U+00F6),
# or 'Æ' and 'æ', would collide. String.Replace is ordinal, so each pair matches case-exactly.
$script:EvidenceMojibakeSequences = @(
    , @(([string][char]0x393 + [char]0xC7 + [char]0xD6), "'")    # right single quote
    , @(([string][char]0x393 + [char]0xC7 + [char]0xFF), "'")    # left single quote
    , @(([string][char]0x393 + [char]0xC7 + [char]0xA3), '"')    # left double quote
    , @(([string][char]0x393 + [char]0xC7 + [char]0xA5), '"')    # right double quote
    , @(([string][char]0x393 + [char]0xC7 + [char]0xF4), '-')    # en dash
    , @(([string][char]0x393 + [char]0xC7 + [char]0xF6), '-')    # em dash
    , @(([string][char]0x393 + [char]0xC7 + [char]0xAA), '...')  # ellipsis
)
$script:EvidenceMojibakeSingles = @(
    , @([string][char]0xC6, "'"); , @([string][char]0xE6, "'")   # AE, ae
    , @([string][char]0xF4, '"'); , @([string][char]0xF6, '"')   # o-circumflex, o-diaeresis
    , @([string][char]0xFB, '-'); , @([string][char]0xF9, '-')   # u-circumflex, u-grave
)
$script:EvidenceTypography = @(
    , @([string][char]0x2018, "'"); , @([string][char]0x2019, "'")
    , @([string][char]0x201C, '"'); , @([string][char]0x201D, '"')
    , @([string][char]0x2013, '-'); , @([string][char]0x2014, '-')
)

function ConvertTo-EvidenceKey {
    <#
    .SYNOPSIS
        The de-duplication key of a quote (spec 7.2). Used only to compare quotes, never shown.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Quote)
    if ([string]::IsNullOrEmpty($Quote)) { return '' }
    $s = $Quote
    foreach ($p in $script:EvidenceMojibakeSequences) { $s = $s.Replace($p[0], $p[1]) }
    foreach ($p in $script:EvidenceMojibakeSingles) { $s = $s.Replace($p[0], $p[1]) }
    $s = $s.Normalize([System.Text.NormalizationForm]::FormKC)
    foreach ($p in $script:EvidenceTypography) { $s = $s.Replace($p[0], $p[1]) }
    $s = $s.ToLowerInvariant()
    $s = [regex]::Replace($s, '[^\p{L}\p{Nd}]', ' ')
    [regex]::Replace($s, ' +', ' ').Trim()
}

function Get-EvidenceLevenshtein {
    # Unit-cost edit distance over UTF-16 code units (spec 7.3 arm 3).
    param([string]$A, [string]$B)
    $la = $A.Length; $lb = $B.Length
    if ($la -eq 0) { return $lb }
    if ($lb -eq 0) { return $la }
    $prev = [int[]]::new($lb + 1); $cur = [int[]]::new($lb + 1)
    for ($j = 0; $j -le $lb; $j++) { $prev[$j] = $j }
    for ($i = 1; $i -le $la; $i++) {
        $cur[0] = $i; $ca = $A[$i - 1]
        for ($j = 1; $j -le $lb; $j++) {
            $cost = if ($ca -ceq $B[$j - 1]) { 0 } else { 1 }
            $v = $prev[$j] + 1
            if ($cur[$j - 1] + 1 -lt $v) { $v = $cur[$j - 1] + 1 }
            if ($prev[$j - 1] + $cost -lt $v) { $v = $prev[$j - 1] + $cost }
            $cur[$j] = $v
        }
        $t = $prev; $prev = $cur; $cur = $t
    }
    $prev[$lb]
}

function Test-EvidenceNearEqual {
    <#
    .SYNOPSIS
        Spec 7.3: are two de-duplication keys near-equal? Integer thresholds only.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
    if ([string]::IsNullOrEmpty($A) -or [string]::IsNullOrEmpty($B)) { return $false }
    if ($A -ceq $B -or $A.Contains($B, [StringComparison]::Ordinal) -or $B.Contains($A, [StringComparison]::Ordinal)) { return $true }
    $ta = [System.Collections.Generic.HashSet[string]]::new([string[]]$A.Split(' '), [StringComparer]::Ordinal)
    $tb = [System.Collections.Generic.HashSet[string]]::new([string[]]$B.Split(' '), [StringComparer]::Ordinal)
    $inter = 0; foreach ($t in $ta) { if ($tb.Contains($t)) { $inter++ } }
    $union = $ta.Count + $tb.Count - $inter
    if (5 * $inter -ge 4 * $union) { return $true }
    $m = [Math]::Max($A.Length, $B.Length)
    # Exact shortcut: lev >= |len(a) - len(b)|, so if even that bound fails the threshold, skip the DP.
    if (20 * ($m - [Math]::Abs($A.Length - $B.Length)) -lt 17 * $m) { return $false }
    20 * ($m - (Get-EvidenceLevenshtein -A $A -B $B)) -ge 17 * $m
}

function Get-SummaryEvidenceLink {
    <#
    .SYNOPSIS
        Spec 7.1: the (node, quote) links of one summary, in file order.
    .OUTPUTS
        One [pscustomobject] { node; field; quote } per link.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowNull()]$Summary)
    Set-StrictMode -Version Latest
    if ($null -eq $Summary) { return }
    $prop = { param($o, $n) if ($null -ne $o -and $o.PSObject.Properties[$n]) { $o.$n } else { $null } }
    $firstText = {
        param($o, [string[]]$names)
        foreach ($n in $names) { $v = & $prop $o $n; if ($v -is [string] -and -not [string]::IsNullOrWhiteSpace($v)) { return $v } }
        ''
    }
    $isNode = { param($v) $v -is [string] -and $v.Length -gt 0 }

    $povs = & $prop $Summary 'pov_summaries'
    if ($null -ne $povs) {
        foreach ($p in $povs.PSObject.Properties) {
            foreach ($kp in @(& $prop $p.Value 'key_points')) {
                if ($null -eq $kp) { continue }
                $n = & $prop $kp 'taxonomy_node_id'
                if (& $isNode $n) { [pscustomobject]@{ node = $n; field = 'key_point'; quote = (& $firstText $kp @('verbatim', 'point')) } }
            }
        }
    }
    foreach ($fc in @(& $prop $Summary 'factual_claims')) {
        if ($null -eq $fc) { continue }
        $q = & $firstText $fc @('claim')
        foreach ($f in 'linked_taxonomy_nodes', 'potential_taxonomy_nodes') {
            foreach ($n in @(& $prop $fc $f)) { if (& $isNode $n) { [pscustomobject]@{ node = $n; field = 'factual_claim'; quote = $q } } }
        }
    }
    foreach ($uc in @(& $prop $Summary 'unmapped_concepts')) {
        if ($null -eq $uc) { continue }
        $n = & $prop $uc 'resolved_node_id'
        if (& $isNode $n) {
            [pscustomobject]@{ node = $n; field = 'unmapped_concept'; quote = (& $firstText $uc @('verbatim', 'suggested_description', 'description', 'concept', 'suggested_label')) }
        }
    }
}

function Get-EvidenceChunkBase {
    <#
    .SYNOPSIS
        Spec 6.2 (t/355, R1): the base X when $Id is a summary-only chunk <X>-N of X, else $null.
    .PARAMETER Docs
        id -> [pscustomobject] { HasSource = [bool]; Mark = <target id or $null> }.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][hashtable]$Docs)
    Set-StrictMode -Version Latest
    $m = [regex]::Match($Id, '^(.+)-(\d+)$')
    if (-not $m.Success) { return $null }
    if ($Docs.ContainsKey($Id) -and $Docs[$Id].HasSource) { return $null }
    $base = $m.Groups[1].Value
    if ($Docs.ContainsKey($base) -and $Docs[$base].HasSource) { return $base }
    $null
}

function Get-EvidenceValidMark {
    <#
    .SYNOPSIS
        The target of $Id's mark when it names another document in $Docs, else $null (spec 6.1).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][hashtable]$Docs)
    Set-StrictMode -Version Latest
    if (-not $Docs.ContainsKey($Id)) { return $null }
    $target = $Docs[$Id].Mark
    if ($target -is [string] -and $target.Length -gt 0 -and $target -cne $Id -and $Docs.ContainsKey($target)) { return $target }
    $null
}

function Resolve-EvidenceDocId {
    <#
    .SYNOPSIS
        Spec 6.2 (t/355, R1, transitive): the document a summary id resolves to. A valid mark, or a chunk's
        base, is followed to the end. A cycle is an error.
    .PARAMETER Docs
        id -> [pscustomobject] { HasSource = [bool]; Mark = <target id or $null> }.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][hashtable]$Docs, [string[]]$Seen = @())
    Set-StrictMode -Version Latest
    if ($Seen -contains $Id) {
        New-ActionableError -Goal 'Resolve the evidence document for a summary id' `
            -Problem "The mark or chunk chain loops back to '$Id'." `
            -Location 'EvidenceUnion.ps1: Resolve-EvidenceDocId' `
            -NextSteps @('Remove or correct one mark in the loop (spec 6.1)', 'Check that no chunk names its own copy as its base')
    }
    $target = Get-EvidenceValidMark -Id $Id -Docs $Docs
    if ($target) { return (Resolve-EvidenceDocId -Id $target -Docs $Docs -Seen (@($Seen) + $Id)) }
    $base = Get-EvidenceChunkBase -Id $Id -Docs $Docs
    if ($base) { return (Resolve-EvidenceDocId -Id $base -Docs $Docs -Seen (@($Seen) + $Id)) }
    $Id
}

function Get-EvidenceGroupMembers {
    <#
    .SYNOPSIS
        Spec 7.1 (t/355, R2): the group of a canonical as ordered members { Id; Kind; Via }.
        Order: marked copies by ordinal id, then D's own chunks, then each copy's chunks, each by N ascending.
        Kind is 'copy', 'chunk_D' (a chunk of the canonical) or 'chunk_copy' (a chunk of a marked copy; Via = that copy).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param([Parameter(Mandatory)][string]$Canonical, [Parameter(Mandatory)][hashtable]$Docs)
    Set-StrictMode -Version Latest
    $ids = [string[]]@($Docs.Keys | Where-Object { $_ -cne $Canonical })
    [Array]::Sort($ids, [StringComparer]::Ordinal)
    $copies = [string[]]@($ids | Where-Object {
            $null -eq (Get-EvidenceChunkBase -Id $_ -Docs $Docs) -and
            (Get-EvidenceValidMark -Id $_ -Docs $Docs) -and
            (Resolve-EvidenceDocId -Id $_ -Docs $Docs) -ceq $Canonical })
    $byN = {
        param($list)
        @($list | Sort-Object -Property @{ Expression = { [int64]([regex]::Match($_, '(\d+)$').Groups[1].Value) } }, @{ Expression = { $_ } })
    }
    $out = [System.Collections.Generic.List[pscustomobject]]::new()
    foreach ($c in $copies) { $out.Add([pscustomobject]@{ Id = $c; Kind = 'copy'; Via = $null }) }
    $own = [string[]]@($ids | Where-Object { (Get-EvidenceChunkBase -Id $_ -Docs $Docs) -ceq $Canonical })
    foreach ($k in (& $byN $own)) { $out.Add([pscustomobject]@{ Id = $k; Kind = 'chunk_D'; Via = $null }) }
    foreach ($c in $copies) {
        $kids = [string[]]@($ids | Where-Object { (Get-EvidenceChunkBase -Id $_ -Docs $Docs) -ceq $c })
        foreach ($k in (& $byN $kids)) { $out.Add([pscustomobject]@{ Id = $k; Kind = 'chunk_copy'; Via = $c }) }
    }
    $out.ToArray()
}

function Merge-GroupEvidence {
    <#
    .SYNOPSIS
        Spec 7.4: the de-duplicated union of a duplicate group's links, attributed to the canonical.
    .PARAMETER CanonicalId
        The group's canonical document id.
    .PARAMETER Members
        The group's members, in any order: @{ Id = <exact id>; Links = <Get-SummaryEvidenceLink
        output> }. They're put in spec 7.1 order here (the canonical first, then the marked members
        by ordinal id), so a caller can't change which copy's quote survives by passing them unsorted.
    .OUTPUTS
        An ordered dictionary: node -> list of { node; field; quote; doc; via; payload } (via only on
        links kept from a marked member; payload only when the input link carried one).
    #>
    [CmdletBinding()]
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory)][string]$CanonicalId,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Members
    )
    Set-StrictMode -Version Latest
    $canonicalMembers = @($Members | Where-Object { $_.Id -ceq $CanonicalId })
    $others = [object[]]@($Members | Where-Object { $_.Id -cne $CanonicalId })
    # Spec 7.1 (t/355 R2): a member with no Kind is a marked copy. Copies sort by ordinal id; chunks keep the
    # order the caller gives them, which Get-EvidenceGroupMembers builds (D's own chunks, then each copy's, N ascending).
    $kindOf = { param($m) if ($m.PSObject.Properties['Kind'] -and $m.Kind) { [string]$m.Kind } else { 'copy' } }
    $copies = [object[]]@($others | Where-Object { (& $kindOf $_) -eq 'copy' })
    $chunks = [object[]]@($others | Where-Object { (& $kindOf $_) -ne 'copy' })
    $ids = [string[]]@(foreach ($m in $copies) { [string]$m.Id })
    # The casts select the non-generic Array.Sort(Array, Array, IComparer). Without them PowerShell
    # binds Sort<TKey,TValue>, converts $copies into a copy, and sorts only the keys.
    [Array]::Sort([Array]$ids, [Array]$copies, [System.Collections.IComparer][StringComparer]::Ordinal)
    $marked = [object[]]@($copies + $chunks)
    $out = [ordered]@{}; $keys = @{}
    foreach ($m in $canonicalMembers + $marked) {
        $own = $m.Id -ceq $CanonicalId
        $kind = & $kindOf $m
        foreach ($l in @($m.Links)) {
            if ($null -eq $l) { continue }
            $n = [string]$l.node; $k = ConvertTo-EvidenceKey -Quote ([string]$l.quote)
            if (-not $out.Contains($n)) { $out[$n] = [System.Collections.Generic.List[object]]::new(); $keys[$n] = [System.Collections.Generic.List[string]]::new() }
            if (-not $own) {
                $dup = $false
                foreach ($kk in $keys[$n]) { if (Test-EvidenceNearEqual -A $k -B $kk) { $dup = $true; break } }
                if ($dup) { continue }
            }
            $entry = [ordered]@{ node = $n; field = [string]$l.field; quote = [string]$l.quote; doc = $CanonicalId }
            # Attribution (t/355 R3): a copy's link is via the copy; a chunk of the canonical is chunk_of the chunk;
            # a chunk of a marked copy is via that copy, never chunk_of.
            if ($kind -eq 'copy' -and -not $own) { $entry['via'] = [string]$m.Id }
            elseif ($kind -eq 'chunk_D') { $entry['chunk_of'] = [string]$m.Id }
            elseif ($kind -eq 'chunk_copy') { $entry['via'] = [string]$m.Via }
            # N2 (t/355, 7.6a): a kept chunk item carries the chunk summary's own provenance when it is known.
            if ($kind -like 'chunk_*') {
                if ($m.PSObject.Properties['ChunkGeneratedAt'] -and $m.ChunkGeneratedAt) { $entry['chunk_generated_at'] = [string]$m.ChunkGeneratedAt }
                if ($m.PSObject.Properties['ChunkModel'] -and $m.ChunkModel) { $entry['chunk_model'] = [string]$m.ChunkModel }
            }
            # A caller's own record for the link (e.g. a source-index entry), carried through untouched.
            if ($l.PSObject.Properties['payload']) { $entry['payload'] = $l.payload }
            $out[$n].Add([pscustomobject]$entry); $keys[$n].Add($k)
        }
    }
    $out
}
