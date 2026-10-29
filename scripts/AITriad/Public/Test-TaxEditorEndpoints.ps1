# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-TaxEditorEndpoints {
    <#
    .SYNOPSIS
        Smoke-tests key API endpoints on the deployed Taxonomy Editor.
    .DESCRIPTION
        Hits a curated set of GET endpoints that are publicly accessible (or
        accessible to anonymous users) and validates HTTP status codes and
        basic response shape. Returns per-endpoint results.
    .PARAMETER BaseUrl
        The base URL of the deployed Taxonomy Editor site.
    .PARAMETER TimeoutSec
        HTTP request timeout in seconds per endpoint. Default: 15.
    .PARAMETER Category
        Filter to a specific category of endpoints. Default: all.
    .PARAMETER AnonymousSession
        Establish an anonymous WebRequestSession against /.auth/anonymous
        (Azure Easy Auth) via New-AnonymousWebSession and pass it as
        -Session on every endpoint check. This replicates the anon cookie
        jar the deploy-time bash acceptance test used to inline (t/1500
        Phase 3, e/41). If the session establishment fails (Easy Auth
        endpoint missing / non-2xx), the switch degrades gracefully to
        unauthenticated requests with a warning — the caller then sees
        whichever endpoints require auth flip to failure, which is the
        signal.
    .EXAMPLE
        Test-TaxEditorEndpoints
    .EXAMPLE
        Test-TaxEditorEndpoints -Category Data | Format-Table
    .EXAMPLE
        # Deploy-time acceptance smoke — anon cookie jar + full endpoint set.
        Test-TaxEditorEndpoints -AnonymousSession | Where-Object { -not $_.Pass }
    .LINK
        Show-AITriadHelp
    .LINK
        Test-TaxEditorHealth
    .LINK
        Test-AnonymousDebateFlow
    .LINK
        Test-PersonaEndpoints
    .LINK
        Test-ServiceWorkerHealth
    .LINK
        Get-FreeTierStatus
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 15,

        [Parameter()]
        [ValidateSet('Health', 'Data', 'Auth', 'Models', 'Metadata', 'Static', 'Debate', 'Community', 'Sync', 'Frontend')]
        [string]$Category,

        [Parameter()]
        [switch]$AnonymousSession,

        [Parameter()]
        [ValidateSet('Authenticated', 'Anonymous', 'Admin')]
        [string]$UserType = 'Authenticated'
    )

    Set-StrictMode -Version Latest

    $BaseUrl = $BaseUrl.TrimEnd('/')

    $Endpoints = @(
        @{ Path = '/healthz';                  Cat = 'Health';    Field = 'status';   Desc = 'Liveness probe' }
        @{ Path = '/health';                   Cat = 'Health';    Field = 'status';   Desc = 'Readiness probe' }
        @{ Path = '/api/auth/me';              Cat = 'Auth';      Field = $null;      Desc = 'Auth identity' }
        @{ Path = '/api/models';               Cat = 'Models';    Field = $null;      Desc = 'Available AI models' }
        # AuthGated = $true marks routes behind Azure Easy Auth. To an anonymous
        # smoke-test caller they serve the Sign-In HTML interstitial (200 text/html),
        # which the t/1474 ExpectJson guard flags as failure — the loop below
        # reclassifies that specific interstitial to PASS (t/1657). Public routes
        # (no key) keep the strict JSON guard, so a public route regressing to
        # require-auth still fails. Route set empirically classified against prod.
        @{ Path = '/api/taxonomy/accelerationist'; Cat = 'Data';  Field = 'nodes';    AuthGated = $true;  Desc = 'Accelerationist taxonomy' }
        @{ Path = '/api/taxonomy/safetyist';   Cat = 'Data';      Field = 'nodes';    AuthGated = $true;  Desc = 'Safetyist taxonomy' }
        @{ Path = '/api/taxonomy/skeptic';     Cat = 'Data';      Field = 'nodes';    AuthGated = $true;  Desc = 'Skeptic taxonomy' }
        @{ Path = '/api/edges';                Cat = 'Data';      Field = $null;      AuthGated = $true;  Desc = 'Edge relationships' }
        @{ Path = '/api/conflicts';            Cat = 'Data';      Field = $null;      AuthGated = $true;  Desc = 'Conflict data' }
        @{ Path = '/api/policy-registry';      Cat = 'Metadata';  Field = $null;      AuthGated = $true;  Desc = 'Policy action registry' }
        @{ Path = '/api/sources';              Cat = 'Metadata';  Field = $null;      AuthGated = $true;  Desc = 'Source document index' }
        @{ Path = '/api/lineage-categories';   Cat = 'Metadata';  Field = $null;      AuthGated = $true;  Desc = 'Lineage categories' }
        @{ Path = '/api/dictionary';           Cat = 'Metadata';  Field = $null;      AuthGated = $true;  Desc = 'Project dictionary' }
        @{ Path = '/api/backends/available';   Cat = 'Models';    Field = $null;      AuthGated = $true;  Desc = 'Available AI backends' }
        @{ Path = '/api/proxy/tier';           Cat = 'Auth';      Field = $null;      AuthGated = $true;  Desc = 'Proxy tier info' }
        @{ Path = '/third-party-notices';      Cat = 'Static';    Field = $null;      AuthGated = $true;  Desc = 'Third-party notices page' }
        # t/1500 Phase 3 — deploy-time acceptance additions (e/41).
        @{ Path = '/api/data/available';       Cat = 'Health';    Field = $null;      Desc = 'Data availability flag' }
        @{ Path = '/api/debates/list';         Cat = 'Debate';    Field = $null;      AuthGated = $true;  Desc = 'Debate listing' }
        @{ Path = '/api/chats';                Cat = 'Debate';    Field = $null;      AuthGated = $true;  Desc = 'Chat listing' }
        @{ Path = '/api/community/debates';    Cat = 'Community'; Field = $null;      AuthGated = $true;  Desc = 'Community debates' }
        @{ Path = '/api/sync/status';          Cat = 'Sync';      Field = 'enabled';  AuthGated = $true;  Desc = 'Sync status' }
        # SPA-shell check — GET / returns HTML; success requires the React root
        # div AND a script tag, so it catches both a blank shell and a
        # bad-cache HTML/500 fallback. Kept as its own category so callers can
        # bypass it via -Category. Handled specially in the loop below
        # (Field='__spa' triggers the raw-body content check).
        # AuthGated (t/1657) — '/' sits behind Azure Easy Auth too, so an
        # anonymous smoke caller gets the same Sign-In interstitial as the API
        # routes; the reclassify block restores it to PASS. A genuinely-broken
        # shell (non-interstitial HTML) still fails the SPA-shell check below.
        @{ Path = '/';                         Cat = 'Frontend';  Field = '__spa';    AuthGated = $true;  Desc = 'SPA shell (root document)' }
    )

    if ($Category) {
        $Endpoints = @($Endpoints | Where-Object { $_.Cat -eq $Category })
    }

    # Anonymous session establishment (t/1500 Phase 3, TL note 1; -UserType t/2374).
    # -AnonymousSession is the legacy switch; -UserType Anonymous is the new param.
    $Session = $null
    $UseAnon = $AnonymousSession -or ($UserType -eq 'Anonymous')
    if ($UseAnon) {
        $Session = New-AnonymousWebSession -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec
        if (-not $Session) {
            Write-Warning "Anonymous session: /.auth/anonymous did not establish a session at $BaseUrl; proceeding unauthenticated."
        }
    }

    $Results = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($Ep in $Endpoints) {
        Write-Verbose "Testing $($Ep.Path) ($($Ep.Desc))..."

        $Params = @{
            BaseUrl    = $BaseUrl
            Path       = $Ep.Path
            TimeoutSec = $TimeoutSec
            AcceptableStatusCodes = @(200, 304)
        }
        # SPA shell: expect HTML, validate raw body shape after the request.
        # Everything else: JSON with optional expected field.
        if ($Ep.Field -eq '__spa') {
            # Do NOT set ExpectJson — SPA endpoint legitimately returns HTML.
        } else {
            if ($Ep.Field) { $Params.ExpectedField = $Ep.Field }
            # t/1474 — flag HTML-200 as failure for JSON endpoints. Static endpoints
            # (e.g. /third-party-notices) legitimately return HTML, so they're excluded.
            if ($Ep.Cat -ne 'Static') { $Params.ExpectJson = $true }
        }
        if ($Session) { $Params.Session = $Session }

        $Check = Invoke-RemoteCheck @Params

        # SPA-shell validation: root-div + script-tag both present.
        # If either is missing (blank shell, cache-miss HTML), flip Pass=$false.
        # For the AuthGated '/' route an anonymous caller receives the Easy Auth
        # Sign-In interstitial here too — that HTML has no root div/script, so this
        # flips it to failure; the reclassify block BELOW (which runs after this,
        # so it observes the flipped state) restores it to PASS on the interstitial
        # title. Order matters: the '/' row sets no ExpectJson, so Invoke-RemoteCheck
        # returns Success=$true for the HTML-200; the reclassify guard (-not Success)
        # only fires once this SPA check has failed it. A genuinely broken shell
        # (non-interstitial HTML) has no title match → stays failed (gate integrity).
        if ($Check.Success -and $Ep.Field -eq '__spa') {
            $HasRootDiv = $Check.RawBody -match '<div\s+id="root"'
            $HasScript  = $Check.RawBody -match 'src="[^"]+\.js"'
            if (-not ($HasRootDiv -and $HasScript)) {
                $Check = [PSCustomObject]@{
                    Success     = $false
                    StatusCode  = $Check.StatusCode
                    ResponseMs  = $Check.ResponseMs
                    Body        = $Check.Body
                    ContentType = $Check.ContentType
                    RawBody     = $Check.RawBody
                    Error       = "SPA shell missing root div or script tag (root-div=$HasRootDiv, script=$HasScript)"
                }
            }
        }

        # t/1657 — an auth-gated route serving the Azure Easy Auth Sign-In
        # interstitial (200 text/html) to an anonymous smoke-test caller is
        # EXPECTED (auth-gating is working), not a failure. For JSON routes the
        # t/1474 ExpectJson guard flags it; for the '/' SPA route the SPA-shell
        # check above flags it. Reclassify to PASS ONLY when the route is AuthGated
        # AND the body carries the interstitial title. A down route returns a 5xx
        # or a different body → no title match → still fails (gate-signal integrity).
        # The dash between "Sign In" and "AITriad" varies by platform encoding
        # (hyphen / en-dash / em-dash); match any so the anchor tokens carry the signal.
        #
        # t/4631 — for Category='Data' this reclassify must NOT produce a silent
        # PASS: PASS on a Data row means "data was verified," not "auth gating
        # worked." The interstitial means no body was ever checked. If $Session
        # is set (established above) and the request still hit the interstitial,
        # or no session was established at all, the row is a FAIL with a reason
        # — never indistinguishable from a real, verified data PASS. Non-Data
        # AuthGated categories (Metadata/Models/Auth/Static/Frontend) keep the
        # original PASS-on-interstitial semantics unchanged: gating-works IS the
        # right signal there, since they carry no data-verification contract.
        if (-not $Check.Success -and $Ep.ContainsKey('AuthGated') -and $Ep.AuthGated -and
            $Check.RawBody -match 'Sign In\s*[-–—]\s*AITriad Taxonomy Editor') {
            if ($Ep.Cat -eq 'Data') {
                $Reason = if ($Session) {
                    "Data endpoint returned the Easy Auth Sign-In interstitial despite an established anonymous session; no data verified (t/4631)."
                } else {
                    "Data endpoint is auth-gated and no anonymous session was established (pass -AnonymousSession or -UserType Anonymous); no data verified (t/4631)."
                }
                $Check = [PSCustomObject]@{
                    Success     = $false
                    StatusCode  = $Check.StatusCode
                    ResponseMs  = $Check.ResponseMs
                    Body        = $null
                    ContentType = $Check.ContentType
                    RawBody     = $Check.RawBody
                    Error       = $Reason
                }
            } else {
                $Check = [PSCustomObject]@{
                    Success     = $true
                    StatusCode  = $Check.StatusCode
                    ResponseMs  = $Check.ResponseMs
                    Body        = $null
                    ContentType = $Check.ContentType
                    RawBody     = $Check.RawBody
                    Error       = $null
                }
            }
        }

        $NodeCount = $null
        if ($Check.Success -and $Check.Body -and $Ep.Field -eq 'nodes') {
            $NodeCount = @($Check.Body.nodes).Count
        }

        $Result = [EndpointTestResult]::new()
        $Result.Endpoint    = $Ep.Path
        $Result.Category    = $Ep.Cat
        $Result.Description = $Ep.Desc
        $Result.Status      = $Check.StatusCode
        $Result.Pass        = $Check.Success
        $Result.Ms          = $Check.ResponseMs
        $Result.NodeCount   = $NodeCount
        $Result.Error       = $Check.Error
        $Results.Add($Result)
    }

    # -- List→load contract tests (t/2374) ----------------------------------------
    # Runs when the category scope includes Community or Debate endpoints. Catches
    # cross-endpoint contract violations: a listed item that 404s on load is a bug
    # (t/2368 scenario: list community as anon → attempt load → expect 200).
    $RunCommunityContract = -not $Category -or $Category -eq 'Community'
    $RunDebateContract    = -not $Category -or $Category -eq 'Debate'

    if ($RunCommunityContract) {
        Write-Verbose "Running list→load contract test for Community debates..."
        $Results.Add((Invoke-ListLoadContractTest `
            -BaseUrl      $BaseUrl `
            -ListPath     '/api/community/debates' `
            -LoadTemplate '/api/community/debates/{id}' `
            -Category     'Community' `
            -Description  'Community debate list→load contract (t/2374)' `
            -Session      $Session `
            -TimeoutSec   $TimeoutSec))
    }

    if ($RunDebateContract) {
        Write-Verbose "Running list→load contract test for user debates..."
        $Results.Add((Invoke-ListLoadContractTest `
            -BaseUrl      $BaseUrl `
            -ListPath     '/api/debates/list' `
            -LoadTemplate '/api/debates/{id}' `
            -Category     'Debate' `
            -Description  'User debate list→load contract (t/2374)' `
            -Session      $Session `
            -TimeoutSec   $TimeoutSec))
    }

    @($Results)
}
