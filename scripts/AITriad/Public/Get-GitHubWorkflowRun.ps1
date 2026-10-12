# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-GitHubWorkflowRun {
    <#
    .SYNOPSIS
        Fetches a GitHub Actions workflow run for a commit SHA (or by run ID), with per-job conclusions.
    .DESCRIPTION
        Consolidates the workflow-run status queries duplicated in
        `.github/workflows/deploy-azure.yml:86-99` (CI-readiness gate for
        a deploy — needs per-job status by name) and
        `.github/workflows/container.yml:45-46` (simpler top-level
        conclusion check before a container build). Both call the same
        GitHub API endpoints — this cmdlet is one entry point for both.

        Two lookup modes:
          - By SHA: -Repo + -Workflow + -CommitSha. Fetches the most
            recent run of the given workflow for that commit.
          - By ID:  -Repo + -RunId. Fetches that specific run.

        Returns [GitHubWorkflowRunInfo] with RunId/Status/Conclusion/
        Jobs (each with Name/Status/Conclusion). Jobs are only fetched
        when at least one job is present in the run.
    .PARAMETER Repo
        Owner/repo (e.g. 'AI-Rosetta-Stone/ai-triad-research').
    .PARAMETER Workflow
        Workflow file name (e.g. 'ci.yml'). Required when resolving by
        commit SHA; ignored when -RunId is provided.
    .PARAMETER CommitSha
        Head SHA to look up. Required unless -RunId is provided.
    .PARAMETER RunId
        Specific workflow run ID. Overrides -CommitSha/-Workflow lookup.
    .EXAMPLE
        Get-GitHubWorkflowRun -Repo 'AI-Rosetta-Stone/ai-triad-research' -Workflow 'ci.yml' -CommitSha $sha
    .EXAMPLE
        (Get-GitHubWorkflowRun -Repo $r -Workflow ci.yml -CommitSha $sha).Jobs |
            Where-Object Name -eq 'test-container'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-GitHubHealth
    #>
    [CmdletBinding(DefaultParameterSetName = 'BySha')]
    param(
        [Parameter(Mandatory)]
        [string]$Repo,

        [Parameter(Mandatory, ParameterSetName = 'BySha')]
        [string]$Workflow,

        [Parameter(Mandatory, ParameterSetName = 'BySha')]
        [string]$CommitSha,

        [Parameter(Mandatory, ParameterSetName = 'ById')]
        [long]$RunId
    )

    Set-StrictMode -Version Latest

    # ── Resolve run ──────────────────────────────────────────────────────
    $Run = $null
    if ($PSCmdlet.ParameterSetName -eq 'BySha') {
        $Endpoint = "/repos/$Repo/actions/workflows/$Workflow/runs?head_sha=$CommitSha&per_page=1"
        $Response = Invoke-GitHubApi -Endpoint $Endpoint -Method 'GET' `
            -CallerName 'Get-GitHubWorkflowRun'
        if ($Response -and $Response.PSObject.Properties['workflow_runs']) {
            $Runs = @($Response.workflow_runs)
            if ($Runs.Count -gt 0) { $Run = $Runs[0] }
        }
    } else {
        $Run = Invoke-GitHubApi -Endpoint "/repos/$Repo/actions/runs/$RunId" `
            -Method 'GET' -CallerName 'Get-GitHubWorkflowRun'
    }

    if (-not $Run) {
        Write-Verbose 'No matching workflow run found'
        return $null
    }

    # ── Fetch jobs ───────────────────────────────────────────────────────
    $Jobs = [System.Collections.Generic.List[object]]::new()
    try {
        $JobsResponse = Invoke-GitHubApi -Endpoint "/repos/$Repo/actions/runs/$($Run.id)/jobs" `
            -Method 'GET' -CallerName 'Get-GitHubWorkflowRun'
        if ($JobsResponse -and $JobsResponse.PSObject.Properties['jobs']) {
            foreach ($j in @($JobsResponse.jobs)) {
                $JobInfo = [GitHubWorkflowJobInfo]::new()
                $JobInfo.Name       = [string]$j.name
                if ($j.PSObject.Properties['status']) {
                    $JobInfo.Status = [string]$j.status
                }
                if ($j.PSObject.Properties['conclusion']) {
                    $JobInfo.Conclusion = [string]$j.conclusion
                }
                $Jobs.Add($JobInfo)
            }
        }
    } catch {
        Write-Warning "Failed to fetch jobs for run $($Run.id): $($_.Exception.Message)"
    }

    $Result = [GitHubWorkflowRunInfo]::new()
    $Result.RunId       = [long]$Run.id
    if ($Run.PSObject.Properties['status'])     { $Result.Status     = [string]$Run.status }
    if ($Run.PSObject.Properties['conclusion']) { $Result.Conclusion = [string]$Run.conclusion }
    if ($Run.PSObject.Properties['head_sha'])   { $Result.HeadSha    = [string]$Run.head_sha }
    if ($Run.PSObject.Properties['html_url'])   { $Result.Url        = [string]$Run.html_url }
    $Result.Jobs = @($Jobs)
    $Result
}
