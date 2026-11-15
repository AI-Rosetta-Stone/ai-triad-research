# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-GhcrManifestChildDigest {
    <#
    .SYNOPSIS
        Returns the child manifest digests of a GHCR image index.
    .DESCRIPTION
        GETs ghcr.io/v2/<package>/manifests/<reference> and returns the
        digests listed in its `manifests` array (platform manifests and
        attestation manifests). A single-platform image manifest has no
        children and returns nothing. Throws an actionable error if the GET
        fails, so a caller that protects children never guesses (t/4966).
    .PARAMETER Package
        Package in owner/name form, for example ai-rosetta-stone/taxonomy-editor.
    .PARAMETER Reference
        A digest (sha256:...) or a tag.
    .PARAMETER Token
        A GHCR bearer token with pull scope (Get-GhcrAuthToken -Scope pull).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [string]$Package,

        [Parameter(Mandatory)]
        [string]$Reference,

        [Parameter(Mandatory)]
        [string]$Token
    )

    Set-StrictMode -Version Latest

    $Accept = @(
        'application/vnd.oci.image.index.v1+json'
        'application/vnd.docker.distribution.manifest.list.v2+json'
        'application/vnd.oci.image.manifest.v1+json'
        'application/vnd.docker.distribution.manifest.v2+json'
    ) -join ', '

    try {
        $Resp = Invoke-WebRequest `
            -Uri "https://ghcr.io/v2/$Package/manifests/$Reference" `
            -Headers @{ Authorization = "Bearer $Token"; Accept = $Accept } `
            -ErrorAction Stop
    }
    catch {
        throw (New-ActionableError `
            -Goal "Read the child manifests of $Package@$Reference" `
            -Problem "GHCR manifest GET failed: $($_.Exception.Message)" `
            -Location 'Get-GhcrManifestChildDigest' `
            -NextSteps @("Check that $Package@$Reference exists",
                         'Check that GITHUB_TOKEN can pull the package') `
            -AsErrorRecord)
    }

    $Body = $Resp.Content
    if ($Body -is [byte[]]) { $Body = [System.Text.Encoding]::UTF8.GetString($Body) }
    $Manifest = $Body | ConvertFrom-Json
    if ($Manifest.PSObject.Properties['manifests']) {
        foreach ($M in @($Manifest.manifests)) {
            if ($M.PSObject.Properties['digest'] -and $M.digest) { [string]$M.digest }
        }
    }
}
