# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
Decides whether Auto-Deploy to Staging should proceed, given the triggering Container Image
run's push flag and an ancestor comparison against staging's current deploy (t/4932).

.DESCRIPTION
2026-11-06 staging incident (TL p/331#2658/#2659): `deploy-staging.yml` gated only on
`workflow_run.conclusion == 'success'`. Docker's t/4840 A/B ran 10 `push=false` dispatches of
SHAs older than staging's `a8be306`; each one triggered a deploy of an EXISTING OLDER image.
A separate smoke regression (#4646) happened to block every one -- without it, staging would
have been downgraded.

Two independent guards, either one sufficient to skip:
  1. the triggering run did not actually push (an A/B/dry-run `workflow_dispatch`);
  2. the built SHA is an ancestor of (or equal to) staging's CURRENT `DEPLOY_SHA` -- a rebuild
     of something already superseded, which would be a downgrade or a no-op redeploy.

This function is the PURE decision core: it takes already-computed facts (the push flag, and
whether `git merge-base --is-ancestor` already said yes) and returns a verdict plus a reason
string for the WARN. The impure git/CLI calls (run-name parsing, `git merge-base`, reading
staging's current DEPLOY_SHA via `az`) are the caller's job (deploy-staging.yml's gate job).

.PARAMETER Pushed
Whether the triggering Container Image run actually pushed (Get-PushFlagFromRunName.ps1).

.PARAMETER BuiltSha
The commit Container Image actually built (Get-BuiltShaFromRunName.ps1).

.PARAMETER CurrentDeploySha
Staging's current `DEPLOY_SHA` env var, or $null/empty on a first deploy (nothing to compare
against, so the ancestor guard cannot fire).

.PARAMETER BuiltShaIsAncestorOfCurrent
$true when `git merge-base --is-ancestor $BuiltSha $CurrentDeploySha` exited 0 (the built commit
is already in staging's history, i.e. not newer), $false when it exited 1 (genuinely not an
ancestor) -- the caller computes this because it requires a git checkout; $null when there was
no current deploy to compare against (a true first deploy, nothing to check).

.PARAMETER CurrentDeployReadFailed
S1 (Lead review, #4679): $true when an active revision EXISTS but its `DEPLOY_SHA` could not be
determined -- the `az containerapp revision show` call itself failed (non-zero exit; a native
command does not throw even under `$ErrorActionPreference = 'Stop'`), or it succeeded but the
env var was missing from the response. Distinct from "no active revision at all" (a true first
deploy, which proceeds normally) -- here SOMETHING is running and we can't prove deploying won't
downgrade it, so this fails closed with a WARN, never silently proceeds.

.PARAMETER AncestorCheckUnknownCommit
S2 (Lead review, #4679): $true when `git merge-base --is-ancestor` exited 128 (or any code other
than 0/1) rather than a clean 0/1 -- `CurrentDeploySha` isn't in this checkout's history at all
(for example, a branch build whose base diverged). Proceeding is still correct (an unreachable
commit can't be proven to be an ancestor), but it must WARN, not pass silently, since the
ancestor guard genuinely could not run.
#>
function Get-StagingDeployGateVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [bool] $Pushed,
        [string] $BuiltSha,
        [string] $CurrentDeploySha,
        [Nullable[bool]] $BuiltShaIsAncestorOfCurrent,
        [bool] $CurrentDeployReadFailed = $false,
        [bool] $AncestorCheckUnknownCommit = $false
    )

    if (-not $Pushed) {
        return [PSCustomObject]@{
            Proceed = $false
            Warn    = $true
            Reason  = "the triggering Container Image run did not push (push=false -- an A/B " +
                      "or dry-run dispatch, t/4840); staging must not deploy an image nothing tagged."
        }
    }

    if ($CurrentDeployReadFailed) {
        return [PSCustomObject]@{
            Proceed = $false
            Warn    = $true
            Reason  = "an active revision exists but its DEPLOY_SHA could not be read (az call " +
                      "failed, or the env var was missing) -- failing closed rather than risk a " +
                      "silent downgrade. This is NOT a true-first-deploy case."
        }
    }

    if ($CurrentDeploySha -and $BuiltSha -and $BuiltSha -eq $CurrentDeploySha) {
        return [PSCustomObject]@{
            Proceed = $false
            Warn    = $true
            Reason  = "built SHA $BuiltSha already matches staging's current DEPLOY_SHA -- nothing to redeploy."
        }
    }

    if ($BuiltShaIsAncestorOfCurrent -eq $true) {
        return [PSCustomObject]@{
            Proceed = $false
            Warn    = $true
            Reason  = "built SHA $BuiltSha is an ANCESTOR of staging's current DEPLOY_SHA " +
                      "$CurrentDeploySha -- deploying it would be a downgrade."
        }
    }

    if ($AncestorCheckUnknownCommit) {
        return [PSCustomObject]@{
            Proceed = $true
            Warn    = $true
            Reason  = "proceeding, but staging's current DEPLOY_SHA ($CurrentDeploySha) was not " +
                      "found in this checkout's history (git merge-base exited 128, not 0/1) -- " +
                      "the non-downgrade guard could not verify this deploy; visibility gap, not a block."
        }
    }

    return [PSCustomObject]@{
        Proceed = $true
        Warn    = $false
        Reason  = "pushed, and not an ancestor of (or equal to) the current deploy -- proceeding."
    }
}

# Dot-sourced only (same pattern as Get-ReminderLivenessVerdict.ps1) -- the caller (deploy-
# staging.yml's gate job) supplies the already-computed facts and handles GITHUB_OUTPUT / WARN
# itself, since a skip here is a legitimate, expected outcome, never a thrown error.
