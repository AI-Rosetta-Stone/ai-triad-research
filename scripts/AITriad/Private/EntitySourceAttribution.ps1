# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Per-entity source attribution (t/4404, design v2 at t/4404#6, CL decisions t/4404#8).
# An entity's source_refs used to be the batch-level doc list of the node it was proposed from, so 360 of 465
# entities shared one of 95 identical lists. Now each doc in source_refs is attributed, and its basis recorded:
#   1. quote-attributed  the docs whose facts contain the proposal's stored supporting quote;
#   2. mention-verified  the other docs in the list whose snapshot names the entity (strict whole-word name
#                        or alias, CL #8: the rule hand-checked 19/20 correct at #4);
#   3. only when 1 and 2 are both empty, for new entities without a usable quote:
#      mention-verified-loose (a name's content words, at least 2 of them, all within a 6-token window), then
#      summary-mention (the strict match against the doc's summary text);
#      STIPULATED parameters (specified t/4404#4, measured #5, hand-checked by the CL at #10: loose 6/7,
#      summary 6/6): the 6-token window, and content tokens = more than 3 characters, at least 2 per name.
#   4. otherwise none-matched, with an empty list (CL #4); the status says so explicitly (CL #8).
# Pairs only ever come from the CURRENT list: nothing is added from outside it. Ids stay exact as found
# (spec 6.4, CL #8); consumers resolve to the canonical at read time.
# Text comparisons use the spec 7.2 key (ConvertTo-EvidenceKey: t/4394 repair, NFKC, typography fold,
# casefold, letters and digits as words).

$script:AttributionStopWords = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
    'the', 'of', 'and', 'a', 'an', 'in', 'on', 'for', 'to', 'at', 'by', 's', 'de', 'la', 'le', 'von', 'van'), [StringComparer]::Ordinal)

function Get-AttributionTokenForms {
    # The forms a token may take across singular and plural: itself, without a final s, without a final es,
    # and ies -> y. Comparing form SETS makes the match symmetric (release <-> releases, policy <-> policies;
    # CL review of #3743, fix 3), where a one-way fold missed in both directions.
    param([string]$Token)
    $forms = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    [void]$forms.Add($Token)
    if ($Token.Length -gt 3 -and $Token.EndsWith('s') -and -not $Token.EndsWith('ss')) { [void]$forms.Add($Token.Substring(0, $Token.Length - 1)) }
    if ($Token.Length -gt 4 -and $Token.EndsWith('es')) { [void]$forms.Add($Token.Substring(0, $Token.Length - 2)) }
    if ($Token.Length -gt 4 -and $Token.EndsWith('ies')) { [void]$forms.Add($Token.Substring(0, $Token.Length - 3) + 'y') }
    , $forms
}

function Test-AttributionQuoteMatch {
    # The quote occurs in the claim as whole words; or, for a claim of at least 4 tokens, the claim occurs in
    # the quote as whole words. Padding stops a short key matching inside a word ("ai" in "said"; CL review of
    # #3743, fix 1); the length floor stops a short claim matching inside a long quote.
    param([string]$ClaimKey, [string]$QuoteKey)
    if (-not $ClaimKey -or -not $QuoteKey) { return $false }
    if ((' ' + $ClaimKey + ' ').Contains(' ' + $QuoteKey + ' ')) { return $true }
    (@($ClaimKey -split ' ' | Where-Object { $_ }).Count -ge 4) -and (' ' + $QuoteKey + ' ').Contains(' ' + $ClaimKey + ' ')
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
    # A name's content tokens (more than 3 characters, stop words dropped; at least 2 of them) all occur, in any
    # singular/plural form, within a 6-token window. The >3-character floor is the rule specified at t/4404#4
    # (CL review of #3743, fix 2): "AI+ plan" keys to one content token, so it no longer matches "AI Action Plan".
    param([string]$TextKey, [string[]]$NameKeys)
    if (-not $TextKey) { return $false }
    $toks = [string[]]@($TextKey -split ' ' | Where-Object { $_ })
    $tokForms = @(foreach ($t in $toks) { , (Get-AttributionTokenForms $t) })
    foreach ($k in $NameKeys) {
        $want = [string[]]@($k -split ' ' | Where-Object { $_ -and $_.Length -gt 3 -and -not $script:AttributionStopWords.Contains($_) } | Select-Object -Unique)
        if ($want.Count -lt 2) { continue }
        $wantForms = @(foreach ($w in $want) { , (Get-AttributionTokenForms $w) })
        for ($i = 0; $i -lt $toks.Count; $i++) {
            $end = [Math]::Min($toks.Count, $i + 6)
            $window = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            for ($j = $i; $j -lt $end; $j++) { $window.UnionWith($tokForms[$j]) }
            $all = $true
            foreach ($wf in $wantForms) { if (-not $window.Overlaps($wf)) { $all = $false; break } }
            if ($all) { return $true }
        }
    }
    $false
}

function Get-AttributionFactValue {
    # Read a field from a fact that may be a hashtable or an object.
    param($Fact, [string]$Key)
    if ($Fact -is [System.Collections.IDictionary]) { return [string]$Fact[$Key] }
    [string]$Fact.$Key
}

