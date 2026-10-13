# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Impure bridge for t/4173 Build B: queries GitHub for each declared scheduled workflow's recent
    `schedule`-event run history, then evaluates liveness via the pure
    Get-ScheduledWorkflowLivenessVerdict predicate (cadence-based, t/4173#6 — not last-run age alone).
.DESCRIPTION
    Intended to be invoked by an Orca reminder on ORCA'S OWN SCHEDULER. The whole point of this
    check is that it must keep running even if GitHub Actions' cron trigger itself stalls (t/4173:
    GitHub's schedules went silent 5-8h after the org move and nothing alerted, because the
    in-workflow scheduled-workflow-health check is itself schedule-triggered and went silent for the
    same reason) — so this script must never be fired BY a GitHub-triggered workflow.

    Reuses the single declared list at operations/devops/scheduled-workflows.json (t/4058) — no
    duplicate source of truth.
.PARAMETER Repo
    owner/repo. No default — per the t/4115/t/4156 canonical-name lesson, a stale default silently
    returns 0/empty with no error after an org rename, which is a blind spot, not a query failure.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Repo
)

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'ScheduledWorkflowLivenessVerdict.ps1')

$declaredPath = Join-Path $PSScriptRoot 'scheduled-workflows.json'
$declared = (Get-Content $declaredPath -Raw | ConvertFrom-Json).workflows

$resolvedFullName = $null
try { $resolvedFullName = (gh api "repos/$Repo" -q '.full_name' 2>$null) } catch { $resolvedFullName = $null }

# t/4156 canonical-name guard: a renamed/transferred/unresolvable repo must fail SAFE (QueryError),
# never report a clean zero that looks identical to "nothing wrong."
if ([string]::IsNullOrWhiteSpace($resolvedFullName) -or
    $resolvedFullName.ToLowerInvariant() -ne $Repo.ToLowerInvariant()) {
    return [pscustomobject]@{
        Violations = @()
        Checked    = 0
        ShouldAct  = $false
        QueryError = "Repo '$Repo' did not resolve to itself (got '$resolvedFullName') — renamed/transferred or unresolvable; refusing to report a clean zero."
    }
}

$now = [datetime]::UtcNow
$live = foreach ($w in $declared) {
    $runsJson = $null
    # per_page=5, not 1: the pure predicate needs a short RUN HISTORY to compute a cadence gap
    # (t/4173#6) — a single newest-run timestamp can't distinguish a healthy cron from a burst
    # that fired once after a long stall and will stall again.
    try { $runsJson = gh api "repos/$Repo/actions/workflows/$($w.file)/runs?event=schedule&per_page=5" 2>$null } catch { $runsJson = $null }
    $timestamps = @()
    if ($runsJson) {
        $parsed = $runsJson | ConvertFrom-Json
        $timestamps = @($parsed.workflow_runs | ForEach-Object { [datetime]::Parse($_.created_at).ToUniversalTime() })
    }
    [pscustomobject]@{ file = $w.file; scheduleRunTimestamps = $timestamps }
}

$verdict = Get-ScheduledWorkflowLivenessVerdict -Declared $declared -LiveByFile $live -Now $now
[pscustomobject]@{
    Violations = $verdict.Violations
    Checked    = $verdict.Checked
    ShouldAct  = $verdict.ShouldAct
    QueryError = $null
}
