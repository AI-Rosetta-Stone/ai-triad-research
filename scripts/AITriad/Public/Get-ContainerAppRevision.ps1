# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-ContainerAppRevision {
    <#
    .SYNOPSIS
        Queries Azure Container App revisions by mode: Active, Stale, or Fqdn.
    .DESCRIPTION
        Consolidates the three `az containerapp revision` query patterns
        that `.github/workflows/deploy-azure.yml` inlines (t/1498):

          - Active: the revision currently receiving traffic
                    (properties.trafficWeight > 0)
          - Stale:  revisions still marked active but with 0% traffic
                    (properties.active && properties.trafficWeight == 0)
          - Fqdn:   the revision-specific hostname used to probe a new
                    revision before shifting traffic to it

        Returns typed [ContainerAppRevisionInfo] objects so consumers can
        filter and format via the object pipeline instead of parsing raw
        `az` output.
    .PARAMETER Mode
        Query mode — Active, Stale, or Fqdn.
    .PARAMETER AppName
        Container App name. Default: 'taxonomy-editor'.
    .PARAMETER ResourceGroup
        Azure resource group. Default: 'ai-triad'.
    .PARAMETER RevisionName
        Required when -Mode Fqdn — the revision whose FQDN to resolve.
    .EXAMPLE
        Get-ContainerAppRevision -Mode Active
    .EXAMPLE
        Get-ContainerAppRevision -Mode Stale
    .EXAMPLE
        Get-ContainerAppRevision -Mode Fqdn -RevisionName 'taxonomy-editor--deploy-abc1234'
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AzureHealth
    .LINK
        Remove-StaleContainerImages
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Test-TaxEditorInfra
    .LINK
        Deploy-TaxEditorInfra
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Active', 'Stale', 'Fqdn')]
        [string]$Mode,

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$RevisionName
    )

    Set-StrictMode -Version Latest

    if ($Mode -eq 'Fqdn' -and -not $RevisionName) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Get revision-specific FQDN" `
            -Problem '-RevisionName is required when -Mode Fqdn is specified' `
            -Location 'Get-ContainerAppRevision' `
            -NextSteps @('Pass -RevisionName <name>',
                         "Or query with -Mode Active to find the current traffic-receiving revision"))
    }

    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Query $Mode revision" `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Get-ContainerAppRevision' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli',
                         'Ensure az is on your PATH'))
    }

    switch ($Mode) {
        'Fqdn' {
            $Json = Invoke-Az @(
                'containerapp', 'revision', 'show',
                '--name', $AppName,
                '--resource-group', $ResourceGroup,
                '--revision', $RevisionName,
                '--output', 'json'
            )
            if (-not $Json) { return $null }
            $Obj = $Json | ConvertFrom-Json
            $Info = [ContainerAppRevisionInfo]::new()
            $Info.Name          = $Obj.name
            $Info.TrafficWeight = 0
            if ($Obj.PSObject.Properties['properties']) {
                if ($Obj.properties.PSObject.Properties['trafficWeight']) {
                    $Info.TrafficWeight = [int]$Obj.properties.trafficWeight
                }
                if ($Obj.properties.PSObject.Properties['fqdn']) {
                    $Info.Fqdn = [string]$Obj.properties.fqdn
                }
                if ($Obj.properties.PSObject.Properties['active']) {
                    $Info.Active = [bool]$Obj.properties.active
                }
                if ($Obj.properties.PSObject.Properties['createdTime']) {
                    $Info.CreatedTime = [string]$Obj.properties.createdTime
                }
            }
            return $Info
        }
        default {
            # Active + Stale: list all revisions and filter locally so both modes
            # share one az call — cheaper than a per-mode --query and easier to test.
            $Json = Invoke-Az @(
                'containerapp', 'revision', 'list',
                '--name', $AppName,
                '--resource-group', $ResourceGroup,
                '--output', 'json'
            )
            if (-not $Json) { return @() }
            $All = @($Json | ConvertFrom-Json)
            $Filtered = switch ($Mode) {
                'Active' { @($All | Where-Object {
                    $_.PSObject.Properties['properties'] -and
                    $_.properties.PSObject.Properties['trafficWeight'] -and
                    [int]$_.properties.trafficWeight -gt 0
                }) }
                'Stale' { @($All | Where-Object {
                    $_.PSObject.Properties['properties'] -and
                    $_.properties.PSObject.Properties['active'] -and
                    [bool]$_.properties.active -and
                    $_.properties.PSObject.Properties['trafficWeight'] -and
                    [int]$_.properties.trafficWeight -eq 0
                }) }
            }
            $Filtered | ForEach-Object {
                $Info = [ContainerAppRevisionInfo]::new()
                $Info.Name          = $_.name
                if ($_.properties.PSObject.Properties['trafficWeight']) {
                    $Info.TrafficWeight = [int]$_.properties.trafficWeight
                }
                if ($_.properties.PSObject.Properties['active']) {
                    $Info.Active        = [bool]$_.properties.active
                }
                if ($_.properties.PSObject.Properties['fqdn']) {
                    $Info.Fqdn          = [string]$_.properties.fqdn
                }
                if ($_.properties.PSObject.Properties['createdTime']) {
                    $Info.CreatedTime   = [string]$_.properties.createdTime
                }
                $Info
            }
        }
    }
}
