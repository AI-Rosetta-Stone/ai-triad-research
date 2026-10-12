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
    # The member's value. `return` enumerates it, so an empty array comes back as $null and a
    # one-element array as its element. Pinned behaviour (t/4079); callers rely on the falsy $null.
    if ($Obj -is [System.Collections.IDictionary]) { return $Obj[$Name] }
    $P = $Obj.PSObject.Properties[$Name]
    if ($P) { return $P.Value }
    return $null
}

function Get-SummaryCampKeyPoints {
    # Every key_point across the three camps, in camp order then list order. -WithPov wraps each as
    # @{ KeyPoint = <kp>; POV = <camp> }. Camps that are missing, or whose key_points are absent or
    # empty, contribute nothing. Pure. Returns an array (never unrolled).
    param([object]$SummaryObject, [switch]$WithPov)
    $Items = [System.Collections.Generic.List[object]]::new()
    foreach ($Camp in $script:AITriadPovCamps) {
        $CampData = $SummaryObject.pov_summaries.$Camp
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
        if ($CampData -is [System.Collections.IDictionary]) { $CampData['key_points'] = $KP }
        elseif ($CampData.PSObject.Properties['key_points']) { $CampData.key_points = $KP }
        else { $CampData | Add-Member -NotePropertyName 'key_points' -NotePropertyValue $KP -Force }
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
