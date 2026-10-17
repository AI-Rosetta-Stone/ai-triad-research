# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-ContainerAppDiagnostics {
    <#
    .SYNOPSIS
        Gathers revision state and logs for a failed Azure Container App revision.
    .DESCRIPTION
        Combines three az calls into one diagnostic snapshot (t/1500 Phase 3):
          - az containerapp revision show   → RevisionState (RunningState, HealthState, etc.)
          - az containerapp logs show --type console → last -TailLines lines of app output
          - az containerapp logs show --type system  → last 50 lines of platform events

        Console log availability is not instantaneous after deploy. The cmdlet polls
        up to 30 seconds (6 attempts × 5-second sleep) before declaring logs
        unavailable. System logs use a fixed tail of 50 lines (they are noisier).

        Per-log-fetch failures are non-fatal — a warning is emitted and the field
        returns an empty array. Only a failure in az containerapp revision show
        (revision doesn't exist / az not logged in) is fatal.
    .PARAMETER RevisionName
        The full revision name to inspect (e.g. 'taxonomy-editor--deploy-abc1234').
    .PARAMETER AppName
        Container App name. Default: 'taxonomy-editor'.
    .PARAMETER ResourceGroup
        Azure resource group. Default: 'ai-triad'.
    .PARAMETER TailLines
        Number of console log lines to return. Default: 100.
    .EXAMPLE
        Get-ContainerAppDiagnostics -RevisionName 'taxonomy-editor--deploy-abc1234'
    .EXAMPLE
        Get-ContainerAppDiagnostics -RevisionName 'taxonomy-editor--deploy-abc1234' -TailLines 200
    .LINK
        Get-ContainerAppRevision
    .LINK
        New-ContainerAppRevision
    .LINK
        Set-ContainerAppTraffic
    .LINK
        Disable-ContainerAppRevision
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName,

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$TailLines = 100
    )

    Set-StrictMode -Version Latest

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Get diagnostics for revision '$RevisionName'" `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Get-ContainerAppDiagnostics' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli',
                         'Ensure az is on your PATH'))
    }

    # --- Revision state (fatal if this fails) ---
    $RevJson = Invoke-Az @(
        'containerapp', 'revision', 'show',
        '--name', $AppName,
        '--resource-group', $ResourceGroup,
        '--revision', $RevisionName,
        '--output', 'json'
    ) -CallerName 'Get-ContainerAppDiagnostics'

    $RevObj = $RevJson | ConvertFrom-Json
    $RunningState  = ''
    $HealthState   = ''
    $Replicas      = 0
    $StatusMessage = ''

    if ($RevObj.PSObject.Properties['properties']) {
        $Props = $RevObj.properties
        if ($Props.PSObject.Properties['runningState'])  { $RunningState  = [string]$Props.runningState  }
        if ($Props.PSObject.Properties['healthState'])   { $HealthState   = [string]$Props.healthState   }
        if ($Props.PSObject.Properties['replicas'])      { $Replicas      = [int]$Props.replicas         }
        if ($Props.PSObject.Properties['statusMessage']) { $StatusMessage = [string]$Props.statusMessage }
    }

    $RevisionState = [PSCustomObject]@{
        RunningState  = $RunningState
        HealthState   = $HealthState
        Replicas      = $Replicas
        StatusMessage = $StatusMessage
    }

    # --- Console logs with poll loop (non-fatal if unavailable) ---
    $ConsoleLogs   = @()
    $LogsAvailable = $false
    $MaxPolls      = 6
    $PollSleepSec  = 5

    for ($i = 1; $i -le $MaxPolls; $i++) {
        try {
            $RawConsole = Invoke-Az @(
                'containerapp', 'logs', 'show',
                '--name', $AppName,
                '--resource-group', $ResourceGroup,
                '--revision', $RevisionName,
                '--type', 'console',
                '--tail', [string]$TailLines,
                '--output', 'table'
            ) -CallerName 'Get-ContainerAppDiagnostics'

            if (-not [string]::IsNullOrWhiteSpace($RawConsole)) {
                $ConsoleLogs   = @($RawConsole -split "`n" | Where-Object { $_ -ne '' })
                $LogsAvailable = $true
                break
            }
        }
        catch {
            Write-Warning "Get-ContainerAppDiagnostics: console log fetch attempt $i failed (non-fatal): $_"
            break
        }

        if ($i -lt $MaxPolls) {
            Write-Verbose "Get-ContainerAppDiagnostics: console logs not yet available, waiting ${PollSleepSec}s (attempt $i of $MaxPolls)..."
            Start-Sleep -Seconds $PollSleepSec
        }
    }

    if (-not $LogsAvailable) {
        Write-Verbose "Get-ContainerAppDiagnostics: console logs unavailable after $($MaxPolls * $PollSleepSec)s polling — returning empty array."
    }

    # --- System logs (non-fatal; fixed 50-line tail — system logs are noisier) ---
    $SystemLogs = @()
    try {
        $RawSystem = Invoke-Az @(
            'containerapp', 'logs', 'show',
            '--name', $AppName,
            '--resource-group', $ResourceGroup,
            '--type', 'system',
            '--tail', '50',
            '--output', 'table'
        ) -CallerName 'Get-ContainerAppDiagnostics'

        if (-not [string]::IsNullOrWhiteSpace($RawSystem)) {
            $SystemLogs = @($RawSystem -split "`n" | Where-Object { $_ -ne '' })
        }
    }
    catch {
        Write-Warning "Get-ContainerAppDiagnostics: system log fetch failed (non-fatal): $_"
    }

    [PSCustomObject]@{
        RevisionName   = $RevisionName
        RevisionState  = $RevisionState
        ConsoleLogs    = $ConsoleLogs
        SystemLogs     = $SystemLogs
        LogsAvailable  = $LogsAvailable
    }
}
