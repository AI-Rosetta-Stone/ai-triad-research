# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-CuiAuth002 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter()][int]$TimeoutSec = 15
    )

    Set-StrictMode -Version Latest
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Checks = [System.Collections.Generic.List[PSObject]]::new()
    $BaseUrl = $BaseUrl.TrimEnd('/')

    # Check 1: GET /api/auth/me → 200, { anonymous: true }
    $r = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/auth/me' -TimeoutSec $TimeoutSec
    $IsAnon = $false
    if ($r.Success -and $r.Body -and $r.Body.PSObject.Properties['anonymous']) {
        $IsAnon = [bool]$r.Body.anonymous
    }
    $Checks.Add((New-CuiCheckResult -Check 'Anonymous identity' -Pass ($r.Success -and $IsAnon) `
        -Detail $(if ($IsAnon) { 'anonymous=true' } elseif ($r.Success) { 'Not anonymous (may have cached session)' } else { "Failed: $($r.Error)" }) -Ms $r.ResponseMs))

    # Check 2: GET /api/taxonomy/accelerationist → 200 (reads work)
    $tr = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/taxonomy/accelerationist' -TimeoutSec $TimeoutSec -ExpectedField 'nodes'
    $Checks.Add((New-CuiCheckResult -Check 'Anonymous read succeeds' -Pass $tr.Success `
        -Detail $(if ($tr.Success) { 'Taxonomy readable' } else { "Failed: $($tr.Error)" }) -Ms $tr.ResponseMs))

    # Check 3: PUT /api/taxonomy/accelerationist → 401 or 403 (writes blocked)
    $WriteSw = [System.Diagnostics.Stopwatch]::StartNew()
    $WriteBlocked = $false
    $WriteStatus = 0
    try {
        $PutBody = '{"nodes":[]}'
        # Send If-Match anyway (t/4222), so a 428 can never hide the 401/403 this check expects.
        $PutHeaders = Get-CuiTaxonomyWriteHeaders -BaseUrl $BaseUrl -Pov 'accelerationist' -TimeoutSec $TimeoutSec
        $PutResp = Invoke-WebRequest -Uri "$BaseUrl/api/taxonomy/accelerationist" -Method PUT `
            -Body $PutBody -ContentType 'application/json' -TimeoutSec $TimeoutSec `
            -UseBasicParsing -ErrorAction Stop -Headers $PutHeaders
        $WriteStatus = $PutResp.StatusCode
    } catch {
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $WriteStatus = [int]$_.Exception.Response.StatusCode
        }
        $WriteBlocked = $WriteStatus -in @(401, 403)
    }
    $WriteSw.Stop()
    $Checks.Add((New-CuiCheckResult -Check 'Anonymous write blocked' -Pass $WriteBlocked `
        -Detail $(if ($WriteBlocked) { "HTTP $WriteStatus" } else { "Unexpected status: $WriteStatus" }) -Ms $WriteSw.ElapsedMilliseconds))

    # Check 4: PUT /api/debates → 401 or 403 (writes blocked)
    $DebSw = [System.Diagnostics.Stopwatch]::StartNew()
    $DebBlocked = $false
    $DebStatus = 0
    try {
        $DebBody = '{"id":"anon-test","topic":"test","transcript":[]}'
        $DebResp = Invoke-WebRequest -Uri "$BaseUrl/api/debates" -Method PUT `
            -Body $DebBody -ContentType 'application/json' -TimeoutSec $TimeoutSec `
            -UseBasicParsing -ErrorAction Stop
        $DebStatus = $DebResp.StatusCode
    } catch {
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $DebStatus = [int]$_.Exception.Response.StatusCode
        }
        $DebBlocked = $DebStatus -in @(401, 403)
    }
    $DebSw.Stop()
    $Checks.Add((New-CuiCheckResult -Check 'Anonymous debate write blocked' -Pass $DebBlocked `
        -Detail $(if ($DebBlocked) { "HTTP $DebStatus" } else { "Unexpected status: $DebStatus" }) -Ms $DebSw.ElapsedMilliseconds))

    $Sw.Stop()
    New-CuiTestResult -CuiId 'CUI-AUTH-002' -Domain 'Auth' -Priority 'P0' `
        -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray()
}
