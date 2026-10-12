# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-GitHubHealth {
    <#
    .SYNOPSIS
        Tests health of GitHub services used by the AI Triad project.
    .DESCRIPTION
        Checks GitHub platform status, repo accessibility, Actions workflow
        status, and API rate limits. Uses GITHUB_TOKEN env var for authenticated
        checks (higher rate limits, workflow status) when available.
    .PARAMETER Repo
        GitHub repo in owner/name format. Default: AI-Rosetta-Stone/ai-triad-research.
    .PARAMETER TimeoutSec
        HTTP request timeout in seconds. Default: 10.
    .PARAMETER Branch
        Branch to scope the workflow-runs status check to. Default: main (the
        deployed line) — so a red PR/branch run does not false-FAIL the CI-health
        category in a prod smoke (t/1975).
    .PARAMETER DeployedSha
        When provided, the ci.yml check queries by exact commit SHA instead of
        branch=main. Fail-closed: zero completed runs for the SHA → check fails
        (never silently passes or falls back to branch). Fixes the gh-run-rerun
        created_at displacement false-negative (t/2639).
    .EXAMPLE
        Test-GitHubHealth
    .EXAMPLE
        Test-GitHubHealth -Repo 'AI-Rosetta-Stone/ai-triad-research'
    .LINK
        Show-AITriadHelp
    .LINK
        Get-GitHubWorkflowRun
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 10,

        [Parameter()]
        [string]$Branch = 'main',

        [Parameter()]
        [string]$DeployedSha = ''
    )

    Set-StrictMode -Version Latest

    $Checks = [System.Collections.Generic.List[PSObject]]::new()
    $Headers = @{ 'Accept' = 'application/json'; 'User-Agent' = 'AITriad-HealthCheck/1.0' }
    $Token = $env:GITHUB_TOKEN
    if ($Token) { $Headers['Authorization'] = "Bearer $Token" }

    # ── GitHub Status API ────────────────────────────────────────────────
    try {
        $Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $StatusResp = Invoke-RestMethod -Uri 'https://www.githubstatus.com/api/v2/status.json' `
            -Headers @{ 'Accept' = 'application/json' } -TimeoutSec $TimeoutSec -ErrorAction Stop
        $Sw.Stop()

        $Indicator = $StatusResp.status.indicator
        $Description = $StatusResp.status.description

        $Checks.Add([PSCustomObject]@{
            Check      = 'GitHub Platform Status'
            Pass       = $Indicator -eq 'none'
            ResponseMs = $Sw.ElapsedMilliseconds
            Detail     = "$Indicator — $Description"
        })
    }
    catch {
        $Checks.Add([PSCustomObject]@{
            Check      = 'GitHub Platform Status'
            Pass       = $false
            ResponseMs = 0
            Detail     = $_.Exception.Message
        })
    }

    # ── Repository Accessibility ─────────────────────────────────────────
    try {
        $Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $RepoResp = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" `
            -Headers $Headers -TimeoutSec $TimeoutSec -ErrorAction Stop
        $Sw.Stop()

        $Checks.Add([PSCustomObject]@{
            Check      = 'Repository Accessible'
            Pass       = $true
            ResponseMs = $Sw.ElapsedMilliseconds
            Detail     = "visibility=$($RepoResp.visibility) | default_branch=$($RepoResp.default_branch)"
        })
    }
    catch {
        $Checks.Add([PSCustomObject]@{
            Check      = 'Repository Accessible'
            Pass       = $false
            ResponseMs = 0
            Detail     = $_.Exception.Message
        })
    }

    # ── API Rate Limits ──────────────────────────────────────────────────
    try {
        $RateResp = Invoke-RestMethod -Uri 'https://api.github.com/rate_limit' `
            -Headers $Headers -TimeoutSec $TimeoutSec -ErrorAction Stop

        $Core = $RateResp.resources.core
        $Remaining = $Core.remaining
        $Limit = $Core.limit
        $ResetEpoch = $Core.reset
        $ResetTime = ([DateTimeOffset]::FromUnixTimeSeconds($ResetEpoch)).LocalDateTime.ToString('HH:mm:ss')
        $Pct = if ($Limit -gt 0) { [math]::Round(($Remaining / $Limit) * 100, 0) } else { 0 }

        $Checks.Add([PSCustomObject]@{
            Check      = 'API Rate Limit'
            Pass       = $Remaining -gt 10
            ResponseMs = 0
            Detail     = "$Remaining/$Limit remaining ($Pct%) | resets $ResetTime | auth=$(if ($Token) {'token'} else {'anonymous'})"
        })
    }
    catch {
        $Checks.Add([PSCustomObject]@{
            Check      = 'API Rate Limit'
            Pass       = $false
            ResponseMs = 0
            Detail     = $_.Exception.Message
        })
    }

    # ── Latest Workflow Runs ─────────────────────────────────────────────
    # deploy-azure.yml excluded: checking the last deploy creates a circular
    # dependency — a failed deploy blocks all future deploys from passing the
    # pre-traffic smoke gate (t/2425).
    $KeyWorkflows = @('ci.yml', 'health-monitor.yml')

    # t/1975 — scope the workflow-runs query to the deployed line (default: main)
    # so a red PR/branch run doesn't false-FAIL the CI-health category in a prod
    # smoke. GitHub filters by head_branch via the `branch` param; escape guards
    # branch names containing '/'.
    # t/2639 — when DeployedSha is provided, ci.yml uses head_sha= instead of
    # branch= so a gh-run-rerun (which preserves original created_at) is not
    # displaced by a newer branch run. Fail-closed: zero runs for the SHA → FAIL.
    $BranchQ = [uri]::EscapeDataString($Branch)
    foreach ($Wf in $KeyWorkflows) {
        $UseSha = $DeployedSha -and $Wf -eq 'ci.yml'
        $CheckLabel = if ($UseSha) { "Workflow: $Wf @$DeployedSha" } else { "Workflow: $Wf @$Branch" }
        $RunsUri = if ($UseSha) {
            "https://api.github.com/repos/$Repo/actions/workflows/$Wf/runs?head_sha=$DeployedSha&status=completed&per_page=1"
        } else {
            "https://api.github.com/repos/$Repo/actions/workflows/$Wf/runs?per_page=1&status=completed&branch=$BranchQ"
        }
        try {
            $RunsResp = Invoke-RestMethod -Uri $RunsUri `
                -Headers $Headers -TimeoutSec $TimeoutSec -ErrorAction Stop

            if ($RunsResp.total_count -gt 0) {
                $Run = $RunsResp.workflow_runs[0]
                $Conclusion = $Run.conclusion
                $RunDate = ([datetime]$Run.updated_at).ToString('yyyy-MM-dd HH:mm')
                if ($UseSha) {
                    Write-Verbose "Checking CI for sha=$DeployedSha, run #$($Run.run_number)"
                }

                $Checks.Add([PSCustomObject]@{
                    Check      = $CheckLabel
                    Pass       = $Conclusion -eq 'success'
                    ResponseMs = 0
                    Detail     = "conclusion=$Conclusion | $RunDate | #$($Run.run_number)"
                })
            }
            elseif ($UseSha) {
                # Fail-closed: a SHA with no completed runs must not silently pass
                Write-Verbose "sha=$DeployedSha — no CI run found → failing closed"
                $Checks.Add([PSCustomObject]@{
                    Check      = $CheckLabel
                    Pass       = $false
                    ResponseMs = 0
                    Detail     = "sha=$DeployedSha — no CI run found → failing closed"
                })
            }
            else {
                $Checks.Add([PSCustomObject]@{
                    Check      = $CheckLabel
                    Pass       = $true
                    ResponseMs = 0
                    Detail     = 'No completed runs found'
                })
            }
        }
        catch {
            $StatusCode = 0
            if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
                $StatusCode = [int]$_.Exception.Response.StatusCode
            }
            $Checks.Add([PSCustomObject]@{
                Check      = $CheckLabel
                Pass       = $false
                ResponseMs = 0
                Detail     = if ($StatusCode -eq 404) { 'Workflow not found' }
                             elseif ($StatusCode -eq 403) { 'Auth required — set GITHUB_TOKEN env var' }
                             else { $_.Exception.Message }
            })
        }
    }

    # ── GHCR Package Accessibility ───────────────────────────────────────
    try {
        $Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $GhcrResp = Invoke-WebRequest -Uri 'https://ghcr.io/v2/' `
            -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop `
            -Headers @{ 'Accept' = 'application/json' }
        $Sw.Stop()

        $Checks.Add([PSCustomObject]@{
            Check      = 'GHCR Registry'
            Pass       = $true
            ResponseMs = $Sw.ElapsedMilliseconds
            Detail     = "Reachable (HTTP $($GhcrResp.StatusCode))"
        })
    }
    catch {
        $StatusCode = 0
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
        }
        # GHCR returns 401 for unauthenticated — that still means it's reachable
        $Reachable = $StatusCode -eq 401
        $Checks.Add([PSCustomObject]@{
            Check      = 'GHCR Registry'
            Pass       = $Reachable
            ResponseMs = 0
            Detail     = if ($Reachable) { "Reachable (HTTP 401 — auth required for pulls)" } else { $_.Exception.Message }
        })
    }

    # ── Summary ──────────────────────────────────────────────────────────
    $AllPass = @($Checks | Where-Object { -not $_.Pass }).Count -eq 0

    [PSCustomObject]@{
        Platform  = 'GitHub'
        Repo      = $Repo
        Healthy   = $AllPass
        Checks    = @($Checks)
        Timestamp = (Get-Date).ToString('o')
    }
}
