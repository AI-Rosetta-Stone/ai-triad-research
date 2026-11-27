# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Steps of Finalize-Summary (Invoke-DocumentSummary.ps1), extracted for t/4136 PR B1 (plan t/3910#37):
# the schema normalization, stance normalization, hallucinated node-ID reroute, cross-camp check and
# the one shared "collect key_points across camps" loop. Behaviour-preserving: pinned byte for byte by
# tests/Finalize-Summary.Characterization.Tests.ps1. These are module-level functions (not nested in
# Finalize-Summary) so they resolve inside Invoke-BatchSummary's -Parallel runspaces. Strict mode is
# inherited from the caller's scope. Every input is a parameter: nothing here reads Finalize-Summary's
# locals through dynamic scope.

function Test-SummaryField($Obj, [string]$Name) {
    # True when $Obj (an IDictionary or a PSCustomObject) has the member $Name.
    if ($Obj -is [System.Collections.IDictionary]) { return $Obj.Contains($Name) }
    if ($Obj.PSObject.Properties[$Name]) { return $true }
    return $false
}

function Get-SummaryField($Obj, [string]$Name) {
    # The member's value, or $null when the member is absent. The unary comma stops `return` from
    # enumerating it: an empty array comes back as an empty array ("present but empty"), not as $null,
    # and a one-element array stays an array (t/4079). A JSON null still comes back as $null.
    if ($Obj -is [System.Collections.IDictionary]) { return , $Obj[$Name] }
    $P = $Obj.PSObject.Properties[$Name]
    if ($P) { return , $P.Value }
    return $null
}

function Get-SummaryCampKeyPoints {
    # Every key_point across the three camps, in camp order then list order. -WithPov wraps each as
    # @{ KeyPoint = <kp>; POV = <camp> }. Camps that are missing, or whose key_points are absent or
    # empty, contribute nothing. Pure. Returns an array (never unrolled).
    param([object]$SummaryObject, [switch]$WithPov)
    $Items = [System.Collections.Generic.List[object]]::new()
    $PovSums = Get-SummaryField $SummaryObject 'pov_summaries'
    foreach ($Camp in $script:AITriadPovCamps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if (-not $CampData -or -not (Test-SummaryField $CampData 'key_points')) { continue }
        $KpList = Get-SummaryField $CampData 'key_points'
        if (-not $KpList) { continue }
        foreach ($kp in @($KpList)) {
            if ($WithPov) { [void]$Items.Add(@{ KeyPoint = $kp; POV = $Camp }) } else { [void]$Items.Add($kp) }
        }
    }
    return , $Items.ToArray()
}

function Repair-SummaryCampKeyPoints {
    # Force-array each camp's key_points (null/absent -> @() with a WARN, t/3434); a missing camp is
    # recorded in $SchemaErrors.
    param([object]$PovSums, [string]$Model, [System.Collections.Generic.List[string]]$SchemaErrors)
    foreach ($Camp in $script:AITriadPovCamps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if ($null -eq $CampData) {
            $SchemaErrors.Add("Missing camp in pov_summaries: $Camp")
            continue
        }
        $KP = Get-SummaryField $CampData 'key_points'
        if ($null -eq $KP) {
            # A camp with null/absent key_points is NOT a fatal schema error: only a missing
            # pov_summaries is. Normalize to @() like the sibling fields and WARN instead (t/3434).
            Write-Warning "pov_summaries.$Camp.key_points missing/null — defaulting to empty array (model=$Model)"
            $KP = @()
        }
        # Force-array: ConvertFrom-Json unwraps single-element arrays to scalars.
        $KP = @($KP)
        Repair-SummaryKeyPointFields -Camp $Camp -KeyPoints $KP
        if ($CampData -is [System.Collections.IDictionary]) { $CampData['key_points'] = $KP }
        elseif ($CampData.PSObject.Properties['key_points']) { $CampData.key_points = $KP }
        else { $CampData | Add-Member -NotePropertyName 'key_points' -NotePropertyValue $KP -Force }
    }
}

function Repair-SummaryKeyPointFields {
    # t/4079: every later step reads $kp.stance, $kp.taxonomy_node_id and $kp.point directly, which
    # throws under StrictMode when the model left one out. A key point missing any of them gets the
    # field added as $null, with a WARN naming the field and the camp. Downstream, a null stance
    # resolves to 'neutral', a null node ID counts as unmapped, and a null point gets the fallback label.
    param([string]$Camp, [object[]]$KeyPoints)
    for ($i = 0; $i -lt $KeyPoints.Count; $i++) {
        $kp = $KeyPoints[$i]
        if ($null -eq $kp) { continue }
        foreach ($Field in 'stance', 'taxonomy_node_id', 'point') {
            if (Test-SummaryField $kp $Field) { continue }
            Write-Warning "Finalize-Summary: pov_summaries.$Camp.key_points[$i] has no '$Field' field — defaulting it to null (t/4079)"
            if ($kp -is [System.Collections.IDictionary]) { $kp[$Field] = $null }
            else { $kp | Add-Member -NotePropertyName $Field -NotePropertyValue $null -Force }
        }
    }
}

function Repair-SummaryFactualClaims {
    # Force-array factual_claims; absent or null is a schema error.
    param([object]$SummaryObject, [System.Collections.Generic.List[string]]$SchemaErrors)
    $FC = $null
    if (Test-SummaryField $SummaryObject 'factual_claims') { $FC = Get-SummaryField $SummaryObject 'factual_claims' }
    if ($null -eq $FC) {
        $SchemaErrors.Add("Missing required field: factual_claims")
        return
    }
    # Force-array: ConvertFrom-Json unwraps single-element arrays to scalars. Write it back.
    $FC = @($FC)
    if ($SummaryObject -is [System.Collections.IDictionary]) { $SummaryObject['factual_claims'] = $FC }
    else { $SummaryObject.factual_claims = $FC }
    Repair-SummaryClaimDuplicateNodeIds -Claims $FC
}

function Repair-SummaryClaimDuplicateNodeIds {
    # One claim links a node once (t/292). A model that repeats an id in linked_taxonomy_nodes would
    # otherwise put the same fact under that node twice in source_evidence_index.json, which spec
    # source-identity 7.4 deliberately keeps ("including repeats"). Order-preserving; WARNs per claim.
    param([object[]]$Claims)
    for ($i = 0; $i -lt $Claims.Count; $i++) {
        $Claim = $Claims[$i]
        if ($null -eq $Claim -or -not (Test-SummaryField $Claim 'linked_taxonomy_nodes')) { continue }
        # Assign, then @(): Get-SummaryField returns `, $value`, so @(Get-SummaryField ...) would nest it.
        $Linked = Get-SummaryField $Claim 'linked_taxonomy_nodes'
        $Linked = @($Linked)
        $Seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
        $Unique = @($Linked | Where-Object { $null -eq $_ -or $_ -isnot [string] -or $Seen.Add($_) })
        if ($Unique.Count -eq $Linked.Count) { continue }
        Write-Warning "Finalize-Summary: factual_claims[$i] repeated $($Linked.Count - $Unique.Count) node id(s) in linked_taxonomy_nodes; kept the first of each (t/292)"
        if ($Claim -is [System.Collections.IDictionary]) { $Claim['linked_taxonomy_nodes'] = $Unique }
        else { $Claim.linked_taxonomy_nodes = $Unique }
    }
}

