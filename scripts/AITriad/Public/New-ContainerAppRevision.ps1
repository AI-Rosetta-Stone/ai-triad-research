# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function New-ContainerAppRevision {
    <#
    .SYNOPSIS
        Deploys a new Azure Container App revision at 0% traffic.
    .DESCRIPTION
        Wraps `az containerapp update --revision-suffix` to create a new revision
        without shifting any traffic to it. This is the safe blue-green deploy
        first step (t/1500 Phase 3).

        This cmdlet is distinct from Deploy-TaxEditorImage, which shifts immediately
        to 100% traffic. Use New-ContainerAppRevision when you want to probe the new
        revision via its FQDN (Get-ContainerAppRevision -Mode Fqdn) before promoting
        via Set-ContainerAppTraffic.

        CRITICAL: The revision name returned by az is verified non-empty. A silent
        empty return would break downstream steps 4/8/10 of the deploy chain.
    .PARAMETER ImageRef
        Full image reference including tag (e.g. 'ghcr.io/ai-rosetta-stone/taxonomy-editor:latest').
    .PARAMETER RevisionSuffix
        Suffix appended to the app name to form the revision name
        (e.g. 'deploy-abc1234-12345'). Must be unique.
    .PARAMETER EnvVars
        Optional hashtable of additional environment variables to set on the revision.
        Keys and values are passed as KEY=val pairs via --set-env-vars.
    .PARAMETER AppName
        Container App name. Default: 'taxonomy-editor'.
    .PARAMETER ResourceGroup
        Azure resource group. Default: 'ai-triad'.
    .EXAMPLE
        New-ContainerAppRevision `
            -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
            -RevisionSuffix 'deploy-abc1234-12345'
    .EXAMPLE
        New-ContainerAppRevision `
            -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor:sha-abc1234' `
            -RevisionSuffix 'deploy-abc1234-12345' `
            -EnvVars @{ FEATURE_FLAG = '1'; BUILD_ID = 'abc1234' }
    .LINK
        Get-ContainerAppRevision
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
        [string]$ImageRef,

        [Parameter(Mandatory)]
        [string]$RevisionSuffix,

        [Parameter()]
        [hashtable]$EnvVars,

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad'
    )

    Set-StrictMode -Version Latest

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError `
            -Goal "Create new Container App revision with suffix '$RevisionSuffix'" `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'New-ContainerAppRevision' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli',
                         'Ensure az is on your PATH'))
    }

    $AzArgs = @(
        'containerapp', 'update',
        '--name', $AppName,
        '--resource-group', $ResourceGroup,
        '--image', $ImageRef,
        '--revision-suffix', $RevisionSuffix,
        '--output', 'json'
    )

    if ($EnvVars -and $EnvVars.Count -gt 0) {
        $EnvPairs = @($EnvVars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
        $AzArgs += '--set-env-vars'
        $AzArgs += $EnvPairs
    }

    $Json = Invoke-Az $AzArgs -CallerName 'New-ContainerAppRevision'

    # Parse the JSON response and extract latestRevisionName.
    # Use JSON output (not --query -o tsv) so we can detect az returning an
    # empty field vs az failing — a silent empty breaks Steps 4/8/10 downstream.
    $Obj = $Json | ConvertFrom-Json
    $RevisionName = $null
    if ($Obj.PSObject.Properties['properties']) {
        if ($Obj.properties.PSObject.Properties['latestRevisionName']) {
            $RevisionName = $Obj.properties.latestRevisionName
        }
    }

    if ([string]::IsNullOrWhiteSpace($RevisionName)) {
        throw (New-ActionableError `
            -Goal "Create new Container App revision with suffix '$RevisionSuffix'" `
            -Problem 'az containerapp update returned empty latestRevisionName — cannot confirm revision was created' `
            -Location 'New-ContainerAppRevision' `
            -NextSteps @(
                'Check az containerapp revision list to see if the revision was partially created',
                'Verify the --revision-suffix is unique and does not conflict with an existing revision',
                'Re-run with -Verbose to see the raw az output'))
    }

    [PSCustomObject]@{
        RevisionName = $RevisionName
        ImageRef     = $ImageRef
        Suffix       = $RevisionSuffix
        Timestamp    = [System.DateTime]::UtcNow.ToString('o')
    }
}
