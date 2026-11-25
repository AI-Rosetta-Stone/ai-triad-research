# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Measure-EmbeddingLatency {
    <#
    .SYNOPSIS
        Timed probe of the embeddings compute path — catches a "correct but 100x slow"
        perf regression that error-rate gates can't see (t/3088).
    .DESCRIPTION
        POSTs a small fixed batch of KNOWN taxonomy node ids (present in embeddings.json)
        to /api/embeddings/compute and measures the request wall-time. Those ids resolve
        against the precomputed embeddings.json cache (t/3085): a healthy cache returns in
        milliseconds; a regressed cache (embeddings.json unreachable in prod, as in the
        3.5-month t/3085 incident) falls through to in-process ONNX at 25-48s per chunk.
        Nothing *fails* in that state — every request still returns 200 — so only a
        wall-time ceiling catches it.

        Returns a status object; does NOT gate anything itself (the caller decides). A
        breach of -CeilingSec, or a completed non-200 (503 load-shed / 500 / typed
        timeout), is reported as `degraded`. So is a 200 that carries NO vectors (t/621):
        nothing was looked up, so the round trip is fast whatever state the cache is in,
        and its time says nothing about the cache. A connection-level failure (the server never
        answered) raises New-ActionableError — that is "server unreachable", a different
        condition from "answered slowly".
    .PARAMETER BaseUrl
        Base URL of the deployed Taxonomy Editor.
    .PARAMETER NodeId
        Known node ids to probe (must exist in embeddings.json so they cache-hit). Default
        is a small cross-POV batch of stable ids (skp/sit/acc/saf) — the classes t/3085
        confirmed are ~fully covered by the precomputed cache.
    .PARAMETER CeilingSec
        Wall-time ceiling. Over this the result is `degraded`. Default 2s (the cache-hit
        path is well under 1s post-t/3085; tune from real post-fix timings).
    .PARAMETER TimeoutSec
        Per-request HTTP timeout. Default 15.
    .PARAMETER Session
        Optional anonymous WebRequestSession (the endpoint is anon-allowed but AUTH_OPTIONAL
        serves a Sign-In interstitial to a cookie-less request — pass a session to avoid it).
    .OUTPUTS
        [PSCustomObject] { DurationMs; Status ('ok'|'degraded'); Count; HttpStatus; CeilingSec; NodeIds; Error }
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [string]$BaseUrl,

        [Parameter()]
        [string[]]$NodeId = @('skp-beliefs-001', 'sit-001', 'acc-desires-001', 'saf-desires-001'),

        [Parameter()]
        [ValidateRange(0.1, 60)]
        [double]$CeilingSec = 2,

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 15,

        [Parameter()]
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session
    )

    Set-StrictMode -Version Latest

    $ids = @($NodeId)
    if ($ids.Count -eq 0) {
        New-ActionableError `
            -Goal 'Measure embedding latency' `
            -Problem 'no node ids supplied for the probe batch' `
            -Location 'Measure-EmbeddingLatency' `
            -NextSteps 'Pass -NodeId with >=1 known taxonomy node id present in embeddings.json.' `
            -Throw
    }

    # A cache-hit id never re-embeds its text, so placeholder text is fine; the server
    # requires `texts` to be an array (413 otherwise), so force arrays past ConvertTo-Json's
    # single-element unwrap.
    $texts = @($ids | ForEach-Object { "smoke-probe:$_" })
    $bodyJson = '{"texts":' + (ConvertTo-Json @($texts) -Compress -AsArray) +
                ',"ids":' + (ConvertTo-Json @($ids) -Compress -AsArray) + '}'

    $params = @{
        BaseUrl               = $BaseUrl
        Path                  = '/api/embeddings/compute'
        Method                = 'POST'
        Body                  = $bodyJson
        TimeoutSec            = $TimeoutSec
        AcceptableStatusCodes = @(200)
    }
    if ($Session) { $params.Session = $Session }

    $check = Invoke-RemoteCheck @params
    $ms = [int]$check.ResponseMs

    # StatusCode 0 = the request never reached a responding server (DNS/connection/timeout
    # before any HTTP status). That is "unreachable" — actionable, distinct from "slow".
    if ($check.StatusCode -eq 0) {
        New-ActionableError `
            -Goal 'Measure embedding latency' `
            -Problem "embeddings endpoint unreachable at $BaseUrl/api/embeddings/compute after ${ms}ms: $($check.Error)" `
            -Location 'Measure-EmbeddingLatency' `
            -NextSteps 'Confirm the server is up (Test-TaxEditorHealth -BaseUrl <url>) and the BaseUrl is correct.' `
            -Throw
    }

    $count = 0
    if ($check.Success -and $check.Body -and
        $check.Body.PSObject.Properties['vectors'] -and $null -ne $check.Body.vectors) {
        $count = @($check.Body.vectors).Count
    }

    # degraded = answered but over the ceiling, OR answered non-200 (a completed 503/500/
    # typed-timeout is a real degradation signal, not unreachable), OR answered 200 with no
    # vectors (t/621: prod returned `0 vectors, http 200` in 109ms and the probe said PASS;
    # the latency of a response that looked nothing up measures nothing).
    # ok = 200, at least one vector, within the ceiling.
    $problem = $check.Error
    $status = if (-not $check.Success) { 'degraded' }
    elseif ($count -eq 0) { $problem = 'no vectors returned; latency not measured'; 'degraded' }
    elseif ($ms -gt ($CeilingSec * 1000)) { 'degraded' }
    else { 'ok' }

    [PSCustomObject]@{
        DurationMs = $ms
        Status     = $status
        Count      = $count
        HttpStatus = $check.StatusCode
        CeilingSec = $CeilingSec
        NodeIds    = $ids
        Error      = $problem
    }
}
