# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Per-entity source attribution (t/4404, design v2 at t/4404#6, CL decisions t/4404#8).
# An entity's source_refs used to be the batch-level doc list of the node it was proposed from, so 360 of 465
# entities shared one of 95 identical lists. Now each doc in source_refs is attributed, and its basis recorded:
#   1. quote-attributed  the docs whose facts contain the proposal's stored supporting quote;
#   2. mention-verified  the other docs in the list whose snapshot names the entity (strict whole-word name
#                        or alias, CL #8: the rule hand-checked 19/20 correct at #4);
#   3. only when 1 and 2 are both empty, for new entities without a usable quote:
#      mention-verified-loose (a multiword name's content words within a 6-token window), then
#      summary-mention (the strict match against the doc's summary text);
#   4. otherwise none-matched, with an empty list (CL #4); the status says so explicitly (CL #8).
# Pairs only ever come from the CURRENT list: nothing is added from outside it. Ids stay exact as found
# (spec 6.4, CL #8); consumers resolve to the canonical at read time.
# Text comparisons use the spec 7.2 key (ConvertTo-EvidenceKey: t/4394 repair, NFKC, typography fold,
# casefold, letters and digits as words).

$script:AttributionStopWords = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
    'the', 'of', 'and', 'a', 'an', 'in', 'on', 'for', 'to', 'at', 'by', 's', 'de', 'la', 'le', 'von', 'van'), [StringComparer]::Ordinal)

function ConvertTo-AttributionToken {
    # Plural folding, both sides (as measured at t/4404#5).
    param([string]$Token)
    if ($Token.Length -gt 4 -and $Token.EndsWith('ies')) { return $Token.Substring(0, $Token.Length - 3) + 'y' }
    if ($Token.Length -gt 4 -and $Token.EndsWith('es') -and 'sxz'.Contains($Token[$Token.Length - 3])) { return $Token.Substring(0, $Token.Length - 2) }
    if ($Token.Length -gt 3 -and $Token.EndsWith('s') -and -not $Token.EndsWith('ss')) { return $Token.Substring(0, $Token.Length - 1) }
    $Token
}

function Test-AttributionStrictMention {
    # True when any name key occurs as whole words in the text key.
    param([string]$TextKey, [string[]]$NameKeys)
    if (-not $TextKey) { return $false }
    $padded = ' ' + $TextKey + ' '
    foreach ($k in $NameKeys) { if ($k -and $padded.Contains(' ' + $k + ' ')) { return $true } }
    $false
}

function Test-AttributionLooseMention {
    # A multiword name's content tokens (plural-folded, stop words dropped) all occur within a 6-token window.
    param([string]$TextKey, [string[]]$NameKeys)
    if (-not $TextKey) { return $false }
    $toks = [string[]]@($TextKey -split ' ' | Where-Object { $_ } | ForEach-Object { ConvertTo-AttributionToken $_ })
    foreach ($k in $NameKeys) {
        $want = [string[]]@($k -split ' ' | Where-Object { $_ -and -not $script:AttributionStopWords.Contains($_) } | ForEach-Object { ConvertTo-AttributionToken $_ } | Select-Object -Unique)
        if (@($k -split ' ' | Where-Object { $_ }).Count -lt 2 -or $want.Count -eq 0) { continue }
        for ($i = 0; $i -lt $toks.Count; $i++) {
            $end = [Math]::Min($toks.Count, $i + 6)
            $window = [System.Collections.Generic.HashSet[string]]::new([string[]]$toks[$i..($end - 1)], [StringComparer]::Ordinal)
            if (@($want | Where-Object { -not $window.Contains($_) }).Count -eq 0) { return $true }
        }
    }
    $false
}

