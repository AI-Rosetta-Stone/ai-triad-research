# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Validated dispatch of the Container Image build workflow (t/2487).
.DESCRIPTION
    Guards against two known dispatch failure modes before triggering container.yml:
      1. Short or malformed SHA — resolves via GH API; fails fast if unresolvable.
      2. CI not green — polls the `ci-gate` check-run for the resolved SHA to a terminal
         'success' conclusion (t/4796: the single required status context, not the raw
         ci.yml workflow-run conclusion — an advisory job elsewhere on that run can time
         out or fail and flip the overall run red while ci-gate itself stays green).

    The in-workflow ci-gate in container.yml remains as defense-in-depth. This script
    is the operator-facing layer — errors surface before consuming workflow minutes.

    Three-arm proof (t/2487, re-verified t/4796):
      Arm 1 (bad SHA)  : pass garbage string → fails at step 1
      Arm 2 (no CI run): pass a known SHA with no ci-gate check-run → fails at step 2
      Arm 3 (clean)    : pass main HEAD with green ci-gate → dispatches, returns run URL
.PARAMETER Sha
    Commit SHA to build. 7-40 lowercase hex chars; shorter SHAs are resolved to 40-char
    via the GitHub API.
.PARAMETER Push
    Push the built image to GHCR. Default: $true. Pass -Push:$false for a smoke-only build.
.PARAMETER Repo
    GitHub repository slug. Default: AI-Rosetta-Stone/ai-triad-research.
.PARAMETER WaitTimeoutMinutes
    Max minutes to wait for a still-running ci.yml run to reach a terminal state.
    Default: 20. If the run is already terminal, this parameter has no effect.
#>

#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Sha,

    [switch]$Push = $true,

    [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',

    [int]$WaitTimeoutMinutes = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail {
    param(
        [string]$Goal,
        [string]$Problem,
        [string]$Location,
        [string[]]$NextSteps
    )
    $lines = @(
        "Goal    : $Goal"
        "Problem : $Problem"
        "Location: $Location"
        "Next    : $($NextSteps -join ' | ')"
    )
    throw ($lines -join "`n")
}

# ── Step 1: Validate and resolve SHA ──────────────────────────────────────────
if ($Sha -notmatch '^[0-9a-f]{7,40}$') {
    Fail -Goal     'Dispatch container build' `
         -Problem  "SHA '$Sha' is not 7-40 lowercase hex characters." `
         -Location 'Invoke-ContainerBuild.ps1 step 1 (format check)' `
         -NextSteps @(
             "Run: git rev-parse HEAD   to get the current 40-char SHA",
             "Run: git log --oneline -1  for a short SHA git will accept"
         )
}

if ($Sha.Length -lt 40) {
    Write-Host "Resolving short SHA $Sha via API..."
    $resolved = gh api "repos/$Repo/commits/$Sha" --jq '.sha' 2>$null
    if ($LASTEXITCODE -ne 0 -or $resolved -notmatch '^[0-9a-f]{40}$') {
        Fail -Goal     'Dispatch container build' `
             -Problem  "Cannot resolve '$Sha' to a commit in $Repo." `
             -Location 'Invoke-ContainerBuild.ps1 step 1 (GH API resolve)' `
             -NextSteps @(
                 "Verify the commit exists on origin/main: git fetch origin && git log origin/main --oneline | head -5",
                 "Check authentication: gh auth status"
             )
    }
    Write-Host "  Resolved: $Sha → $resolved"
    $Sha = $resolved
}

# ── Step 2: Wait for the ci-gate check-run to succeed ──────────────────────────
# t/4796: gate on the `ci-gate` check-run specifically, not the raw ci.yml workflow-run
# conclusion. ci-gate IS the single required status context (t/1962) branch protection
# actually enforces; other jobs on the same run (e.g. complexity-tickets, advisory,
# continue-on-error) can time out or fail and flip the overall run conclusion to
# 'cancelled'/'failure' while ci-gate itself is green — which used to fail this script
# closed on a condition that doesn't actually block merges (t/4796 evidence: run
# 41622024606 on commit 483f0340, ci-gate=success, overall run=cancelled).
Write-Host "Checking ci-gate check-run for $Sha..."

$deadline   = (Get-Date).AddMinutes($WaitTimeoutMinutes)
$conclusion = ''
$status     = ''
do {
    $checkRuns = gh api "repos/$Repo/commits/$Sha/check-runs" --jq '[.check_runs[] | select(.name == "ci-gate")]' | ConvertFrom-Json
    $gate      = $checkRuns | Sort-Object -Property started_at -Descending | Select-Object -First 1

    if (-not $gate) {
        Write-Host "  no ci-gate check-run yet for $Sha — waiting..."
        Start-Sleep -Seconds 30
        continue
    }

    $status     = $gate.status
    $conclusion = if ($gate.conclusion) { $gate.conclusion } else { '' }

    if ($status -eq 'completed') { break }

    Write-Host "  ci-gate: $status — waiting..."
    Start-Sleep -Seconds 30
} while ((Get-Date) -lt $deadline)

if ($status -ne 'completed') {
    Fail -Goal     'Dispatch container build' `
         -Problem  "ci-gate for $Sha did not complete within $WaitTimeoutMinutes min (status: $status)." `
         -Location 'Invoke-ContainerBuild.ps1 step 2 (poll timeout)' `
         -NextSteps @(
             "Wait for CI to finish, then retry",
             "Check runs for the commit: gh api repos/$Repo/commits/$Sha/check-runs --jq '.check_runs[] | {name, status, conclusion}'"
         )
}

if ($conclusion -ne 'success') {
    Fail -Goal     'Dispatch container build' `
         -Problem  "ci-gate for $Sha concluded '$conclusion' — the required gate must be green before building." `
         -Location 'Invoke-ContainerBuild.ps1 step 2 (CI not green)' `
         -NextSteps @(
             "Fix failing CI jobs, push a fix commit, and retry with the new SHA",
             "Inspect the ci-gate run: gh api repos/$Repo/commits/$Sha/check-runs --jq '.check_runs[] | select(.name == `"ci-gate`")'"
         )
}

Write-Host "  ci-gate for ${Sha}: success — green."

# ── Step 3: Dispatch ───────────────────────────────────────────────────────────
$pushVal = if ($Push) { 'true' } else { 'false' }
Write-Host "Dispatching container.yml for $Sha (push=$pushVal)..."
gh workflow run container.yml --repo $Repo --ref main -f sha=$Sha -f push=$pushVal
if ($LASTEXITCODE -ne 0) {
    Fail -Goal     'Dispatch container build' `
         -Problem  "gh workflow run container.yml exited $LASTEXITCODE." `
         -Location 'Invoke-ContainerBuild.ps1 step 3 (dispatch)' `
         -NextSteps @(
             "Check authentication: gh auth status",
             "Verify workflow_dispatch permission on $Repo"
         )
}

Start-Sleep -Seconds 5
$latest = gh api "repos/$Repo/actions/workflows/container.yml/runs?per_page=1" `
    --jq '.workflow_runs[0] | "Run \(.id): \(.html_url)"' 2>$null
Write-Host "Dispatched. $latest"
