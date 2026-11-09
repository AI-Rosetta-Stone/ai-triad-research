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

LIVE INCIDENT (p/648#377, p/916#11-18): #4679's first real post-merge run showed the ancestor
check's own exit code leaking through to become the WHOLE gate STEP's reported result, so
`deploy-staging`'s `needs: [gate]` SKIPPED every legitimate forward deploy regardless of this
function's verdict. Fixed at the workflow-step layer with a `$global:LASTEXITCODE = 0` reset
(t/4252 pattern) -- see `deploy-staging.yml`'s `compare` step. Separately, the TL (p/916#12/#14)
found the ORIGINAL predicate direction was itself unsound: "built is not an ancestor of current"
also reads true for a DIVERGED build (a branch build off an older base), which would then
PROCEED and deploy a non-main image. The predicate is now the POSITIVE relation -- see
`Get-StagingCurrentDeployComparison.ps1`'s header for the full exit-code table.

Three independent guards, any one sufficient to skip:
  1. the triggering run did not actually push (an A/B/dry-run `workflow_dispatch`);
  2. the built SHA does not descend from staging's CURRENT `DEPLOY_SHA` (downgrade or diverged);
  3. `CurrentDeploySha` can't be confirmed missing from `BuiltSha` -- except that one, S2 (below),
     is a WARN-and-proceed, not a skip, by design (recovery path).

This function is the PURE decision core: it takes already-computed facts and returns a verdict
plus a reason string for the WARN. The impure git/CLI calls (run-name parsing, `git merge-base`,
`git cat-file`, reading staging's current DEPLOY_SHA via `az`) are the caller's job
(`deploy-staging.yml`'s `gate` job, via `Get-StagingCurrentDeployComparison.ps1`).

.PARAMETER Pushed
Whether the triggering Container Image run actually pushed (Get-PushFlagFromRunName.ps1).

.PARAMETER BuiltSha
The commit Container Image actually built (Get-BuiltShaFromRunName.ps1).

.PARAMETER CurrentDeploySha
Staging's current `DEPLOY_SHA` env var, or $null/empty on a first deploy (nothing to compare
against, so the ancestor guard cannot fire).

.PARAMETER CurrentDeployReadFailed
S1 (Lead review, #4679): $true when an active revision EXISTS but its `DEPLOY_SHA` could not be
determined -- the `az containerapp revision show` call itself failed (non-zero exit; a native
command does not throw even under `$ErrorActionPreference = 'Stop'`), or it succeeded but the
env var was missing from the response. Distinct from "no active revision at all" (a true first
deploy, which proceeds normally) -- here SOMETHING is running and we can't prove deploying won't
downgrade it, so this fails closed with a WARN, never silently proceeds.

.PARAMETER CurrentIsAncestorOfBuilt
$true when `git merge-base --is-ancestor $CurrentDeploySha $BuiltSha` exited 0 -- staging's
current deploy IS in the built commit's history, i.e. a genuine forward deploy. $false when it
exited 1 -- NOT an ancestor, which covers both a downgrade (built is older) and a diverged build
(different branch); both must block, and the predicate doesn't need to tell them apart. $null
when there's nothing to compare (no current deploy at all, or one of the two commits couldn't be
resolved -- see BuiltMissing/CurrentMissing below, which take precedence).

.PARAMETER BuiltMissing
TL correction (p/916#17): $true when `git cat-file -e "$BuiltSha^{commit}"` failed -- the built
commit doesn't even resolve in this checkout. Proceeding would deploy an image this checkout
can't verify is a real commit, so this always BLOCKS, regardless of CurrentIsAncestorOfBuilt.

.PARAMETER CurrentMissing
S2 (Lead review #4679, scoped by TL p/916#17): $true when `BuiltSha` was confirmed resolvable
but `CurrentDeploySha` was not (merge-base itself returned neither 0 nor 1 -- typically 128 --
with `BuiltMissing` false). This is the legitimate recovery case: staging is on an off-main or
force-pushed SHA that this checkout's history doesn't contain. Proceeds, but WARNs, since the
forward-deploy guard genuinely could not verify this one.
#>
function Get-StagingDeployGateVerdict {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [bool] $Pushed,
        [string] $BuiltSha,
        [string] $CurrentDeploySha,
        [bool] $CurrentDeployReadFailed = $false,
        [Nullable[bool]] $CurrentIsAncestorOfBuilt = $null,
        [bool] $BuiltMissing = $false,
        [bool] $CurrentMissing = $false
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

    if ($BuiltMissing) {
        return [PSCustomObject]@{
            Proceed = $false
            Warn    = $true
            Reason  = "built SHA $BuiltSha does not resolve in this checkout -- refusing to " +
                      "deploy an image this checkout cannot even verify is a real commit."
        }
    }

    if (-not $CurrentDeploySha) {
        return [PSCustomObject]@{
            Proceed = $true
            Warn    = $false
            Reason  = "no active revision found -- first deploy, nothing to compare against."
        }
    }

    if ($CurrentMissing) {
        return [PSCustomObject]@{
            Proceed = $true
            Warn    = $true
            Reason  = "proceeding, but staging's current DEPLOY_SHA ($CurrentDeploySha) was not " +
                      "found in this checkout's history (built SHA $BuiltSha is resolvable, but " +
                      "the merge-base call could not place current) -- likely an off-main or " +
                      "force-pushed staging deploy; a main build can always recover it."
        }
    }

    if ($CurrentIsAncestorOfBuilt -eq $true) {
        return [PSCustomObject]@{
            Proceed = $true
            Warn    = $false
            Reason  = "staging's current DEPLOY_SHA is an ancestor of the built SHA -- forward deploy confirmed."
        }
    }

    return [PSCustomObject]@{
        Proceed = $false
        Warn    = $true
        Reason  = "built SHA $BuiltSha does not descend from staging's current DEPLOY_SHA " +
                  "$CurrentDeploySha (downgrade or diverged build) -- refusing."
    }
}

# Dot-sourced only (same pattern as Get-ReminderLivenessVerdict.ps1) -- the caller (deploy-
# staging.yml's gate job) supplies the already-computed facts and handles GITHUB_OUTPUT / WARN
# itself, since a skip here is a legitimate, expected outcome, never a thrown error.