function Add-AttributionQuoteBasis {
    # Step 1: mark listed docs whose fact claim matches a stored quote. Mutates $Basis in place.
    param($Facts, $InList, [string[]]$QuoteKeys, $Basis)
    foreach ($f in $Facts) {
        $doc = Get-AttributionFactValue -Fact $f -Key 'doc_id'
        $claim = Get-AttributionFactValue -Fact $f -Key 'claim'
        if (-not $doc -or -not $InList.Contains($doc) -or $Basis.Contains($doc)) { continue }
        $ck = ConvertTo-EvidenceKey -Quote $claim
        if (-not $ck) { continue }
        foreach ($q in $QuoteKeys) { if (Test-AttributionQuoteMatch -ClaimKey $ck -QuoteKey $q) { $Basis[$doc] = 'quote-attributed'; break } }
    }
}

function Add-AttributionMentionBasis {
    # Step 2: mark listed docs not already attributed whose snapshot names the entity. Fills $SnapKey and
    # mutates $Basis in place.
    param($Candidates, $GetSnapshotText, [string[]]$NameKeys, $Basis, $SnapKey)
    foreach ($d in $Candidates) {
        if ($Basis.Contains($d)) { continue }
        $t = & $GetSnapshotText $d
        $SnapKey[$d] = if ($t) { ConvertTo-EvidenceKey -Quote ([string]$t) } else { '' }
        if (Test-AttributionStrictMention -TextKey $SnapKey[$d] -NameKeys $NameKeys) { $Basis[$d] = 'mention-verified' }
    }
}

function Add-AttributionRecallBasis {
    # Step 3: recall steps (loose mention, then summary mention), only when steps 1 and 2 found nothing.
    # Mutates $Basis in place.
    param($Candidates, $GetSummaryText, [string[]]$NameKeys, $Basis, $SnapKey)
    if ($Basis.Count -eq 0) {
        foreach ($d in $Candidates) {
            if (Test-AttributionLooseMention -TextKey $SnapKey[$d] -NameKeys $NameKeys) { $Basis[$d] = 'mention-verified-loose' }
        }
    }
    if ($Basis.Count -eq 0 -and $GetSummaryText) {
        foreach ($d in $Candidates) {
            $s = & $GetSummaryText $d
            if ($s -and (Test-AttributionStrictMention -TextKey (ConvertTo-EvidenceKey -Quote ([string]$s)) -NameKeys $NameKeys)) { $Basis[$d] = 'summary-mention' }
        }
    }
}

function ConvertTo-OrderedAttribution {
    # Order: quote-attributed docs first, then the rest, each ordinal.
    param($Basis)
    $ordered = [ordered]@{}
    foreach ($d in ($Basis.Keys | Where-Object { $Basis[$_] -eq 'quote-attributed' } | Sort-Object -CaseSensitive)) { $ordered[$d] = $Basis[$d] }
    foreach ($d in ($Basis.Keys | Where-Object { $Basis[$_] -ne 'quote-attributed' } | Sort-Object -CaseSensitive)) { $ordered[$d] = $Basis[$d] }
    $ordered
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
    $snapKey = @{}

    # 1. quote-attributed: a fact of a listed doc whose claim contains the quote (or is contained by it).
    Add-AttributionQuoteBasis -Facts $Facts -InList $inList -QuoteKeys $quoteKeys -Basis $basis

    # 2. mention-verified: the other listed docs whose snapshot names the entity.
    Add-AttributionMentionBasis -Candidates $candidates -GetSnapshotText $GetSnapshotText -NameKeys $nameKeys -Basis $basis -SnapKey $snapKey

    # 3. Recall steps, only when 1 and 2 found nothing.
    Add-AttributionRecallBasis -Candidates $candidates -GetSummaryText $GetSummaryText -NameKeys $nameKeys -Basis $basis -SnapKey $snapKey

    # Order: quote-attributed docs first, then the rest, each ordinal.
    $ordered = ConvertTo-OrderedAttribution -Basis $basis
    [pscustomobject]@{
        source_refs        = [string[]]@($ordered.Keys)
        source_refs_basis  = $ordered
        source_refs_status = if ($ordered.Count) { 'attributed' } else { 'none-matched' }
    }
}

function Add-AttributionKeyPointParts {
    # The key-point point + verbatim text across all POV summaries. Appends to $Parts in place.
    param($Summary, $Parts)
    if (-not ($Summary.PSObject.Properties['pov_summaries'] -and $Summary.pov_summaries)) { return }
    foreach ($pov in $Summary.pov_summaries.PSObject.Properties) {
        if ($null -eq $pov.Value -or -not $pov.Value.PSObject.Properties['key_points']) { continue }
        foreach ($kp in @($pov.Value.key_points)) {
            if (-not $kp) { continue }
            foreach ($f in 'point', 'verbatim') { if ($kp.PSObject.Properties[$f] -and $kp.$f) { $Parts.Add([string]$kp.$f) } }
        }
    }
}

function Add-AttributionClaimParts {
    # The factual_claims claim text. Appends to $Parts in place.
    param($Summary, $Parts)
    if (-not $Summary.PSObject.Properties['factual_claims']) { return }
    foreach ($fc in @($Summary.factual_claims)) { if ($fc -and $fc.PSObject.Properties['claim'] -and $fc.claim) { $Parts.Add([string]$fc.claim) } }
}

function Get-AttributionSummaryText {
    # The summary text Phase 1's mentions came from: key-point point + verbatim, and factual claims.
    param($Summary)
    if ($null -eq $Summary) { return $null }
    $parts = [System.Collections.Generic.List[string]]::new()
    Add-AttributionKeyPointParts -Summary $Summary -Parts $parts
    Add-AttributionClaimParts -Summary $Summary -Parts $parts
    $parts -join "`n"
}