function ConvertTo-NumericGroundingKey {
    # A number's comparison key (t/375): thousands commas dropped, trailing '%' dropped, then the decimal
    # value in invariant form, so "4.0%" and "4" and "1,000" and "1000" compare equal. $null if not a number.
    param([string]$Token)
    $t = ($Token -replace ',', '').TrimEnd('%')
    $d = [decimal]0
    if (-not [decimal]::TryParse($t, [System.Globalization.NumberStyles]::Number, [cultureinfo]::InvariantCulture, [ref]$d)) { return $null }
    $d.ToString('G29', [cultureinfo]::InvariantCulture)
}

# t/384: four tightenings of the numeric guard, each behind a flag so it can be measured on its own
# against the corpus (CL's rule: a tightening that mostly adds false drops isn't worth adopting).
#   Percent:    a claim's "5%" must appear in percent form in the source ("5%", "5 percent", "5 per cent").
#   Scale:      "75K", "2.3 billion" and "1.2 trillion" are their full values, which a claim "75,000" can match.
#   LeadingDot: ".5" is 0.5, not 5, unless it follows a word's final full stop (a footnote marker).
#   Superscript: "10^26" is grounded by the concatenation "1026", which is how the PDF text reads.
# With every flag off, the keys are the t/375 keys.
# Defaults (CL's ruling on t/384 after reading every changed claim against its snapshot): Scale, LeadingDot and
# Superscript are ON; alone they drop no claim and keep 3, 8 and 2 that the t/375 keys dropped. Percent is OFF and
# its evaluation is closed as not met (4 of 10 correct drops against a bar of 9; a chart prints percent values as
# bare numbers, which a percent-aware rule cannot accept). If the matcher changes, CL re-reads the per-flag counts.
# Known limit of LeadingDot, accepted by CL: a section number that PDF text glues to the next word
# ("SectionB.3onextensions", "Wis.2d") reads as 0.3 or 0.2, because a letter follows the digits.
$script:NumericGroundingFeatures = @{ Percent = $false; Scale = $true; LeadingDot = $true; Superscript = $true }
$script:NumericScaleWords = @{ 'k' = 1e3; 'thousand' = 1e3; 'm' = 1e6; 'million' = 1e6; 'bn' = 1e9; 'b' = 1e9; 'billion' = 1e9; 'trillion' = 1e12; 'tn' = 1e12 }

# Number words the Percent rule reads before "percent" in a source (t/384#16). Longest first within Units,
# so "fourteen" is not read as "four".
$script:NumericWordUnits = [ordered]@{
    'seventeen' = 17; 'thirteen' = 13; 'fourteen' = 14; 'eighteen' = 18; 'nineteen' = 19; 'fifteen' = 15; 'sixteen' = 16
    'eleven' = 11; 'twelve' = 12; 'seven' = 7; 'eight' = 8; 'three' = 3; 'zero' = 0; 'four' = 4; 'five' = 5; 'nine' = 9
    'one' = 1; 'two' = 2; 'six' = 6; 'ten' = 10
}
$script:NumericWordTens = [ordered]@{ 'twenty' = 20; 'thirty' = 30; 'forty' = 40; 'fifty' = 50; 'sixty' = 60; 'seventy' = 70; 'eighty' = 80; 'ninety' = 90 }

function Get-NumericGroundingKeys {
    # Every number in $Text as a comparison key. A range ("0.5-0.7", "0.5–0.7") yields both endpoints,
    # because the regex matches each number on its own.
    param([string]$Text, [switch]$AsClaim)
    $keys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    if ([string]::IsNullOrEmpty($Text)) { return , $keys }
    $F = $script:NumericGroundingFeatures
    if (-not ($F.Percent -or $F.Scale -or $F.LeadingDot -or $F.Superscript)) {
        foreach ($m in [regex]::Matches($Text, '\d+(?:,\d{3})*(?:\.\d+)?%?')) {
            $k = ConvertTo-NumericGroundingKey -Token $m.Value
            if ($null -ne $k) { [void]$keys.Add($k) }
        }
        return , $keys
    }
    # With a flag on, a number that the flag's rule does not touch must key exactly as the merged guard
    # keys it (t/384#10): no word-boundary test before a number (PDF text glues "across1,000"), ".5" is
    # "5" unless LeadingDot is on, and "10^26" is "10" and "26" unless Superscript is on.
    # Percent, source side only (CL t/384#14): how a snapshot prints a percent figure. A claim is read as written.
    #   - a percent sign or a dash the converter damaged: "108 ù in legal" is 108%, "54û67%" and the three-
    #     character form of an en or em dash between two numbers are a range. Only next to a digit, because
    #     ù and û are also letters;
    #   - the sign up to three white-space characters after its number, a line break included ("5" / "%");
    #   - a range gives both ends the percent form: "9 to 14%", "54-67%", and "9to14%" as PDF text glues it.
    $SourcePercent = $F.Percent -and -not $AsClaim
    if ($SourcePercent) {
        $Text = [regex]::Replace($Text, '(?<=\d)[ \t]?ù(?!\p{L})', '%')
        $Text = [regex]::Replace($Text, '(?<=\d)(?:û|ΓÇ[ôö])(?=\d)', '-')
    }
    #   - the word "percent" up to three white-space characters after its number ("16" / "percent");
    #   - a whole number from zero to one hundred written as a word before "percent" ("twenty-five percent"),
    #     CL t/384#16. Only before the word or the sign: a number word anywhere else grounds nothing.
    $PercentSign = if ($SourcePercent) { '(\s{0,3}%)' } else { '(%)' }
    $PercentWord = if ($SourcePercent) { '\s{0,3}(percent|per\s?cent)\b' } else { '\s?(percent|per\s?cent)\b' }
    $Pattern = '(\d+(?:,\d{3})*(?:\.\d+)?|(?<!\d)\.\d+)(?:' + $PercentSign + '|' + $PercentWord + '|(?<=\d)(k|m|bn|b|tn)\b|\s(thousand|million|billion|trillion)\b|\^(\d+))?'
    if ($SourcePercent) {
        $Units = $script:NumericWordUnits; $Tens = $script:NumericWordTens
        $WordNumber = "\b(?:(?<h>(?:one|a)\s+hundred)|(?<t>$($Tens.Keys -join '|'))(?:[-\s](?<u>one|two|three|four|five|six|seven|eight|nine))?|(?<s>$($Units.Keys -join '|')))\s{0,3}(?:%|percent\b|per\s?cent\b)"
        foreach ($m in [regex]::Matches($Text, $WordNumber, 'IgnoreCase')) {
            $Value = if ($m.Groups['h'].Success) { 100 }
            elseif ($m.Groups['t'].Success) { $Tens[$m.Groups['t'].Value.ToLowerInvariant()] + $(if ($m.Groups['u'].Success) { $Units[$m.Groups['u'].Value.ToLowerInvariant()] } else { 0 }) }
            else { $Units[$m.Groups['s'].Value.ToLowerInvariant()] }
            [void]$keys.Add("$Value%")
        }
        $Number = '\d+(?:,\d{3})*(?:\.\d+)?'
        foreach ($m in [regex]::Matches($Text, "(?<![\d.])($Number)\s?(?:[-–—]|to)\s?$Number(?:\s{0,3}%|\s?(?:percent|per\s?cent)\b)", 'IgnoreCase')) {
            $First = ConvertTo-NumericGroundingKey -Token $m.Groups[1].Value
            if ($null -ne $First) { [void]$keys.Add("$First%") }
        }
    }
    # Superscript (CL t/384#21): a snapshot also prints the exponent as "10(^25)"; read it as "10^25".
    if ($F.Superscript) { $Text = [regex]::Replace($Text, '(?<=\d)\(\^(\d+)\)', '^$1') }
    foreach ($m in [regex]::Matches($Text, $Pattern, 'IgnoreCase')) {
        $Num = $m.Groups[1].Value
        # LeadingDot (CL t/384#21): digits after a word's final full stop are a footnote marker, not a decimal
        # ("intentionality.5", "race.43,44", "measure).14"), so they key as the merged guard keys them. They are
        # a figure only when a letter or a percent sign follows at once, as PDF text glues it ("achieves.74AUC").
        $IsDecimal = $F.LeadingDot -and $Num.StartsWith('.')
        if ($IsDecimal -and $m.Index -gt 0 -and $Text[$m.Index - 1] -match '[\p{L}\)\]"'']') {
            $After = $m.Groups[1].Index + $m.Groups[1].Length
            $IsDecimal = $After -lt $Text.Length -and $Text[$After] -match '[\p{L}%]'
        }
        $Base = ConvertTo-NumericGroundingKey -Token $(if (-not $Num.StartsWith('.')) { $Num } elseif ($IsDecimal) { '0' + $Num } else { $Num.Substring(1) })
        if ($null -eq $Base) { continue }
        $Pct = $m.Groups[2].Success -or $m.Groups[3].Success
        $Suffix = if ($m.Groups[4].Success) { $m.Groups[4].Value } elseif ($m.Groups[5].Success) { $m.Groups[5].Value } else { $null }
        $Exp = if ($m.Groups[6].Success) { $m.Groups[6].Value } else { $null }
        if ($Pct) {
            if ($F.Percent) {
                # A percent claim is keyed "5%" and grounded only by the percent form. A plain source "5" still grounds a plain claim.
                [void]$keys.Add("$Base%")
                if (-not $AsClaim) { [void]$keys.Add($Base) }
            } else { [void]$keys.Add($Base) }
            continue
        }
        if ($Suffix -and $F.Scale) {
            $Scale = $script:NumericScaleWords[$Suffix.ToLowerInvariant()]
            $FullKey = $null
            try {
                $Full = [decimal]::Parse($Num.Replace(',', ''), [cultureinfo]::InvariantCulture) * [decimal]$Scale
                $FullKey = $Full.ToString('G29', [cultureinfo]::InvariantCulture)
            }
            catch {
                # t/780: a scaled figure too large for a decimal is not grounded; it never throws out of the guard.
                Write-Warning "Finalize-Summary: numeric grounding could not scale '$($m.Value)' ($($_.Exception.Message)); the figure is treated as not grounded (t/780)"
            }
            if ($null -eq $FullKey) {
                # A claim keeps a key no source has, so the claim is not grounded; a source gets its plain number only.
                if ($AsClaim) { [void]$keys.Add("unscalable:$($m.Value)") } else { [void]$keys.Add($Base) }
                continue
            }
            if ($AsClaim) {
                # A claim "75K" is grounded by the source's full value or its plain number, either one.
                [void]$keys.Add("$FullKey|$Base")
            } else {
                # A source "75K" carries both its full value and its plain number.
                [void]$keys.Add($FullKey); [void]$keys.Add($Base)
            }
            continue
        }
        if ($Exp -and $F.Superscript) {
            $Concat = ConvertTo-NumericGroundingKey -Token (($Num.Replace(',', '')) + $Exp)
            if ($null -ne $Concat) { [void]$keys.Add($Concat) }
            # A claim "10^26" is grounded by "1026" alone; the source also keeps its parts.
            if (-not $AsClaim) { [void]$keys.Add($Base); [void]$keys.Add((ConvertTo-NumericGroundingKey -Token $Exp)) }
            continue
        }
        [void]$keys.Add($Base)
        if ($Exp) {
            # Superscript off: the exponent is a number of its own, as in the merged guard.
            $ExpKey = ConvertTo-NumericGroundingKey -Token $Exp
            if ($null -ne $ExpKey) { [void]$keys.Add($ExpKey) }
        }
    }
    , $keys
}

