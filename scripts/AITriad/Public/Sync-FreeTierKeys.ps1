# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Sync-FreeTierKeys {
    <#
    .SYNOPSIS
        Validate-then-set the FREE_TIER_GEMINI_KEY pool.
    .DESCRIPTION
        Reads a set of candidate Gemini API keys (from a file or explicit list),
        auth-probes each one against the Gemini API (GET /v1beta/models), classifies
        each as Pass / 401-Invalid / 429-RateLimited / Error, then sets only the
        passing keys as the comma-separated pool value.

        Never logs full key values — only masked 8-char SHA-256 fingerprints
        (same keyHash pattern as the server-side keyRotator).

        Prints the resulting K (passing key count) and front-door RPM so the
        operator sees the effect of the change immediately (RPM = min(12*K, 30)).

        Target options:
          GHASecret  (default) — writes FREE_TIER_GEMINI_KEY via `gh secret set`
          LocalEnv             — sets $env:FREE_TIER_GEMINI_KEY in the current session
          None                 — probe and report only; do not write anywhere
    .PARAMETER KeyFile
        Path to a file containing one API key per line (or comma-separated).
        Blank lines and # comments are ignored.
        Mutually exclusive with -Key.
    .PARAMETER Key
        One or more API keys supplied directly.
        Mutually exclusive with -KeyFile.
    .PARAMETER Target
        Where to write the validated pool: GHASecret | LocalEnv | None.
        Default: GHASecret.
    .PARAMETER Repo
        GitHub repo slug used when Target=GHASecret.
        Default: AI-Rosetta-Stone/ai-triad-research.
    .PARAMETER SecretName
        GitHub secret name to set when Target=GHASecret.
        Default: FREE_TIER_GEMINI_KEY.
    .PARAMETER TimeoutSec
        Per-key probe timeout in seconds (1-30). Default: 10.
    .PARAMETER WhatIf
        Show what would be set without actually writing.
    .EXAMPLE
        Sync-FreeTierKeys -KeyFile ~/gemini-keys.txt
    .EXAMPLE
        Sync-FreeTierKeys -Key $env:CANDIDATE_KEYS.Split(',') -Target LocalEnv
    .EXAMPLE
        Sync-FreeTierKeys -KeyFile ~/gemini-keys.txt -Target None
    .LINK
        Get-FreeTierStatus
    .LINK
        Test-GeminiKeyPool
    #>
    [CmdletBinding(DefaultParameterSetName = 'File', SupportsShouldProcess)]
    param(
        [Parameter(Mandatory, ParameterSetName = 'File', Position = 0)]
        [string]$KeyFile,

        [Parameter(Mandatory, ParameterSetName = 'Explicit')]
        [string[]]$Key,

        [ValidateSet('GHASecret', 'LocalEnv', 'None')]
        [string]$Target = 'GHASecret',

        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',

        [string]$SecretName = 'FREE_TIER_GEMINI_KEY',

        [ValidateRange(1, 30)]
        [int]$TimeoutSec = 10
    )

    Set-StrictMode -Version Latest

    # ── Key fingerprint (mirrors keyRotator.ts keyHash) ──────────────────────
    # SHA-256 of first 75% of key, hex, first 8 chars — safe for logs.
    function Get-KeyFingerprint([string]$RawKey) {
        $Slice = $RawKey.Substring(0, [Math]::Floor($RawKey.Length * 0.75))
        $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Slice)
        $Sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $Hash = $Sha.ComputeHash($Bytes)
        } finally {
            $Sha.Dispose()
        }
        return ([System.BitConverter]::ToString($Hash) -replace '-', '').ToLowerInvariant().Substring(0, 8)
    }

    # ── scaledFreeTierRpm (mirrors proxyTiers.ts) ─────────────────────────────
    function Get-ScaledFreeTierRpm([int]$KeyCount) {
        return [Math]::Min(12 * [Math]::Max(0, $KeyCount), 30)
    }

    # ── Probe a single key ────────────────────────────────────────────────────
    function Invoke-GeminiKeyProbe {
        param([string]$RawKey, [int]$TimeoutSec)
        # GET /v1beta/models — minimal call, no tokens consumed, auth-gates on key validity.
        $Uri = 'https://generativelanguage.googleapis.com/v1beta/models'
        try {
            $Response = Invoke-WebRequest -Uri $Uri `
                -Method GET `
                -Headers @{ 'x-goog-api-key' = $RawKey } `
                -TimeoutSec $TimeoutSec `
                -ErrorAction Stop
            if ($Response.StatusCode -eq 200) {
                return 'Pass'
            }
            return "HTTP-$($Response.StatusCode)"
        }
        catch [System.Net.WebException] {
            $StatusCode = [int]$_.Exception.Response.StatusCode
            if ($StatusCode -eq 401) { return '401-Invalid' }
            if ($StatusCode -eq 429) { return '429-RateLimited' }
            return "HTTP-$StatusCode"
        }
        catch {
            # Non-HTTP errors (timeout, DNS, etc.)
            return "Error: $($_.Exception.GetType().Name)"
        }
    }

    # ── Load candidate keys ───────────────────────────────────────────────────
    [string[]]$CandidateKeys = @()
    if ($PSCmdlet.ParameterSetName -eq 'File') {
        if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
            New-ActionableError `
                -Goal     'Load candidate keys from file' `
                -Problem  "Key file not found: $KeyFile" `
                -Location 'Sync-FreeTierKeys' `
                -NextSteps @(
                    'Verify -KeyFile path exists and is readable',
                    'Use -Key to supply keys directly'
                ) -Throw
        }
        $Lines = Get-Content -LiteralPath $KeyFile
        foreach ($Line in $Lines) {
            # Split on commas (support comma-separated on one line too)
            $Parts = $Line -split ',' | ForEach-Object { $_.Trim() } |
                Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
            $CandidateKeys += $Parts
        }
    }
    else {
        $CandidateKeys = $Key | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    }

    $CandidateKeys = @($CandidateKeys | Select-Object -Unique)

    if ($CandidateKeys.Count -eq 0) {
        New-ActionableError `
            -Goal     'Sync free-tier key pool' `
            -Problem  'No candidate keys supplied (file was empty or all entries were blank/commented)' `
            -Location 'Sync-FreeTierKeys' `
            -NextSteps @(
                'Ensure the key file contains at least one non-blank, non-comment line',
                'Use -Key to supply keys directly'
            ) -Throw
    }

    Write-Verbose "[Sync-FreeTierKeys] Probing $($CandidateKeys.Count) candidate key(s) against Gemini..."

    # ── Probe each key ────────────────────────────────────────────────────────
    # Wrap in @() so $Results is always an array (strict-mode safe for .Count / indexing).
    $Results = @(foreach ($RawKey in $CandidateKeys) {
        $Fingerprint = Get-KeyFingerprint $RawKey
        $Status = Invoke-GeminiKeyProbe -RawKey $RawKey -TimeoutSec $TimeoutSec
        [PSCustomObject]@{
            Fingerprint = $Fingerprint
            Status      = $Status
            Pass        = ($Status -eq 'Pass')
        }
    })

    # ── Build passing key list (index-based; avoids re-probing) ───────────────
    $PassingKeys = @()
    for ($i = 0; $i -lt $Results.Count; $i++) {
        if ($Results[$i].Pass) {
            $PassingKeys += $CandidateKeys[$i]
        }
    }

    $K   = $PassingKeys.Count
    $Rpm = Get-ScaledFreeTierRpm -KeyCount $K

    # ── Emit probe report ─────────────────────────────────────────────────────
    Write-Host ''
    Write-Host 'Sync-FreeTierKeys — Probe Report' -ForegroundColor Cyan
    Write-Host ('─' * 50) -ForegroundColor DarkGray
    foreach ($R in $Results) {
        $Color = if ($R.Pass) { 'Green' } elseif ($R.Status -like '429*') { 'Yellow' } else { 'Red' }
        Write-Host ("  [{0,-12}]  fp:{1}" -f $R.Status, $R.Fingerprint) -ForegroundColor $Color
    }
    Write-Host ('─' * 50) -ForegroundColor DarkGray
    Write-Host "  Total:    $($CandidateKeys.Count) probed"
    Write-Host "  Passing:  $K"
    Write-Host "  Failed:   $($CandidateKeys.Count - $K)"
    Write-Host "  K=$K  →  Front-door RPM = $Rpm  (min(12×K, 30))" -ForegroundColor $(if ($K -gt 0) { 'Cyan' } else { 'Red' })
    Write-Host ''

    if ($K -eq 0) {
        Write-Warning '[Sync-FreeTierKeys] No keys passed validation — pool will NOT be updated.'
        return [PSCustomObject]@{
            Probed      = $CandidateKeys.Count
            Passing     = 0
            K           = 0
            RPM         = 0
            Target      = $Target
            Applied     = $false
            Results     = $Results
        }
    }

    # ── Write result ──────────────────────────────────────────────────────────
    $PoolValue = $PassingKeys -join ','
    $Applied   = $false

    switch ($Target) {
        'GHASecret' {
            if ($PSCmdlet.ShouldProcess("$Repo / $SecretName", "Set GitHub secret ($K key(s))")) {
                Write-Verbose "[Sync-FreeTierKeys] Setting GitHub secret $SecretName on $Repo..."
                $GhOutput = $PoolValue | & gh secret set $SecretName --repo $Repo 2>&1
                if ($LASTEXITCODE -ne 0) {
                    New-ActionableError `
                        -Goal     "Set GitHub secret $SecretName" `
                        -Problem  "gh secret set failed (exit $LASTEXITCODE): $GhOutput" `
                        -Location 'Sync-FreeTierKeys' `
                        -NextSteps @(
                            'Ensure gh CLI is authenticated: gh auth status',
                            "Verify you have write access to $Repo",
                            'Use -Target LocalEnv or -Target None to skip GHA secret write'
                        ) -Throw
                }
                Write-Host "  GitHub secret '$SecretName' updated ($K key(s) — RPM=$Rpm)." -ForegroundColor Green
                $Applied = $true
            }
        }
        'LocalEnv' {
            if ($PSCmdlet.ShouldProcess('$env:FREE_TIER_GEMINI_KEY', "Set local env ($K key(s))")) {
                $env:FREE_TIER_GEMINI_KEY = $PoolValue
                Write-Host "  `$env:FREE_TIER_GEMINI_KEY set in current session ($K key(s) — RPM=$Rpm)." -ForegroundColor Green
                $Applied = $true
            }
        }
        'None' {
            Write-Host '  Target=None — probe complete; pool not written.' -ForegroundColor Yellow
        }
    }

    return [PSCustomObject]@{
        Probed      = $CandidateKeys.Count
        Passing     = $K
        K           = $K
        RPM         = $Rpm
        Target      = $Target
        Applied     = $Applied
        Results     = $Results
    }
}
