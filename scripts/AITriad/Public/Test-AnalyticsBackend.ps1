# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-AnalyticsBackend {
    <#
    .SYNOPSIS
        Tests the analytics storage round-trip: POST a synthetic event, then GET
        and verify it appears in the query result.
    .DESCRIPTION
        Confirms analytics write/read path health in under 60 seconds.
        Useful after deploys or config changes to catch silent Blob write failures
        (the server always returns 200 regardless of whether the backend stored
        the event).

        Two checks are performed:
          1. Write — POST to /api/analytics/event; pass if ok=true and count=1.
             count=0 means the event was silently dropped by the server sanitizer
             (missing required fields) — indicates a test-payload bug, not a
             backend failure.
          2. Read  — GET /api/analytics/query; pass if summary.totalEvents >= 1
             and the synthetic event_type appears in eventTypes.
    .PARAMETER BaseUrl
        The Taxonomy Editor base URL. Default: production URL from Get-TaxEditorBaseUrl.
    .PARAMETER TimeoutSec
        HTTP request timeout per call. Default: 10.
    .PARAMETER WaitSec
        Seconds to wait between POST and GET to allow the async append to settle.
        Default: 2.
    .EXAMPLE
        Test-AnalyticsBackend
    .EXAMPLE
        Test-AnalyticsBackend -BaseUrl 'https://staging.example.io'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AzureHealth
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Position = 0)]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 10,

        [Parameter()]
        [ValidateRange(0, 30)]
        [int]$WaitSec = 2,

        # Request headers of an administrator's session. With them the read probe confirms the event was
        # persisted. Without them the read probe is not run: the query route is administrator-only since
        # incident t/579, and this cmdlet does not read it anonymously.
        [Parameter()]
        [hashtable]$AuthHeaders = @{}
    )

    Set-StrictMode -Version Latest
    $BaseUrl = if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl.TrimEnd('/') } else { '' }
    $Checks = [System.Collections.Generic.List[PSObject]]::new()

    # Unique probe marker so the read probe can confirm this specific event appears.
    $ProbeId   = [System.Guid]::NewGuid().ToString('N')
    $ProbeType = "diag.probe-$ProbeId"
    $ProbeTs   = (Get-Date).ToUniversalTime().ToString('o')

    # ── Write probe ─────────────────────────────────────────────────────────
    $WritePayload = @{
        events = @(
            @{
                user       = 'Test-AnalyticsBackend'
                session_id = $ProbeId
                timestamp  = $ProbeTs
                event_type = $ProbeType
                category   = 'diagnostics'
                detail     = @{ probe = $true }
            }
        )
    }

    $WriteResult = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/analytics/event' `
        -Method POST -Body $WritePayload -TimeoutSec $TimeoutSec -ExpectJson

    $WriteOk    = $WriteResult.Body -and $WriteResult.Body.PSObject.Properties['ok'] -and [bool]$WriteResult.Body.ok
    $WriteCount = if ($WriteResult.Body -and $WriteResult.Body.PSObject.Properties['count']) { [int]$WriteResult.Body.count } else { -1 }
    $WritePass  = $WriteResult.Success -and $WriteOk -and $WriteCount -eq 1

    $WriteDetail = if ($WriteResult.Success -and $WriteResult.Body) {
        $OkVal    = if ($WriteResult.Body.PSObject.Properties['ok'])    { $WriteResult.Body.ok    } else { 'missing' }
        $CountVal = if ($WriteResult.Body.PSObject.Properties['count']) { $WriteResult.Body.count } else { 'missing' }
        "ok=$OkVal count=$CountVal$(if ($WriteCount -eq 0) { ' (event dropped by sanitizer — check payload fields)' })"
    }
    else {
        if ($WriteResult.Error) { $WriteResult.Error } else { "HTTP $($WriteResult.StatusCode)" }
    }

    $Checks.Add([PSCustomObject]@{
        Check      = 'Analytics Write (POST /api/analytics/event)'
        Pass       = $WritePass
        ResponseMs = $WriteResult.ResponseMs
        Detail     = $WriteDetail
    })

    # ── Wait for async append ────────────────────────────────────────────────
    if ($WaitSec -gt 0) {
        Write-Verbose "Waiting ${WaitSec}s for analytics append to settle..."
        Start-Sleep -Seconds $WaitSec
    }

    # ── Read probe (administrator only: t/579, t/592) ────────────────────────
    # GET /api/analytics/query exposed user identifiers to anonymous callers and now refuses them. Without
    # an administrator's headers the probe is not run, and the result says so: the write probe alone
    # cannot confirm that the event was persisted.
    $HasAuth = $AuthHeaders -and $AuthHeaders.Count -gt 0
    if (-not $HasAuth) {
        Write-Warning 'Test-AnalyticsBackend: read probe needs admin (t/579), skipped: only the event write was checked, so persistence is not confirmed. Pass -AuthHeaders with an administrator''s session headers to run it.'
        return [PSCustomObject]@{
            Backend   = $BaseUrl
            Healthy   = @($Checks | Where-Object { -not $_.Pass }).Count -eq 0
            Checks    = @($Checks)
            Timestamp = (Get-Date).ToString('o')
        }
    }
    $Today      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    $ReadResult = Invoke-RemoteCheck -BaseUrl $BaseUrl `
        -Path "/api/analytics/query?from=$Today&to=$Today" `
        -TimeoutSec $TimeoutSec -ExpectJson -ExtraHeaders $AuthHeaders

    $ReadPass   = $false
    $ReadDetail = ''

    if ($ReadResult.Success -and $ReadResult.Body) {
        $Body = $ReadResult.Body
        $HasSummary = $Body.PSObject.Properties['summary']
        $TotalEvents = if ($HasSummary -and $Body.summary.PSObject.Properties['totalEvents']) {
            [int]$Body.summary.totalEvents
        } else { 0 }

        $ProbeVisible = $Body.PSObject.Properties['eventTypes'] -and
                        $Body.eventTypes.PSObject.Properties[$ProbeType]

        if ($ProbeVisible) {
            $ReadPass   = $true
            $ReadDetail = "probe event_type confirmed in eventTypes (totalEvents=$TotalEvents)"
        }
        elseif ($HasSummary) {
            $ReadDetail = "query succeeded but probe event_type '$ProbeType' absent from eventTypes (totalEvents=$TotalEvents) — write may have failed silently"
        }
        else {
            $ReadDetail = "unexpected response shape: summary field missing"
        }
    }
    else {
        $ReadDetail = if ($ReadResult.Error) { $ReadResult.Error }
                      elseif ($ReadResult.StatusCode -in @(302, 401, 403)) {
                          "Auth required (HTTP $($ReadResult.StatusCode)): the -AuthHeaders given are not a signed-in administrator's session"
                      }
                      else { "HTTP $($ReadResult.StatusCode)" }
    }

    $Checks.Add([PSCustomObject]@{
        Check      = 'Analytics Read (GET /api/analytics/query)'
        Pass       = $ReadPass
        ResponseMs = $ReadResult.ResponseMs
        Detail     = $ReadDetail
    })

    # ── Summary ──────────────────────────────────────────────────────────────
    $AllPass = @($Checks | Where-Object { -not $_.Pass }).Count -eq 0

    [PSCustomObject]@{
        Backend   = $BaseUrl
        Healthy   = $AllPass
        Checks    = @($Checks)
        Timestamp = (Get-Date).ToString('o')
    }
}
