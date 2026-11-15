# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pure decision for deploy-azure.yml's "Verify the restored revision after a gate rollback" step (t/353).

.DESCRIPTION
    After a gate rollback, "Rollback on failure" ends in an unconditional exit 1. So the AC2
    serving-revision check (implicit success()) never runs, and nothing verified that the RESTORED
    revision is actually serving (SO p/106#18, DevOps Lead p/107#14). This verdict closes that gap.

    It takes the fresh reads the workflow step makes and returns @{ Healthy = $true|$false; Reason }.
    Fail-closed: every input must positively say "serving"; anything missing or unknown is NOT healthy,
    because the alert this feeds is the only signal that prod may be down after a rollback.

    Healthy needs ALL of:
      - a restored revision name (the rollback had a target)
      - Active is exactly $true
      - Weight is exactly 100 (no canary split exists today; the same assumption as AC2, SO C4)
      - the app URL's /health check passed ($true)
#>

function Get-RestoredRevisionVerdict {
    param(
        [AllowEmptyString()][string]$RestoredRevision,
        [Nullable[bool]]$Active,
        [Nullable[int]]$Weight,
        [Nullable[bool]]$HealthOk
    )
    function Bad([string]$why) { @{ Healthy = $false; Reason = $why } }

    if ([string]::IsNullOrWhiteSpace($RestoredRevision)) { return Bad 'no restored revision name (rollback target unknown)' }
    if ($null -eq $Active) { return Bad "could not read whether '$RestoredRevision' is active" }
    if (-not $Active) { return Bad "restored revision '$RestoredRevision' is NOT active" }
    if ($null -eq $Weight) { return Bad "could not read the traffic weight of '$RestoredRevision'" }
    if ($Weight -ne 100) { return Bad "restored revision '$RestoredRevision' serves at weight $Weight, not 100" }
    if ($null -eq $HealthOk) { return Bad 'the /health check did not run' }
    if (-not $HealthOk) { return Bad "app /health is not healthy with '$RestoredRevision' serving" }

    @{ Healthy = $true; Reason = "'$RestoredRevision' is active at weight 100 and /health is healthy" }
}
