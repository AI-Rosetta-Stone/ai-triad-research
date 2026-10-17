# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AnalyticsEventTypes {
    <#
    .SYNOPSIS
        Show per-event-type counts from the deployed analytics query endpoint.
    .DESCRIPTION
        Read-side analytics diagnostic. Calls GET /api/analytics/query on a deployed
        taxonomy-editor and returns the aggregated per-event-type counts (the
        `eventTypes` map — analytics.ts). This is the discriminator that resolved
        t/2699: it immediately shows, e.g., `tab.switch: 42, view.dwell: 0`, exposing
        a client instrumentation gap (DwellTracker emitting no view.dwell events)
        without server-log triage.

        Complements Test-AnalyticsBlobHealth (write path: container reachable, blobs
        landing) with the read path (what the query endpoint actually aggregates).

        The endpoint is anon-allowed (GET), but in AUTH_OPTIONAL a cookie-less request
        returns a 200 Sign-In interstitial (t/2683/t/2684), so this establishes an
        anonymous session first and threads it through the request.

        No AI calls are made — this is a purely offline diagnostic against a deployment.
    .PARAMETER Days
        Look-back window in days (maps to the endpoint's from/to range). Default: 7.
        The server caps aggregation history independently; large windows are fine.
    .PARAMETER Env
        Target environment: 'prod' (default) resolves to Get-TaxEditorBaseUrl;
        'staging' resolves to $env:TAXEDITOR_STAGING_URL. Ignored when -BaseUrl is
        given explicitly.
    .PARAMETER BaseUrl
        Explicit base URL. Overrides -Env. Default: resolved from -Env.
    .PARAMETER TimeoutSec
        Per-request timeout. Default: 30.
    .OUTPUTS
        [PSCustomObject] rows with EventType and Count (descending by Count).
    .EXAMPLE
        Get-AnalyticsEventTypes
    .EXAMPLE
        Get-AnalyticsEventTypes -Days 14 -Env staging
    .EXAMPLE
        Get-AnalyticsEventTypes | Where-Object Count -eq 0   # instrumentation gaps
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AnalyticsBlobHealth
    .LINK
        Test-TaxEditorHealth
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [ValidateRange(1, 365)]
        [int]$Days = 7,

        [Parameter()]
        [ValidateSet('prod', 'staging')]
        [string]$Env = 'prod',

        [Parameter()]
        [string]$BaseUrl,

        [Parameter()]
        [ValidateRange(1, 600)]
        [int]$TimeoutSec = 30
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Get-AnalyticsEventTypes'

    # ── Resolve base URL ─────────────────────────────────────────────────
    if (-not $BaseUrl) {
        if ($Env -eq 'staging') {
            $BaseUrl = $env:TAXEDITOR_STAGING_URL
            if (-not $BaseUrl) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Query analytics event types on staging' `
                    -Problem 'No staging URL configured (-Env staging)' `
                    -Location $CallerName `
                    -NextSteps @('Set $env:TAXEDITOR_STAGING_URL to the staging base URL',
                                 'Or pass -BaseUrl explicitly'))
            }
        }
        else {
            $BaseUrl = Get-TaxEditorBaseUrl
        }
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')

    # ── Establish anon session (avoid the AUTH_OPTIONAL interstitial, t/2684) ──
    $Session = New-AnonymousWebSession -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    if (-not $Session) {
        Write-Host '  (anonymous session not established — the query may return the auth interstitial)' -ForegroundColor DarkYellow
    }

    # ── Query the aggregated endpoint ────────────────────────────────────
    $From = (Get-Date).ToUniversalTime().AddDays(-$Days).ToString('yyyy-MM-dd')
    $To   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    $Path = "/api/analytics/query?from=$From&to=$To"

    $Params = @{ BaseUrl = $BaseUrl; Path = $Path; Method = 'GET'; TimeoutSec = $TimeoutSec; AcceptableStatusCodes = @(200) }
    if ($Session) { $Params.Session = $Session }
    $Check = Invoke-RemoteCheck @Params

    if (-not $Check.Success) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Query analytics event types' `
            -Problem "GET /api/analytics/query failed (status=$($Check.StatusCode))$(if ($Check.Error) { ": $($Check.Error)" })" `
            -Location $CallerName `
            -NextSteps @("Verify the deployment is reachable: $BaseUrl",
                         'Check Test-TaxEditorHealth for liveness/readiness'))
    }

    if (-not ($Check.Body -and $Check.Body.PSObject.Properties['eventTypes'])) {
        # A 200 with no eventTypes is the auth interstitial or an unexpected shape.
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Query analytics event types' `
            -Problem 'Response had no eventTypes field (likely the auth Sign-In interstitial or an unexpected payload)' `
            -Location $CallerName `
            -NextSteps @('Confirm the anonymous session was established (re-run; watch for the warning above)',
                         'Verify /api/analytics/query is anon-allowed on this deployment'))
    }

    # ── Emit per-event-type rows (descending by count) ───────────────────
    $Total = 0
    if ($Check.Body.PSObject.Properties['summary'] -and $Check.Body.summary -and
        $Check.Body.summary.PSObject.Properties['totalEvents']) {
        $Total = [int]$Check.Body.summary.totalEvents
    }

    $Rows = [System.Collections.Generic.List[PSCustomObject]]::new()
    foreach ($Prop in $Check.Body.eventTypes.PSObject.Properties) {
        $Rows.Add([PSCustomObject]@{
            EventType = $Prop.Name
            Count     = [int]$Prop.Value
        })
    }
    $Sorted = @($Rows | Sort-Object -Property @{ Expression = 'Count'; Descending = $true }, EventType)

    Write-Host "`nAnalytics event types — $BaseUrl ($From..$To)" -ForegroundColor Cyan
    Write-Host "  $($Sorted.Count) event type(s), $Total event(s) total" -ForegroundColor Gray
    if ($Sorted.Count -eq 0) {
        Write-Host '  (no events aggregated in this window)' -ForegroundColor Yellow
    }
    Write-Host ''

    $Sorted
}
