# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-TaxEditorInquiry {
    <#
    .SYNOPSIS
        Verifies the hosted inquiry flow returns REAL data (not ADR-001 graceful-empty)
        on the deployed web profile — the dual-build silent-empty escape catcher (t/3584).
    .DESCRIPTION
        "Works locally" is not sign-off for a dual-build feature: Electron and the hosted
        web profile read data through different backends, and ADR-001 graceful-empty makes a
        web-profile failure SILENT — a valid-shaped-but-empty InquiryResult, no crash, no
        error (the escape that shipped in t/2648, t/2661). This probe defeats that by driving
        a real inquiry end-to-end against the hosted profile and asserting DATA PRESENCE
        (count > 0), not merely "status == done" / "renders without error."

        Flow (inquiry is POST-then-poll, authenticated-only — there is no GET that lists
        pre-existing results): POST /api/inquiry -> 202 { jobId } -> poll GET /api/inquiry/:jobId
        until terminal -> assert on `result` via Test-InquiryDataPresence.

        AUTH (t/3584 option 1 — runner-supplied session, TL-approved t/3584#2): the inquiry
        routes are fail-closed (401 for anonymous). Pass -SessionCookie = the value of the
        Azure Easy Auth `AppServiceAuthSession` cookie from an authenticated browser session
        (DevTools -> Application -> Cookies after signing in). No secret is stored; the caller
        supplies a live session. CI-automation of this (a refreshable session) is deferred to
        t/3615.

        FAILURE IS LOUD (never a silent pass — the whole point): a missing/expired session,
        a failed inquiry, or an EMPTY-shell result throws a New-ActionableError. A poll
        TIMEOUT is treated as a WARN (monitoring signal, not a hard fail) and returns a
        result with Status='timeout' — a slow debate must not masquerade as a broken feature.

        EXPENSIVE: each run is a real headless debate + QBAF evals (BYOK LLM cost), server
        concurrency-capped at 1/user. Use fidelity 'quick'; run on demand, not per-deploy.
    .PARAMETER BaseUrl
        Base URL of the deployed Taxonomy Editor site. Defaults to the canonical hosted URL.
    .PARAMETER SessionCookie
        Value of the Easy Auth `AppServiceAuthSession` cookie from an authenticated session.
    .PARAMETER Question
        The inquiry prompt. Defaults to a fixed, corpus-grounded governance question.
    .PARAMETER Fidelity
        Inquiry fidelity: quick | standard | deep. Default 'quick' (cheapest).
    .PARAMETER CookieName
        Auth cookie name. Default 'AppServiceAuthSession' (Azure Easy Auth).
    .PARAMETER PollIntervalSec
        Seconds between poll attempts. Default 5.
    .PARAMETER TimeoutSec
        Overall poll ceiling in seconds. Default 600 (10 min). Timeout -> WARN, not fail.
    .OUTPUTS
        [pscustomobject] with BaseUrl, JobId, Status, TerminationReason, Pass, DataPresence,
        ElapsedSec.
    .EXAMPLE
        Test-TaxEditorInquiry -SessionCookie $env:AITRIAD_AUTH_COOKIE
    .LINK
        Test-InquiryDataPresence
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Position = 0)]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$SessionCookie,

        [Parameter()]
        [ValidateNotNullOrEmpty()]
        [string]$Question = 'What are the key risks and benefits of open-weight AI models?',

        [Parameter()]
        [ValidateSet('quick', 'standard', 'deep')]
        [string]$Fidelity = 'quick',

        [Parameter()]
        [string]$CookieName = 'AppServiceAuthSession',

        [Parameter()]
        [ValidateRange(1, 60)]
        [int]$PollIntervalSec = 5,

        [Parameter()]
        [ValidateRange(30, 3600)]
        [int]$TimeoutSec = 600
    )

    Set-StrictMode -Version Latest

    $BaseUrl = $BaseUrl.TrimEnd('/')

    # Build an authenticated WebRequestSession from the supplied Easy Auth cookie.
    $Uri = [Uri]$BaseUrl
    $Session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $Session.Cookies.Add([System.Net.Cookie]::new($CookieName, $SessionCookie, '/', $Uri.Host))

    # 1. POST the inquiry -> expect 202 { jobId }.
    $Post = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/api/inquiry' -Method POST `
        -Body @{ question = $Question; fidelity = $Fidelity } `
        -Session $Session -AcceptableStatusCodes @(202) -ExpectJson -TimeoutSec 30

    if (-not $Post.Success) {
        $Hint = if ($Post.StatusCode -eq 401) {
            'The session is unauthenticated/expired. Re-copy a fresh AppServiceAuthSession cookie from an authenticated browser session and pass it via -SessionCookie.'
        } else {
            "POST /api/inquiry returned $($Post.StatusCode). Check the app is up (Test-TaxEditorHealth) and the request shape."
        }
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Verify the hosted inquiry flow returns real data' `
            -Problem "Could not start an inquiry: POST /api/inquiry did not return 202 (got $($Post.StatusCode)$(if ($Post.Error) { " — $($Post.Error)" }))." `
            -Location "$BaseUrl/api/inquiry" `
            -NextSteps $Hint)
    }

    $JobId = if ($Post.Body -and $Post.Body.PSObject.Properties['jobId']) { [string]$Post.Body.jobId } else { $null }
    if ([string]::IsNullOrWhiteSpace($JobId)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Verify the hosted inquiry flow returns real data' `
            -Problem 'POST /api/inquiry returned 202 but no jobId in the body.' `
            -Location "$BaseUrl/api/inquiry" `
            -NextSteps 'Inspect the raw 202 response; the { jobId } contract may have changed.')
    }

    # 2. Poll until terminal or timeout.
    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Terminal = @('done', 'done_truncated', 'failed')
    $Status = ''
    $Poll = $null
    do {
        Start-Sleep -Seconds $PollIntervalSec
        $Poll = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path "/api/inquiry/$JobId" `
            -Session $Session -ExpectJson -TimeoutSec 15
        if ($Poll.Success -and $Poll.Body -and $Poll.Body.PSObject.Properties['status']) {
            $Status = [string]$Poll.Body.status
        }
        Write-Verbose "inquiry $JobId status=$Status elapsed=$([int]$Sw.Elapsed.TotalSeconds)s"
    } while ($Status -notin $Terminal -and $Sw.Elapsed.TotalSeconds -lt $TimeoutSec)
    $Sw.Stop()

    $TermReason = if ($Poll -and $Poll.Body -and $Poll.Body.PSObject.Properties['terminationReason']) { [string]$Poll.Body.terminationReason } else { $null }
    $ElapsedSec = [int]$Sw.Elapsed.TotalSeconds

    # 3a. Timeout -> WARN, not fail (a slow debate is a monitoring signal, not a broken feature).
    if ($Status -notin $Terminal) {
        Write-Warning "test-inquiry: no terminal status after ${TimeoutSec}s (last status='$Status', job=$JobId) — WARN, not a data failure. Re-run with a longer -TimeoutSec if the debate is legitimately slow."
        return [pscustomobject]@{
            BaseUrl = $BaseUrl; JobId = $JobId; Status = 'timeout'; TerminationReason = $TermReason
            Pass = $null; DataPresence = $null; ElapsedSec = $ElapsedSec
        }
    }

    # 3b. Inquiry failed server-side -> loud.
    if ($Status -eq 'failed') {
        $Err = if ($Poll.Body -and $Poll.Body.PSObject.Properties['error']) { [string]$Poll.Body.error } else { '(no error detail)' }
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Verify the hosted inquiry flow returns real data' `
            -Problem "Inquiry $JobId ended status='failed': $Err" `
            -Location "$BaseUrl/api/inquiry/$JobId" `
            -NextSteps 'Check the server logs (Get-TaxEditorServerLogs) for the inquiry pipeline error; this is a real server-side failure, not an empty corpus.')
    }

    # 3c. Terminal + done -> assert DATA PRESENCE (the escape catcher).
    $Result = if ($Poll.Body -and $Poll.Body.PSObject.Properties['result']) { $Poll.Body.result } else { $null }
    $Presence = Test-InquiryDataPresence -Result $Result

    if (-not $Presence.Pass) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Verify the hosted inquiry flow returns real data' `
            -Problem "Inquiry $JobId reached '$Status' but returned an EMPTY result (ADR-001 graceful-empty — the silent dual-build escape): $($Presence.Reasons -join '; '). campVerdicts=$($Presence.CampVerdicts) calibration=$($Presence.Calibration) groundingNodes=$($Presence.GroundingNodes)." `
            -Location "$BaseUrl/api/inquiry/$JobId" `
            -NextSteps 'The hosted profile likely read an empty corpus via the github-api backend. Check the assembled-corpus cache and the inquiry-grounding-empty WARN in the server logs; verify data is deployed. This is exactly the failure that renders green while broken (t/2648, t/2661).')
    }

    Write-Verbose "inquiry $JobId PASS: campVerdicts=$($Presence.CampVerdicts) calibration=$($Presence.Calibration) groundingNodes=$($Presence.GroundingNodes)"
    [pscustomobject]@{
        BaseUrl = $BaseUrl; JobId = $JobId; Status = $Status; TerminationReason = $TermReason
        Pass = $true; DataPresence = $Presence; ElapsedSec = $ElapsedSec
    }
}
