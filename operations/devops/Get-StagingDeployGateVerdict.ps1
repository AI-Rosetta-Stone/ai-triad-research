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
$true when `git merge-base --is-ancestor $BuiltSha $CurrentDeploySha` succeeded (the built
commit is already in staging's history, i.e. not newer) -- the caller computes this because it
requires a git checkout; $null when there was no current deploy to compare against.
#>
function Get-StagingDeployGateVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [bool] $Pushed,
        [string] $BuiltSha,
        [string] $CurrentDeploySha,
        [Nullable[bool]] $BuiltShaIsAncestorOfCurrent
    )

    if (-not $Pushed) {
        return [PSCustomObject]@{
            Proceed = $false
            Reason  = "the triggering Container Image run did not push (push=false -- an A/B " +
                      "or dry-run dispatch, t/4840); staging must not deploy an image nothing tagged."
        }
    }

    if ($CurrentDeploySha -and $BuiltSha -and $BuiltSha -eq $CurrentDeploySha) {
        return [PSCustomObject]@{
            Proceed = $false
            Reason  = "built SHA $BuiltSha already matches staging's current DEPLOY_SHA -- nothing to redeploy."
        }
    }

    if ($BuiltShaIsAncestorOfCurrent -eq $true) {
        return [PSCustomObject]@{
            Proceed = $false
            Reason  = "built SHA $BuiltSha is an ANCESTOR of staging's current DEPLOY_SHA " +
                      "$CurrentDeploySha -- deploying it would be a downgrade."
        }
    }

    return [PSCustomObject]@{
        Proceed = $true
        Reason  = "pushed, and not an ancestor of (or equal to) the current deploy -- proceeding."
    }
}

# Dot-sourced only (same pattern as Get-ReminderLivenessVerdict.ps1) -- the caller (deploy-
# staging.yml's gate job) supplies the already-computed facts and handles GITHUB_OUTPUT / WARN
# itself, since a skip here is a legitimate, expected outcome, never a thrown error.
