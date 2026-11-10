# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-TaxEditorPinnedTag {
    <#
    .SYNOPSIS
        Tags the exact image digest a deploy pins with a non-moving 'pinned-*' tag in GHCR.
    .DESCRIPTION
        t/121. Prod revisions are pinned BY DIGEST, but GHCR cleanup protects
        images BY TAG. A container.yml re-run for the same commit moves
        sha-<commit> to a new digest, leaving the pinned digest untagged and,
        after 30 days, deletable together with its child manifests. With
        minReplicas 0, the next cold start would then fail to pull.

        This cmdlet gives the pinned digest its own tag, named by the pure
        Get-PinnedImageTagName ('pinned-<runId>-<attempt>-<hex12>'), so the
        existing tag-based protection in Remove-StaleContainerImages (tagged
        versions and their untagged children) always covers it.

        It fetches the manifest BY DIGEST, refuses if GHCR returns a different
        digest, reads the tag first and never moves an existing tag
        (Get-PinnedImageTagVerdict), then PUTs the same manifest bytes under
        the tag and re-reads it to confirm. If the tag can't be read, nothing
        is written (fail closed). It never writes the known-good tag; that
        stays with Set-TaxEditorKnownGood.

        Only deploy-azure.yml's tag-known-good job calls it, with the token
        that job already has (packages:write). Supports -WhatIf/-Confirm.
    .PARAMETER ImageRef
        The digest-pinned image ref the deploy used: <registry>/<repo>@sha256:<hex>.
    .PARAMETER RunId
        The deploy's GitHub Actions run id.
    .PARAMETER RunAttempt
        The deploy's run attempt. Default: 1.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .EXAMPLE
        Set-TaxEditorPinnedTag -ImageRef 'ghcr.io/ai-rosetta-stone/taxonomy-editor@sha256:<hex>' -RunId 42621970336 -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Remove-StaleContainerImages
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory)]
        [string]$ImageRef,

        [Parameter(Mandatory)]
        [string]$RunId,

        [Parameter()]
        [ValidateRange(1, 1000)]
        [int]$RunAttempt = 1,

        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Set-TaxEditorPinnedTag'

    $RefParts = ConvertFrom-TaxEditorImageRef -ImageRef $ImageRef
    if (-not $RefParts -or -not $RefParts.Digest) {
        throw (New-ActionableError `
            -Goal 'Tag the deployed digest with a pinned tag' `
            -Problem "The image ref is not digest-pinned: '$ImageRef'. Only an exact digest can be pinned." `
            -Location $CallerName `
            -NextSteps @('Pass the resolved image ref the deploy used (<registry>/<repo>@sha256:<hex>)') `
            -AsErrorRecord)
    }
    $Digest = $RefParts.Digest
    $TagName = Get-PinnedImageTagName -Digest $Digest -RunId $RunId -RunAttempt $RunAttempt

    if (-not $PSCmdlet.ShouldProcess("ghcr.io/$Package@$Digest", "Add non-moving tag '$TagName'")) {
        return
    }

    $GhcrToken = Get-GhcrAuthToken -Package $Package -Scope 'pull,push' -CallerName $CallerName
    $AcceptTypes = @(
        'application/vnd.oci.image.index.v1+json'
        'application/vnd.docker.distribution.manifest.list.v2+json'
        'application/vnd.oci.image.manifest.v1+json'
        'application/vnd.docker.distribution.manifest.v2+json'
    ) -join ', '
    $Headers = @{ Authorization = "Bearer $GhcrToken"; Accept = $AcceptTypes }

    # -- The pinned manifest, fetched BY DIGEST ----------------------------
    try {
        $ManifestResp = Invoke-WebRequest -Uri "https://ghcr.io/v2/$Package/manifests/$Digest" `
            -Headers $Headers -ErrorAction Stop
    }
    catch {
        throw (New-ActionableError `
            -Goal "Fetch the pinned manifest $Digest" `
            -Problem "GHCR manifest GET failed: $($_.Exception.Message)" `
            -Location $CallerName `
            -NextSteps @("Verify the image exists: $ImageRef") `
            -AsErrorRecord)
    }
    $FetchedDigest = Get-OciManifestDigest -Response $ManifestResp
    if ($FetchedDigest -ne $Digest) {
        throw (New-ActionableError `
            -Goal 'Tag the deployed digest with a pinned tag' `
            -Problem "GHCR returned manifest '$FetchedDigest' for digest $Digest; refusing to tag a different image" `
            -Location $CallerName `
            -NextSteps @("Inspect the image: $ImageRef") `
            -AsErrorRecord)
    }
    $ContentType = $ManifestResp.Headers['Content-Type']
    if ($ContentType -is [array]) { $ContentType = $ContentType[0] }

    # -- Read the tag first: a pinned tag never moves (fail closed) --------
    $ExistingDigest = Get-PinnedTagDigest -Package $Package -TagName $TagName -Headers $Headers -CallerName $CallerName
    $Verdict = Get-PinnedImageTagVerdict -Digest $Digest -ExistingDigest $ExistingDigest
    if ($Verdict.Action -eq 'Refuse') {
        throw (New-ActionableError `
            -Goal "Tag $Digest as '$TagName'" `
            -Problem "Refused: $($Verdict.Reason)" `
            -Location $CallerName `
            -NextSteps @("Inspect ghcr.io/${Package}:$TagName; it should never have been written for another digest") `
            -AsErrorRecord)
    }

    if ($Verdict.Action -eq 'Create') {
        try {
            Invoke-RestMethod -Uri "https://ghcr.io/v2/$Package/manifests/$TagName" -Method PUT `
                -Headers @{ Authorization = "Bearer $GhcrToken" } `
                -ContentType $ContentType -Body $ManifestResp.Content -ErrorAction Stop | Out-Null
        }
        catch {
            throw (New-ActionableError `
                -Goal "Tag $Digest as '$TagName'" `
                -Problem "GHCR manifest PUT failed: $($_.Exception.Message)" `
                -Location $CallerName `
                -NextSteps @('Verify GITHUB_TOKEN has write:packages scope', "Package: $Package") `
                -AsErrorRecord)
        }

        # Confirm the tag now names the pinned digest, not just that the PUT returned.
        $Confirmed = Get-PinnedTagDigest -Package $Package -TagName $TagName -Headers $Headers -CallerName $CallerName
        if ($Confirmed -ne $Digest) {
            throw (New-ActionableError `
                -Goal "Tag $Digest as '$TagName'" `
                -Problem "After the PUT, '$TagName' names '$Confirmed', not $Digest" `
                -Location $CallerName `
                -NextSteps @("Inspect ghcr.io/${Package}:$TagName") `
                -AsErrorRecord)
        }
    }

    Write-Verbose "$($Verdict.Action): '$TagName' names $Digest."
    [PSCustomObject]@{
        Action    = $Verdict.Action
        Tag       = $TagName
        Digest    = $Digest
        Image     = $ImageRef
        Package   = $Package
        Timestamp = (Get-Date).ToString('o')
    }
}
