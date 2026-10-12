# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TaxEditorImage {
    <#
    .SYNOPSIS
        Lists GHCR image versions for the taxonomy editor.
    .DESCRIPTION
        Queries the GitHub Packages API for container image versions of the
        taxonomy editor. Returns typed GhcrImage objects with tags, digest,
        creation date, and known-good status.
        Requires GITHUB_TOKEN environment variable with read:packages scope.
    .PARAMETER Last
        Number of image versions to return (1-100). Default: 10.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .EXAMPLE
        Get-TaxEditorImage
    .EXAMPLE
        Get-TaxEditorImage -Last 5 | Where-Object IsKnownGood
    .LINK
        Show-AITriadHelp
    .LINK
        Deploy-TaxEditorImage
    .LINK
        Deploy-TaxEditorInfra
    .LINK
        Get-TaxEditorRevision
    .LINK
        Switch-TaxEditorRevision
    .LINK
        Test-TaxEditorInfra
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [ValidateRange(1, 100)]
        [int]$Last = 10,

        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor'
    )

    Set-StrictMode -Version Latest

    $Parts = $Package -split '/', 2
    $Owner = $Parts[0]
    $PkgName = $Parts[1]

    $Versions = Invoke-GitHubApi `
        -Endpoint "/orgs/$Owner/packages/container/$PkgName/versions?per_page=$Last&state=active" `
        -CallerName 'Get-TaxEditorImage'

    foreach ($V in $Versions) {
        $Tags = @()
        if ($V.PSObject.Properties['metadata'] -and
            $V.metadata.PSObject.Properties['container'] -and
            $V.metadata.container.PSObject.Properties['tags']) {
            $Tags = @($V.metadata.container.tags)
        }

        $Obj = [GhcrImage]::new()
        $Obj.Tags        = $Tags
        $Obj.Digest      = $V.name
        $Obj.CreatedAt   = $V.created_at
        $Obj.IsKnownGood = 'known-good' -in $Tags
        $Obj
    }
}
