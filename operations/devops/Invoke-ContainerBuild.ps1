# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Validated dispatch of the Container Image build workflow (t/2487).
.DESCRIPTION
    Guards against two known dispatch failure modes before triggering container.yml:
      1. Short or malformed SHA — resolves via GH API; fails fast if unresolvable.
      2. CI not green — polls the full ci.yml run for the resolved SHA to a terminal
         'success' conclusion. Any non-success conclusion fails immediately.

    The in-workflow ci-gate in container.yml remains as defense-in-depth. This script
    is the operator-facing layer — errors surface before consuming workflow minutes.

    Three-arm proof (t/2487):
      Arm 1 (bad SHA)  : pass garbage string → fails at step 1
      Arm 2 (no CI run): pass a known SHA with no ci.yml run → fails at step 2
      Arm 3 (clean)    : pass main HEAD with green CI → dispatches, returns run URL
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

# ── Step 2: Wait for full ci.yml run to succeed ────────────────────────────────
Write-Host "Checking ci.yml run for $Sha..."
$runId = gh api "repos/$Repo/actions/workflows/ci.yml/runs?head_sha=$Sha&per_page=1" `
    --jq '.workflow_runs[0].id // empty' 2>$null

if (-not $runId) {
    Fail -Goal     'Dispatch container build' `
         -Problem  "No ci.yml run found for commit $Sha." `
         -Location 'Invoke-ContainerBuild.ps1 step 2 (CI run lookup)' `
         -NextSteps @(
             "Push the commit to origin/main to trigger CI",
             "Wait for CI to complete, then retry"
         )
}

$deadline   = (Get-Date).AddMinutes($WaitTimeoutMinutes)
$conclusion = ''
$status     = ''
do {
    $run        = gh api "repos/$Repo/actions/runs/$runId" --jq '{status: .status, conclusion: .conclusion}' | ConvertFrom-Json
    $status     = $run.status
    $conclusion = if ($run.conclusion) { $run.conclusion } else { '' }

    if ($status -eq 'completed') { break }

    Write-Host "  ci.yml run ${runId}: $status — waiting..."
    Start-Sleep -Seconds 30
} while ((Get-Date) -lt $deadline)

if ($status -ne 'completed') {
    Fail -Goal     'Dispatch container build' `
         -Problem  "ci.yml run $runId did not complete within $WaitTimeoutMinutes min (status: $status)." `
         -Location 'Invoke-ContainerBuild.ps1 step 2 (poll timeout)' `
         -NextSteps @(
             "Wait for CI to finish, then retry",
             "Watch the run: gh run watch $runId --exit-status"
         )
}

if ($conclusion -ne 'success') {
    Fail -Goal     'Dispatch container build' `
         -Problem  "ci.yml run $runId concluded '$conclusion' — full CI must be green before building." `
         -Location 'Invoke-ContainerBuild.ps1 step 2 (CI not green)' `
         -NextSteps @(
             "Fix failing CI jobs, push a fix commit, and retry with the new SHA",
             "Inspect failures: gh run view $runId --log-failed"
         )
}

Write-Host "  ci.yml run ${runId}: success — green."

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
