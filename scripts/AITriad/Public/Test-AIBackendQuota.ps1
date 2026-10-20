# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Probes each configured AI backend and flags quota-exhausted ones, with a best-effort reset time.
.DESCRIPTION
    Sends a minimal completion ('ping') to each backend's default model (from ai-models.json)
    through the same Invoke-AIApi path production cmdlets use, and classifies the result. Its
    purpose is proactive quota visibility: a backend whose quota is exhausted returns
    Status='quota' here instead of surfacing only as a wall of judge failures mid-session.

    Shares one probe implementation with Test-AIBackendHealth (Private/Invoke-AIBackendProbe);
    the difference is projection — this cmdlet reports the quota reset time (ResetAt) rather than
    latency, and is intended for the session-start health check.

    Status values: ok | quota | timeout | error | no-model. Per-backend failure is a reported
    row, never a thrown exception; only an unloadable ai-models.json throws.

    ResetAt is best-effort. Providers do not reliably return a reset time and Invoke-AIApi scrubs
    the response body, so ResetAt is populated only when a Retry-After delay or an explicit date
    survives in the captured warning text — otherwise $null. Treat a $null ResetAt on a 'quota'
    row as "reset time unknown", not "resets now".
.PARAMETER Backend
    Single backend to probe. One of: gemini, claude, groq, openai, deepseek, azure, zai,
    moonshot, xai, ollama. Omit (or use -All) to probe every backend with a default model.
.PARAMETER All
    Probe every backend that has a default model in ai-models.json. This is the default when no
    backend is named — a bare Test-AIBackendQuota probes all, for session-start use.
.PARAMETER TimeoutSec
    Per-probe timeout in seconds. Default 15.
.EXAMPLE
    Test-AIBackendQuota | Format-Table Backend, Model, Status, ResetAt
    # Session-start sweep across every configured backend.
.EXAMPLE
    Test-AIBackendQuota | Where-Object Status -eq 'quota'
    # Surface only quota-exhausted backends.
.EXAMPLE
    Test-AIBackendQuota -Backend claude
    # Check a single backend (e.g. after a run of judge failures).
.LINK
    Test-AIBackendHealth
.LINK
    Test-AIApiKey
.LINK
    Show-AITriadHelp
#>
function Test-AIBackendQuota {
    [CmdletBinding(DefaultParameterSetName = 'All')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'One', Position = 0)]
        [ValidateSet('gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama')]
        [string]$Backend,

        [Parameter(ParameterSetName = 'All')]
        [switch]$All,

        [ValidateRange(1, 300)]
        [int]$TimeoutSec = 15
    )

    Set-StrictMode -Version Latest

    # ── Load ai-models.json defaults (backend id -> default model id) ──────
    $ConfigPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..' '..' '..' 'ai-models.json'))
    if (-not (Test-Path $ConfigPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal      'Load AI backend defaults for quota probe' `
            -Problem   "ai-models.json not found at: $ConfigPath" `
            -Location  'Test-AIBackendQuota' `
            -NextSteps 'Verify the repo root contains ai-models.json and that the module is loaded from its expected path.')
    }
    $Config   = Get-Content -Raw $ConfigPath | ConvertFrom-Json
    $Defaults = $Config.defaults

    # ── Project the shared probe to the quota-focused columns ─────────────
    function _QuotaRow {
        param([string]$B, [string]$ModelId, [int]$Timeout)
        $P = Invoke-AIBackendProbe -Backend $B -ModelId $ModelId -TimeoutSec $Timeout
        [PSCustomObject]@{
            Backend      = $P.Backend
            Model        = $P.Model
            Status       = $P.Status
            ResetAt      = $P.ResetAt
            ErrorMessage = $P.ErrorMessage
            TestedAt     = $P.TestedAt
        }
    }

    # ── Dispatch (bare call / -All => every backend; -Backend => one) ─────
    if ($PSCmdlet.ParameterSetName -eq 'One') {
        $MId = if ($Defaults.PSObject.Properties[$Backend]) { $Defaults.$Backend } else { $null }
        _QuotaRow -B $Backend -ModelId $MId -Timeout $TimeoutSec
    } else {
        foreach ($B in $Defaults.PSObject.Properties.Name) {
            _QuotaRow -B $B -ModelId $Defaults.$B -Timeout $TimeoutSec
        }
    }
}
