# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Classifies whether a test-powershell shard ended abnormally (infra) or genuinely ran to
completion -- the structured counterpart to ci.yml's "Explain a test-powershell mid-run kill"
step (t/4548 arm 3).

.DESCRIPTION
t/4548: the TL rejected a log-grep classifier for the auto-rerun handler ("a grep on the
::error:: wording silently disables the rerun the first time someone edits the message, and
nothing would notice"). This pure function is the single source of truth both the inline
workflow step (dot-sourced) and the cross-workflow rerun handler consume -- the workflow step
writes its result to a JSON artifact (job outputs aren't readable from a separate workflow_run
handler; see t/4548#2), and the rerun handler reads that artifact, never a log line.

Same decision shape as the existing inline switch: a completion marker PRESENT means the suite
ran to completion (a real pass or a real fail) -- never abnormal, regardless of Pester's
step-level outcome. A marker ABSENT means the suite was killed before finishing; classify by the
step outcome that killed it. This mirrors ci.yml:758-762 exactly, so the contract can't silently
drift between the human-readable log line and the machine-readable artifact.

PURE: no I/O. The caller supplies MarkerPresent and PesterOutcome; this never reads a file or
calls an API itself.
#>
function Get-TestPowerShellAbnormalEndVerdict {
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)][bool] $MarkerPresent,
        [Parameter(Mandatory)][AllowEmptyString()][AllowNull()][string] $PesterOutcome
    )

    if ($MarkerPresent) {
        return [PSCustomObject]@{ AbnormalEnd = $false; Reason = $null }
    }

    switch ($PesterOutcome) {
        'failure' {
            return [PSCustomObject]@{
                AbnormalEnd = $true
                Reason      = 'timed-out-after-25-minutes'
            }
        }
        'cancelled' {
            return [PSCustomObject]@{
                AbnormalEnd = $true
                Reason      = 'cancelled-mid-run'
            }
        }
        default {
            return [PSCustomObject]@{
                AbnormalEnd = $true
                Reason      = "ended-abnormally-outcome-$PesterOutcome"
            }
        }
    }
}
