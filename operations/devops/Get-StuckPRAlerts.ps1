# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Local escalation bridge (t/4115): surface stuck-PR SLA breaches and sweep-signature
    escalations to the DevOps agent via its scheduled Orca reminder.
.DESCRIPTION
    Impure runner, same shape as Get-CiAlertEscalations.ps1 (t/3912): `pr-triage.yml`
    (operations/devops/stuck-pr-classifier.mjs) is the pure classifier + the impure
    fact-fetch/labelling step, both running IN GitHub Actions, which cannot call Orca MCP
    tools (resolve_owner, send_ping). This script closes that gap: it reads what the
    workflow already labelled, and returns a verdict object. The CALLER (the reminder
    prompt, run by an agent) acts when ShouldAct is true -- it is this script's job to
    surface the facts, never to call send_ping itself (this file has no MCP access either;
    it just runs as a plain script under gh).

    A gh failure is NOT read as "nothing to report" (same rule as t/3912 cond 1): it returns
    ShouldAct=$true with QueryError set.

    OWNER RESOLUTION ORDER (Lead review, PR #3141 item 4) -- performed by the CALLING AGENT,
    not this script (branch parsing alone mis-routes any PR whose branch lacks a ticket, or
    names a parent ticket, so it is a hint only, never the resolution):
      1. If `.ticket` (the branch-derived hint) is non-null, call `get_ticket` on it. If the
         ticket has an assignee, ping that role's Main.
      2. Otherwise (no hint, or the ticket has no assignee), call `resolve_owners_batch` on the
         PR's changed files (`gh pr view <number> --json files`), and ping the owning role's Main.
      3. If neither resolves, escalate to the TL rather than silently dropping the alert.
.EXAMPLE
    ./operations/devops/Get-StuckPRAlerts.ps1
#>
[CmdletBinding()]
param(
    [string] $Repo = 'AI-Rosetta-Stone/ai-triad-research'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function script:Get-PrsByLabel([string]$Label) {
    $json = gh pr list -R $Repo --state open --label $Label --limit 50 --json number,title,url,headRefName,labels,body
    if ($LASTEXITCODE -ne 0) { throw "gh pr list (label=$Label) exited $LASTEXITCODE" }
    @($json | ConvertFrom-Json)
}

function script:Get-TicketHintFromBranch([string]$Ref) {
    # A HINT only -- see the OWNER RESOLUTION ORDER note above. Never treated as resolved.
    if ($Ref -match 't(\d{3,5})') { return "t/$($Matches[1])" }
    return $null
}

try {
    $ownerAlerts = @(Get-PrsByLabel 'stuck-pr-alert-owner' | ForEach-Object {
        [pscustomobject]@{
            number     = $_.number
            title      = $_.title
            url        = $_.url
            ticketHint = Get-TicketHintFromBranch $_.headRefName
            level      = 'owner'
        }
    })
    $tlAlerts = @(Get-PrsByLabel 'stuck-pr-alert-tl' | ForEach-Object {
        [pscustomobject]@{
            number     = $_.number
            title      = $_.title
            url        = $_.url
            ticketHint = Get-TicketHintFromBranch $_.headRefName
            level      = 'tl'
        }
    })
    $sweepAlerts = @(Get-PrsByLabel 'sweep-signature-alert' | ForEach-Object {
        [pscustomobject]@{
            number = $_.number
            title  = $_.title
            url    = $_.url
        }
    })

    [pscustomobject]@{
        OwnerAlerts  = $ownerAlerts
        TLAlerts     = $tlAlerts
        SweepAlerts  = $sweepAlerts
        ShouldAct    = (($ownerAlerts.Count + $tlAlerts.Count + $sweepAlerts.Count) -gt 0)
        QueryError   = $null
    }
}
catch {
    # Fail loud: an unreadable alert state must reach the owner, never read as "all clear".
    Write-Warning "Stuck-PR alert bridge could not query GitHub ($Repo): $($_.Exception.Message) — reporting ShouldAct=true"
    [pscustomobject]@{
        OwnerAlerts = @()
        TLAlerts    = @()
        SweepAlerts = @()
        ShouldAct   = $true
        QueryError  = $_.Exception.Message
    }
}
