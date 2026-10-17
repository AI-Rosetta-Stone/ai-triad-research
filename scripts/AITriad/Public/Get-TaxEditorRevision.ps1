# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TaxEditorRevision {
    <#
    .SYNOPSIS
        Lists Azure Container App revisions for the Taxonomy Editor.
    .DESCRIPTION
        Queries ACA revision list via Azure CLI and returns typed objects
        with name, traffic weight, running state, image tag, and creation time.
        Requires 'az' CLI logged in.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER AppName
        Container App name. Default: taxonomy-editor.
    .EXAMPLE
        Get-TaxEditorRevision
    .EXAMPLE
        Get-TaxEditorRevision | Where-Object Active
    .LINK
        Show-AITriadHelp
    .LINK
        Deploy-TaxEditorImage
    .LINK
        Deploy-TaxEditorInfra
    .LINK
        Get-TaxEditorImage
    .LINK
        Switch-TaxEditorRevision
    .LINK
        Test-TaxEditorInfra
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$AppName = 'taxonomy-editor'
    )

    Set-StrictMode -Version Latest

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'List ACA revisions' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Get-TaxEditorRevision' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli', 'Ensure az is on your PATH'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'List ACA revisions' `
            -Problem 'Azure CLI is not logged in' `
            -Location 'Get-TaxEditorRevision' `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    $RevisionJson = & az containerapp revision list -g $ResourceGroup -n $AppName --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $RevisionJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'List ACA revisions' `
            -Problem "Failed to query revisions for '$AppName' in resource group '$ResourceGroup'" `
            -Location 'Get-TaxEditorRevision' `
            -NextSteps @("Verify app exists: az containerapp show -g $ResourceGroup -n $AppName",
                         'Check your Azure subscription: az account show'))
    }

    $Revisions = $RevisionJson | ConvertFrom-Json

    $Results = foreach ($Rev in $Revisions) {
        $TrafficWeight = 0
        if ($Rev.PSObject.Properties['properties'] -and
            $Rev.properties.PSObject.Properties['trafficWeight']) {
            $TrafficWeight = [int]$Rev.properties.trafficWeight
        }

        $RunningState = 'Unknown'
        if ($Rev.PSObject.Properties['properties'] -and
            $Rev.properties.PSObject.Properties['runningState']) {
            $RunningState = $Rev.properties.runningState
        }

        $ImageTag = ''
        if ($Rev.PSObject.Properties['properties'] -and
            $Rev.properties.PSObject.Properties['template'] -and
            $Rev.properties.template.PSObject.Properties['containers']) {
            $Containers = @($Rev.properties.template.containers)
            if ($Containers.Count -gt 0 -and $Containers[0].PSObject.Properties['image']) {
                $ImageTag = $Containers[0].image
            }
        }

        $CreatedAt = ''
        if ($Rev.PSObject.Properties['properties'] -and
            $Rev.properties.PSObject.Properties['createdTime']) {
            $CreatedAt = $Rev.properties.createdTime
        }

        $Obj = [AcaRevision]::new()
        $Obj.Name          = $Rev.name
        $Obj.Active        = $TrafficWeight -gt 0
        $Obj.TrafficWeight = $TrafficWeight
        $Obj.RunningState  = $RunningState
        $Obj.ImageTag      = $ImageTag
        $Obj.CreatedAt     = $CreatedAt
        $Obj
    }

    @($Results) | Sort-Object { $_.CreatedAt } -Descending
}
