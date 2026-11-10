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

        -Last reads only the newest N versions (one page). GHCR lists versions
        newest-created first, and adding a tag to an existing version does not
        move it up. Every pushed build adds about five versions (image index,
        platform manifest, buildx attestation, sigstore referrer index, sigstore
        bundle), so an image falls out of -Last 100 after about 20 builds.
        To find the image carrying a tag, use -Tag, which pages until it finds
        it (t/4966).
    .PARAMETER Last
        Number of image versions to return (1-100). Default: 10.
    .PARAMETER Tag
        Return only the version(s) carrying this tag, paging through the whole
        package (up to -MaxPages pages of 100) instead of reading one page.
    .PARAMETER MaxPages
        With -Tag: the most pages of 100 to read. Default: 20.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .EXAMPLE
        Get-TaxEditorImage
    .EXAMPLE
        Get-TaxEditorImage -Last 5 | Where-Object IsKnownGood
    .EXAMPLE
        Get-TaxEditorImage -Tag known-good
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
    [CmdletBinding(DefaultParameterSetName = 'Newest')]
    param(
        [Parameter(Position = 0, ParameterSetName = 'Newest')]
        [ValidateRange(1, 100)]
        [int]$Last = 10,

        [Parameter(Mandatory, ParameterSetName = 'ByTag')]
        [ValidateNotNullOrEmpty()]
        [string]$Tag,

        [Parameter(ParameterSetName = 'ByTag')]
        [ValidateRange(1, 100)]
        [int]$MaxPages = 20,

        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor'
    )

    Set-StrictMode -Version Latest

    $Parts = $Package -split '/', 2
    $Owner = $Parts[0]
    $PkgName = $Parts[1]
    $Base = "/orgs/$Owner/packages/container/$PkgName/versions"

    $Versions = if ($PSCmdlet.ParameterSetName -eq 'ByTag') {
        $Found = @()
        $ReachedEnd = $false
        for ($Page = 1; $Page -le $MaxPages; $Page++) {
            # Assign first, then @(): the API returns the page as one array object.
            $Raw = Invoke-GitHubApi `
                -Endpoint "${Base}?per_page=100&page=$Page&state=active" `
                -CallerName 'Get-TaxEditorImage'
            $Batch = @($Raw)
            $Found = @($Batch | Where-Object { $Tag -in @(Get-GhcrVersionTag -Version $_) })
            if ($Found.Count -gt 0) { break }
            if ($Batch.Count -lt 100) { $ReachedEnd = $true; break }
        }
        if ($Found.Count -eq 0 -and -not $ReachedEnd) {
            Write-Warning "Get-TaxEditorImage: no version tagged '$Tag' in the newest $($MaxPages * 100) versions of $Package; stopped at -MaxPages $MaxPages without reaching the end. Raise -MaxPages to search further."
        }
        $Found
    }
    else {
        Invoke-GitHubApi `
            -Endpoint "${Base}?per_page=$Last&state=active" `
            -CallerName 'Get-TaxEditorImage'
    }

    foreach ($V in $Versions) {
        $Tags = @(Get-GhcrVersionTag -Version $V)

        $Obj = [GhcrImage]::new()
        $Obj.Tags        = $Tags
        $Obj.Digest      = $V.name
        $Obj.CreatedAt   = $V.created_at
        $Obj.IsKnownGood = 'known-good' -in $Tags
        $Obj
    }
}
