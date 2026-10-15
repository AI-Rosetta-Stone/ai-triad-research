# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-CuiTax010 {
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

    # Check 1: Verify authenticated (not anonymous)
    $AuthCheck = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/auth/me' -TimeoutSec $TimeoutSec
    $IsAuth = $false
    if ($AuthCheck.Success -and $AuthCheck.Body) {
        $IsAnon = $false
        if ($AuthCheck.Body.PSObject.Properties['anonymous']) {
            $IsAnon = [bool]$AuthCheck.Body.anonymous
        }
        $IsAuth = -not $IsAnon
    }
    $Checks.Add((New-CuiCheckResult -Check 'User is authenticated' -Pass $IsAuth `
        -Detail $(if ($IsAuth) { 'Authenticated' } else { 'Anonymous — skipping mutation checks' }) -Ms $AuthCheck.ResponseMs))

    if (-not $IsAuth) {
        $Sw.Stop()
        return (New-CuiTestResult -CuiId 'CUI-TAX-010' -Domain 'Taxonomy' -Priority 'P0' `
            -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray() `
            -ErrorMessage 'Skipped: no auth credentials provided')
    }

    # Check 2: Load taxonomy and pick a node
    $r = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/taxonomy/accelerationist' -TimeoutSec $TimeoutSec -ExpectedField 'nodes'
    $HasNodes = $r.Success -and $r.Body.PSObject.Properties['nodes'] -and @($r.Body.nodes).Count -gt 0
    $Checks.Add((New-CuiCheckResult -Check 'Load taxonomy' -Pass $HasNodes `
        -Detail $(if ($HasNodes) { 'Loaded' } else { "Failed: $($r.Error)" }) -Ms $r.ResponseMs))

    if (-not $HasNodes) {
        $Sw.Stop()
        return (New-CuiTestResult -CuiId 'CUI-TAX-010' -Domain 'Taxonomy' -Priority 'P0' `
            -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray())
    }

    # Note original state for cleanup
    $OriginalNodes = $r.Body
    $TestNode = $r.Body.nodes[0]
    $OriginalDesc = ''
    if ($TestNode.PSObject.Properties['description']) {
        $OriginalDesc = $TestNode.description
    }
    $TestMarker = "__CUI_TEST_$(Get-Date -Format 'yyyyMMddHHmmss')__"

    # Check 3: PUT with test marker
    $TestNode.description = "$OriginalDesc $TestMarker"
    $PutBody = $OriginalNodes | ConvertTo-Json -Depth 20 -Compress
    $PutSw = [System.Diagnostics.Stopwatch]::StartNew()
    $PutOk = $false
    try {
        $PutHeaders = Get-CuiTaxonomyWriteHeaders -BaseUrl $BaseUrl -Pov 'accelerationist' -Headers $AuthHeaders -TimeoutSec $TimeoutSec
        $PutResp = Invoke-WebRequest -Uri "$BaseUrl/api/taxonomy/accelerationist" -Method PUT `
            -Body $PutBody -ContentType 'application/json' -TimeoutSec $TimeoutSec `
            -UseBasicParsing -ErrorAction Stop -Headers $PutHeaders
        $PutOk = $PutResp.StatusCode -eq 200
    } catch { $PutOk = $false }
    $PutSw.Stop()
    $Checks.Add((New-CuiCheckResult -Check 'PUT edit succeeds' -Pass $PutOk `
        -Detail $(if ($PutOk) { 'Saved' } else { 'PUT failed' }) -Ms $PutSw.ElapsedMilliseconds))

    # Check 4: GET and verify marker persists
    $VerifyR = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/taxonomy/accelerationist' -TimeoutSec $TimeoutSec -ExpectedField 'nodes'
    $MarkerFound = $false
    if ($VerifyR.Success -and $VerifyR.Body.PSObject.Properties['nodes']) {
        $VerifyNode = $VerifyR.Body.nodes[0]
        if ($VerifyNode.PSObject.Properties['description']) {
            $MarkerFound = $VerifyNode.description -like "*$TestMarker*"
        }
    }
    $Checks.Add((New-CuiCheckResult -Check 'Edit persists on GET' -Pass $MarkerFound `
        -Detail $(if ($MarkerFound) { 'Marker found' } else { 'Marker not found' }) -Ms $VerifyR.ResponseMs))

    # Check 5: Cleanup — restore original description
    $TestNode.description = $OriginalDesc
    $RestoreBody = $OriginalNodes | ConvertTo-Json -Depth 20 -Compress
    $RestoreOk = $false
    try {
        # Re-read the ETag: the edit PUT above changed the taxonomy version (t/4222).
        $RestoreHeaders = Get-CuiTaxonomyWriteHeaders -BaseUrl $BaseUrl -Pov 'accelerationist' -Headers $AuthHeaders -TimeoutSec $TimeoutSec
        $RestoreResp = Invoke-WebRequest -Uri "$BaseUrl/api/taxonomy/accelerationist" -Method PUT `
            -Body $RestoreBody -ContentType 'application/json' -TimeoutSec $TimeoutSec `
            -UseBasicParsing -ErrorAction Stop -Headers $RestoreHeaders
        $RestoreOk = $RestoreResp.StatusCode -eq 200
    } catch { $RestoreOk = $false }
    $Checks.Add((New-CuiCheckResult -Check 'Cleanup: restore original' -Pass $RestoreOk `
        -Detail $(if ($RestoreOk) { 'Restored' } else { 'Cleanup failed — manual restore needed' })))

    $Sw.Stop()
    New-CuiTestResult -CuiId 'CUI-TAX-010' -Domain 'Taxonomy' -Priority 'P0' `
        -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray()
}
