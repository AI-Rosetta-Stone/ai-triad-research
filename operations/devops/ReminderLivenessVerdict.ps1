# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure predicate for the t/4139 reminder-liveness check (t/4053 prevention).
.DESCRIPTION
    t/4053's Get-DataComplianceWatchdog.ps1 (code #3028) was merged with both arms proven, but no
    reminder ever invoked it, so it stayed silent for 5 days -- a tested mechanism with no
    production invocation. Nothing checked that the reminder existed, was enabled, or had fired
    recently. This predicate is that check, generalized to any declared alerting reminder.

    Three violation shapes, any one of which is a finding:
      - missing   -- no reminder matches the declared ref/name at all.
      - disabled  -- the reminder exists but enabled=false.
      - stale     -- the reminder is enabled, but its last_run_at is older than its own
                      max_age_hours (or it has never run at all, which is stale by definition).

    PURE: no I/O. The declared list (data) and the live reminder states (from get_reminder /
    list_reminders) are both gathered by the caller.
#>

Set-StrictMode -Version Latest

function Get-ReminderLivenessVerdict {
    [CmdletBinding()]
    param(
        # Declared entries: { name, ref, max_age_hours, why }.
        [AllowEmptyCollection()] [object[]] $Declared = @(),
        # Live reminder states, keyed by matching `name` (or $null entries for ones not found):
        # { name, enabled (bool), last_run_at (datetime or $null) }. One entry per Declared item,
        # in the same order, or omit an entry entirely to mean "not found".
        [AllowEmptyCollection()] [object[]] $LiveByName = @(),
        [Parameter(Mandatory)] [datetime] $Now
    )

    $violations = @(
        foreach ($d in $Declared) {
            $live = $LiveByName | Where-Object { $_.name -eq $d.name } | Select-Object -First 1

            if (-not $live) {
                [pscustomobject]@{
                    Name    = $d.name
                    Ref     = $d.ref
                    Kind    = 'missing'
                    Message = "$($d.ref) ($($d.name)) is declared but no matching reminder exists"
                }
                continue
            }

            if (-not $live.enabled) {
                [pscustomobject]@{
                    Name    = $d.name
                    Ref     = $d.ref
                    Kind    = 'disabled'
                    Message = "$($d.ref) ($($d.name)) is disabled"
                }
                continue
            }

            $ageHours = if ($null -eq $live.last_run_at) { [double]::PositiveInfinity } `
                else { ($Now.ToUniversalTime() - $live.last_run_at.ToUniversalTime()).TotalHours }

            if ($ageHours -gt $d.max_age_hours) {
                $ageText = if ([double]::IsPositiveInfinity($ageHours)) { 'never run' } else { "last ran $([math]::Round($ageHours, 1))h ago" }
                [pscustomobject]@{
                    Name    = $d.name
                    Ref     = $d.ref
                    Kind    = 'stale'
                    Message = "$($d.ref) ($($d.name)) is stale: $ageText (threshold $($d.max_age_hours)h)"
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
