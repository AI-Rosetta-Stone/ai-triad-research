# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-ContainerAppTraffic {
    <#
    .SYNOPSIS
        Sets the traffic weight for an Azure Container App revision, with retry.
    .DESCRIPTION
        Wraps `az containerapp ingress traffic set --revision-weight` with
        configurable retry logic (t/1500 Phase 3).

        ROLLBACK ORDER WARNING:
        This cmdlet MUST be called BEFORE Disable-ContainerAppRevision in rollback
        sequences. Shift traffic to the known-good revision first, then deactivate
        the failed revision. Deactivate-then-shift is unrecoverable.

        This cmdlet is used for both promotion (Step 8: -Weight 100 on the new
        revision) and rollback (Step 10: -Weight 100 on the previous revision).
    .PARAMETER RevisionName
        The full revision name to update traffic weight for.
    .PARAMETER Weight
        Traffic weight percentage (0-100). Default: 100.
    .PARAMETER AppName
        Container App name. Default: 'taxonomy-editor'.
    .PARAMETER ResourceGroup
        Azure resource group. Default: 'ai-triad'.
    .PARAMETER MaxAttempts
        Maximum number of attempts before giving up. Default: 5.
    .PARAMETER RetryIntervalSec
        Seconds to wait between retry attempts. Default: 30.
    .EXAMPLE
        # Promote new revision to 100% traffic (Step 8)
        Set-ContainerAppTraffic -RevisionName 'taxonomy-editor--deploy-abc1234-12345' -Weight 100
    .EXAMPLE
        # Rollback: shift back to known-good BEFORE deactivating the failed revision (Step 10)
        Set-ContainerAppTraffic -RevisionName 'taxonomy-editor--rev-good' -Weight 100
        Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad'
    .EXAMPLE
        # Canary: direct 10% to a new revision
        Set-ContainerAppTraffic -RevisionName 'taxonomy-editor--deploy-abc1234-12345' -Weight 10
    .LINK
        Get-ContainerAppRevision
    .LINK
        New-ContainerAppRevision
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
        [ValidateRange(0, 100)]
        [int]$Weight = 100,

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [ValidateRange(1, 20)]
        [int]$MaxAttempts = 5,

        [Parameter()]
        [ValidateRange(1, 300)]
        [int]$RetryIntervalSec = 30
    )

    Set-StrictMode -Version Latest

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Set traffic weight $Weight% on revision '$RevisionName'" `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Set-ContainerAppTraffic' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli',
                         'Ensure az is on your PATH'))
    }

    $AttemptCount = 0
    $LastError    = $null

    while ($AttemptCount -lt $MaxAttempts) {
        $AttemptCount++
        try {
            Invoke-Az @(
                'containerapp', 'ingress', 'traffic', 'set',
                '--name', $AppName,
                '--resource-group', $ResourceGroup,
                '--revision-weight', "${RevisionName}=${Weight}",
                '--output', 'json'
            ) -CallerName 'Set-ContainerAppTraffic' | Out-Null

            return [PSCustomObject]@{
                Success      = $true
                AttemptCount = $AttemptCount
                RevisionName = $RevisionName
                Weight       = $Weight
            }
        }
        catch {
            $LastError = $_
            Write-Warning "Set-ContainerAppTraffic: attempt $AttemptCount of $MaxAttempts failed: $_"
            if ($AttemptCount -lt $MaxAttempts) {
                Start-Sleep -Seconds $RetryIntervalSec
            }
        }
    }

    throw (New-ActionableError -AsErrorRecord `
        -Goal "Set traffic weight $Weight% on revision '$RevisionName'" `
        -Problem "All $MaxAttempts attempts failed. Last error: $LastError" `
        -Location 'Set-ContainerAppTraffic' `
        -NextSteps @(
            'Verify az login: az account show',
            "Check revision exists: Get-ContainerAppRevision -Mode Active",
            'Increase -MaxAttempts or -RetryIntervalSec if the cluster is under load',
            'Check Azure Container Apps service health at https://status.azure.com'))
}
