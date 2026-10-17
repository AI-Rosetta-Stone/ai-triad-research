# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Disable-ContainerAppRevision {
    <#
    .SYNOPSIS
        Deactivates an Azure Container App revision.
    .DESCRIPTION
        Wraps `az containerapp revision deactivate` to mark a revision as inactive.
        Deactivation failures are NON-FATAL — the cmdlet emits a warning and returns
        with Deactivated=$false rather than throwing. This matches the `|| true`
        behavior in the original deploy-azure.yml shell script (t/1500).

        ROLLBACK ORDER WARNING:
        In rollback sequences, call Set-ContainerAppTraffic -Weight 100 on the
        KNOWN-GOOD revision BEFORE calling this on the failed revision.
        Deactivate-then-shift is unrecoverable; shift-then-deactivate is.
    .PARAMETER RevisionName
        The full revision name to deactivate (e.g. 'taxonomy-editor--deploy-abc1234').
    .PARAMETER AppName
        Container App name. Default: 'taxonomy-editor'.
    .PARAMETER ResourceGroup
        Azure resource group. Default: 'ai-triad'.
    .EXAMPLE
        # Safe rollback sequence — shift traffic first, then deactivate
        Set-ContainerAppTraffic -RevisionName 'taxonomy-editor--rev-good' -Weight 100
        Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--rev-bad'
    .EXAMPLE
        # WhatIf — shows what would happen without making any changes
        Disable-ContainerAppRevision -RevisionName 'taxonomy-editor--deploy-abc1234' -WhatIf
    .LINK
        Get-ContainerAppRevision
    .LINK
        New-ContainerAppRevision
    .LINK
        Set-ContainerAppTraffic
    .LINK
        Show-AITriadHelp
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory)]
        [string]$RevisionName,

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad'
    )

    Set-StrictMode -Version Latest

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Deactivate revision '$RevisionName'" `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Disable-ContainerAppRevision' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli',
                         'Ensure az is on your PATH'))
    }

    $Timestamp = [System.DateTime]::UtcNow.ToString('o')

    if (-not $PSCmdlet.ShouldProcess($RevisionName, 'Deactivate Container App revision')) {
        return [PSCustomObject]@{
            RevisionName = $RevisionName
            Deactivated  = $false
            Timestamp    = $Timestamp
        }
    }

    $Deactivated = $false
    try {
        Invoke-Az @(
            'containerapp', 'revision', 'deactivate',
            '--name', $AppName,
            '--resource-group', $ResourceGroup,
            '--revision', $RevisionName
        ) -CallerName 'Disable-ContainerAppRevision' | Out-Null
        $Deactivated = $true
    }
    catch {
        Write-Warning "Disable-ContainerAppRevision: deactivation of '$RevisionName' failed (non-fatal): $_"
    }

    [PSCustomObject]@{
        RevisionName = $RevisionName
        Deactivated  = $Deactivated
        Timestamp    = $Timestamp
    }
}