function Remove-NumericallyUngroundedClaims {
    # t/375: a factual claim whose numbers aren't in the source text was invented. This happens when a
    # PDF's text layer lacks the figures (rendered as images or glyphs): the snapshot reads "less than of
    # all work tasks" and the model fills in "5%". Any claim with a number absent from the snapshot is
    # dropped, with a WARN naming the missing number. The rule (any ungrounded number drops the claim) is
    # stipulated by CL (t/375). Returns the count dropped.
    param([object]$SummaryObject, [string]$SnapshotText, [string]$ThisDocId)
    if (-not (Test-SummaryField $SummaryObject 'factual_claims')) { return 0 }
    # Assign, then @(): Get-SummaryField returns `, $value`, so @(Get-SummaryField ...) would nest it.
    $claims = Get-SummaryField $SummaryObject 'factual_claims'
    $claims = @($claims)
    if ($claims.Count -eq 0) { return 0 }
    $grounded = Get-NumericGroundingKeys -Text $SnapshotText
    $kept = [System.Collections.Generic.List[object]]::new()
    $dropped = 0
    foreach ($c in $claims) {
        $text = ''
        if ($null -ne $c -and (Test-SummaryField $c 'claim')) { $text = [string](Get-SummaryField $c 'claim') }
        # Assign first: the function returns `, $keys`, so piping its call would pass the whole set as one item.
        $claimKeys = Get-NumericGroundingKeys -Text $text -AsClaim
        # A key "a|b" is grounded by either alternative (t/384 scale suffixes); every other key must be present.
        $missing = @($claimKeys | Where-Object {
            if ($_.Contains('|')) { -not (@($_.Split('|')) | Where-Object { $grounded.Contains($_) }) }
            else { -not $grounded.Contains($_) }
        })
        if ($missing.Count -gt 0) {
            $dropped++
            $preview = if ($text.Length -gt 100) { $text.Substring(0, 100) + '…' } else { $text }
            Write-Warning "Finalize-Summary: $ThisDocId dropped a factual claim whose number(s) [$($missing -join ', ')] are not in the snapshot (t/375): $preview"
            continue
        }
        $kept.Add($c)
    }
    if ($dropped -gt 0) {
        $arr = $kept.ToArray()
        if ($SummaryObject -is [System.Collections.IDictionary]) { $SummaryObject['factual_claims'] = $arr }
        else { $SummaryObject.factual_claims = $arr }
    }
    $dropped
}

function Repair-SummaryUnmappedConcepts {
    # Absent -> @(). Present -> force-array, drop bare nulls (t/3907 WARN), replace ID-shaped
    # suggested_labels (t/3915). Not a schema error either way.
    param([object]$SummaryObject, [string]$Model)
    if (-not (Test-SummaryField $SummaryObject 'unmapped_concepts')) {
        if ($SummaryObject -is [System.Collections.IDictionary]) { $SummaryObject['unmapped_concepts'] = @() }
        else { $SummaryObject | Add-Member -NotePropertyName 'unmapped_concepts' -NotePropertyValue @() -Force }
        return
    }
    # Force-array via @() directly (never `$UC = if (...) {@($UC)} else {@()}`): a 0-element array
    # captured by assignment from an if/else expression collapses to $null (t/3915). A bare null
    # becomes a single-null-element array, which the t/3907 filter below strips to empty.
    $UC = Get-SummaryField $SummaryObject 'unmapped_concepts'
    $UC = @($UC)
    # t/3907: drop bare-null elements, which a later StrictMode reader throws on.
    $NullUcCount = @($UC | Where-Object { $null -eq $_ }).Count
    if ($NullUcCount -gt 0) {
        Write-Warning "Finalize-Summary: dropped $NullUcCount null unmapped_concepts entry/entries (t/3907, model=$Model)"
        $UC = @($UC | Where-Object { $null -ne $_ })
    }
    # t/3915: suggested_label is a free-text display field; an ID-shaped value is junk.
    $IdShapedLabelCount = Repair-IdShapedSuggestedLabel -Concepts $UC -Model $Model
    if ($IdShapedLabelCount -gt 0) {
        Write-Host "  │  ⚠ ID-shaped suggested_label replaced: $IdShapedLabelCount" -ForegroundColor Yellow
    }
    if ($SummaryObject -is [System.Collections.IDictionary]) { $SummaryObject['unmapped_concepts'] = $UC }
    else { $SummaryObject.unmapped_concepts = $UC }
}

