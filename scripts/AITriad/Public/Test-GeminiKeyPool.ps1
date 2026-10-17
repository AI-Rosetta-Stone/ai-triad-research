# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Definitive count + per-key validity of the Gemini free-key pool, from a key file — masked only.
.DESCRIPTION
    Reads a key file, extracts every Gemini key (both the classic `AIza…` and the newer `AQ.<...>`
    formats), dedups, and validates each via the canonical auth-only probe (`Test-AIApiKey -Backend
    gemini` → `GET /v1beta/models?key=` — no tokens consumed). Reports a definitive unique count and
    a per-key status, each key shown only as a MASKED fingerprint (first 6 … last 4).

    SECURITY: raw keys are NEVER printed or written to disk — only masked fingerprints. The key file
    is read locally and never echoed. (t/3141)

    Status classification (from Test-AIApiKey's StatusCode/Functional):
      VALID       — 200
      DEAD        — 401 / 403 (present but rejected)
      THROTTLED   — 429 (rate-limited; validity indeterminate right now)
      NETWORK-ERR — no StatusCode (timeout / transport)
      ERROR(<n>)  — any other status
.PARAMETER Path
    Key file to read. Defaults to $env:GEMINI_FREE_KEYS_FILE. One key per line, or any file the two
    key-format regexes can extract from (blank lines and `#` comments are ignored in line-fallback).
.PARAMETER TimeoutSec
    Per-key probe timeout (seconds). Default 12.
.OUTPUTS
    [PSCustomObject] (AITriad.GeminiKeyPool): UniqueCount, Valid, Dead, Throttled, NetworkErr, Error,
    and Keys (array of masked per-key rows: Fingerprint, Status, StatusCode, LatencyMs).
.EXAMPLE
    Test-GeminiKeyPool -Path ./free-keys.txt
    # Definitive pool report; each key masked.
.EXAMPLE
    (Test-GeminiKeyPool -Path ./free-keys.txt).Keys | Where-Object Status -ne 'VALID'
    # Surface only the non-valid keys (masked).
.LINK
    Test-AIApiKey
.LINK
    Show-AITriadHelp
#>
function Test-GeminiKeyPool {
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Position = 0)]
        [string]$Path,

        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 12
    )

    Set-StrictMode -Version Latest

    $keyFile = if ($Path) { $Path } elseif ($env:GEMINI_FREE_KEYS_FILE) { $env:GEMINI_FREE_KEYS_FILE } else { $null }
    if (-not $keyFile) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal     'Report the Gemini free-key pool' `
            -Problem  'No key-file path given.' `
            -Location 'Test-GeminiKeyPool' `
            -NextSteps @('Pass -Path <file>', 'or set $env:GEMINI_FREE_KEYS_FILE to the key file'))
    }
    if (-not (Test-Path -LiteralPath $keyFile)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal     'Report the Gemini free-key pool' `
            -Problem  "Key file not found: $keyFile" `
            -Location 'Test-GeminiKeyPool' `
            -NextSteps @('Verify the path', 'Pass -Path to the correct key file'))
    }

    # ── Parse: match both key formats; fall back to one-per-line; dedup (t/3141, TL ref) ──
    $raw = Get-Content -Raw -LiteralPath $keyFile
    $rxMatches = [regex]::Matches($raw, '(AIza[0-9A-Za-z_\-]{35}|AQ\.[A-Za-z0-9_\-\.]{20,80})')
    $all = @($rxMatches | ForEach-Object { $_.Value })
    if ($all.Count -eq 0) {
        $all = @(Get-Content -LiteralPath $keyFile |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and -not $_.StartsWith('#') })
    }
    $unique = @($all | Select-Object -Unique)

    # Masked fingerprint — never the raw key.
    $mask = {
        param([string]$k)
        if ([string]::IsNullOrEmpty($k)) { return '' }
        if ($k.Length -le 10) { return ('*' * $k.Length) }
        "$($k.Substring(0, 6))…$($k.Substring($k.Length - 4))"
    }

    $rows = [System.Collections.Generic.List[PSObject]]::new()
    foreach ($k in $unique) {
        $probe = Test-AIApiKey -Backend gemini -ApiKey $k
        $sc = if ($probe -and $probe.PSObject.Properties['StatusCode']) { $probe.StatusCode } else { $null }
        $fn = if ($probe -and $probe.PSObject.Properties['Functional']) { [bool]$probe.Functional } else { $false }
        $lat = if ($probe -and $probe.PSObject.Properties['LatencyMs']) { $probe.LatencyMs } else { $null }

        $status =
            if ($fn -and $sc -eq 200) { 'VALID' }
            elseif ($sc -in 401, 403) { 'DEAD' }
            elseif ($sc -eq 429)      { 'THROTTLED' }
            elseif ($null -eq $sc)    { 'NETWORK-ERR' }
            else                      { "ERROR($sc)" }

        $rows.Add([PSCustomObject]@{
            Fingerprint = & $mask $k
            Status      = $status
            StatusCode  = $sc
            LatencyMs   = $lat
        })
    }

    $count = { param($s) @($rows | Where-Object { $_.Status -eq $s }).Count }

    [PSCustomObject]@{
        PSTypeName  = 'AITriad.GeminiKeyPool'
        UniqueCount = $unique.Count
        Valid       = (& $count 'VALID')
        Dead        = (& $count 'DEAD')
        Throttled   = (& $count 'THROTTLED')
        NetworkErr  = (& $count 'NETWORK-ERR')
        Error       = @($rows | Where-Object { $_.Status -like 'ERROR(*' }).Count
        Keys        = @($rows)
    }
}
