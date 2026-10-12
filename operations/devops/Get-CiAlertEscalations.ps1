# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Local escalation bridge (t/3912): surface persisting main-ci-monitor alerts and a dead monitor
    to the DevOps agent via its hourly Orca reminder.
.DESCRIPTION
    Impure runner for CiAlertEscalationVerdict.ps1. Reads, from GitHub:
      - open issues labelled `alert-escalated` (latched once per episode by main-ci-monitor.yml);
      - the open `main-ci-monitor-heartbeat` issue body (its timestamp is the monitor's liveness).
    Returns the verdict object. The caller (the reminder prompt) acts when ShouldAct is true, then
    labels each handled issue `owner-acked` so the same episode is not re-surfaced next hour.

    A gh failure is NOT read as "nothing to report": it returns ShouldAct=$true with QueryError set,
    because an unreadable alarm state is itself something the owner must see (t/3671 cond 1).
.EXAMPLE
    ./operations/devops/Get-CiAlertEscalations.ps1
#>
[CmdletBinding()]
param(
    [string] $Repo = 'AI-Rosetta-Stone/ai-triad-research',
    [double] $HeartbeatStaleHours = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CiAlertEscalationVerdict.ps1')
. (Join-Path $PSScriptRoot 'AlertReaderGuardVerdict.ps1')

try {
    # t/4156: a renamed/unresolvable repo must read as blind, never as a clean zero.
    $fullName = gh api "repos/$Repo" -q .full_name 2>$null
    if ($LASTEXITCODE -ne 0) { $fullName = $null }
    $floorJson = gh issue list -R $Repo --label main-ci-monitor-heartbeat --state all --limit 1 --json number 2>$null
    $floorCount = if ($LASTEXITCODE -eq 0) { @($floorJson | ConvertFrom-Json).Count } else { 0 }
    $guard = Get-AlertReaderGuardVerdict -Repo $Repo -ResolvedFullName $fullName `
        -FloorLabel 'main-ci-monitor-heartbeat' -FloorLabelAllStatesCount $floorCount
    if ($guard.IsBlind) { throw $guard.Reason }

    $escalatedJson = gh issue list -R $Repo --state open --label alert-escalated --limit 50 --json number,title,url,labels
    if ($LASTEXITCODE -ne 0) { throw "gh issue list (alert-escalated) exited $LASTEXITCODE" }
    $escalated = @($escalatedJson | ConvertFrom-Json | ForEach-Object {
        [pscustomobject]@{ number = $_.number; title = $_.title; url = $_.url; labels = @($_.labels | ForEach-Object { $_.name }) }
    })

    $hbJson = gh issue list -R $Repo --state open --label main-ci-monitor-heartbeat --limit 1 --json number,body
    if ($LASTEXITCODE -ne 0) { throw "gh issue list (heartbeat) exited $LASTEXITCODE" }
    $hb = @($hbJson | ConvertFrom-Json)
    $hbBody = if ($hb.Count -gt 0) { $hb[0].body } else { $null }

    $verdict = Get-CiAlertEscalationVerdict -EscalatedIssues $escalated -HeartbeatBody $hbBody `
        -Now ([datetime]::UtcNow) -HeartbeatStaleHours $HeartbeatStaleHours
    $verdict | Add-Member -NotePropertyName QueryError -NotePropertyValue $null
    $verdict
}
catch {
    # Fail loud: an unreadable alarm state must reach the owner, never read as "all clear".
    Write-Warning "CI alert escalation bridge could not query GitHub ($Repo): $($_.Exception.Message) — reporting ShouldAct=true"
    [pscustomobject]@{
        UnackedEscalations = @()
        HeartbeatAt        = $null
        HeartbeatAgeHours  = $null
        HeartbeatStale     = $null
        HeartbeatReason    = 'not evaluated'
        ShouldAct          = $true
        QueryError         = $_.Exception.Message
    }
}