function Repair-SummarySchema {
    # Schema validation and normalization (Gap 3.4). Mutates $SummaryObject, prints each schema error
    # and returns the error list. The caller decides the early Success=$false return.
    param([object]$SummaryObject, [string]$Model)
    $SchemaErrors = [System.Collections.Generic.List[string]]::new()
    if (Test-SummaryField $SummaryObject 'pov_summaries') {
        Repair-SummaryCampKeyPoints -PovSums (Get-SummaryField $SummaryObject 'pov_summaries') -Model $Model -SchemaErrors $SchemaErrors
    } else {
        $SchemaErrors.Add("Missing required field: pov_summaries")
    }
    Repair-SummaryFactualClaims -SummaryObject $SummaryObject -SchemaErrors $SchemaErrors
    Repair-SummaryUnmappedConcepts -SummaryObject $SummaryObject -Model $Model
    foreach ($Err in $SchemaErrors) {
        Write-Host "  │  ✗ Schema: $Err" -ForegroundColor Red
    }
    return , $SchemaErrors
}

function Update-SummaryStances {
    # Normalizes every key_point's stance (Resolve-Stance) and counts the points and the unmapped ones.
    param([object]$SummaryObject)
    $Kps = Get-SummaryCampKeyPoints -SummaryObject $SummaryObject
    foreach ($kp in $Kps) {
        if ($kp.stance -notin $script:ValidStances) { $kp.stance = Resolve-Stance $kp.stance }
    }
    return @{
        TotalPoints = @($Kps).Count
        NullNodes   = @($Kps | Where-Object { $null -eq $_.taxonomy_node_id }).Count
    }
}

function Get-HallucinatedNodeFallbackLabel([object]$KeyPoint) {
    # t/3915: suggested_label must never be the dead node ID itself. Derive a short label from the point
    # text; the ID stays traceable in `reason`.
    if (-not $KeyPoint.point) { return 'Unresolved concept' }
    $LabelWords = @(($KeyPoint.point -split '\s+') | Where-Object { $_ } | Select-Object -First 8)
    return ($LabelWords -join ' ') + '...'
}

function Move-HallucinatedNodeIdsToUnmapped {
    # Validates taxonomy_node_id existence (Gap 3.1). A key_point whose node ID is not in the taxonomy
    # has it nulled and is appended to unmapped_concepts. Returns the "<camp>/<id>" list; the caller
    # counts each as one more unmapped point. Skipped when the node-ID set is unavailable.
    param([object]$SummaryObject)
    $InvalidNodeIds = [System.Collections.Generic.List[string]]::new()
    $NodeIdSet = Get-TaxonomyNodeIdSet
    if ($null -eq $NodeIdSet -or @($NodeIdSet).Count -le 0) { return , $InvalidNodeIds }
    foreach ($Item in (Get-SummaryCampKeyPoints -SummaryObject $SummaryObject -WithPov)) {
        $kp = $Item.KeyPoint
        # New output only: a superseded id is attributed to its survivor, with a WARN (t/4356, t/4430).
        if ($kp.taxonomy_node_id) { $kp.taxonomy_node_id = ConvertTo-SurvivorNodeId -Id ([string]$kp.taxonomy_node_id) -Context "Summary $($Item.POV) key_point" }
        if (-not $kp.taxonomy_node_id -or $NodeIdSet.Contains($kp.taxonomy_node_id)) { continue }
        $InvalidNodeIds.Add("$($Item.POV)/$($kp.taxonomy_node_id)")
        $BadId = $kp.taxonomy_node_id
        $kp.taxonomy_node_id = $null
        if (-not $SummaryObject.PSObject.Properties['unmapped_concepts']) {
            $SummaryObject | Add-Member -NotePropertyName 'unmapped_concepts' -NotePropertyValue @() -Force
        }
        $FallbackLabel = Get-HallucinatedNodeFallbackLabel $kp
        # Filter bare nulls before appending: @()-wrapping a $null unmapped_concepts would otherwise
        # prepend a [$null] entry ahead of the new one (t/3915, same quirk as t/3907).
        $ExistingUc = @(@($SummaryObject.unmapped_concepts) | Where-Object { $null -ne $_ })
        $SummaryObject.unmapped_concepts = $ExistingUc + @(
            [PSCustomObject]@{
                suggested_label = $FallbackLabel
                concept         = $kp.point
                reason          = "Hallucinated node ID '$BadId' not found in taxonomy — moved from $($Item.POV) key_points"
            }
        )
    }
    if ($InvalidNodeIds.Count -gt 0) {
        Write-Host "  │  ⚠ Hallucinated node IDs moved to unmapped: $($InvalidNodeIds -join ', ')" -ForegroundColor Yellow
    }
    return , $InvalidNodeIds
}

function Get-CrossCampAgreementWarnings {
    # Cross-camp consistency check (Gap 3.3): one warning per key_point whose node|stance pair was
    # first seen in a different camp. Pure.
    param([object]$SummaryObject)
    $NodeStanceMap = @{}
    $Warnings = [System.Collections.Generic.List[string]]::new()
    foreach ($Item in (Get-SummaryCampKeyPoints -SummaryObject $SummaryObject -WithPov)) {
        $kp = $Item.KeyPoint
        if (-not $kp.taxonomy_node_id) { continue }
        $Key = "$($kp.taxonomy_node_id)|$($kp.stance)"
        if (-not $NodeStanceMap.ContainsKey($Key)) { $NodeStanceMap[$Key] = $Item.POV; continue }
        $PriorCamp = $NodeStanceMap[$Key]
        if ($PriorCamp -ne $Item.POV) {
            $Warnings.Add("Cross-camp agreement: $PriorCamp + $($Item.POV) both '$($kp.stance)' on $($kp.taxonomy_node_id)")
        }
    }
    return , $Warnings
}

# -- t/4136 PR B2: enrichment passes, model_info, the summary document, its write and metadata.json --
# Same contract as above: module-level, every input a parameter. Each enrichment pass is called as a
# bare statement, so anything the underlying pass emits still reaches Finalize-Summary's output.

