# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-CIFailureSummary {
    <#
    .SYNOPSIS
        Extract Pester failures and error lines from a GitHub Actions run log (t/2882).
    .DESCRIPTION
        One call to surface why a CI run failed instead of several
        `gh run view --log | Select-String` passes. Resolves a run (explicit -RunId,
        latest failed run for -WorkflowFile, or the latest failed run), pulls the
        failed-step log via `gh run view --log-failed`, and returns a structured
        summary: failed job names, failing Pester and vitest test names, the `[-]`
        failure lines with their assertion detail (test-emitted), one VitestFailures
        entry per vitest failure (File, TestName, Error, Location; t/4271), and the
        remaining `##[error]` lines (real infrastructure errors).
    .PARAMETER RunId
        The GitHub Actions run id. If omitted, the latest failed run is used
        (optionally filtered by -WorkflowFile).
    .PARAMETER WorkflowFile
        Workflow file name (e.g. 'ci.yml') to scope the latest-failed-run lookup.
    .OUTPUTS
        [PSCustomObject] with RunId, FailedJobs, FailingTests, PesterFailureLines,
        VitestFailures, InfraErrorLines, FailedCount.
    .EXAMPLE
        Get-CIFailureSummary
    .EXAMPLE
        Get-CIFailureSummary -RunId 31614727103
    .EXAMPLE
        Get-CIFailureSummary -WorkflowFile ci.yml | Select-Object -ExpandProperty FailingTests
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Position = 0)]
        [string]$RunId,

        [Parameter()]
        [string]$WorkflowFile
    )

    Set-StrictMode -Version Latest

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Summarize a CI failure' `
            -Problem 'GitHub CLI (gh) was not found on PATH.' `
            -Location 'Get-CIFailureSummary' `
            -NextSteps 'Install the GitHub CLI and authenticate (gh auth login), then retry.')
    }

    # ── Resolve the run id ────────────────────────────────────────────────
    if (-not $RunId) {
        $ListArgs = @('run', 'list', '--status', 'failure', '--limit', '1', '--json', 'databaseId,name,workflowName')
        if ($WorkflowFile) { $ListArgs += @('--workflow', $WorkflowFile) }
        $ListRaw = & gh @ListArgs 2>$null
        $Runs = if ($ListRaw) { @($ListRaw | ConvertFrom-Json) } else { @() }
        if ($Runs.Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Summarize a CI failure' `
                -Problem "No failed run found$(if ($WorkflowFile) { " for workflow '$WorkflowFile'" })." `
                -Location 'Get-CIFailureSummary' `
                -NextSteps 'Pass -RunId explicitly, or verify with: gh run list --status failure.')
        }
        $RunId = [string]$Runs[0].databaseId
    }

    # ── Failed job names ──────────────────────────────────────────────────
    $FailedJobs = @()
    $JobsRaw = & gh run view $RunId --json jobs 2>$null
    if ($JobsRaw) {
        try {
            $JobsObj = $JobsRaw | ConvertFrom-Json
            if ($JobsObj.PSObject.Properties['jobs']) {
                $FailedJobs = @($JobsObj.jobs |
                    Where-Object { $_.conclusion -eq 'failure' } |
                    ForEach-Object { $_.name })
            }
        } catch {
            Write-Warning "Get-CIFailureSummary: could not parse jobs for run $RunId — $($_.Exception.Message)"
        }
    }

    # ── Failed-step log (fall back to full log if empty) ─────────────────
    $Log = (& gh run view $RunId --log-failed 2>$null) -join "`n"
    if ([string]::IsNullOrWhiteSpace($Log)) {
        $Log = (& gh run view $RunId --log 2>$null) -join "`n"
    }
    if ([string]::IsNullOrWhiteSpace($Log)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Summarize a CI failure' `
            -Problem "Could not retrieve any log for run $RunId (empty output from gh run view)." `
            -Location 'Get-CIFailureSummary' `
            -NextSteps "Verify the run id and access: gh run view $RunId --log-failed.")
    }

    $Summary = ConvertFrom-CILog -LogText $Log -FailedJobs $FailedJobs
    return ($Summary | Add-Member -NotePropertyName RunId -NotePropertyValue $RunId -PassThru)
}
