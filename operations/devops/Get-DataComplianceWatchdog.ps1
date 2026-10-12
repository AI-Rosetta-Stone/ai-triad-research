# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Orca-side reader for the data-compliance alert watchdog (t/4053, leg b), run by DevOps' hourly r/23.
.DESCRIPTION
    Impure runner for DataComplianceWatchdogVerdict.ps1. PULLS from GitHub (there is no GitHub->Orca
    inbound path, t/4053#5):
      - open ai-triad-data issues labelled `bridge-stale` (set by data-compliance-watchdog.yml when a
        data-compliance alert sat unrouted past its threshold);
      - the most recent SCHEDULED run of data-compliance-watchdog.yml that concluded success.
    Returns the verdict object. The caller acts when ShouldAct is true: ping CL for each unrouted
    alert, or investigate / re-enable a stale watchdog.

    A gh failure is NOT read as "nothing to report": it returns ShouldAct=$true with QueryError set.
.EXAMPLE
    ./operations/devops/Get-DataComplianceWatchdog.ps1
#>
[CmdletBinding()]
param(
    [string] $Repo = 'AI-Rosetta-Stone/ai-triad-data',
    [string] $Workflow = 'data-compliance-watchdog.yml',
    [double] $WatchdogStaleHours = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DataComplianceWatchdogVerdict.ps1')

try {
    $staleJson = gh issue list -R $Repo --state open --label bridge-stale --limit 100 --json number,title,url,labels
    if ($LASTEXITCODE -ne 0) { throw "gh issue list (bridge-stale) exited $LASTEXITCODE" }
    $stale = @($staleJson | ConvertFrom-Json | ForEach-Object {
        [pscustomobject]@{ number = $_.number; title = $_.title; url = $_.url; labels = @($_.labels | ForEach-Object { $_.name }) }
    })

    # A workflow that does not exist yet (not merged) makes gh exit non-zero; that is NOT "healthy" —
    # report it as "no successful scheduled run", which the verdict treats as stale.
    $runsJson = gh run list -R $Repo --workflow $Workflow --event schedule --status success --limit 1 --json updatedAt 2>$null
    $lastSuccess = $null
    if ($LASTEXITCODE -eq 0) {
        $runs = @($runsJson | ConvertFrom-Json)
        if ($runs.Count -gt 0) { $lastSuccess = ([datetime]$runs[0].updatedAt).ToUniversalTime() }
    } else {
        Write-Warning "gh run list for $Workflow exited $LASTEXITCODE (workflow missing or unreadable) — treating as no successful scheduled run"
    }

    $verdict = Get-DataComplianceWatchdogVerdict -StaleIssues $stale -LastScheduledSuccessAt $lastSuccess `
        -Now ([datetime]::UtcNow) -WatchdogStaleHours $WatchdogStaleHours
    $verdict | Add-Member -NotePropertyName QueryError -NotePropertyValue $null
    $verdict
}
catch {
    Write-Warning "Data-compliance watchdog reader could not query GitHub ($Repo): $($_.Exception.Message) — reporting ShouldAct=true"
    [pscustomobject]@{
        UnroutedAlerts   = @()
        WatchdogAgeHours = $null
        WatchdogStale    = $null
        WatchdogReason   = 'not evaluated'
        ShouldAct        = $true
        QueryError       = $_.Exception.Message
    }
}
