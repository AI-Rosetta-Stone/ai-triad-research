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

# githubAppAuth.ts logs `Installation token mint failed` with the HTTP status for ANY non-OK mint (SO C1 on
# #3217). Only 404 (wrong installation) and 401 (bad App credentials) never recover on their own, so only those
# are fatal on sight. 403/429/5xx are rate limits or GitHub outages: they keep the step waiting, and the last one
# seen is reported if the step times out (SO C2).
$script:MintFailedPattern = '(?m)^.*Installation token mint failed.*$'
$script:MintFatal = @{
    404 = @{ Cause   = 'github-app-installation'
             Message = 'The GitHub App could not mint an installation token (HTTP 404). SYNC_GITHUB_APP_INSTALLATION_ID is probably the installation of a different App, or the App is not installed on the data repo. Check it matches the ai-triad-taxonomy-sync installation.' }
    401 = @{ Cause   = 'github-app-credentials'
             Message = 'The GitHub App could not mint an installation token (HTTP 401). The App ID or private key is wrong. Check GITHUB_APP_ID and the Key Vault private-key secret.' }
}

# Transient GitHub refusals: never fatal, but named on timeout (SO C2). Most specific first.
$script:RefusalPatterns = @(
    @{ Pattern = 'github-api circuit open'; Label = 'GitHub API circuit open (repeated refusals during data load)' }
    @{ Pattern = 'GitHub API non-ok response'; Label = 'GitHub API non-ok response during data load' }
)

# Other known startup failures, matched against the revision's log tail.
$script:KnownCauses = @(
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
    $cause   = $null
    $refusal = $null
    if (-not [string]::IsNullOrWhiteSpace($LogTail)) {
        # Token mint: fatal only on 404/401 (SO C1). Any other status is a transient refusal.
        foreach ($line in [regex]::Matches($LogTail, $script:MintFailedPattern)) {
            $statusMatch = [regex]::Match($line.Value, '"status"\s*:\s*(\d{3})')
            $status = if ($statusMatch.Success) { [int]$statusMatch.Groups[1].Value } else { $null }
            if ($null -ne $status -and $script:MintFatal.ContainsKey($status)) {
                $cause = $script:MintFatal[$status]; break
            }
            $refusal = if ($null -ne $status) { "GitHub App token mint refused (HTTP $status)" } else { 'GitHub App token mint refused (status not logged)' }
        }
        if (-not $cause) {
            foreach ($known in $script:KnownCauses) {
                if ($LogTail -match $known.Pattern) { $cause = $known; break }
            }
        }
        if (-not $refusal) {
            foreach ($r in $script:RefusalPatterns) {
                if ($LogTail -match $r.Pattern) { $refusal = $r.Label; break }
            }
        }
    }

    if ($ProbeHealthy) {
        return [pscustomobject]@{ Verdict = 'healthy'; Cause = $null; Message = 'Revision answered the health probe.'; LastRefusal = $refusal }
    }
    if ($RunningState -in $script:TerminalRunningStates) {
        if ($cause) {
            return [pscustomobject]@{ Verdict = 'failed'; Cause = $cause.Cause; Message = $cause.Message; LastRefusal = $refusal }
        }
        return [pscustomobject]@{ Verdict = 'failed'; Cause = 'activation'; Message = "Revision is $RunningState (health: $HealthState) and will not start. See the revision's container log for the cause."; LastRefusal = $refusal }
    }
    # A known fatal cause in the log fails the revision even before Azure flips the state: a 404/401 mint
    # repeats on every request and never recovers on its own.
    if ($cause -and $cause.Cause -in @('github-app-installation', 'github-app-credentials')) {
        return [pscustomobject]@{ Verdict = 'failed'; Cause = $cause.Cause; Message = $cause.Message; LastRefusal = $refusal }
    }
    return [pscustomobject]@{ Verdict = 'waiting'; Cause = $null; Message = "Revision is $RunningState (health: $HealthState); still waiting."; LastRefusal = $refusal }
}
