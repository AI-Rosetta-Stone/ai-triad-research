# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-TaxEditorKnownGood {
    <#
    .SYNOPSIS
        Tags the current production image as known-good in GHCR.
    .DESCRIPTION
        Queries ACA for the active revision's image, then moves the
        'known-good' tag in GHCR to that image via the OCI Distribution API.
        Maintains the exactly-one invariant: only one image carries the
        known-good tag at any time. Supports -WhatIf/-Confirm.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER AppName
        Container App name. Default: taxonomy-editor.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .EXAMPLE
        Set-TaxEditorKnownGood
    .EXAMPLE
        Set-TaxEditorKnownGood -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor'
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Set-TaxEditorKnownGood'

    # ── Get active revision's image tag ──────────────────────────────────
    $Revisions = @(Get-TaxEditorRevision -ResourceGroup $ResourceGroup -AppName $AppName)
    $Active = @($Revisions | Where-Object { $_.Active })

    if (@($Active).Count -eq 0) {
        throw (New-ActionableError `
            -Goal 'Tag production image as known-good' `
            -Problem 'No active revision found — cannot determine production image' `
            -Location $CallerName `
            -NextSteps @('Run Get-TaxEditorRevision to inspect current state',
                         'Deploy an image first with Deploy-TaxEditorImage'))
    }

    $ImageRef = $Active[0].ImageTag
    if (-not $ImageRef -or $ImageRef -notmatch ':') {
        throw (New-ActionableError `
            -Goal 'Tag production image as known-good' `
            -Problem "Active revision image ref is missing or has no tag: '$ImageRef'" `
            -Location $CallerName `
            -NextSteps @('The active revision may be deployed by digest — tag it first'))
    }

    $CurrentTag = ($ImageRef -split ':')[-1]

    # ── Find previous known-good (for reporting) ─────────────────────────
    $PreviousKnownGood = '(none)'
    try {
        $Images = @(Get-TaxEditorImage -Last 100 -Package $Package)
        $KnownGoodImages = @($Images | Where-Object { $_.IsKnownGood })
        if (@($KnownGoodImages).Count -gt 0) {
            $OtherTags = @($KnownGoodImages[0].Tags | Where-Object { $_ -ne 'known-good' })
            if (@($OtherTags).Count -gt 0) {
                $PreviousKnownGood = $OtherTags[0]
            }
            else {
                $PreviousKnownGood = $KnownGoodImages[0].Digest.Substring(0, [Math]::Min(19, $KnownGoodImages[0].Digest.Length))
            }
        }
    }
    catch {
        Write-Verbose "Could not determine previous known-good: $($_.Exception.Message)"
    }

    # ── WhatIf / Confirm gate ────────────────────────────────────────────
    $WhatIfMsg = "Tag image '${ImageRef}' as known-good"
    if ($PreviousKnownGood -ne '(none)') {
        $WhatIfMsg += " (replacing previous: $PreviousKnownGood)"
    }
    if (-not $PSCmdlet.ShouldProcess("ghcr.io/$Package", $WhatIfMsg)) {
        return
    }

    # ── Get GHCR auth token ──────────────────────────────────────────────
    $GhcrToken = Get-GhcrAuthToken -Package $Package -Scope 'pull,push' -CallerName $CallerName

    # ── Get manifest for current tag ─────────────────────────────────────
    $AcceptTypes = @(
        'application/vnd.oci.image.index.v1+json'
        'application/vnd.docker.distribution.manifest.v2+json'
        'application/vnd.docker.distribution.manifest.list.v2+json'
    ) -join ', '

    try {
        $ManifestResp = Invoke-WebRequest `
            -Uri "https://ghcr.io/v2/$Package/manifests/$CurrentTag" `
            -Headers @{ Authorization = "Bearer $GhcrToken"; Accept = $AcceptTypes } `
            -ErrorAction Stop
    }
    catch {
        throw (New-ActionableError `
            -Goal "Fetch manifest for tag '$CurrentTag'" `
            -Problem "GHCR manifest GET failed: $($_.Exception.Message)" `
            -Location $CallerName `
            -NextSteps @("Verify image exists: ghcr.io/${Package}:${CurrentTag}",
                         'Check GITHUB_TOKEN has read:packages scope'))
    }

    $ManifestContentType = $ManifestResp.Headers['Content-Type']
    if ($ManifestContentType -is [array]) { $ManifestContentType = $ManifestContentType[0] }
    $ManifestBody = $ManifestResp.Content

    # ── PUT manifest with known-good tag ─────────────────────────────────
    try {
        Invoke-RestMethod `
            -Uri "https://ghcr.io/v2/$Package/manifests/known-good" `
            -Method PUT `
            -Headers @{ Authorization = "Bearer $GhcrToken" } `
            -ContentType $ManifestContentType `
            -Body $ManifestBody `
            -ErrorAction Stop | Out-Null
    }
    catch {
        throw (New-ActionableError `
            -Goal "Tag image as 'known-good'" `
            -Problem "GHCR manifest PUT failed: $($_.Exception.Message)" `
            -Location $CallerName `
            -NextSteps @('Verify GITHUB_TOKEN has write:packages scope',
                         "Package: $Package"))
    }

    Write-Verbose "Tagged '$ImageRef' as known-good."

    # ── Return result ────────────────────────────────────────────────────
    [PSCustomObject]@{
        Action           = 'SetKnownGood'
        Image            = $ImageRef
        Tag              = $CurrentTag
        PreviousKnownGood = $PreviousKnownGood
        Package          = $Package
        Timestamp        = (Get-Date).ToString('o')
    }
}
