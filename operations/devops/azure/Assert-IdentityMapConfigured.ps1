# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deploy preflight for IDENTITY_MAP (t/4326): refuse a prod deploy that would ship an empty or
    incomplete identity map; warn on staging.
.DESCRIPTION
    principalName.ts maps a stable provider id onto the legacy principal name via IDENTITY_MAP.
    An unset map deploys as '' and the ExpectedEnvVars drift gate stays GREEN (it expects ''),
    while the smoke account silently loses its read-only tier and the PI's GitHub account loses
    admin. That is a silent fail-open, so the prod deploy fails here instead (TL p/404#119).

    Value format: comma-separated `<idp>:<stableId>=<legacy principal name>`.
    Fails (or warns) when the value is empty, when an entry is malformed, or when a required key
    is missing or maps to an empty name. Defaults: `github:6188114` (the PI's GitHub account, for
    admin) and `github:344897154` (ai-triad-smoke, for READ_ONLY_PRINCIPALS — t/4326 SO C2).

    Test-IdentityMapValue is pure, so tests/Assert-IdentityMapConfigured.Tests.ps1 proves both arms.
#>
[CmdletBinding()]
param(
    [AllowEmptyString()][string]$Value = '',
    [ValidateSet('Fail', 'Warn')][string]$Mode = 'Fail',
    # github:6188114 = the PI's GitHub account (admin); github:344897154 = ai-triad-smoke
    # (READ_ONLY_PRINCIPALS, t/4326 SO C2).
    [string[]]$RequiredKeys = @('github:6188114', 'github:344897154')
)

function Test-IdentityMapValue {
    <# Pure: returns @{ Pass; Problems[] } for an IDENTITY_MAP value. #>
    param([AllowEmptyString()][string]$Value, [string[]]$RequiredKeys)
    $problems = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($Value)) {
        $problems.Add('vars.IDENTITY_MAP is empty or unset')
        return [PSCustomObject]@{ Pass = $false; Problems = @($problems) }
    }
    $map = @{}
    foreach ($raw in ($Value -split ',')) {
        $entry = $raw.Trim()
        if (-not $entry) { continue }
        $eq = $entry.IndexOf('=')
        $key = if ($eq -gt 0) { $entry.Substring(0, $eq).Trim() } else { '' }
        if ($eq -le 0 -or $key -notmatch '^[a-z]+:[^=\s]+$') {
            $problems.Add("malformed entry '$($entry.Split('=')[0])…' (expected <idp>:<stableId>=<legacy principal name>)")
            continue
        }
        $map[$key] = $entry.Substring($eq + 1).Trim()
    }
    foreach ($k in $RequiredKeys) {
        if (-not $map.ContainsKey($k)) { $problems.Add("required entry '$k=' is missing") }
        elseif ([string]::IsNullOrWhiteSpace($map[$k])) { $problems.Add("required entry '$k=' maps to an empty name") }
    }
    return [PSCustomObject]@{ Pass = ($problems.Count -eq 0); Problems = @($problems) }
}

if ($MyInvocation.InvocationName -ne '.') {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    . (Join-Path $PSScriptRoot '..' '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')
    $v = Test-IdentityMapValue -Value $Value -RequiredKeys $RequiredKeys
    if ($v.Pass) {
        $count = @($Value -split ',' | Where-Object { $_.Trim() }).Count
        Write-Host "t/4326: IDENTITY_MAP OK — $count entr$(if ($count -eq 1) { 'y' } else { 'ies' }), required keys present: $($RequiredKeys -join ', ')."
        exit 0
    }
    $summary = $v.Problems -join '; '
    if ($Mode -eq 'Warn') {
        Write-Host "::warning title=t/4326 IDENTITY_MAP::$summary — signed-in GitHub users will not map onto their legacy ids (read-only tier and admin are lost)."
        exit 0
    }
    Write-Host "::error title=t/4326 IDENTITY_MAP::$summary"
    # Explicit exit 1 (not just a throw): a fail-closed gate must not depend on how the host maps
    # an uncaught exception to an exit code.
    $msg = New-ActionableError -Goal 'Deploy production with a complete IDENTITY_MAP' `
        -Problem "$summary. Deploying would set IDENTITY_MAP to an incomplete value: ai-triad-smoke loses its read-only tier and the PI's GitHub account loses admin, while the env drift gate stays green." `
        -Location 'operations/devops/azure/Assert-IdentityMapConfigured.ps1 (deploy-azure.yml preflight)' `
        -NextSteps @(
            'Set the IDENTITY_MAP repository variable (PI only): gh variable set IDENTITY_MAP -R AI-Rosetta-Stone/ai-triad-research',
            "Include every required entry ($($RequiredKeys -join ', ')) in the form <idp>:<stableId>=<legacy principal name>",
            'Re-dispatch the deploy'
        ) -PassThru
    Write-Host $msg
    exit 1
}
