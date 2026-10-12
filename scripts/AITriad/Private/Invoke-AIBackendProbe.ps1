# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Shared single-backend AI probe. Sends one minimal completion through Invoke-AIApi and
    classifies the outcome. Private helper behind Test-AIBackendHealth and Test-AIBackendQuota.
.DESCRIPTION
    Invoke-AIApi swallows HTTP failures into a $null return plus one or more Write-Warning
    lines that carry the status ("... API call failed (HTTP 429) ...") and, separately, the
    (sensitive-scrubbed) response body. This helper captures those warnings via
    -WarningVariable and classifies the result so both public cmdlets share exactly one probe
    implementation and one classification table.

    Status values:
      ok       — a completion came back with text
      quota    — HTTP 429, or HTTP 400 with a quota/rate-limit/exhausted signal in the body
      timeout  — the probe hit its wall-clock budget or the warning names a cancellation
      error    — any other null return (auth failure, transport error, unexpected shape)

    ResetAt is best-effort: providers do not reliably surface a reset time, and Invoke-AIApi
    scrubs the response body, so ResetAt is populated only when a Retry-After delay or an
    explicit date survives in the captured warning text — otherwise $null.
.PARAMETER Backend
    Backend id (gemini, claude, groq, ...). Used only for labelling and messages.
.PARAMETER ModelId
    ai-models.json model id to probe. When empty the row is returned as 'no-model' without a call.
.PARAMETER TimeoutSec
    Per-probe wall-clock budget in seconds. Default 15.
.OUTPUTS
    [PSCustomObject] with Backend, Model, Status, LatencyMs, ResetAt, ErrorMessage, TestedAt.
#>
function Invoke-AIBackendProbe {
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [string]$Backend,

        [string]$ModelId,

        [ValidateRange(1, 300)]
        [int]$TimeoutSec = 15
    )

    Set-StrictMode -Version Latest

    $Row = [ordered]@{
        Backend      = $Backend
        Model        = $ModelId
        Status       = 'error'
        LatencyMs    = $null
        ResetAt      = $null
        ErrorMessage = $null
        TestedAt     = [datetime]::UtcNow
    }

    if ([string]::IsNullOrEmpty($ModelId)) {
        $Row['Status']       = 'no-model'
        $Row['ErrorMessage'] = "No default model configured for backend '$Backend' in ai-models.json."
        return [PSCustomObject]$Row
    }

    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    $AIResult = Invoke-AIApi `
        -Prompt          'ping' `
        -Model           $ModelId `
        -MaxTokens       5 `
        -TimeoutSec      $TimeoutSec `
        -MaxRetries      1 `
        -FallbackModels  @() `
        -Temperature     0.0 `
        -SkipTokenCheck `
        -WarningVariable WarnVar
    $Sw.Stop()
    # t/4078: one attempt and no cascade. -MaxRetries 0 (now rejected by Invoke-AIApi's ValidateRange)
    # sent no request at all, so the probe only ever reported what the fallback chain did.

    $Row['LatencyMs'] = [int]$Sw.ElapsedMilliseconds

    if ($null -ne $AIResult -and $AIResult.PSObject.Properties['Text']) {
        $Row['Status'] = 'ok'
        return [PSCustomObject]$Row
    }
    # t/4078 §3: a 200 with no text is now $null plus a "response had no text" WARN. For a probe the
    # backend still answered (a 5-token budget can be spent before any text), so it is reachable: 'ok'.
    if (@($WarnVar | Where-Object { "$_" -match 'response had no text' }).Count -gt 0) {
        $Row['Status'] = 'ok'
        return [PSCustomObject]$Row
    }

    # ── Classify the failure from the captured warning(s) ──
    # Invoke-AIApi emits the status line and the body as separate warnings; join so both are
    # visible to a single set of patterns.
    $WarnText = if (@($WarnVar).Count -gt 0) { (@($WarnVar) -join ' | ') } else { '' }

    $IsQuota = ($WarnText -match 'HTTP\s*429') -or
               (($WarnText -match 'HTTP\s*400') -and ($WarnText -match 'quota|rate.?limit|resource_exhausted|exhausted|insufficient|billing|credit')) -or
               ($WarnText -match 'quota|resource_exhausted|rate.?limit')

    $IsTimeout = ($Sw.ElapsedMilliseconds -ge ($TimeoutSec * 1000 - 500)) -or
                 ($WarnText -match 'timeout|timed.out|TaskCanceled|OperationCanceled')

    if ($IsQuota) {
        $Row['Status']  = 'quota'
        $Row['ResetAt'] = ConvertTo-QuotaResetAt -Text $WarnText
    } elseif ($IsTimeout) {
        $Row['Status'] = 'timeout'
    } else {
        $Row['Status'] = 'error'
    }

    $Row['ErrorMessage'] = if ($WarnText) { $WarnText }
        elseif ($IsTimeout) { "Backend '$Backend' did not respond within ${TimeoutSec}s." }
        else { "Invoke-AIApi returned null for backend '$Backend'." }

    return [PSCustomObject]$Row
}

<#
.SYNOPSIS
    Best-effort extraction of a quota reset timestamp from captured warning text.
.DESCRIPTION
    Returns an ISO-8601 UTC string ('yyyy-MM-ddTHH:mm:ssZ') when a reset hint is recoverable,
    else $null. Tries, in order: a Retry-After delay in seconds (relative to now), an explicit
    ISO-8601 datetime, then a bare reset date. Any parse failure falls through to $null — this
    is advisory, never fatal.
#>
function ConvertTo-QuotaResetAt {
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }

    # 1) Retry-After: <seconds> (relative)
    if ($Text -match 'Retry-?After["'':\s]+(\d{1,7})') {
        try { return ([datetime]::UtcNow.AddSeconds([int]$Matches[1])).ToString('yyyy-MM-ddTHH:mm:ssZ') } catch { }
    }

    # 2) Explicit ISO-8601 datetime in the body (e.g. "resets 2026-09-01T00:00:00Z")
    if ($Text -match '(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)') {
        try { return ([datetimeoffset]::Parse($Matches[1])).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ') } catch { }
    }

    # 3) A bare reset date (e.g. "resets 2026-09-01")
    if ($Text -match 'reset[s]?[^0-9]{0,12}(\d{4}-\d{2}-\d{2})') {
        try { return ([datetimeoffset]::Parse($Matches[1])).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ') } catch { }
    }

    return $null
}
