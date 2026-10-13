# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4173 Build B: Orca-side scheduled-workflow liveness check.
.DESCRIPTION
    t/4173: GitHub's own cron scheduler stalled 5-8h after the org move and nothing alerted —
    main-ci-monitor's heartbeat is ALSO refreshed by workflow_run (push-triggered CI completions),
    so push traffic masked the schedule stall; and the in-workflow scheduled-workflow-health check
    (t/4058) is ITSELF schedule-triggered, so it went silent for the same reason. This predicate is
    meant to be driven by an Orca reminder on Orca's OWN scheduler — independent of GitHub Actions
    cron — so a GitHub-wide schedule stall stays visible even when every GitHub-side signal that
    depends on GitHub's own cron firing is silenced simultaneously.

    Reuses the single declared list at operations/devops/scheduled-workflows.json (t/4058) — no
    duplicate source of truth. Live state (the newest `schedule`-event run per file) is gathered by
    the caller via `gh api repos/<repo>/actions/workflows/<file>/runs?event=schedule`.

    PURE: no I/O. Two violation kinds:
      - missing — no live entry for the file, or its timestamp is null (never seen a schedule run).
      - stale   — the newest schedule-triggered run is older than its own maxSilentHours.
#>

Set-StrictMode -Version Latest

function Get-ScheduledWorkflowLivenessVerdict {
    [CmdletBinding()]
    param(
        # Declared entries: { file, maxSilentHours } — scheduled-workflows.json's `workflows` array.
        [AllowEmptyCollection()] [object[]] $Declared = @(),
        # Live state, keyed by matching `file`: { file, lastScheduleRunAt (datetime or $null) }. One
        # entry per Declared item, in the same order, or omit an entry entirely to mean "not found".
        [AllowEmptyCollection()] [object[]] $LiveByFile = @(),
        [Parameter(Mandatory)] [datetime] $Now
    )

    $violations = @(
        foreach ($d in $Declared) {
            $live = $LiveByFile | Where-Object { $_.file -eq $d.file } | Select-Object -First 1

            if (-not $live -or $null -eq $live.lastScheduleRunAt) {
                [pscustomobject]@{
                    File    = $d.file
                    Kind    = 'missing'
                    Message = "$($d.file) has no schedule-triggered run on record"
                }
                continue
            }

            $ageHours = ($Now.ToUniversalTime() - $live.lastScheduleRunAt.ToUniversalTime()).TotalHours
            if ($ageHours -gt $d.maxSilentHours) {
                [pscustomobject]@{
                    File    = $d.file
                    Kind    = 'stale'
                    Message = "$($d.file) last schedule-triggered run was $([math]::Round($ageHours, 1))h ago (threshold $($d.maxSilentHours)h)"
                }
            }
        }
    )

    [pscustomobject]@{
        Violations = $violations
        Checked    = @($Declared).Count
        ShouldAct  = $violations.Count -gt 0
    }
}
