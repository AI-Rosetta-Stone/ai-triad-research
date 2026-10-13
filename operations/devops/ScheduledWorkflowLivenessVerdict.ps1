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
    duplicate source of truth. Live state is gathered by the caller via `gh api
    repos/<repo>/actions/workflows/<file>/runs?event=schedule&per_page=5` — the last FEW runs, not
    just the newest.

    CADENCE, NOT JUST LAST-RUN AGE (t/4173#6, Lead's own correction after shipping an age-only
    check in this same ticket): "liveness has to be judged on cadence ... not on the last-run age
    alone." A single burst run after a long stall resets "age since last run" to ~0 and reads as
    healthy under an age-only check, even though the cron is still broken (exactly what happened at
    t/4173#5 — a burst at 02:53Z was mistaken for recovery, then the cron stalled again). This
    predicate instead computes the MAX GAP across ALL consecutive pairs in the supplied run history
    (including from the newest run to `now`) and flags staleness if any gap exceeds maxSilentHours.
    A burst-then-stall shows up as a huge gap between the pre-stall run and the burst run, even
    though the newest run is fresh — so it still flags correctly. A single lonely data point (one
    run, no history) cannot evidence a gap at all and is treated as 'missing', not assumed healthy —
    true cadence needs at least 2 runs to compute one gap.

    PURE: no I/O. Two violation kinds:
      - missing — no live entry for the file, or fewer than 2 run timestamps on record (can't
        compute a gap, so can't claim a cadence — never read this as "healthy by default").
      - stale   — the largest gap among (now - newest) and all consecutive run-to-run gaps in the
        supplied history exceeds the declared maxSilentHours.
#>

Set-StrictMode -Version Latest

function Get-ScheduledWorkflowLivenessVerdict {
    [CmdletBinding()]
    param(
        # Declared entries: { file, maxSilentHours } — scheduled-workflows.json's `workflows` array.
        [AllowEmptyCollection()] [object[]] $Declared = @(),
        # Live state, keyed by matching `file`: { file, scheduleRunTimestamps (datetime[], any order,
        # recommend the last 3-5 schedule-triggered runs) }. Omit an entry, or pass an empty/single-
        # element array, to mean "no evidenced cadence".
        [AllowEmptyCollection()] [object[]] $LiveByFile = @(),
        [Parameter(Mandatory)] [datetime] $Now
    )

    $violations = @(
        foreach ($d in $Declared) {
            $live = $LiveByFile | Where-Object { $_.file -eq $d.file } | Select-Object -First 1
            $timestamps = if ($live) { @($live.scheduleRunTimestamps | Where-Object { $null -ne $_ }) } else { @() }

            if (@($timestamps).Count -lt 2) {
                [pscustomobject]@{
                    File    = $d.file
                    Kind    = 'missing'
                    Message = "$($d.file) has fewer than 2 schedule-triggered runs on record — cannot evidence a cadence"
                }
                continue
            }

            $sorted = $timestamps | ForEach-Object { $_.ToUniversalTime() } | Sort-Object -Descending
            $gaps = @()
            $gaps += ($Now.ToUniversalTime() - $sorted[0]).TotalHours
            for ($i = 0; $i -lt ($sorted.Count - 1); $i++) {
                $gaps += ($sorted[$i] - $sorted[$i + 1]).TotalHours
            }
            $maxGapHours = ($gaps | Measure-Object -Maximum).Maximum

            if ($maxGapHours -gt $d.maxSilentHours) {
                [pscustomobject]@{
                    File    = $d.file
                    Kind    = 'stale'
                    Message = "$($d.file) has a $([math]::Round($maxGapHours, 1))h gap in its schedule-triggered run history (threshold $($d.maxSilentHours)h) — a burst run does not clear this"
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
