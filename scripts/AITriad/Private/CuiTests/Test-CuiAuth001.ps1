# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-CuiAuth001 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter()][int]$TimeoutSec = 15,
        [Parameter()][hashtable]$AuthHeaders = @{}
    )

    Set-StrictMode -Version Latest
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Checks = [System.Collections.Generic.List[PSObject]]::new()
    $BaseUrl = $BaseUrl.TrimEnd('/')

    # Check 1: GET /api/auth/me → 200, response has user field (not anonymous)
    $r = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/auth/me' -TimeoutSec $TimeoutSec
    $IsAuth = $false
    if ($r.Success -and $r.Body) {
        $IsAnon = $false
        if ($r.Body.PSObject.Properties['anonymous']) {
            $IsAnon = [bool]$r.Body.anonymous
        }
        $IsAuth = -not $IsAnon
    }
    $Checks.Add((New-CuiCheckResult -Check 'Auth identity (not anonymous)' -Pass $IsAuth `
        -Detail $(if ($IsAuth) { 'Authenticated' } else { 'Anonymous — pass auth headers to test fully' }) -Ms $r.ResponseMs))

    # Check 2: GET /api/user/profile → 200, has storageUserId
    $pr = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/user/profile' -TimeoutSec $TimeoutSec
    $ProfileOk = $pr.Success
    $HasStorageId = $false
    if ($pr.Success -and $pr.Body -and $pr.Body.PSObject.Properties['storageUserId']) {
        $HasStorageId = $pr.Body.storageUserId.Length -gt 0
    }
    $Checks.Add((New-CuiCheckResult -Check 'User profile loads' -Pass $ProfileOk `
        -Detail $(if ($HasStorageId) { "storageUserId present" } elseif ($ProfileOk) { 'Profile loaded (no storageUserId)' } else { "Failed: $($pr.Error)" }) -Ms $pr.ResponseMs))

    # Check 3: PUT taxonomy succeeds with auth (write access)
    $WriteOk = $false
    if ($IsAuth) {
        $WriteSw = [System.Diagnostics.Stopwatch]::StartNew()
        $tr = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/taxonomy/accelerationist' -TimeoutSec $TimeoutSec -ExpectedField 'nodes'
        if ($tr.Success -and $tr.Body) {
            try {
                $PutHeaders = Get-CuiTaxonomyWriteHeaders -BaseUrl $BaseUrl -Pov 'accelerationist' -Headers $AuthHeaders -TimeoutSec $TimeoutSec
                $PutResp = Invoke-WebRequest -Uri "$BaseUrl/api/taxonomy/accelerationist" -Method PUT `
                    -Body ($tr.Body | ConvertTo-Json -Depth 20 -Compress) -ContentType 'application/json' `
                    -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop -Headers $PutHeaders
                $WriteOk = $PutResp.StatusCode -eq 200
            } catch { }
        }
        $WriteSw.Stop()
        $Checks.Add((New-CuiCheckResult -Check 'Write access (PUT taxonomy)' -Pass $WriteOk `
            -Detail $(if ($WriteOk) { 'Write succeeded' } else { 'Write failed' }) -Ms $WriteSw.ElapsedMilliseconds))
    } else {
        $Checks.Add((New-CuiCheckResult -Check 'Write access (PUT taxonomy)' -Pass $false `
            -Detail 'Skipped — not authenticated'))
    }

    $Sw.Stop()
    New-CuiTestResult -CuiId 'CUI-AUTH-001' -Domain 'Auth' -Priority 'P0' `
        -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray()
}
