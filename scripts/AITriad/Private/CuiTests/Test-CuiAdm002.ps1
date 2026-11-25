# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-CuiAdm002 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter()][int]$TimeoutSec = 15,
        [Parameter()][hashtable]$AuthHeaders = @{}
    )

    Set-StrictMode -Version Latest
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Checks = [System.Collections.Generic.List[PSObject]]::new()
    # All three routes are administrator-only (the analytics query since incident t/579): the caller's
    # -AuthHeaders go on every request. With none the checks fail with the server's refusal, which is the
    # honest result for an admin CUI run as nobody.
    $Auth = @{}
    if ($AuthHeaders -and $AuthHeaders.Count -gt 0) { $Auth['ExtraHeaders'] = $AuthHeaders }

    # Check 1: GET /api/admin/telemetry/summary returns data
    $r = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/admin/telemetry/summary' -TimeoutSec $TimeoutSec @Auth
    $TelemetryOk = $r.Success -and ($null -ne $r.Body)
    $Checks.Add((New-CuiCheckResult -Check 'Telemetry summary endpoint' -Pass $TelemetryOk `
        -Detail $(if ($TelemetryOk) { 'Summary loaded' } else { "Failed: $($r.Error)" }) -Ms $r.ResponseMs))

    # Check 2: GET /api/analytics/query returns analytics data
    $ar = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/analytics/query' -TimeoutSec $TimeoutSec @Auth
    $AnalyticsOk = $ar.Success -and ($null -ne $ar.Body)
    $Checks.Add((New-CuiCheckResult -Check 'Analytics query endpoint' -Pass $AnalyticsOk `
        -Detail $(if ($AnalyticsOk) { 'Analytics loaded' } else { "Failed: $($ar.Error)" }) -Ms $ar.ResponseMs))

    # Check 3: GET /api/admin/review/stats returns review statistics
    $sr = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/admin/review/stats' -TimeoutSec $TimeoutSec @Auth
    $StatsOk = $sr.Success -and ($null -ne $sr.Body)
    $Checks.Add((New-CuiCheckResult -Check 'Review stats endpoint' -Pass $StatsOk `
        -Detail $(if ($StatsOk) { 'Stats loaded' } else { "Failed: $($sr.Error)" }) -Ms $sr.ResponseMs))

    $Sw.Stop()
    New-CuiTestResult -CuiId 'CUI-ADM-002' -Domain 'Admin' -Priority 'P1' `
        -DurationMs $Sw.ElapsedMilliseconds -Details $Checks.ToArray()
}
