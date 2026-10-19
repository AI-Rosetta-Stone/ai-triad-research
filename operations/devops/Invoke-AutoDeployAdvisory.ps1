<#
.SYNOPSIS
t/4285 advisory-mode continuous-deploy check. Reads live state, calls the pure
Get-AutoDeployAdvisoryVerdict predicate, and posts a verdict — it never deploys, builds an
image, or writes any persistent state. The "last auto-deploy" rate-cap clock is simulated by
reading this workflow's own run history (its own run name carries the verdict), so even that
is read-only.

.PARAMETER Repo
owner/repo, e.g. AI-Rosetta-Stone/ai-triad-research.

.PARAMETER HeadSha
The commit SHA this run is evaluating (the push that triggered ci.yml).

.PARAMETER ProdHealthUrl
Prod's /health endpoint. Its buildSha is the authoritative "last deployed" SHA (TL condition 2
— not the known-good tag, which can drift, t/4273).

.PARAMETER HoldActive
Read by the caller from the repo variable (e.g. vars.AUTO_DEPLOY_HOLD) and passed in as a bool,
so this script never reaches into GitHub config itself (keeps it testable without gh auth).

.PARAMETER MinIntervalMinutes
The rate-cap floor (TL condition 5). Default 120 (2h), per the design doc.

.OUTPUTS
Writes the verdict as JSON to stdout, and (when $GITHUB_OUTPUT is set) as step outputs
`verdict`, `skip_reason`, `detail`, `head_sha`. Never exits non-zero on a Skip verdict — a
skip is a normal advisory outcome, not a failure.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$ProdHealthUrl,
    [Parameter(Mandatory)][bool]$HoldActive,
    [int]$MinIntervalMinutes = 120,
    [string]$ThisWorkflowFile = 'auto-deploy-advisory.yml'
)

. "$PSScriptRoot/Get-AutoDeployAdvisoryVerdict.ps1"

$ErrorActionPreference = 'Stop'

# ── 1. Last deployed SHA, from prod's own /health (TL condition 2) ──
try {
    $health = Invoke-RestMethod -Uri $ProdHealthUrl -TimeoutSec 15
    $lastDeployedSha = $health.buildSha
    if ([string]::IsNullOrWhiteSpace($lastDeployedSha)) {
        throw "prod /health returned no buildSha"
    }
} catch {
    Write-Error "Cannot read prod's last-deployed SHA from $ProdHealthUrl — treating as UNREADABLE, not as a deploy signal. $_"
    throw
}

# ── 2. Required-context results, from the combined commit status (TL condition 1) ──
$requiredContextsPath = Join-Path $PSScriptRoot '../../.github/ci/required-contexts.json'
$requiredContextsConfig = Get-Content $requiredContextsPath -Raw | ConvertFrom-Json
$wantedContexts = @($requiredContextsConfig.required_contexts | ForEach-Object { $_.context })

$statusJson = gh api "repos/$Repo/commits/$HeadSha/status" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "gh api commits/.../status failed for $HeadSha`: $statusJson"
    throw "Cannot read commit status — treating as UNREADABLE"
}
$status = $statusJson | ConvertFrom-Json
$liveByContext = @{}
foreach ($s in @($status.statuses)) { $liveByContext[$s.context] = $s.state }

$requiredContextResults = @()
foreach ($ctx in $wantedContexts) {
    $state = if ($liveByContext.ContainsKey($ctx)) { $liveByContext[$ctx] } else { 'missing' }
    $requiredContextResults += [PSCustomObject]@{ Context = $ctx; Conclusion = $state }
}

# ── 3. Changed paths since the last deployed SHA (TL condition 3 feeds off this) ──
$changedPaths = @(git diff --name-only "$lastDeployedSha..$HeadSha" 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Error "git diff failed between $lastDeployedSha and $HeadSha — treating as UNREADABLE (never silently 'no infra change')"
    throw
}

# ── 4. Infra paths, from tier-paths.json — the tier check's own source (TL condition 3) ──
$tierPathsPath = Join-Path $PSScriptRoot '../../.github/ci/tier-paths.json'
$tierPaths = Get-Content $tierPathsPath -Raw | ConvertFrom-Json
$infraPaths = @($tierPaths.r1Paths) + @($tierPaths.r1Globs)

# ── 5. Simulated rate-cap clock: the most recent WouldDeploy verdict this workflow itself posted ──
# Read-only — no state is written. The run name carries the verdict (see the workflow YAML),
# e.g. "auto-deploy-advisory: would-deploy abc1234" vs "auto-deploy-advisory: skip (hold) abc1234".
$lastAutoDeployAt = $null
try {
    $pastRunsJson = gh api "repos/$Repo/actions/workflows/$ThisWorkflowFile/runs?per_page=50&status=completed" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pastRuns = ($pastRunsJson | ConvertFrom-Json).workflow_runs
        $wouldDeployRun = @($pastRuns | Where-Object { $_.display_title -like 'would-deploy*' } | Sort-Object created_at -Descending | Select-Object -First 1)
        if (@($wouldDeployRun).Count -gt 0) {
            $lastAutoDeployAt = [datetime]$wouldDeployRun[0].created_at
        }
    }
} catch {
    Write-Warning "Could not read this workflow's own run history for the rate-cap clock — proceeding with no prior auto-deploy known (fails open toward WouldDeploy, same as a cold start). $_"
}

# ── Evaluate ──
$verdict = Get-AutoDeployAdvisoryVerdict `
    -HeadSha $HeadSha `
    -LastDeployedSha $lastDeployedSha `
    -RequiredContextResults $requiredContextResults `
    -HoldActive $HoldActive `
    -ChangedPaths $changedPaths `
    -InfraPaths $infraPaths `
    -LastAutoDeployAt $lastAutoDeployAt `
    -MinIntervalMinutes $MinIntervalMinutes `
    -Now (Get-Date).ToUniversalTime()

$verdict | ConvertTo-Json -Depth 5

if ($env:GITHUB_OUTPUT) {
    "verdict=$($verdict.Verdict)" | Out-File -Append -FilePath $env:GITHUB_OUTPUT
    "skip_reason=$($verdict.SkipReason)" | Out-File -Append -FilePath $env:GITHUB_OUTPUT
    "detail=$($verdict.Detail)" | Out-File -Append -FilePath $env:GITHUB_OUTPUT
    "head_sha=$($verdict.HeadSha)" | Out-File -Append -FilePath $env:GITHUB_OUTPUT
}

if ($env:GITHUB_STEP_SUMMARY) {
    $label = if ($verdict.Verdict -eq 'WouldDeploy') { 'Would deploy' } else { "Skip ($($verdict.SkipReason))" }
    "## t/4285 auto-deploy advisory`n`n- **Verdict:** $label`n- **HEAD:** ``$($verdict.HeadSha)```n- **Last deployed:** ``$($verdict.LastDeployedSha)```n- **Detail:** $($verdict.Detail)" | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY
}
