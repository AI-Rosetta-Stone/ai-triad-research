# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Shape-preserving JSON reader for whole-file read-modify-write (t/3124 follow-up). PowerShell
# 7.4's `ConvertFrom-Json` mutates document SHAPE in two ways that a subsequent whole-file
# `ConvertTo-Json` then bakes into the file — silently changing fields the write never targeted:
#
#   1. ISO-8601 datetime STRINGS are coerced to [datetime], losing the original timezone offset +
#      trailing fractional digits ("2026-05-02T20:38:45.7336380-04:00" -> re-emitted "...+01:00").
#      Same defect class as ConvertFrom-EdgesJson / t/2974. `-DateKind String` is PS 7.5+ only.
#   2. SINGLE-ELEMENT arrays are unwrapped to scalars (`"vocabulary_terms": ["x"]` -> `"x"`, and
#      `[{...}]` -> a bare object), the "Force-array" pitfall this module already fights.
#
# Both are corrected at READ time by walking the ConvertFrom-Json result and a parallel
# System.Text.Json JsonDocument in tandem (objects matched by property NAME, arrays by INDEX —
# both parsers preserve source order). SCHEMA-AGNOSTIC: a general walk, not a field allowlist.
#
# POWERSHELL ARRAY HAZARD (why the walk is structured the way it is): returning a container through
# the pipeline is lossy — an EMPTY array collapses to $null and a SINGLE-element array unwraps to a
# scalar, and each function boundary re-triggers it. So the walker reassigns a slot ONLY for the two
# corrections that genuinely need a new value — a coerced datetime (-> its string) and a COLLAPSED
# single-element array (rebuilt via the `,([object[]]...)` idiom in ONE function hop, assigned
# directly so it is not unwrapped). Objects, empty arrays, and genuine (>=2 element) arrays are
# fixed IN PLACE and their slot is left untouched. Fails OPEN but NOT silent (mirrors
# ConvertFrom-EdgesJson, TL t/2974#3). Dot-sourced — do NOT export.

function Restore-CollapsedJsonArray {
    # ConvertFrom-Json collapsed a single-element source array to the scalar/object $Collapsed.
    # Rebuild it as an [object[]], recursing into the sole element if it is itself a container or a
    # coerced datetime. Returns via `,([object[]]...)` in ONE hop so a direct slot assignment at the
    # caller keeps it an array (no pipeline unwrap).
    [CmdletBinding()]
    param(
        $Collapsed,
        [System.Text.Json.JsonElement]$Element
    )
    Set-StrictMode -Version Latest
    $list = [System.Collections.Generic.List[object]]::new()
    foreach ($childEl in $Element.EnumerateArray()) {
        $item = $Collapsed
        switch ($childEl.ValueKind) {
            ([System.Text.Json.JsonValueKind]::Object) {
                if ($item -is [System.Management.Automation.PSCustomObject]) { Restore-JsonShapeInPlace -Container $item -Element $childEl }
            }
            ([System.Text.Json.JsonValueKind]::Array) {
                if ($item -is [System.Collections.IList] -and $item -isnot [string]) { Restore-JsonShapeInPlace -Container $item -Element $childEl }
                else { $item = Restore-CollapsedJsonArray -Collapsed $item -Element $childEl }
            }
            ([System.Text.Json.JsonValueKind]::String) {
                if ($item -is [datetime] -or $item -is [datetimeoffset]) { $item = $childEl.GetString() }
            }
        }
        $list.Add($item)
    }
    $arr = [object[]]$list.ToArray()
    return , $arr
}

