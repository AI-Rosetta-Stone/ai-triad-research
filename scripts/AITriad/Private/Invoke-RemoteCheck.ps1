# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-RemoteCheck {
    <#
    .SYNOPSIS
        Makes an HTTP request to a remote endpoint and returns a structured result.
    .DESCRIPTION
        Default-GET smoke-check helper used by Test-TaxEditorEndpoints and
        Test-AnonymousDebateFlow. Optional -Body, -Session, and -ExtraHeaders
        allow POST/PUT flows with cookie persistence across calls (anonymous
        session smoke test, etc).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$BaseUrl,

        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter()]
        [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
        [string]$Method = 'GET',

        [Parameter()]
        [int]$TimeoutSec = 10,

        [Parameter()]
        [string]$ExpectedField,

        [Parameter()]
        [int[]]$AcceptableStatusCodes = @(200),

        # Optional request body. Hashtables/objects are JSON-encoded automatically
        # and Content-Type is set to application/json.
        [Parameter()]
        [object]$Body,

        # Optional shared WebRequestSession for cookie persistence across calls.
        [Parameter()]
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session,

        # Optional extra headers merged on top of the default Accept: application/json.
        [Parameter()]
        [hashtable]$ExtraHeaders,

        # t/1474: when set, Success is $false if the response Content-Type is text/html.
        # Opt-in so callers that expect non-JSON responses (third-party-notices) are unaffected.
        [Parameter()]
        [switch]$ExpectJson
    )

    $Url = "$BaseUrl$Path"
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()

    $Headers = @{ 'Accept' = 'application/json' }
    if ($ExtraHeaders) {
        foreach ($K in $ExtraHeaders.Keys) { $Headers[$K] = $ExtraHeaders[$K] }
    }

    $WebParams = @{
        Uri             = $Url
        Method          = $Method
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
        Headers         = $Headers
    }
    if ($PSBoundParameters.ContainsKey('Body') -and $null -ne $Body) {
        if ($Body -is [string]) {
            $WebParams.Body = $Body
        } else {
            $WebParams.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
        }
        $WebParams.ContentType = 'application/json'
    }
    if ($Session) {
        $WebParams.WebSession = $Session
    }

    try {
        $Response = Invoke-WebRequest @WebParams
        $Sw.Stop()

        $StatusCode = $Response.StatusCode
        $ContentType = ''
        if ($Response.Headers -and $Response.Headers['Content-Type']) {
            # Headers[key] returns string[] in PS7 — take the first entry.
            $ContentType = @($Response.Headers['Content-Type'])[0]
        }
        # RawBody is a short slice for shape-matching (SPA-shell detection, etc). t/1355.
        # Bumped 400 → 4096 (t/1500#7): this app's <head> is 464+ chars before
        # Vite's script injection, so `<div id="root">` and `src="...js"` both
        # fall past a 400-char slice → SPA-shell check always fails on `/`.
        # 4096 gives ~10× headroom for future <head> growth without turning
        # RawBody into a full-page buffer.
        $RawBody = ''
        if ($Response.Content) {
            $RawBody = if ($Response.Content.Length -gt 4096) {
                $Response.Content.Substring(0, 4096)
            } else {
                $Response.Content
            }
        }
        $Body = $null
        if ($Response.Content) {
            # -NoEnumerate (t/4913 staging incident, p/169#228): without it, ConvertFrom-Json's
            # own array output gets unrolled onto the pipeline by `|`, and a scalar assignment
            # capturing ZERO unrolled elements (a genuinely empty JSON array, "[]") becomes
            # $null -- indistinguishable from "didn't parse at all". A real `/api/*` endpoint
            # returning an empty list (valid, common) was wrongly flagged as unparseable and
            # failed every check depending on it. -NoEnumerate keeps the parsed array as one
            # object, empty or not, so only a genuine parse failure still produces $null.
            try { $Body = $Response.Content | ConvertFrom-Json -NoEnumerate } catch { $Body = $null }
        }

        $Success = $StatusCode -in $AcceptableStatusCodes
        # t/1474 / t/4913 — catch the auth-shell trap AND the broken-path trap: a server
        # returning 200 for an API path with ANY Content-Type other than JSON is wrong,
        # whether that's the expected text/html login page or an unexpected value a static
        # host's SPA-fallback rewrite happens to serve (missing header, text/plain, etc. —
        # t/4913 found 14/24 endpoint checks passing against a nonexistent path prefix purely
        # on status code, because the old guard only blocked a Content-Type that MATCHED
        # 'text/html' and never required one that positively looked like JSON). An allowlist
        # (must contain 'application/json') is strictly more correct than a blocklist (must
        # not contain 'text/html') and catches every shape of this bug, not just the one
        # production host happened to exhibit.
        if ($Success -and $ExpectJson -and $ContentType -notmatch 'application/json') {
            $Success = $false
        }
        # t/4913 — Content-Type claiming JSON is not proof of a usable body: require it to
        # have actually parsed. Folds t/1474's original $Body-null case in as a positive "did
        # this parse" check that applies even when -ExpectedField isn't set (most of
        # Test-TaxEditorEndpoints's /api/* checks have no ExpectedField -- t/4913's "a minimal
        # shape" ask).
        if ($Success -and $ExpectJson -and $null -eq $Body) {
            $Success = $false
        }
        # t/1474 — the previous guard `-and $Body` short-circuited when
        # ConvertFrom-Json failed on HTML, leaving Success=$true. Drop $Body
        # from the outer guard; move it inside as a negative check so a missing
        # or unparseable body flips Success.
        if ($Success -and $ExpectedField) {
            if (-not $Body -or -not $Body.PSObject.Properties[$ExpectedField]) {
                $Success = $false
            }
        }

        [PSCustomObject]@{
            Success     = $Success
            StatusCode  = $StatusCode
            ResponseMs  = $Sw.ElapsedMilliseconds
            Body        = $Body
            ContentType = $ContentType
            RawBody     = $RawBody
            Error       = $null
        }
    }
    catch {
        $Sw.Stop()
        $StatusCode = 0
        $ContentType = ''
        $RawBody = ''
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
            # Best-effort content-type extraction from the error-response headers
            # (used by the persona-endpoint 401/403 classifier — non-200 with HTML
            # body is a real signal for auth-shell distinguisher).
            try {
                if ($_.Exception.Response.Content -and $_.Exception.Response.Content.Headers.ContentType) {
                    $ContentType = $_.Exception.Response.Content.Headers.ContentType.MediaType
                }
            } catch { }
            try {
                $ErrResp = $_.ErrorDetails
                if ($ErrResp -and $ErrResp.Message) {
                    $ErrText = [string]$ErrResp.Message
                    $RawBody = if ($ErrText.Length -gt 400) { $ErrText.Substring(0, 400) } else { $ErrText }
                }
            } catch { }
        }
        [PSCustomObject]@{
            Success     = $false
            StatusCode  = $StatusCode
            ResponseMs  = $Sw.ElapsedMilliseconds
            Body        = $null
            ContentType = $ContentType
            RawBody     = $RawBody
            Error       = $_.Exception.Message
        }
    }
}
