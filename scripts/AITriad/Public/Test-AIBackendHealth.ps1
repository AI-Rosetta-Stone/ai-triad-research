# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Probes each AI backend with a minimal completion request and reports latency and status.
.DESCRIPTION
    Sends a 1-token completion probe ("ping") through the same Invoke-AIApi path used by all
    production cmdlets, using the default model for each backend from ai-models.json. Reports
    reachability, round-trip latency, and whether the completion succeeded.

    Unlike Test-AIApiKey (which hits an auth-only /models endpoint without consuming tokens),
    Test-AIBackendHealth exercises the full completion stack — key resolution, serialization,
    transport, and deserialization. A backend that passes Test-AIApiKey but fails here has a
    model-level or quota problem.

    Per-backend failure is returned as a row with status 'error' or 'timeout', not a thrown
    exception. Only unrecoverable setup failures (e.g., ai-models.json not found) throw.

.PARAMETER Backend
    Single backend to probe. One of: gemini, claude, groq, openai, deepseek, azure, zai,
    moonshot, xai, ollama.

.PARAMETER All
    Probe every backend that has a default model in ai-models.json.

.PARAMETER TimeoutSec
    Per-probe timeout in seconds. Default 15.

.EXAMPLE
    Test-AIBackendHealth -Backend gemini
    # Returns one row: backend, model, status, latency_ms.

.EXAMPLE
    Test-AIBackendHealth -All | Format-Table Backend, Model, Status, LatencyMs, ErrorMessage

.EXAMPLE
    Test-AIBackendHealth -All | Where-Object Status -ne 'ok'
    # Surface only degraded backends before starting a debate run.

.LINK
    Test-AIApiKey
.LINK
    Show-AITriadHelp
#>
function Test-AIBackendHealth {
    [CmdletBinding(DefaultParameterSetName = 'One')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'One', Position = 0)]
        [ValidateSet('gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama')]
        [string]$Backend,

        [Parameter(Mandatory, ParameterSetName = 'All')]
        [switch]$All,

        [ValidateRange(1, 300)]
        [int]$TimeoutSec = 15
    )

    Set-StrictMode -Version Latest

    # ── Load ai-models.json defaults ────────────────────────────────────
    $ConfigPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..' '..' '..' 'ai-models.json'))
    if (-not (Test-Path $ConfigPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal     'Load AI backend defaults for health probe' `
            -Problem  "ai-models.json not found at: $ConfigPath" `
            -Location 'Test-AIBackendHealth' `
            -NextSteps 'Verify the repo root contains ai-models.json and that the module is loaded from its expected path.')
    }
    $Config  = Get-Content -Raw $ConfigPath | ConvertFrom-Json
    $Defaults = $Config.defaults

    # ── Project the shared probe to this cmdlet's latency-focused columns ──
    # The probe (Private/Invoke-AIBackendProbe) is the single source of the ping + classification,
    # shared with Test-AIBackendQuota. Health reports latency and drops the quota-specific ResetAt.
    function _HealthRow {
        param([string]$B, [string]$ModelId, [int]$Timeout)
        $P = Invoke-AIBackendProbe -Backend $B -ModelId $ModelId -TimeoutSec $Timeout
        [PSCustomObject]@{
            Backend      = $P.Backend
            Model        = $P.Model
            Status       = $P.Status
            LatencyMs    = $P.LatencyMs
            ErrorMessage = $P.ErrorMessage
            TestedAt     = $P.TestedAt
        }
    }

    # ── Dispatch ─────────────────────────────────────────────────────────
    if ($PSCmdlet.ParameterSetName -eq 'All') {
        foreach ($B in $Defaults.PSObject.Properties.Name) {
            _HealthRow -B $B -ModelId $Defaults.$B -Timeout $TimeoutSec
        }
    } else {
        $MId = if ($Defaults.PSObject.Properties[$Backend]) { $Defaults.$Backend } else { $null }
        _HealthRow -B $Backend -ModelId $MId -Timeout $TimeoutSec
    }
}
