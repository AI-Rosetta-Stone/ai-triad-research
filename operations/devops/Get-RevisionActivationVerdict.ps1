# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Classifies a new Container App revision during the deploy health check: keep waiting, healthy, or a
terminal activation failure with a named cause (t/4158).

.DESCRIPTION
On 2026-10-12 (t/4096 deploy attempt 2) a new prod revision went ActivationFailed because the GitHub App
installation ID pointed at another App: every request logged `Installation token mint failed` (HTTP 404).
The health-check step kept probing a revision that could never start and held the job for 20+ minutes,
and its error said only "unhealthy".

This verdict lets the step stop on the first poll that shows a terminal state, and names the cause from
the revision's own log so the operator sees "wrong installation ID", not "timed out". It deliberately does
NOT mint an App token in CI: that would need the deploy identity to read the App private key, a widening
of secret access. The app already performs the mint at startup; its log is the oracle.

PURE: no I/O. The workflow gathers runningState, healthState and a log tail and passes them in.
#>

# Revision states Azure Container Apps uses for a revision that will not come up without a new revision.
# 'Degraded' is deliberately absent: a degraded revision can recover, so it keeps the step waiting.
$script:TerminalRunningStates = @('ActivationFailed', 'Failed')

# Known startup failures, most specific first. Each pattern is matched against the revision's log tail.
$script:KnownCauses = @(
    @{ Pattern = 'Installation token mint failed'
       Cause   = 'github-app-installation'
       Message = 'The GitHub App could not mint an installation token (HTTP 404). SYNC_GITHUB_APP_INSTALLATION_ID is probably the installation of a different App, or the App is not installed on the data repo. Check it matches the ai-triad-taxonomy-sync installation.' }
    @{ Pattern = 'GitHub App credentials are missing or not configured'
       Cause   = 'github-app-credentials'
       Message = 'The server reports missing GitHub App credentials (GITHUB_APP_ID, the private-key secret name, or GITHUB_REPO). Check the SYNC_GITHUB_* repo variables and the Key Vault secret.' }
    @{ Pattern = 'manifest unknown|failed to pull|ImagePullBackOff|unauthorized: authentication required'
       Cause   = 'image-pull'
       Message = 'The revision could not pull its image. Check the package exists and is public at the digest being deployed.' }
)

function Get-RevisionActivationVerdict {
    [CmdletBinding()]
    param(
        [AllowEmptyString()][AllowNull()][string] $RunningState,
        [AllowEmptyString()][AllowNull()][string] $HealthState,
        [AllowEmptyString()][AllowNull()][string] $LogTail,
        [bool] $ProbeHealthy = $false
    )
    $cause = $null
    if (-not [string]::IsNullOrWhiteSpace($LogTail)) {
        foreach ($known in $script:KnownCauses) {
            if ($LogTail -match $known.Pattern) { $cause = $known; break }
        }
    }

    if ($ProbeHealthy) {
        return [pscustomobject]@{ Verdict = 'healthy'; Cause = $null; Message = 'Revision answered the health probe.' }
    }
    if ($RunningState -in $script:TerminalRunningStates) {
        if ($cause) {
            return [pscustomobject]@{ Verdict = 'failed'; Cause = $cause.Cause; Message = $cause.Message }
        }
        return [pscustomobject]@{ Verdict = 'failed'; Cause = 'activation'; Message = "Revision is $RunningState (health: $HealthState) and will not start. See the revision's container log for the cause." }
    }
    # A known fatal cause in the log fails the revision even before Azure flips the state: the token mint
    # 404 repeats on every request and never recovers on its own.
    if ($cause -and $cause.Cause -in @('github-app-installation', 'github-app-credentials')) {
        return [pscustomobject]@{ Verdict = 'failed'; Cause = $cause.Cause; Message = $cause.Message }
    }
    return [pscustomobject]@{ Verdict = 'waiting'; Cause = $null; Message = "Revision is $RunningState (health: $HealthState); still waiting." }
}
