# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-TaxEditorSmokeTest {
    <#
    .SYNOPSIS
        Runs a comprehensive remote smoke test against the deployed Taxonomy Editor.
    .DESCRIPTION
        Orchestrates Test-TaxEditorHealth, Test-TaxEditorEndpoints,
        Test-AzureHealth, and Test-GitHubHealth, plus an analytics write/read
        round-trip probe (t/2667), then produces a summary report with pass/fail
        counts, response time stats, and per-category breakdowns. The analytics
        probe reads aggregated totalEvents, POSTs a synthetic event, and re-reads
        to confirm the count increased — catching silent blob-storage drops that
        still return HTTP 200. With -AssertDataPresence, an additional phase (t/2671)
        asserts entities/organizations/taxonomy-nodes return JSON with > 0 rows over
        an anonymous session — catching empty data and auth-interstitial false-greens.
    .PARAMETER BaseUrl
        The base URL of the deployed Taxonomy Editor site.
    .PARAMETER TimeoutSec
        HTTP request timeout in seconds per endpoint. Default: 15.
    .PARAMETER HealthMaxAttempts
        Cold-start tolerance for the Health-Checks phase (t/1696). Polls the
        health probe up to this many attempts, returning on the first healthy
        result, so a scale-from-zero container whose first request exceeds
        TimeoutSec is not false-red'd. Default: 5. Set to 1 for fast-fail
        (single-shot, prior behavior).
    .PARAMETER HealthRetryIntervalSec
        Seconds to sleep between health-probe attempts when HealthMaxAttempts > 1.
        Default: 10.
    .PARAMETER DeployedSha
        When provided, passes the commit SHA to Test-GitHubHealth so the ci.yml
        check queries by exact SHA instead of branch=main. Fail-closed: no
        completed CI run for the SHA → GitHub check fails. Intended for use in
        the deploy workflow immediately after a push (t/2639).
    .PARAMETER Detailed
        Show per-endpoint results in addition to the summary.
    .PARAMETER AssertDataPresence
        Run the data-presence phase (t/2671): establish an anonymous session, then
        assert /api/entities, /api/organizations, and /api/taxonomy/<pov> return
        JSON with > 0 rows — not just HTTP 200. Off by default so local runs (which
        may not point at a data-populated instance) are unaffected; the deploy
        workflow passes it. Catches the escape where the endpoint smoke went 26/26
        green while data was empty on web, and where an auth Sign-In interstitial
        (200 text/html) is mistaken for real data.
    .EXAMPLE
        Invoke-TaxEditorSmokeTest
    .EXAMPLE
        Invoke-TaxEditorSmokeTest -Detailed
    .EXAMPLE
        Invoke-TaxEditorSmokeTest -BaseUrl 'https://staging.example.io' | ConvertTo-Json -Depth 5
    .LINK
        Show-AITriadHelp
    .LINK
        Test-TaxEditorHealth
    .LINK
        Test-TaxEditorEndpoints
    .LINK
        Test-AnonymousDebateFlow
    .LINK
        Test-PersonaEndpoints
    .LINK
        Test-ServiceWorkerHealth
    .LINK
        Get-FreeTierStatus
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 15,

        [Parameter()]
        [ValidateRange(1, 60)]
        [int]$HealthMaxAttempts = 5,

        [Parameter()]
        [ValidateRange(1, 300)]
        [int]$HealthRetryIntervalSec = 10,

        [Parameter()]
        [string]$DeployedSha = '',

        [Parameter()]
        [switch]$Detailed,

        [Parameter()]
        [switch]$AssertDataPresence,

        # t/3088 — wall-time ceiling (seconds) for the embedding-latency perf probe.
        # Calibrated against real prod post-t/3085 numbers (Diagnostics verify, deploy-64c7772):
        #   cache-HIT embeddings.compute is <200ms server-side (1ms pure hit / 183ms warm max
        #   incl. ~4 genuine dynamic-text misses); a regressed cache-MISS runs 24-56s (some
        #   500-ing at the 50s ONNX-init timeout) — a ~130x gap.
        # 2s = ~11x headroom over the warm max (safe for client-side network variance and the
        # thin n=2 sample) and ~12x below the miss floor, so it catches the regression with
        # margin without false-warning on normal jitter. Deliberately NOT set below ~1s: a
        # request landing on a cold revision before prewarm completes transiently recomputes
        # (the 24-56s spikes; t/3112 /readyz will gate this), so the category stays WARN-FIRST
        # (excluded from OverallPass) — a breach is a monitoring signal, not a hard failure.
        [Parameter()]
        [ValidateRange(0.1, 60)]
        [double]$EmbeddingCeilingSec = 2
    )

    Set-StrictMode -Version Latest

    $StartTime = Get-Date
    Write-Host "Smoke testing: $BaseUrl" -ForegroundColor Cyan
    Write-Host ''

    # Each phase prints its own section and returns its results (Private/TaxEditorSmokeTestPhases.ps1).
    $Health        = Invoke-SmokeHealthPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec `
        -MaxAttempts $HealthMaxAttempts -RetryIntervalSec $HealthRetryIntervalSec
    $Endpoints     = @(Invoke-SmokeEndpointPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec)
    $AnonEndpoints = @(Invoke-SmokeAnonEndpointPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec)
    $Azure         = Invoke-SmokeAzurePhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    $GitHub        = Invoke-SmokeGitHubPhase -TimeoutSec $TimeoutSec -DeployedSha $DeployedSha
    $Analytics     = @(Invoke-SmokeAnalyticsPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec)
    $DataPresence  = @()
    if ($AssertDataPresence) {
        $DataPresence = @(Invoke-SmokeDataPresencePhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec)
    }
    $OpedFiles = Invoke-SmokeOpedFilesPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    $Embedding = Invoke-SmokeEmbeddingLatencyPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec -CeilingSec $EmbeddingCeilingSec
    $Cache     = Invoke-SmokeCachePresencePhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    $IdentityAllowlist = Invoke-SmokeIdentityAllowlistPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec

    # ── Summary ──────────────────────────────────────────────────────────
    $AllResults = @($Endpoints) + @($AnonEndpoints) + @($Analytics) + @($DataPresence) + @($OpedFiles.Result)
    $Passed = @($AllResults | Where-Object { $_.Pass }).Count
    $Failed = @($AllResults | Where-Object { -not $_.Pass }).Count
    $Total = $AllResults.Count
    $Stats = Get-SmokeResponseStatistic -AllResults $AllResults
    $CategorySummary = Get-SmokeCategorySummary -AllResults $AllResults

    $Duration = (Get-Date) - $StartTime
    # t/2673 — gate on app health only (Health + Endpoints + Azure). GitHubOk is
    # reported below and surfaced as a warning when degraded, but is intentionally
    # excluded here so a transient GitHub API flap cannot false-red the deploy gate.
    $OverallPass = $Health.Healthy -and $Failed -eq 0 -and $Azure.Healthy

    Write-SmokeSummary -OverallPass $OverallPass -HealthOk $Health.Healthy -AzureOk $Azure.Healthy -GitHubOk $GitHub.Healthy `
        -Passed $Passed -Total $Total -Stats $Stats -Duration $Duration -Detailed $Detailed -CategorySummary $CategorySummary

    [PSCustomObject]@{
        BaseUrl         = $BaseUrl
        OverallPass     = $OverallPass
        HealthOk        = $Health.Healthy
        AzureOk         = $Azure.Healthy
        GitHubOk        = $GitHub.Healthy
        OpedFilesOk     = $OpedFiles.Pass
        EmbeddingStatus     = $Embedding.Status
        EmbeddingLatencyMs  = $Embedding.Ms
        EmbeddingCeilingSec = $EmbeddingCeilingSec
        EmbeddingCachePresent = $Cache.Present
        EmbeddingCacheStatus  = $Cache.Status
        IdentityAllowlistUnreachable      = $IdentityAllowlist.Count
        IdentityAllowlistKnownPendingCount = $IdentityAllowlist.KnownPendingCount
        IdentityAllowlistStatus           = $IdentityAllowlist.Status
        EndpointsPassed = $Passed
        EndpointsFailed = $Failed
        EndpointsTotal  = $Total
        AvgResponseMs   = $Stats.Avg
        MaxResponseMs   = $Stats.Max
        MinResponseMs   = $Stats.Min
        DurationSec     = [math]::Round($Duration.TotalSeconds, 1)
        Categories      = @($CategorySummary)
        FailedEndpoints = @($AllResults | Where-Object { -not $_.Pass })
        Timestamp       = (Get-Date).ToString('o')
    }
}