function Get-EntitySourceAttribution {
    <#
    .SYNOPSIS
        Attributes an entity to the docs it actually came from or is named in, within its current doc list.
    .PARAMETER Names
        The entity name and its aliases.
    .PARAMETER Quotes
        The stored supporting quote(s) the entity was proposed with (may be empty).
    .PARAMETER Facts
        The node's facts as @{ doc_id; claim } (selectable docs only), searched for the quote.
    .PARAMETER CandidateDocs
        The entity's current doc list. Every returned doc is from it.
    .PARAMETER GetSnapshotText
        { param($DocId) -> snapshot text or $null }.
    .PARAMETER GetSummaryText
        { param($DocId) -> summary text or $null } for the summary-mention step (optional).
    .OUTPUTS
        [pscustomobject] @{ source_refs = string[]; source_refs_basis = ordered{ doc -> basis }; source_refs_status }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Names,
        [AllowEmptyCollection()][string[]]$Quotes = @(),
        [AllowEmptyCollection()][object[]]$Facts = @(),
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$CandidateDocs,
        [Parameter(Mandatory)][scriptblock]$GetSnapshotText,
        [scriptblock]$GetSummaryText
    )
    Set-StrictMode -Version Latest
    $nameKeys = [string[]]@($Names | Where-Object { $_ } | ForEach-Object { ConvertTo-EvidenceKey -Quote ([string]$_) } | Where-Object { $_ } | Select-Object -Unique)
    $quoteKeys = [string[]]@($Quotes | Where-Object { $_ } | ForEach-Object { ConvertTo-EvidenceKey -Quote ([string]$_) } | Where-Object { $_ } | Select-Object -Unique)
    $candidates = [string[]]@($CandidateDocs | Where-Object { $_ } | Select-Object -Unique | Sort-Object -CaseSensitive)
    $inList = [System.Collections.Generic.HashSet[string]]::new($candidates, [StringComparer]::Ordinal)
    $basis = [ordered]@{}

    # 1. quote-attributed: a fact of a listed doc whose claim contains the quote (or is contained by it).
    foreach ($f in $Facts) {
        $doc = if ($f -is [System.Collections.IDictionary]) { [string]$f['doc_id'] } else { [string]$f.doc_id }
        $claim = if ($f -is [System.Collections.IDictionary]) { [string]$f['claim'] } else { [string]$f.claim }
        if (-not $doc -or -not $inList.Contains($doc) -or $basis.Contains($doc)) { continue }
        $ck = ConvertTo-EvidenceKey -Quote $claim
        if (-not $ck) { continue }
        foreach ($q in $quoteKeys) { if ($ck.Contains($q) -or $q.Contains($ck)) { $basis[$doc] = 'quote-attributed'; break } }
    }

    # 2. mention-verified: the other listed docs whose snapshot names the entity.
    $snapKey = @{}
    foreach ($d in $candidates) {
        if ($basis.Contains($d)) { continue }
        $t = & $GetSnapshotText $d
        $snapKey[$d] = if ($t) { ConvertTo-EvidenceKey -Quote ([string]$t) } else { '' }
        if (Test-AttributionStrictMention -TextKey $snapKey[$d] -NameKeys $nameKeys) { $basis[$d] = 'mention-verified' }
    }

    # 3. Recall steps, only when 1 and 2 found nothing.
    if ($basis.Count -eq 0) {
        foreach ($d in $candidates) {
            if (Test-AttributionLooseMention -TextKey $snapKey[$d] -NameKeys $nameKeys) { $basis[$d] = 'mention-verified-loose' }
        }
    }
    if ($basis.Count -eq 0 -and $GetSummaryText) {
        foreach ($d in $candidates) {
            $s = & $GetSummaryText $d
            if ($s -and (Test-AttributionStrictMention -TextKey (ConvertTo-EvidenceKey -Quote ([string]$s)) -NameKeys $nameKeys)) { $basis[$d] = 'summary-mention' }
        }
    }

    # Order: quote-attributed docs first, then the rest, each ordinal.
    $ordered = [ordered]@{}
    foreach ($d in ($basis.Keys | Where-Object { $basis[$_] -eq 'quote-attributed' } | Sort-Object -CaseSensitive)) { $ordered[$d] = $basis[$d] }
    foreach ($d in ($basis.Keys | Where-Object { $basis[$_] -ne 'quote-attributed' } | Sort-Object -CaseSensitive)) { $ordered[$d] = $basis[$d] }
    [pscustomobject]@{
        source_refs        = [string[]]@($ordered.Keys)
        source_refs_basis  = $ordered
        source_refs_status = if ($ordered.Count) { 'attributed' } else { 'none-matched' }
    }
}

function Get-AttributionSummaryText {
    # The summary text Phase 1's mentions came from: key-point point + verbatim, and factual claims.
    param($Summary)
    if ($null -eq $Summary) { return $null }
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($Summary.PSObject.Properties['pov_summaries'] -and $Summary.pov_summaries) {
        foreach ($pov in $Summary.pov_summaries.PSObject.Properties) {
            if ($null -eq $pov.Value -or -not $pov.Value.PSObject.Properties['key_points']) { continue }
            foreach ($kp in @($pov.Value.key_points)) {
                if (-not $kp) { continue }
                foreach ($f in 'point', 'verbatim') { if ($kp.PSObject.Properties[$f] -and $kp.$f) { $parts.Add([string]$kp.$f) } }
            }
        }
    }
    if ($Summary.PSObject.Properties['factual_claims']) {
        foreach ($fc in @($Summary.factual_claims)) { if ($fc -and $fc.PSObject.Properties['claim'] -and $fc.claim) { $parts.Add([string]$fc.claim) } }
    }
    $parts -join "`n"
}
