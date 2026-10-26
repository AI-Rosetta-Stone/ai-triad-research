# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# The phases of Invoke-TaxEditorSmokeTest, one function each (t/3910 complexity refactor).
# Pure move: host text, result objects and gate semantics are pinned by
# tests/Invoke-TaxEditorSmokeTest.Characterization.Tests.ps1 (golden transcripts) and the
# five Invoke-TaxEditorSmokeTest.*.Tests.ps1 files. The why-comments for each phase stay
# with the phase.

function Write-SmokeCheckLine {
    # One "[PASS]/[FAIL] text" line, plus an indented DarkRed detail line when $ShowDetail.
    param([bool]$Pass, [string]$Text, [bool]$ShowDetail = $false, [string]$Detail = '')
    $Icon = if ($Pass) { '[PASS]' } else { '[FAIL]' }
    $Color = if ($Pass) { 'Green' } else { 'Red' }
    Write-Host "  $Icon $Text" -ForegroundColor $Color
    if ($ShowDetail) {
        Write-Host "        $Detail" -ForegroundColor DarkRed
    }
}

function ConvertTo-SmokeEndpointResult {
    # An [EndpointTestResult] from named fields; Error is set only when given.
    param([string]$Endpoint, [string]$Category, [string]$Description, $Status, [bool]$Pass, $Ms, $NodeCount, $ErrorText)
    $R = [EndpointTestResult]::new()
    $R.Endpoint    = $Endpoint
    $R.Category    = $Category
    $R.Description = $Description
    $R.Status      = $Status
    $R.Pass        = $Pass
    $R.Ms          = $Ms
    $R.NodeCount   = $NodeCount
    if ($PSBoundParameters.ContainsKey('ErrorText')) { $R.Error = $ErrorText }
    return $R
}

function Invoke-SmokeHealthPhase {
    # ── Phase 1: Health checks ───────────────────────────────────────────
    # t/1696 — tolerate a scale-from-zero cold start: retry the health probe so a
    # healthy-but-cold container (whose first request exceeds TimeoutSec) is not
    # false-red'd. Mirrors the deploy workflow's cold-start-tolerant health gate
    # (deploy-azure.yml: Test-TaxEditorHealth -MaxAttempts 42 -RetryIntervalSec 10).
    param([string]$BaseUrl, [int]$TimeoutSec, [int]$MaxAttempts, [int]$RetryIntervalSec)
    Write-Host '=== Health Checks ===' -ForegroundColor Cyan
    $Health = Test-TaxEditorHealth -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec `
        -MaxAttempts $MaxAttempts -RetryIntervalSec $RetryIntervalSec
    foreach ($Check in $Health.Checks) {
        Write-SmokeCheckLine -Pass $Check.Healthy -Text "$($Check.Endpoint) ($($Check.Purpose)) — $($Check.Ms)ms" `
            -ShowDetail (-not $Check.Healthy) -Detail $Check.Detail
    }
    Write-Host ''
    return $Health
}

