# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DataPresenceAssertion {
    <#
    .SYNOPSIS
        Pure assertion helper (t/2671): decides whether a parsed API response
        actually carries data rows (> 0), independent of HTTP status.
    .DESCRIPTION
        The hosted deploy smoke passed 26/26 green while Entities/Organizations
        were empty on web, because it asserted endpoints RESPOND, not that data
        POPULATES — and worse, an auth Sign-In interstitial is served as 200
        text/html, which a status-only check reads as PASS. This helper is the
        authoritative presence check: it fails a non-JSON body (the interstitial),
        a null/unparseable body, a missing/null count field, and an empty
        collection — and it NEVER throws on malformed input (returns Pass=$false).

        Pure by design (no HTTP): takes an already-parsed body + content-type so
        it is unit-testable against synthetic bodies with no live server.
    .PARAMETER Body
        The parsed response body (e.g. Invoke-RemoteCheck's .Body), or $null when
        the response was not valid JSON.
    .PARAMETER ContentType
        The response Content-Type. A non-JSON type (e.g. text/html) fails the
        assertion — this is the auth-interstitial catch. Empty string skips the
        content-type check (for pure unit tests that pass a body directly).
    .PARAMETER CountField
        Name of the field holding the row collection (e.g. 'nodes' for taxonomy).
        Empty string means the body itself is the array (entities, organizations).
    .PARAMETER Label
        Human label for the data kind, used in the Reason text.
    .OUTPUTS
        [PSCustomObject] with Count (int), Pass (bool), Reason (string).
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Body,

        [Parameter()]
        [string]$ContentType = '',

        [Parameter()]
        [string]$CountField = '',

        [Parameter()]
        [string]$Label = 'data'
    )

    Set-StrictMode -Version Latest

    $Result = { param($c, $p, $r) [PSCustomObject]@{ Count = $c; Pass = $p; Reason = $r } }

    # 1. Must be JSON. An AUTH_OPTIONAL Sign-In interstitial is 200 text/html —
    #    the exact escape that made the endpoint smoke falsely green.
    if ($ContentType -and $ContentType -notmatch 'application/json') {
        return & $Result 0 $false "Expected application/json but got '$ContentType' (likely the auth Sign-In interstitial, not data)"
    }

    # 2. Null / unparseable body.
    if ($null -eq $Body) {
        return & $Result 0 $false 'Response body was null or not valid JSON'
    }

    # 3. Resolve the collection to count.
    if ($CountField) {
        # Get-JsonField/Test-JsonField read PSCustomObject and Hashtable bodies alike (t/4934).
        if (-not (Test-JsonField $Body $CountField)) {
            return & $Result 0 $false "Field '$CountField' absent from response body"
        }
        $Coll = Get-JsonField $Body $CountField -NoEnumerate   # keep [] (empty) distinct from null
        $What = "Field '$CountField'"
    } else {
        $Coll = $Body
        $What = 'Response body'
    }

    # 4. Null collection (e.g. {"nodes":null}) — fail, never throw.
    #    (@($null).Count is 1, so this MUST be guarded before the @() wrap below.)
    if ($null -eq $Coll) {
        return & $Result 0 $false "$What is null (expected a non-empty array)"
    }

    # 5. Count rows. Array/list → length; a bare object → 1 row if it has any
    #    properties, 0 for an empty object {}; a scalar/string is not a collection.
    if (($Coll -is [string]) -or ($Coll -is [ValueType])) {
        return & $Result 0 $false "$What is not an array (got $($Coll.GetType().Name))"
    }
    if ($Coll -is [System.Collections.IDictionary]) {
        # A Hashtable is one object, not rows: @($h).Count is 1 even for an empty {} (t/4934).
        $Count = if ($Coll.Count -gt 0) { 1 } else { 0 }
    } elseif ($Coll -is [System.Collections.IEnumerable]) {
        $Count = @($Coll).Count
    } else {
        $Count = if (@($Coll.PSObject.Properties).Count -gt 0) { 1 } else { 0 }
    }

    $Pass = $Count -gt 0
    $Reason = if ($Pass) { "$Count $Label row(s)" } else { "Empty — $What present but 0 rows" }
    return & $Result $Count $Pass $Reason
}