function Invoke-SummaryRetrievalConfidencePass {
    <#
    .SYNOPSIS
        Retrieval confidence pass (t/2288) over every key_point. Skipped without cached embeddings.
        Runs after hallucinated-ID nulling so only valid assignments get scored.
    #>
    param([object]$SummaryObject)
    if (-not ($script:CachedEmbeddings -and $script:CachedEmbeddings.Count -gt 0)) { return }
    # -WithPov (t/4478): Invoke-RetrievalConfidencePass needs each key_point's camp to scope
    # candidate retrieval to that POV.
    $AllKpsForConf = Get-SummaryCampKeyPoints -SummaryObject $SummaryObject -WithPov
    if ($AllKpsForConf.Count -gt 0) {
        Invoke-RetrievalConfidencePass -KeyPointItems $AllKpsForConf `
            -Threshold $script:RetrievalConfidenceThreshold
    }
}

function Invoke-SummaryPolarityGate {
    <#
    .SYNOPSIS
        Polarity/contradiction gate (t/2739 P1) over every key_point, plus its two-stage telemetry.
    .DESCRIPTION
        Runs after the confidence pass (retrieval_low_confidence populated). Asks the shared
        directional engine whether each aligned, high-topical-band key_point OPPOSES its ASSIGNED
        node's proposition; flips to strongly_opposed + stance_polarity_flag on 'opposes'
        (opposition-only; unresolved keeps). The residual that similarity + the prompt (t/2738)
        cannot catch.

        DIRECTIONAL POLARITY GATE — DISABLED BY DEFAULT (t/2896)
        WHY OFF: the gate's safety invariant ("false-demote structurally ~0") is FALSIFIED.
        deberta-v3-small false-flips genuine aligned agreements to strongly_opposed at NLI margins
        3.4–7.5 — an order of magnitude above the ~1.4 real-contradiction ceiling, so no τ_contra
        separates them (provably not tunable). Root cause is a model reasoning gap: it can't infer
        agency→loss (AI-gains-agency ⊨ humans-lose-oversight), which is the DOMINANT
        safetyist/skeptic claim shape — so the gate corrupts precisely where it fires most (CL
        diagnosis t/2896#1; TL [Decision] e/117#3).
        STATUS (t/2912): the gate is ACTIVE BY DEFAULT. The durable two-stage LLM-judge fix (t/2900)
        resolved the agency→loss false-demote — deberta proposes 'opposes' candidates, the
        gemini-3.1-pro-preview judge disposes (unanimous-opposes-to-flip @ temp 0.3; fail-safe
        unresolved/error → KEEP) — promoted after both-arms GV + a clean observe cycle (121 deberta
        FPs the judge rejected, 0 bad flips). Kill switch: -EnablePolarityGate:$false.
    #>
    param([object]$SummaryObject, [bool]$EnablePolarityGate)
    $PolarityKps = Get-SummaryCampKeyPoints -SummaryObject $SummaryObject -WithPov
    if ($PolarityKps.Count -le 0) { return }
    $PolarityCounts = Invoke-PolarityGatePass -KeyPoints $PolarityKps `
        -SkipDirectionalGate:(-not $EnablePolarityGate)
    if (-not ($EnablePolarityGate -and $PolarityCounts.gated -gt 0)) { return }
    # t/2900/t/2912 two-stage telemetry — emitted EVERY run so the judge's flip /
    # false-positive-kept / self-heal rates are observable in prod (TL GV condition t/2912#3).
    # judge_kept = deberta false-positives the judge rejected (the payoff); judge_flipped =
    # confirmed demotes; self_healed = prior false-flips auto-reverted.
    $polLine = "Polarity gate (two-stage): judge_flipped={0} judge_kept={1} self_healed={2} over {3} gated key_point(s), {4} deberta rep-pair(s)" -f `
        $PolarityCounts.judge_flipped, $PolarityCounts.judge_kept, $PolarityCounts.self_healed, $PolarityCounts.gated, $PolarityCounts.reps
    if ($PolarityCounts.judge_flipped -gt 0) { Write-Warn $polLine } else { Write-Info $polLine }
    # Silent-degradation detector: every claim-rep pair unresolved ⇒ the directional engine likely
    # failed for the whole run (fail-safe kept all mappings). Surface by default so a dead engine
    # does not pass unnoticed (TL GV t/2739#6).
    if ($PolarityCounts.reps -gt 0 -and $PolarityCounts.unresolved -eq $PolarityCounts.reps) {
        Write-Warn ("Polarity gate: all {0} claim-rep pair(s) over {1} gated key_point(s) unresolved — directional engine may be down (no inversion detection this run)" -f `
            $PolarityCounts.reps, $PolarityCounts.gated)
    }
}

function Invoke-SummaryMechanism5Pass {
    <#
    .SYNOPSIS
        Mechanism #5 per-key_point re-retrieval pass (t/2357). Skipped without cached embeddings.
    .DESCRIPTION
        Runs after the confidence pass so retrieval_low_confidence is populated. Flags key_points
        whose assigned node is retrieval_low_confidence OR absent from the attribution_text top-3,
        and surfaces per-key_point top-3 candidates for the t/2289 override path. Flag→surface ships
        unconditionally (zero regression risk). Auto-correct is a separate fast-follow.
    #>
    param([object]$SummaryObject)
    if (-not ($script:CachedEmbeddings -and $script:CachedEmbeddings.Count -gt 0)) { return }
    $AllKpsForM5 = Get-SummaryCampKeyPoints -SummaryObject $SummaryObject -WithPov
    if ($AllKpsForM5.Count -gt 0) {
        Invoke-Mechanism5RetrievalPass -KeyPointItems $AllKpsForM5
    }
}

function Invoke-SummaryExcludesVetoPass {
    <#
    .SYNOPSIS
        Excludes-veto pass (t/2286). Skipped without loaded taxonomy data. Runs after the confidence
        pass so retrieval_low_confidence is already present.
    #>
    param([object]$SummaryObject)
    if (-not ($script:TaxonomyData -and $script:TaxonomyData.Count -gt 0)) { return }
    $AllKpsForVeto = Get-SummaryCampKeyPoints -SummaryObject $SummaryObject
    if ($AllKpsForVeto.Count -le 0) { return }
    $VetoStats = Invoke-ExcludesVetoPass -KeyPoints $AllKpsForVeto
    if ($VetoStats.VetoCount -gt 0 -or $VetoStats.AmbiguousCount -gt 0) {
        Write-Host "  │  excludes-veto: $($VetoStats.VetoCount) vetoed, $($VetoStats.AmbiguousCount) ambiguous" -ForegroundColor DarkYellow
    }
}

# t/4742 (CL spec t/4600#6): mechanical post-check for the camp-bridge construction. Two rounds of
# prompt-wording bans (the single original phrase, then the named-surface-forms rewrite) did not move
# the measured off-tag stretched+unsupported share (t/4600#5) -- the model keeps writing a point as a
# claim ABOUT a camp's relationship to the content ("This aligns with the safetyist goal of...")
# instead of quoting what the document itself asserts. Code filters the output now, rather than asking
# the model to behave a third time.
$script:CampBridgePatterns = @(
    # 1. "from a(n) <camp>('s) perspective/lens/standpoint/view"
    "from an?\s+(accelerationists?|safetyists?|skeptics?)('s)?\s+(perspective|lens|standpoint|view)"
    # 2. "<camp>('s) would support/endorse/reject/interpret/view/argue/counter/see"
    "(accelerationists?|safetyists?|skeptics?)('s)?\s+would\s+(support|endorse|reject|interpret|view|argue|counter|see)"
    # 3. "<verb> (with) (the/a/broader) <camp>" -- "aligns with the X goal", "opposes the X reliance"
    #    (the backward/critique-framed case), "reinforces X positions"
    "(align(s|ing)?|support(s|ing)?|reflect(s|ing)?|reinforc(es|ing)?|underscor(es|ing)?|resonat(es|ing)?|match(es|ing)?|fit(s|ting)?|consistent|oppos(es|ing)?|contradict(s|ing)?|undermin(es|ing)?)\s*(with)?\s*(the|a|broader)?\s*(accelerationists?|safetyists?|skeptics?)"
    # 4. "this is/seems relevant to <camp> because"
    "this (is|seems) relevant to (accelerationists?|safetyists?|skeptics?)\s+because"
    # 5. "<camp> believe/counter/argue/contend/hold/maintain/claim/would"
    "(accelerationists?|safetyists?|skeptics?)\s+(believe|counter|argue|contend|hold|maintain|claim|would)"
    # 6. "does not engage with/propose/discuss/address <camp>" -- the degenerate non-point
    "does not (engage with|propose|discuss|address)\s+(accelerationists?|safetyists?|skeptics?)"
)

