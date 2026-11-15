# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4934 (t/103): the ONE field reader for parsed JSON bodies. A body is a
# PSCustomObject (ConvertFrom-Json) or a dictionary (ConvertFrom-Json -AsHashtable,
# the fallback for keys that differ only in case; [ordered] in-memory summaries).
# $x.PSObject.Properties['k'] is BLIND to dictionary keys — it reflects .NET members
# (Count, Keys, ...) — so a direct read silently misses on a Hashtable body. It also
# "finds" .NET members on strings ('Length') and value types. Get-SummaryProp
# delegates here, so there is one implementation of the shape dispatch.

function Test-JsonField {
    <#
    .SYNOPSIS
        True when a parsed JSON body carries the named field, whatever its shape.
    .DESCRIPTION
        IDictionary → .Contains($Name). PSCustomObject → a property named $Name.
        $null, strings, value types and arrays have no JSON fields → $false. A field
        that is present with a null value is present ($true); use Get-JsonField to read it.
        Case: PSCustomObject and [ordered] lookups ignore case, but ConvertFrom-Json
        -AsHashtable returns a CASE-SENSITIVE table, so pass the exact JSON key name.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Position = 0)][AllowNull()][object]$Body,
        [Parameter(Mandatory, Position = 1)][string]$Name
    )
    if ($null -eq $Body -or $Body -is [string] -or $Body -is [ValueType]) { return $false }
    if ($Body -is [System.Collections.IDictionary]) { return [bool]$Body.Contains($Name) }
    # A JSON array has no fields; its .NET members (Count, Length) are not keys (Quality, t/103#4).
    if ($Body -is [System.Collections.IEnumerable]) { return $false }
    return ($null -ne $Body.PSObject.Properties[$Name])
}

function Get-JsonField {
    <#
    .SYNOPSIS
        Reads a named field from a parsed JSON body (PSCustomObject or dictionary).
    .DESCRIPTION
        Returns the field's value, or -Default (default $null) when the field is
        absent or the body has no fields (see Test-JsonField). Never throws under
        Set-StrictMode -Version Latest. Like any function, an array value is
        enumerated to the pipeline, so wrap the call in @() before .Count.
    .PARAMETER NoEnumerate
        Return an array value as one object, so $x = Get-JsonField ... -NoEnumerate
        keeps [] distinct from null and [x] distinct from x.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][AllowNull()][object]$Body,
        [Parameter(Mandatory, Position = 1)][string]$Name,
        [AllowNull()][object]$Default = $null,
        [switch]$NoEnumerate
    )
    if (-not (Test-JsonField -Body $Body -Name $Name)) { return $Default }
    # Assign in each branch: `$Value = if (...) {...}` would enumerate an array value.
    if ($Body -is [System.Collections.IDictionary]) { $Value = $Body[$Name] } else { $Value = $Body.PSObject.Properties[$Name].Value }
    if ($NoEnumerate -and $Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and
        $Value -isnot [System.Collections.IDictionary]) {
        return , $Value
    }
    return $Value
}
