# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Extracts whether a Container Image run actually PUSHED, from that run's name (t/4932).

.DESCRIPTION
Auto-Deploy to Staging fires on EVERY successful Container Image run, including
`workflow_dispatch` dispatches with `push: false` (Docker's t/4840 A/B testing) and rebuilds of
SHAs older than what's currently running. `deploy-staging.yml:42` only checked
`workflow_run.conclusion == 'success'`, so a push=false dispatch redeployed staging with an
EXISTING older image through the t/4129 run-name SHA parser -- a staging downgrade, caught only
by luck (a separate smoke regression, #4646, happened to block every one of those runs).

container.yml's run-name now also carries `push=<bool>`, computed identically to its own
push_mode step (`github.event_name == 'push' || inputs.push == 'true'`) so the two can't
disagree. This function reads that flag back out of the name.

FAIL-CLOSED: a name with no `push=(true|false)` marker returns `$false` (treated as NOT pushed,
i.e. skip the deploy) -- same fail-closed direction as Get-BuiltShaFromRunName.ps1's "abort",
just resolved as "don't deploy" rather than "throw," because an unrecognized run name is itself
not proof that an image was pushed.

Invoked (not dot-sourced) with -RunName and -GitHubOutput, it writes `pushed=true`/`pushed=false`
to $env:GITHUB_OUTPUT.
#>
[CmdletBinding()]
param(
    [string] $RunName,
    [switch] $GitHubOutput
)

function Get-PushFlagFromRunName {
    # PURE: returns $true only when the run name carries an explicit "push=true" marker.
    # Anything else (no marker, "push=false", malformed) returns $false -- fail-closed.
    param([AllowEmptyString()][AllowNull()][string] $RunName)
    if ([string]::IsNullOrWhiteSpace($RunName)) { return $false }
    $m = [regex]::Match($RunName, 'push=(true|false)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $m.Success) { return $false }
    return $m.Groups[1].Value.ToLowerInvariant() -eq 'true'
}

# Run only when invoked, so the tests can dot-source the pure function.
if ($MyInvocation.InvocationName -ne '.') {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $pushed = Get-PushFlagFromRunName -RunName $RunName
    Write-Host "Pushed (from run name): $pushed"
    if ($GitHubOutput) { Add-Content -Path $env:GITHUB_OUTPUT -Value "pushed=$($pushed.ToString().ToLowerInvariant())" }
}