function Test-CampBridgeConstruction {
    <#
    .SYNOPSIS
        The matched substring if $Text names a camp as the subject of its own relationship to the
        content (t/4600#6), else $null.
    .DESCRIPTION
        Calibrated against CL's 90-item blind-labelled corpus (t/4600#6, analyses/t4603-camp-bridge):
        81% of off-tag bad (stretched+unsupported) items caught, 0% false positives on off-tag genuine
        items, vs. 6 of 30 on-tag items it would catch if applied there too (including 1 genuine) --
        which is why the caller scopes this to untagged camps only, never on-tag.
    #>
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    foreach ($Pattern in $script:CampBridgePatterns) {
        $Match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($Match.Success) { return $Match.Value }
    }
    return $null
}

function Invoke-SummaryCampBridgeFilter {
    <#
    .SYNOPSIS
        Drops untagged-camp key_points that bridge content to a camp by name, instead of quoting what
        the document itself asserts (t/4742, CL spec t/4600#6).
    .DESCRIPTION
        Scoped to camps NOT in the document's pov_tags. When pov_tags is empty, every camp counts as
        tagged -- same convention Test-SummaryDensity's shortfall check already uses -- so nothing is
        ever filtered for a document with no pov_tags at all.

        On a match the key_point is dropped before persistence, not flagged-and-kept: the whole point
        of this check is what reaches the debater prompt (t/4600#6), and a flag that still gets
        rendered doesn't reduce that exposure.
    .OUTPUTS
        Int: the number of key_points dropped, folded into model_info.camp_bridge_dropped (t/4479
        observability pattern).
    #>
    param([object]$SummaryObject, [string]$ThisDocId, [string[]]$PovTags = @())

    $Camps = $script:AITriadPovCamps
    $TaggedCamps = if ($PovTags -and @($PovTags).Count -gt 0) { @($PovTags | Where-Object { $Camps -contains $_ }) } else { @($Camps) }
    $UntaggedCamps = @($Camps | Where-Object { $TaggedCamps -notcontains $_ })
    if ($UntaggedCamps.Count -eq 0) { return 0 }

    $PovSums = Get-SummaryField $SummaryObject 'pov_summaries'
    if ($null -eq $PovSums) { return 0 }

    $Dropped = 0
    foreach ($Camp in $UntaggedCamps) {
        $CampData = Get-SummaryField $PovSums $Camp
        if (-not $CampData -or -not (Test-SummaryField $CampData 'key_points')) { continue }
        # Assign first, THEN @()-wrap the variable -- @(Get-SummaryField ...) directly wraps the
        # function's single protected-array pipeline output in a second array (nests one level,
        # t/4742 postmortem). Assigning first lets a single pipeline object unroll onto $KpList
        # transparently, so the later @() is a true no-op, matching Repair-SummaryCampKeyPoints.
        $KpList = Get-SummaryField $CampData 'key_points'
        if ($null -eq $KpList) { continue }
        $KpList = @($KpList)
        if ($KpList.Count -eq 0) { continue }

        $Kept = [System.Collections.Generic.List[object]]::new()
        $DroppedHere = 0
        foreach ($kp in $KpList) {
            $PointText = Get-SummaryField $kp 'point'
            $BridgeMatch = Test-CampBridgeConstruction -Text ([string]$PointText)
            if ($BridgeMatch) {
                $DroppedHere++
                Write-Warning "Finalize-Summary: dropped camp-bridge key_point (doc=$ThisDocId, camp=$Camp): '$BridgeMatch'"
                continue
            }
            $Kept.Add($kp)
        }
        if ($DroppedHere -le 0) { continue }
        $Dropped += $DroppedHere
        if ($CampData -is [System.Collections.IDictionary]) { $CampData['key_points'] = $Kept.ToArray() }
        else { $CampData.key_points = $Kept.ToArray() }
    }
    return $Dropped
}

function Resolve-SummaryUnmappedConcepts {
    <#
    .SYNOPSIS
        Cross-POV fuzzy match on unmapped concepts. Returns @{ Concepts; Count }: the remaining
        concepts and their count, or the inputs unchanged when nothing resolved or resolution threw.
    .DESCRIPTION
        Resolved concepts are printed and removed from $SummaryObject.unmapped_concepts. A failure is
        a fallback (every concept stays unmapped), so it is a WARN naming that condition (t/4079).
        On the single-call path Invoke-SummaryPipeline has already run one resolution pass, so its
        context_rot stage is folded into this one (Merge-UnmappedResolutionStage, t/4168).
    #>
    param([object]$SummaryObject, [object]$UnmappedConcs, [int]$UnmappedCount)
    $State = @{ Concepts = $UnmappedConcs; Count = $UnmappedCount }
    if ($UnmappedCount -le 0) { return $State }
    try {
        $Resolution = Resolve-UnmappedConcepts -UnmappedConcepts @($SummaryObject.unmapped_concepts)
        Merge-UnmappedResolutionStage
        if (@($Resolution.Resolved).Count -gt 0) {
            foreach ($R in @($Resolution.Resolved)) {
                Write-Host "  │  ✔ Resolved: '$($R.ConceptLabel)' → $($R.MatchedNodeId) (score $($R.Score))" -ForegroundColor Green
            }
            $Remaining = @($Resolution.Remaining)
            $State.Concepts = $Remaining
            if ($SummaryObject.PSObject.Properties['unmapped_concepts']) {
                $SummaryObject.unmapped_concepts = $Remaining
            } else {
                $SummaryObject | Add-Member -NotePropertyName 'unmapped_concepts' -NotePropertyValue $Remaining -Force
            }
            $State.Count = $Remaining.Count
        }
    }
    catch {
        Write-Warning "Finalize-Summary: unmapped concept resolution failed — keeping all $UnmappedCount unmapped concept(s) unresolved: $($_.Exception.Message)"
    }
    return $State
}

function Merge-UnmappedResolutionStage {
    <#
    .SYNOPSIS
        Folds every 'unmapped_resolution' context_rot stage into one, at the position of the last.
    .DESCRIPTION
        On the single-call path both Invoke-SummaryPipeline (Stage 6) and Finalize-Summary resolve
        unmapped concepts, and each Resolve-UnmappedConcepts call recorded a stage, so the summary's
        context_rot.stages listed unmapped_resolution twice (t/4168). Both passes still run: the second
        one sees concepts the first could not, those Move-HallucinatedNodeIdsToUnmapped rerouted and
        those whose ID-shaped label was replaced, so skipping it would change which concepts resolve.
        The one stage left describes resolution as a whole:
          in_count        = the first pass's input, plus the concepts added before each later pass
                            (a later pass's input minus the previous pass's output);
          out_count       = still unmapped after the last pass;
          resolved_count  = the sum over the passes;
          near_miss_count, threshold, used_embeddings = the last pass's (they describe the concepts
                            that remain).
        A single stage, or none, is left as is.
    #>
    $Stages = @($script:ContextRotStages)
    $Idx = @(for ($i = 0; $i -lt $Stages.Count; $i++) { if ((Get-SummaryProp $Stages[$i] 'stage') -eq 'unmapped_resolution') { $i } })
    if ($Idx.Count -lt 2) { return }
    $InCount = $Stages[$Idx[0]]['in_count']
    $Resolved = 0
    for ($k = 0; $k -lt $Idx.Count; $k++) {
        $Pass = $Stages[$Idx[$k]]
        if ($k -gt 0) { $InCount += [Math]::Max(0, $Pass['in_count'] - $Stages[$Idx[$k - 1]]['out_count']) }
        $Resolved += $Pass['flags']['resolved_count']
    }
    $Last = $Stages[$Idx[-1]]
    $Flags = @{}
    foreach ($Key in @($Last['flags'].Keys)) { $Flags[$Key] = $Last['flags'][$Key] }
    $Flags['resolved_count'] = $Resolved
    $Merged = New-ContextRotStage -Stage 'unmapped_resolution' -InUnits $Last['in_units'] -InCount $InCount `
        -OutUnits $Last['out_units'] -OutCount $Last['out_count'] -Flags $Flags
    $script:ContextRotStages = @(for ($i = 0; $i -lt $Stages.Count; $i++) {
            if ($i -eq $Idx[-1]) { $Merged } elseif ($i -notin $Idx) { $Stages[$i] }
        })
}

function New-SummaryModelInfo {
    <#
    .SYNOPSIS
        The summary's model_info block, as an ordered dictionary with the pinned key order.
    .DESCRIPTION
        Detects RAG, compact or full taxonomy from the context format to estimate the node count.
        The compact taxonomy (Build-CompactTaxonomy, the RAG-failure fallback) is labelled 'compact'
        with its real node count; it used to fall through to 'full' with 0 nodes (t/4144).
        max_tokens is the extraction call's MaxTokens as the caller passed it, and
        fire_confidence_threshold is the threshold Invoke-IterativeExtraction reports in its FireStats
        (confidence_threshold). Both used to be hard-coded (32768 and 0.7, t/4079). Either one is
        recorded as null when the caller does not know it, rather than as a made-up number.

        json_repaired/finish_reason/output_tokens/density_retries/camp_bridge_dropped (t/4479, t/4742)
        are forensic/additive -- nothing branches on them. THE EXEMPTION LAPSES the moment a consumer
        branches on one of them. Recorded as the caller reports (aggregated across chunks for chunked
        runs), or null/0 when the caller does not know -- never guessed. density_retries is always 0:
        the single-shot density retry was removed (t/4473/t/4519) and chunked never had one; the field
        exists so a retry mechanism reintroduced later has somewhere to report to.
    #>
    param([string]$Model, [double]$Temperature, [string]$TaxonomyJson, [int]$ChunkCount, [object]$FireStats,
          [object]$MaxTokens = $null, [object]$JsonRepaired = $false, [object]$Truncated = $null,
          [object]$OutputTokens = $null, [int]$CampBridgeDropped = 0, [object]$NumericUngroundedDropped = $null,
          [object]$VerbatimSnapped = $null, [object]$VerbatimDropped = $null,
          [object]$VerbatimInterleaved = $null, [object]$VerbatimQuotes = $null)
    $Multiline = [System.Text.RegularExpressions.RegexOptions]::Multiline
    $IsRagFiltered = $TaxonomyJson -match '^\s*=== RELEVANT TAXONOMY NODES'
    $IsCompact = $TaxonomyJson -match '^\s*=== COMPACT TAXONOMY'
    if ($IsRagFiltered) {
        $EstNodeCount = ([regex]::Matches($TaxonomyJson, '^\s{2}\w', $Multiline)).Count
    }
    elseif ($IsCompact) {
        # One "  <id> [<category>] <label>" line per node.
        $EstNodeCount = ([regex]::Matches($TaxonomyJson, '^  \S', $Multiline)).Count
    }
    else {
        $EstNodeCount = ([regex]::Matches($TaxonomyJson, '"id"\s*:')).Count
    }

    if ($ChunkCount -gt 0) { $TaxFilter = 'rag_per_chunk' }
    elseif ($IsRagFiltered) { $TaxFilter = 'rag' }
    elseif ($IsCompact) { $TaxFilter = 'compact' }
    else { $TaxFilter = 'full' }

    $UsedFire = $null -ne $FireStats
    if ($UsedFire) { $ExtractionMode = 'fire' } else { $ExtractionMode = 'single_shot' }
    $FinishReason = if ($null -eq $Truncated) { $null } elseif ($Truncated) { 'truncated' } else { 'stop' }
    $InterleavedRate = if ($null -eq $VerbatimInterleaved -or $null -eq $VerbatimQuotes) { $null }
        elseif ([int]$VerbatimQuotes -eq 0) { 0.0 }
        else { [Math]::Round([int]$VerbatimInterleaved / [int]$VerbatimQuotes, 4) }
    $ModelInfo = [ordered]@{
        model             = $Model
        temperature       = $Temperature
        max_tokens        = $MaxTokens
        extraction_mode   = $ExtractionMode
        taxonomy_filter   = $TaxFilter
        taxonomy_nodes    = $EstNodeCount
        json_repaired     = $JsonRepaired
        finish_reason     = $FinishReason
        output_tokens     = $OutputTokens
        density_retries   = 0
        camp_bridge_dropped = $CampBridgeDropped
        # t/375: forensic/additive, nothing branches on it; $null when the guard couldn't run (no snapshot).
        numeric_ungrounded_dropped = $NumericUngroundedDropped
        # t/389: forensic/additive, nothing branches on them; $null when the guard couldn't run (no snapshot).
        verbatim_snapped           = $VerbatimSnapped
        verbatim_dropped           = $VerbatimDropped
        # t/389#11 (CL): quotes stored as several strings, one per source piece, because their text is in
        # the snapshot in order but not as one passage (a two-column or table layout). Count and share of
        # the quotes examined; provenance quality, forensic/additive, nothing branches on them. $null when
        # the guard couldn't run.
        verbatim_interleaved       = $VerbatimInterleaved
        verbatim_interleaved_rate  = $InterleavedRate
    }

    if ($UsedFire) {
        # $null when the FireStats predate t/4079 or come from a caller that does not report it.
        $ModelInfo['fire_confidence_threshold'] = Get-SummaryField $FireStats 'confidence_threshold'
        $ModelInfo['fire_stats'] = [ordered]@{
            api_calls                   = $FireStats.total_api_calls
            iterations                  = $FireStats.total_iterations
            claims_total                = $FireStats.claims_total
            claims_confident             = $FireStats.claims_confident
            claims_iterated             = $FireStats.claims_iterated
            claims_dropped_verification = (Get-SummaryField $FireStats 'claims_dropped_verification')
            elapsed_seconds             = $FireStats.elapsed_seconds
            termination_reason          = $FireStats.termination_reason
        }
    }

    if ($ChunkCount -gt 0) {
        $ModelInfo['chunked']     = $true
        $ModelInfo['chunk_count'] = $ChunkCount
    }
    return $ModelInfo
}

function New-SummaryDocument {
    <#
    .SYNOPSIS
        The ordered summary object written to summaries/<doc-id>.json. A warnings key (schema errors,
        hallucinated node IDs, cross-camp warnings, in that order) is added only when there are any.
    #>
    param(
        [string]$DocId, [string]$TaxonomyVersion, [string]$Now, [object]$ModelInfo, [object]$ContextRot,
        [object]$SummaryObject, [object]$FactualClaims, [object]$UnmappedConcepts,
        [object]$EmptyCells = @(),
        [object]$SchemaErrors, [object]$InvalidNodeIds, [object]$CrossCampWarnings
    )
    if ($SummaryObject.PSObject.Properties['pov_summaries']) { $PovSummariesVal = $SummaryObject.pov_summaries } else { $PovSummariesVal = [ordered]@{} }
    $FinalSummary = [ordered]@{
        doc_id            = $DocId
        taxonomy_version  = $TaxonomyVersion
        generated_at      = $Now
        model_info        = $ModelInfo
        context_rot       = $ContextRot
        pov_summaries     = $PovSummariesVal
        factual_claims    = @($FactualClaims)
        unmapped_concepts = @($UnmappedConcepts)
        empty_cells       = @($EmptyCells)
    }
    $AllWarnings = [System.Collections.Generic.List[string]]::new()
    foreach ($e in $SchemaErrors)       { $AllWarnings.Add("Schema: $e") }
    foreach ($n in $InvalidNodeIds)     { $AllWarnings.Add("Hallucinated node ID: $n") }
    foreach ($w in $CrossCampWarnings)  { $AllWarnings.Add($w) }
    if ($AllWarnings.Count -gt 0) {
        $FinalSummary['warnings'] = @($AllWarnings)
    }
    return $FinalSummary
}

function Write-SummaryDocument {
    <#
    .SYNOPSIS
        Writes the summary document to <SummariesDir>/<DocId>.json via Write-Utf8NoBom.
    .OUTPUTS
        Nothing on success. On a write failure, prints the failure line and returns Finalize-Summary's
        Success=$false result, which the caller returns as is: no metadata write follows.
    #>
    param([string]$SummariesDir, [string]$DocId, [object]$Document)
    # Join-Path stays outside the try: a bad SummariesDir throws to the caller, as it always has.
    $SummaryPath = Join-Path $SummariesDir "${DocId}.json"
    try {
        Write-Utf8NoBom -Path $SummaryPath -Value ($Document | ConvertTo-Json -Depth 20)
    }
    catch {
        Write-Host "  └─ ✗ Failed to write summary: $($_.Exception.Message)" -ForegroundColor Red
        return @{ Success = $false; DocId = $DocId; Error = "Failed to write summary file: $($_.Exception.Message)" }
    }
}

function Get-ClaimNodePov([object]$NodeId) {
    # The POV camp a linked taxonomy node ID belongs to, by prefix; $null for a null or other ID.
    if ($null -eq $NodeId) { return $null }
    $PovByPrefix = [ordered]@{ 'acc-*' = 'accelerationist'; 'saf-*' = 'safetyist'; 'skp-*' = 'skeptic'; 'sit-*' = 'situations' }
    foreach ($Prefix in $PovByPrefix.Keys) {
        if ($NodeId -like $Prefix) { return $PovByPrefix[$Prefix] }
    }
    return $null
}

function Get-SummaryClaimPovCounts {
    <#
    .SYNOPSIS
        Source statistics from the factual claims' linked_taxonomy_nodes: @{ NodeRefs; Primary }.
        NodeRefs counts every linked node per POV; Primary counts each claim's first POV-prefixed
        node. Both are ordered dictionaries with their keys in ordinal order, so metadata.json is
        byte-identical across processes (a plain @{} serialized in per-process hash order, t/4079).
    #>
    param([object]$FactualClaims)
    $nodeRefsByPov = [ordered]@{}
    $primaryPovDist = [ordered]@{}
    # Ordinal order, written out: situations sorts before skeptic.
    foreach ($Pov in 'accelerationist', 'safetyist', 'situations', 'skeptic') {
        $nodeRefsByPov[$Pov] = 0
        $primaryPovDist[$Pov] = 0
    }
    foreach ($claim in @($FactualClaims)) {
        if (-not $claim.PSObject.Properties['linked_taxonomy_nodes']) { continue }
        $PrimaryAssigned = $false
        foreach ($nodeId in @($claim.linked_taxonomy_nodes)) {
            $Pov = Get-ClaimNodePov $nodeId
            if (-not $Pov) { continue }
            $nodeRefsByPov[$Pov]++
            if (-not $PrimaryAssigned) { $primaryPovDist[$Pov]++; $PrimaryAssigned = $true }
        }
    }
    return @{ NodeRefs = $nodeRefsByPov; Primary = $primaryPovDist }
}

function Update-SummaryMetadata {
    <#
    .SYNOPSIS
        Records the summary in the source's metadata.json (status, version, statistics, context_rot).
    .DESCRIPTION
        The summary is already written when this runs, so a failure here is swallowed: Finalize-Summary
        still returns Success=$true. That leaves metadata.json stale, so every failure is a WARN naming
        the condition (t/4079): a missing metadata.json is checked for explicitly, and any other
        failure (bad JSON, a failed write) is caught.
    #>
    param(
        [hashtable]$Doc, [string]$TaxonomyVersion, [string]$Now, [object]$FactualClaims,
        [int]$FactualCount, [int]$TotalPoints, [int]$UnmappedCount,
        [object]$ContextRot, [object]$ContextRotStages
    )
    if (-not $Doc.MetaFile -or -not (Test-Path -LiteralPath $Doc.MetaFile -PathType Leaf)) {
        Write-Warning "Finalize-Summary: summary written but metadata.json not updated — the file is missing: '$($Doc.MetaFile)'"
        return
    }
    try {
        $MetaRaw     = Get-Content $Doc.MetaFile -Raw
        # Shape-preserving read (t/4366): a bare ConvertFrom-Json -AsHashtable coerces ISO strings
        # such as import_time to [datetime], and this whole-object rewrite would re-emit them in the
        # running machine's offset.
        $MetaUpdated = ConvertFrom-JsonPreserveShape -Json $MetaRaw -AsOrderedHashtable
        $MetaUpdated['summary_version'] = $TaxonomyVersion
        $MetaUpdated['summary_status']  = 'current'
        $MetaUpdated['summary_updated'] = $Now

        # Summary statistics for Source objects
        $PovCounts = Get-SummaryClaimPovCounts -FactualClaims $FactualClaims
        $MetaUpdated['total_claims']              = $FactualCount
        $MetaUpdated['node_references_by_pov']    = $PovCounts.NodeRefs
        $MetaUpdated['primary_pov_distribution']  = $PovCounts.Primary
        $MetaUpdated.Remove('claims_by_pov')
        $MetaUpdated['total_facts']       = $TotalPoints
        $MetaUpdated['unmapped_concepts'] = $UnmappedCount
        if ($ContextRot) {
            # Worst stage among RETENTION stages only (same in/out units), as cumulative_retention counts them.
            # A mixed-unit stage (extraction: prompt_chars -> items) is a density, not a retention, so its tiny
            # ratio must not be reported as the worst loss (t/4144).
            $WorstStage = @($ContextRotStages | Where-Object { $_.in_units -eq $_.out_units }) |
                Sort-Object { $_.ratio } | Select-Object -First 1
            $MetaUpdated['context_rot'] = [ordered]@{
                cumulative_retention = $ContextRot.cumulative_retention
                worst_stage          = if ($WorstStage) { $WorstStage.stage } else { $null }
                worst_ratio          = if ($WorstStage) { $WorstStage.ratio } else { $null }
            }
        }

        Write-Utf8NoBom -Path $Doc.MetaFile -Value ($MetaUpdated | ConvertTo-Json -Depth 10)
    }
    catch {
        Write-Warning "Finalize-Summary: summary written but metadata update failed, leaving '$($Doc.MetaFile)' stale: $($_.Exception.Message)"
    }
}