function Restore-JsonShapeInPlace {
    # Reconcile $Container (a PSCustomObject when $Element is Object, or an IList when $Element is
    # Array) against $Element, fixing children in place. Returns nothing.
    [CmdletBinding()]
    param(
        $Container,
        [System.Text.Json.JsonElement]$Element
    )
    Set-StrictMode -Version Latest

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        if ($Container -isnot [System.Management.Automation.PSCustomObject]) { return }
        foreach ($prop in $Container.PSObject.Properties) {
            $child = [System.Text.Json.JsonElement]::new()
            if (-not $Element.TryGetProperty($prop.Name, [ref]$child)) { continue }
            switch ($child.ValueKind) {
                ([System.Text.Json.JsonValueKind]::Object) {
                    if ($prop.Value -is [System.Management.Automation.PSCustomObject]) { Restore-JsonShapeInPlace -Container $prop.Value -Element $child }
                }
                ([System.Text.Json.JsonValueKind]::Array) {
                    if ($prop.Value -is [System.Collections.IList] -and $prop.Value -isnot [string]) {
                        Restore-JsonShapeInPlace -Container $prop.Value -Element $child   # empty + multi: in place
                    }
                    else {
                        $prop.Value = Restore-CollapsedJsonArray -Collapsed $prop.Value -Element $child
                    }
                }
                ([System.Text.Json.JsonValueKind]::String) {
                    if ($prop.Value -is [datetime] -or $prop.Value -is [datetimeoffset]) { $prop.Value = $child.GetString() }
                }
            }
        }
        return
    }

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        if ($Container -isnot [System.Collections.IList]) { return }
        $idx = 0
        foreach ($childEl in $Element.EnumerateArray()) {
            if ($idx -ge $Container.Count) { break }
            switch ($childEl.ValueKind) {
                ([System.Text.Json.JsonValueKind]::Object) {
                    if ($Container[$idx] -is [System.Management.Automation.PSCustomObject]) { Restore-JsonShapeInPlace -Container $Container[$idx] -Element $childEl }
                }
                ([System.Text.Json.JsonValueKind]::Array) {
                    if ($Container[$idx] -is [System.Collections.IList] -and $Container[$idx] -isnot [string]) {
                        Restore-JsonShapeInPlace -Container $Container[$idx] -Element $childEl
                    }
                    else {
                        $Container[$idx] = Restore-CollapsedJsonArray -Collapsed $Container[$idx] -Element $childEl
                    }
                }
                ([System.Text.Json.JsonValueKind]::String) {
                    if ($Container[$idx] -is [datetime] -or $Container[$idx] -is [datetimeoffset]) { $Container[$idx] = $childEl.GetString() }
                }
            }
            $idx++
        }
        return
    }
}

function ConvertFrom-JsonPreserveShape {
    <#
    .SYNOPSIS
        Parse JSON preserving ISO-datetime strings AND single-element array shape (t/3124; PS 7.4).
    .DESCRIPTION
        ConvertFrom-Json for the fast structure, then a System.Text.Json.JsonDocument pass restores
        (1) every coerced datetime leaf to its exact original string and (2) any single-element
        array the fast parser unwrapped to a scalar/object. Use wherever a cmdlet reads a JSON
        document and later rewrites the WHOLE file, so unrelated fields round-trip byte-identically.
        Fails OPEN but NOT silent: if System.Text.Json cannot parse, returns the plain
        ConvertFrom-Json result with a Write-Verbose note (mirrors ConvertFrom-EdgesJson, t/2974#3).
    .PARAMETER Json
        The raw JSON text.
    .PARAMETER AsOrderedHashtable
        Return a top-level JSON object as an [ordered] dictionary in source key order (nested
        values keep the preserved shape). For read-modify-write callers that set and remove keys
        the way `ConvertFrom-Json -AsHashtable` callers do, without its datetime coercion (t/4366).
    .OUTPUTS
        The parsed document with datetime fields + single-element arrays preserved verbatim.
    #>
    [CmdletBinding()]
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Json,

        [switch]$AsOrderedHashtable
    )
    Set-StrictMode -Version Latest

    if ($AsOrderedHashtable) {
        $shaped = ConvertFrom-JsonPreserveShape -Json $Json
        if ($shaped -isnot [System.Management.Automation.PSCustomObject]) { return $shaped }
        $ordered = [ordered]@{}
        foreach ($p in $shaped.PSObject.Properties) { $ordered[$p.Name] = $p.Value }
        return $ordered
    }

    $obj = $Json | ConvertFrom-Json
    if ($null -eq $obj) { return $obj }

    $doc = $null
    try { $doc = [System.Text.Json.JsonDocument]::Parse($Json) }
    catch {
        Write-Verbose "ConvertFrom-JsonPreserveShape: System.Text.Json could not parse for shape restoration ($($_.Exception.Message)); falling back to ConvertFrom-Json — datetimes/single-element arrays may be mutated (t/3124)."
        return $obj
    }

    try {
        $root = $doc.RootElement
        if ($root.ValueKind -eq [System.Text.Json.JsonValueKind]::Object -or
            $root.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
            Restore-JsonShapeInPlace -Container $obj -Element $root
        }
        return $obj
    }
    finally {
        $doc.Dispose()
    }
}