function Invoke-SmokeEndpointPhase {
    # ── Phase 2: Endpoint smoke tests ────────────────────────────────────
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Endpoint Tests ===' -ForegroundColor Cyan
    $Endpoints = @(Test-TaxEditorEndpoints -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec)
    foreach ($Ep in $Endpoints) {
        $Extra = if ($Ep.NodeCount) { " ($($Ep.NodeCount) nodes)" } else { '' }
        Write-SmokeCheckLine -Pass $Ep.Pass -Text "$($Ep.Endpoint) — $($Ep.Status) $($Ep.Ms)ms$Extra" `
            -ShowDetail (-not $Ep.Pass -and $Ep.Error) -Detail $Ep.Error
    }
    Write-Host ''
    return $Endpoints
}

function Invoke-SmokeAnonEndpointPhase {
    # t/2374 — anonymous community pass: re-runs Community endpoints as an anon user
    # to catch auth-scope contract bugs (t/2368: listed items must be loadable by the
    # listing user). Included in the default run so staging always exercises anon paths.
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Anon Community Endpoints ===' -ForegroundColor Cyan
    $AnonEndpoints = @(Test-TaxEditorEndpoints -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec `
        -Category Community -UserType Anonymous)
    foreach ($Ep in $AnonEndpoints) {
        Write-SmokeCheckLine -Pass $Ep.Pass -Text "[anon] $($Ep.Endpoint) — $($Ep.Status) $($Ep.Ms)ms" `
            -ShowDetail (-not $Ep.Pass -and $Ep.Error) -Detail $Ep.Error
    }
    Write-Host ''
    return $AnonEndpoints
}

function Invoke-SmokeAzurePhase {
    # ── Phase 3: Azure infrastructure ───────────────────────────────────
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Azure Infrastructure ===' -ForegroundColor Cyan
    $Azure = Test-AzureHealth -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    foreach ($Check in $Azure.Checks) {
        Write-SmokeCheckLine -Pass $Check.Pass -Text "$($Check.Check) — $($Check.Detail)"
    }
    Write-Host ''
    return $Azure
}

function Invoke-SmokeGitHubPhase {
    # ── Phase 4: GitHub services ─────────────────────────────────────────
    param([int]$TimeoutSec, [string]$DeployedSha)
    Write-Host '=== GitHub Services ===' -ForegroundColor Cyan
    $GitHubSplatArgs = @{ TimeoutSec = $TimeoutSec }
    if ($DeployedSha) { $GitHubSplatArgs['DeployedSha'] = $DeployedSha }
    $GitHub = Test-GitHubHealth @GitHubSplatArgs
    foreach ($Check in $GitHub.Checks) {
        Write-SmokeCheckLine -Pass $Check.Pass -Text "$($Check.Check) — $($Check.Detail)"
    }
    # t/2673 — GitHub health (status page, rate limits, GHCR) is a monitoring
    # signal, not app health. A transient GitHub API flap must NOT sink the gate
    # when the app itself is fully healthy — it caused a false-negative rollback on
    # the step-1 staging isolation deploy (run 31890116255, 2026-08-15). Surface a
    # degraded GitHub check as a CI warning; OverallPass gates only on
    # Health/Endpoints/Azure (see the $OverallPass computation in Invoke-TaxEditorSmokeTest).
    if (-not $GitHub.Healthy) {
        Write-Host "::warning::GitHub services degraded — monitoring signal only, does not block the traffic shift. See '=== GitHub Services ===' above."
    }
    Write-Host ''
    return $GitHub
}

function Get-SmokeTotalEventCount {
    # Guarded extractor: pull summary.totalEvents from an Invoke-RemoteCheck result,
    # or $null when the read failed / the field is absent (StrictMode-safe).
    param($Check)
    if ($Check.Success -and $Check.Body -and
        $Check.Body.PSObject.Properties['summary'] -and $Check.Body.summary -and
        $Check.Body.summary.PSObject.Properties['totalEvents']) {
        return [int]$Check.Body.summary.totalEvents
    }
    return $null
}

function Invoke-SmokeAnalyticsQuery {
    # One Invoke-RemoteCheck for the analytics phase, threading the anon session when there is one.
    param([string]$BaseUrl, [string]$Path, [string]$Method, [int]$TimeoutSec, $Session, [string]$Body)
    $Params = @{ BaseUrl = $BaseUrl; Path = $Path; Method = $Method; TimeoutSec = $TimeoutSec; AcceptableStatusCodes = @(200) }
    if ($PSBoundParameters.ContainsKey('Body')) { $Params.Body = $Body }
    if ($Session) { $Params.Session = $Session }
    return (Invoke-RemoteCheck @Params)
}

function Get-SmokeAnalyticsEventJson {
    # Write probe — reachability only (200 + ok:true). NOT a drop detector.
    # Build the body as an explicit JSON string so the single-element `events`
    # array is never unwrapped to an object (the server requires an array — 400 otherwise).
    # Two events in one batch: smoke-probe (system category) + view.dwell (engagement)
    # so the after-read can assert eventTypes['view.dwell'] >= 1 (t/2706 AC).
    $ProbeStamp   = [DateTimeOffset]::UtcNow.ToString('o')
    $ProbeSession = "smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $ProbeEvent   = @{
        user       = 'smoke-probe'
        session_id = $ProbeSession
        timestamp  = $ProbeStamp
        event_type = 'smoke-probe'
        category   = 'system'
        detail     = @{}
    }
    $DwellEvent   = @{
        user       = 'smoke-probe'
        session_id = $ProbeSession
        timestamp  = $ProbeStamp
        event_type = 'view.dwell'
        category   = 'engagement'
        detail     = @{ duration_ms = 100 }
    }
    return '{"events":[' + ($ProbeEvent | ConvertTo-Json -Depth 6 -Compress) + ',' + ($DwellEvent | ConvertTo-Json -Depth 6 -Compress) + ']}'
}

function Get-SmokeAnalyticsWriteResult {
    param($WriteCheck)
    $WriteOk = $false
    if ($WriteCheck.Success -and $WriteCheck.Body -and $WriteCheck.Body.PSObject.Properties['ok']) {
        $WriteOk = [bool]$WriteCheck.Body.ok
    }
    $WritePass = $WriteCheck.Success -and $WriteOk
    $Fields = @{
        Endpoint = 'POST /api/analytics/event'; Category = 'Analytics'
        Description = 'Analytics write reachability (200 + ok:true)'
        Status = $WriteCheck.StatusCode; Pass = $WritePass; Ms = $WriteCheck.ResponseMs; NodeCount = $null
    }
    if (-not $WritePass) {
        $Fields.ErrorText = if ($WriteCheck.Error) {
            $WriteCheck.Error
        } else {
            "Unexpected write response (status=$($WriteCheck.StatusCode), ok=$WriteOk)"
        }
    }
    return (ConvertTo-SmokeEndpointResult @Fields)
}

function Get-SmokeAnalyticsDeltaResult {
    param($BaselineCheck, $AfterCheck, $Before, $After)
    $DeltaPass = $false
    $DeltaErr  = $null
    if ($null -eq $Before) {
        $DeltaErr = "Baseline read failed (status=$($BaselineCheck.StatusCode)) — cannot compute delta$(if ($BaselineCheck.Error) { ": $($BaselineCheck.Error)" })"
    } elseif ($null -eq $After) {
        $DeltaErr = "Read-back failed (status=$($AfterCheck.StatusCode)) — cannot confirm write landed$(if ($AfterCheck.Error) { ": $($AfterCheck.Error)" })"
    } else {
        $Delta = $After - $Before
        $DeltaPass = ($Delta -ge 1)
        if (-not $DeltaPass) {
            $DeltaErr = "Silent drop: totalEvents did not increase after write (before=$Before, after=$After, delta=$Delta) — event accepted but not persisted (blob backend misconfigured?)"
        }
    }
    return (ConvertTo-SmokeEndpointResult -Endpoint 'GET /api/analytics/query (delta read-back)' -Category 'Analytics' `
            -Description 'Analytics storage round-trip (totalEvents increased)' -Status $AfterCheck.StatusCode `
            -Pass $DeltaPass -Ms ($BaselineCheck.ResponseMs + $AfterCheck.ResponseMs) -NodeCount $After -ErrorText $DeltaErr)
}

function Get-SmokeAnalyticsDwellResult {
    # t/2706 — assert view.dwell event_type is recorded in eventTypes.
    # The write batch includes a view.dwell event; the after-read's
    # eventTypes map (QueryResult.eventTypes: Record<string,number>) must
    # contain 'view.dwell' >= 1. This catches a class of routing bug where
    # the event is accepted (200 ok) but silently discarded or mis-typed.
    param($AfterCheck)
    $DwellPass = $false
    $DwellErr  = $null
    if (-not $AfterCheck.Success) {
        $DwellErr = "after-read failed (status=$($AfterCheck.StatusCode)) — cannot check eventTypes"
    } elseif (-not $AfterCheck.Body -or -not $AfterCheck.Body.PSObject.Properties['eventTypes']) {
        $DwellErr = "eventTypes field missing from /api/analytics/query response"
    } else {
        $EventTypes  = $AfterCheck.Body.eventTypes
        $DwellProp   = $EventTypes.PSObject.Properties['view.dwell']
        $DwellCount  = if ($DwellProp) { [int]$DwellProp.Value } else { 0 }
        $DwellPass   = ($DwellCount -ge 1)
        if (-not $DwellPass) {
            $DwellErr = "view.dwell absent or zero in eventTypes after probe write (count=$DwellCount) — event not persisted or event_type mis-routed"
        }
    }
    return (ConvertTo-SmokeEndpointResult -Endpoint 'GET /api/analytics/query (view.dwell eventType)' -Category 'Analytics' `
            -Description 'view.dwell event_type present in analytics after write (t/2706)' -Status $AfterCheck.StatusCode `
            -Pass $DwellPass -Ms $AfterCheck.ResponseMs -NodeCount $null -ErrorText $DwellErr)
}

function Invoke-SmokeAnalyticsPhase {
    # ── Phase 5: Analytics write/read round-trip (t/2667) ────────────────
    # Q3b prevention (failure Class 3): the blob analytics backend silently drops
    # events when misconfigured while the server still returns 200. The POST
    # response's `count` reflects sanitized REQUEST events (session.ts:179), and the
    # blob append is fire-and-forget (session.ts:172) — so the write alone can NEVER
    # confirm persistence. The authoritative detector is a DELTA READ-BACK: read the
    # aggregated totalEvents (read straight from blob storage — analytics.ts:301),
    # POST a synthetic event, wait for the async append, read again, and require the
    # count to increase. A silent drop leaves the count flat. (Design option A,
    # approved t/2667#6. GET /api/analytics/query is anon-allowed — accessControl.ts:335
    # — so this runs without a session token. Concurrent staging traffic between the
    # two reads is an accepted low-risk masking window on quiet staging.)
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Analytics Round-Trip ===' -ForegroundColor Cyan

    # Establish an anonymous session first. Both /api/analytics/event (POST) and
    # /api/analytics/query (GET) are anon-allowed, BUT in AUTH_OPTIONAL a cookie-less
    # request receives a 200 text/html Sign-In interstitial (see the data-presence phase)
    # — so a session-less round-trip POSTs into the interstitial (event never reaches the
    # handler) and reads the interstitial back as delta 0, a false "silent drop" that
    # blocked prod+staging deploys (t/2683 → t/2684). Mirror the t/2671 data-presence
    # phase: get the anon cookies, thread them through all three calls. If the session
    # can't be established, warn explicitly so a resulting read failure is not mistaken
    # for a persistence drop.
    $Session = New-AnonymousWebSession -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    if (-not $Session) {
        Write-Host '  (anonymous session not established — analytics round-trip may hit the auth interstitial; delta cannot be trusted)' -ForegroundColor DarkYellow
    }

    # Baseline read BEFORE the write.
    $BaselineCheck = Invoke-SmokeAnalyticsQuery -BaseUrl $BaseUrl -Path '/api/analytics/query' -Method 'GET' -TimeoutSec $TimeoutSec -Session $Session
    $Before = Get-SmokeTotalEventCount $BaselineCheck

    $WriteCheck = Invoke-SmokeAnalyticsQuery -BaseUrl $BaseUrl -Path '/api/analytics/event' -Method 'POST' `
        -Body (Get-SmokeAnalyticsEventJson) -TimeoutSec $TimeoutSec -Session $Session
    $Analytics = @(Get-SmokeAnalyticsWriteResult $WriteCheck)

    # Async blob append — give the write time to land before the read-back.
    Start-Sleep -Seconds 2

    # Read-back AFTER the write — the delta is the detector.
    $AfterCheck = Invoke-SmokeAnalyticsQuery -BaseUrl $BaseUrl -Path '/api/analytics/query' -Method 'GET' -TimeoutSec $TimeoutSec -Session $Session
    $After = Get-SmokeTotalEventCount $AfterCheck

    $Analytics += Get-SmokeAnalyticsDeltaResult -BaselineCheck $BaselineCheck -AfterCheck $AfterCheck -Before $Before -After $After
    $Analytics += Get-SmokeAnalyticsDwellResult $AfterCheck

    foreach ($Ep in $Analytics) {
        Write-SmokeCheckLine -Pass $Ep.Pass -Text "$($Ep.Endpoint) — $($Ep.Status) $($Ep.Ms)ms" `
            -ShowDetail (-not $Ep.Pass -and $Ep.Error) -Detail $Ep.Error
    }
    Write-Host ''
    return $Analytics
}

function Invoke-SmokeDataPresencePhase {
    # ── Phase 6: Data presence (t/2671) — opt-in via -AssertDataPresence ──
    # The endpoint smoke passed 26/26 green while Entities/Organizations were empty
    # on web (t/2648/t/2661): it asserts endpoints RESPOND, not that data POPULATES.
    # Worse, in AUTH_OPTIONAL a cookie-less GET returns a 200 text/html Sign-In
    # interstitial that a status-only check reads as PASS. This phase establishes an
    # anonymous session (so the app serves real JSON, not the interstitial —
    # accessControl.ts:335 anon-allows GETs; no admin token needed) and asserts each
    # data route returns application/json with > 0 rows. Failures flow into
    # FailedEndpoints → OverallPass. Off by default; the deploy workflow passes the switch.
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Data Presence ===' -ForegroundColor Cyan
    $DataSession = New-AnonymousWebSession -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
    if (-not $DataSession) {
        Write-Host '  (anonymous session not established — data GETs may return the auth interstitial)' -ForegroundColor DarkYellow
    }

    $DataRoutes = @(
        @{ Path = '/api/entities';                 Field = '';      Label = 'entities' }
        @{ Path = '/api/organizations';            Field = '';      Label = 'organizations' }
        @{ Path = '/api/taxonomy/accelerationist'; Field = 'nodes'; Label = 'taxonomy nodes' }
    )
    $DataPresence = @()
    foreach ($R in $DataRoutes) {
        $Params = @{ BaseUrl = $BaseUrl; Path = $R.Path; Method = 'GET'; TimeoutSec = $TimeoutSec; ExpectJson = $true }
        if ($DataSession) { $Params.Session = $DataSession }
        $Check  = Invoke-RemoteCheck @Params
        $Assert = Test-DataPresenceAssertion -Body $Check.Body -ContentType $Check.ContentType `
            -CountField $R.Field -Label $R.Label
        $Fields = @{
            Endpoint = "GET $($R.Path)"; Category = 'DataPresence'; Description = "Data presence: $($R.Label) > 0"
            Status = $Check.StatusCode; Pass = $Assert.Pass; Ms = $Check.ResponseMs; NodeCount = $Assert.Count
        }
        if (-not $Assert.Pass) {
            $Fields.ErrorText = "$($R.Label): $($Assert.Reason)$(if ($Check.Error) { " (http: $($Check.Error))" })"
        }
        $DataPresence += ConvertTo-SmokeEndpointResult @Fields
    }

    foreach ($Ep in $DataPresence) {
        Write-SmokeCheckLine -Pass $Ep.Pass -Text "$($Ep.Endpoint) — $($Ep.Status) ($($Ep.NodeCount) rows) $($Ep.Ms)ms" `
            -ShowDetail (-not $Ep.Pass -and $Ep.Error) -Detail $Ep.Error
    }
    Write-Host ''
    return $DataPresence
}

function Get-SmokeOpedFilesDetail {
    # The one-line verdict for the oped-files check, given the parsed body.
    param([bool]$Pass, [bool]$JsonOk, [bool]$BodyOk, $Check, $Json)
    if ($Pass) {
        $count = if ($Json -and $Json.PSObject.Properties['assets']) { @($Json.assets).Count } else { 0 }
        return "all assets present ($count files)"
    }
    if (-not $JsonOk) {
        return "non-JSON response (content-type=$($Check.ContentType), status=$($Check.StatusCode)) — endpoint unreachable or returned interstitial"
    }
    if (-not $BodyOk) {
        $missing = if ($Json -and $Json.PSObject.Properties['missing']) { ($Json.missing -join ', ') } else { 'ok:false (no missing list)' }
        return "MISSING: $missing (status=$($Check.StatusCode))"
    }
    return "failed (status=$($Check.StatusCode))"
}

function Invoke-SmokeOpedFilesPhase {
    # ── Phase 7: Oped-files runtime asset health (t/2689 AC3) ──────────────────
    # Asserts soul-docs + lib/oped/prompts are present in the container image.
    # Both-arms gate verified (#1124) + clean real-env cycle (#1122) — now blocking.
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Oped Files Health ===' -ForegroundColor Cyan
    # Accept both 200 (ok) and 500 (missing files) so Invoke-WebRequest doesn't throw on the
    # failure arm; we discriminate via ok:true/false in the body, not the HTTP status.
    $Check = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/health/oped-files' `
        -Method 'GET' -TimeoutSec $TimeoutSec -AcceptableStatusCodes @(200, 500)
    # Parse body explicitly — Invoke-RemoteCheck.Body may arrive as a raw string or as a
    # PSCustomObject depending on how ConvertFrom-Json behaved for this response. Parse
    # defensively so the ok/missing checks always operate on a structured object.
    # (t/2689: smoke false-warned on a valid {ok:true} response — body not parsed as object)
    $Json = if ($Check.Body -is [string]) {
        try { $Check.Body | ConvertFrom-Json -ErrorAction SilentlyContinue } catch { $null }
    } else { $Check.Body }
    # Require JSON content-type + ok:true — a 200 text/html response is the Sign-In
    # interstitial (any unknown GET before the endpoint is in PUBLIC_EXACT_PATHS).
    $JsonOk = [bool]($Check.ContentType -and ($Check.ContentType -like '*json*'))
    $BodyOk = [bool]($Json -and $Json.PSObject.Properties['ok'] -and [bool]$Json.ok)
    $Pass   = [bool]($Check.Success -and $JsonOk -and $BodyOk)
    $Detail = Get-SmokeOpedFilesDetail -Pass $Pass -JsonOk $JsonOk -BodyOk $BodyOk -Check $Check -Json $Json

    $OFIcon  = if ($Pass) { '[PASS]' } else { '[FAIL]' }
    $OFColor = if ($Pass) { 'Green' } else { 'Red' }
    Write-Host "  $OFIcon GET /api/health/oped-files — $($Check.StatusCode) $($Check.ResponseMs)ms — $Detail" -ForegroundColor $OFColor
    if (-not $Pass) {
        Write-Host "::error::Oped-files health check failed: $Detail"
    }
    Write-Host ''

    $Fields = @{
        Endpoint = 'GET /api/health/oped-files'; Category = 'OpedFiles'
        Description = 'Soul-docs + oped prompts present in container image'
        Status = $Check.StatusCode; Pass = $Pass; Ms = $Check.ResponseMs; NodeCount = $null
    }
    if (-not $Pass) { $Fields.ErrorText = $Detail }
    return [pscustomobject]@{ Pass = $Pass; Result = (ConvertTo-SmokeEndpointResult @Fields) }
}

function Invoke-SmokeEmbeddingLatencyPhase {
    # ── Phase 8: Embedding latency (t/3088) — perf-regression probe, its OWN category ──
    # embeddings.json was unreachable in prod for 3.5 months (t/3085): every debate
    # re-embedded ~3,600 static texts in-process at 25-48s/chunk where a cache hit is
    # milliseconds — invisible to error-rate gates because nothing FAILED. This probe
    # POSTs a small batch of known cached node ids and times the round-trip. Like the
    # GitHub check (t/2673), a breach is a monitoring signal surfaced as a ::warning::,
    # NOT a hard failure: it is EXCLUDED from $OverallPass so a slow embed can't
    # false-red Health/Endpoints/Azure. Warn-first — promote to gating only after the
    # ceiling is calibrated against real post-t/3085 prod timings.
    param([string]$BaseUrl, [int]$TimeoutSec, [double]$CeilingSec)
    Write-Host '=== Embedding Latency ===' -ForegroundColor Cyan
    $Status = 'ok'
    $Ms     = 0
    try {
        $Perf = Measure-EmbeddingLatency -BaseUrl $BaseUrl -CeilingSec $CeilingSec -TimeoutSec $TimeoutSec
        $Status = $Perf.Status
        $Ms     = $Perf.DurationMs
        $PerfIcon  = if ($Perf.Status -eq 'ok') { '[PASS]' } else { '[DEGRADED]' }
        $PerfColor = if ($Perf.Status -eq 'ok') { 'Green' } else { 'Yellow' }
        Write-Host "  $PerfIcon embeddings.compute — $($Perf.DurationMs)ms (ceiling $($CeilingSec)s, $($Perf.Count) vectors, http $($Perf.HttpStatus))" -ForegroundColor $PerfColor
    } catch {
        # New-ActionableError from an unreachable server — report degraded, do NOT crash the smoke.
        $Status = 'unreachable'
        Write-Host "  [DEGRADED] embeddings.compute — unreachable: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    if ($Status -ne 'ok') {
        Write-Host "::warning::Embedding latency $Status — ${Ms}ms vs ${CeilingSec}s ceiling (perf-regression probe t/3088; monitoring signal, does not block the gate). A sustained breach is the t/3085 cache-miss class."
    }
    Write-Host ''
    return [pscustomobject]@{ Status = $Status; Ms = $Ms }
}

function Invoke-SmokeCachePresencePhase {
    # ── Phase 9: Embeddings cache presence (t/3088 follow-up #1) ────────────────
    # t/3085/t/3086: the precomputed embeddings.json cache was silently dead for 3.5 months.
    # /health exposes embeddings.cachePresent but ONLY to admins (meta.ts anon branch returns
    # status+ai and early-returns), so an anon smoke can't read it. The anon /readyz (t/3112,
    # PUBLIC_EXACT_PATHS) returns 200 IFF the precomputed-vector cache is loaded (present AND
    # nodeCount>0) — the anon-accessible "cache present" signal this probe asserts, no creds.
    # WARN-FIRST like Phase 8 (embedding latency): a fresh revision can be /healthz-ready but
    # /readyz-503 during fire-and-forget prewarm, so a 503 surfaces as ::warning:: (a real but
    # often transient signal), NOT a hard failure — EXCLUDED from $OverallPass so a cold-revision
    # warmup can't false-red Health/Endpoints/Azure.
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Embeddings Cache Presence ===' -ForegroundColor Cyan
    $CacheCheck = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/readyz' `
        -Method 'GET' -TimeoutSec $TimeoutSec -AcceptableStatusCodes @(200, 503)
    $Present = ($CacheCheck.StatusCode -eq 200)
    $Status  = if ($Present) { 'present' }
        elseif ($CacheCheck.StatusCode -eq 503) { 'warming' }
        else { 'unreachable' }
    $CCIcon  = if ($Present) { '[PASS]' } else { '[DEGRADED]' }
    $CCColor = if ($Present) { 'Green' } else { 'Yellow' }
    Write-Host "  $CCIcon GET /readyz — $($CacheCheck.StatusCode) $($CacheCheck.ResponseMs)ms — embeddings cache $Status" -ForegroundColor $CCColor
    if (-not $Present) {
        Write-Host "::warning::Embeddings cache not present (/readyz=$($CacheCheck.StatusCode), $Status) — monitoring signal, does not block the gate. A sustained 'warming'/'unreachable' is the t/3085 dead-cache class."
    }
    Write-Host ''
    return [pscustomobject]@{ Present = $Present; Status = $Status }
}

# Dated known-pending list (t/4516): the PI's two legacy AAD-derived admin names,
# unreachable until #3741/t/4326's tid/oid capture lands and they're added to
# IDENTITY_MAP. EXPIRY TRIGGER: once that lands, drop this to 0 and change
# Invoke-SmokeIdentityAllowlistPhase's comparison from "<=" to a hard "-eq 0" gate.
$script:SmokeIdentityAllowlistKnownPendingCount = 2   # dated 2026-10-26

function Invoke-SmokeIdentityAllowlistPhase {
    # ── Phase 10: Identity allowlist unreachable count (t/4505 AC3, t/4516) ──────
    # /health exposes identityAllowlistUnreachable as a COUNT ONLY (never names) to an
    # anonymous caller (meta.ts's !isAdmin() branch) — t/4326's canonicalization means an
    # admin allowlist entry keyed on a legacy free-text name/email can go unreachable
    # (its new principal name no longer matches) with nothing else surfacing it. WARN-FIRST
    # like Phases 8/9: the PI's two legacy AAD names correctly show as unreachable today and
    # stay that way until IDENTITY_MAP is updated, so a hard `== 0` would fail every deploy.
    # EXCLUDED from $OverallPass, same as Phases 8/9.
    param([string]$BaseUrl, [int]$TimeoutSec)
    Write-Host '=== Identity Allowlist Unreachable ===' -ForegroundColor Cyan
    $Count = $null
    $Status = 'unreachable'
    try {
        $Check = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/health' -Method 'GET' `
            -TimeoutSec $TimeoutSec -ExpectedField 'identityAllowlistUnreachable'
        if ($Check.Success -and $Check.Body -and $Check.Body.PSObject.Properties['identityAllowlistUnreachable']) {
            $Count = [int]$Check.Body.identityAllowlistUnreachable
            $Status = if ($Count -le $script:SmokeIdentityAllowlistKnownPendingCount) { 'ok' } else { 'breach' }
        }
    } catch {
        Write-Host "  [DEGRADED] GET /health — unreachable: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    $Icon  = if ($Status -eq 'ok') { '[PASS]' } else { '[DEGRADED]' }
    $Color = if ($Status -eq 'ok') { 'Green' } else { 'Yellow' }
    $CountText = if ($null -ne $Count) { "$Count" } else { 'n/a' }
    Write-Host "  $Icon GET /health — identityAllowlistUnreachable=$CountText (known-pending $script:SmokeIdentityAllowlistKnownPendingCount)" -ForegroundColor $Color
    if ($Status -ne 'ok') {
        Write-Host "::warning::Identity allowlist unreachable count $CountText exceeds the known-pending list ($script:SmokeIdentityAllowlistKnownPendingCount) or /health was unreachable — monitoring signal, does not block the gate (t/4505 AC3). New unreachable entries may mean an admin lost access; investigate via the admin-only /health or /admin endpoint."
    }
    Write-Host ''
    return [pscustomobject]@{ Count = $Count; KnownPendingCount = $script:SmokeIdentityAllowlistKnownPendingCount; Status = $Status }
}

function Get-SmokeCategorySummary {
    # Pass/fail counts per category, sorted by category name.
    param([object[]]$AllResults)
    $ByCategory = @{}
    foreach ($R in $AllResults) {
        if (-not $ByCategory.ContainsKey($R.Category)) {
            $ByCategory[$R.Category] = @{ Pass = 0; Fail = 0 }
        }
        if ($R.Pass) { $ByCategory[$R.Category].Pass++ }
        else { $ByCategory[$R.Category].Fail++ }
    }
    foreach ($Cat in ($ByCategory.Keys | Sort-Object)) {
        [PSCustomObject]@{
            Category = $Cat
            Pass     = $ByCategory[$Cat].Pass
            Fail     = $ByCategory[$Cat].Fail
        }
    }
}

function Get-SmokeResponseStatistic {
    # Avg/Max/Min response time over results with Ms > 0; all 0 when there are none.
    param([object[]]$AllResults)
    $ResponseTimes = @($AllResults | Where-Object { $_.Ms -gt 0 } |
        Measure-Object -Property Ms -Average -Maximum -Minimum)
    if ($ResponseTimes.Count -eq 0) {
        return [pscustomobject]@{ Any = $false; Avg = 0; Max = 0; Min = 0; RawAvg = 0 }
    }
    return [pscustomobject]@{
        Any = $true; Avg = [math]::Round($ResponseTimes.Average, 0); RawAvg = $ResponseTimes.Average
        Max = $ResponseTimes.Maximum; Min = $ResponseTimes.Minimum
    }
}

function Write-SmokeSummary {
    param([bool]$OverallPass, [bool]$HealthOk, [bool]$AzureOk, [bool]$GitHubOk, [int]$Passed, [int]$Total, $Stats, $Duration, [bool]$Detailed, $CategorySummary)
    $HealthWord = @{ $true = 'Healthy'; $false = 'Unhealthy' }
    Write-Host '=== Summary ===' -ForegroundColor Cyan
    $SummaryColor = if ($OverallPass) { 'Green' } else { 'Red' }
    Write-Host "  Overall: $(if ($OverallPass) { 'PASS' } else { 'FAIL' })" -ForegroundColor $SummaryColor
    Write-Host "  Health:  $($HealthWord[$HealthOk])"
    Write-Host "  Azure:   $($HealthWord[$AzureOk])"
    Write-Host "  GitHub:  $($HealthWord[$GitHubOk])"
    Write-Host "  Endpoints: $Passed/$Total passed"
    if ($Stats.Any) {
        Write-Host "  Response: avg=$([math]::Round($Stats.RawAvg, 0))ms min=$($Stats.Min)ms max=$($Stats.Max)ms"
    }
    Write-Host "  Duration: $([math]::Round($Duration.TotalSeconds, 1))s"
    Write-Host ''

    if ($Detailed) {
        Write-Host '=== Per-Category Breakdown ===' -ForegroundColor Cyan
        $CategorySummary | Format-Table -AutoSize | Out-String | Write-Host
    }
}
