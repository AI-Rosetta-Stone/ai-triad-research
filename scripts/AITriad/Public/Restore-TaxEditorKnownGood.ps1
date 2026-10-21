# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Restore-TaxEditorKnownGood {
    <#
    .SYNOPSIS
        Deploys the known-good image via blue-green flow.
    .DESCRIPTION
        Resolves the image tagged 'known-good' in GHCR, then deploys it
        using the same blue-green flow as Deploy-TaxEditorImage with a
        post-deploy health check and auto-rollback on failure.
        Supports -WhatIf/-Confirm.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .PARAMETER Registry
        Container registry + image path. Default: ghcr.io/ai-rosetta-stone/taxonomy-editor.
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER AppName
        Container App name. Default: taxonomy-editor.
    .PARAMETER BaseUrl
        URL for post-deploy health check. Default: production.
    .PARAMETER SkipHealthCheck
        Skip the post-deploy health check (no auto-rollback).
    .EXAMPLE
        Restore-TaxEditorKnownGood
    .EXAMPLE
        Restore-TaxEditorKnownGood -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Sync-TaxEditorData
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor',

        [Parameter()]
        [string]$Registry = 'ghcr.io/ai-rosetta-stone/taxonomy-editor',

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [switch]$SkipHealthCheck
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Restore-TaxEditorKnownGood'

    # ── Resolve known-good image ─────────────────────────────────────────
    $Images = @(Get-TaxEditorImage -Last 100 -Package $Package)
    $KnownGoodImages = @($Images | Where-Object { $_.IsKnownGood })

    if (@($KnownGoodImages).Count -eq 0) {
        throw (New-ActionableError `
            -Goal 'Restore known-good image' `
            -Problem 'No image tagged known-good found in GHCR' `
            -Location $CallerName `
            -NextSteps @('Run Set-TaxEditorKnownGood to tag an image first',
                         'Run Get-TaxEditorImage to inspect available images') `
            -AsErrorRecord)
    }

    $KgImage = $KnownGoodImages[0]
    $KgDigest = $KgImage.Digest
    $KgOtherTags = @($KgImage.Tags | Where-Object { $_ -ne 'known-good' })
    $KgLabel = if (@($KgOtherTags).Count -gt 0) { $KgOtherTags[0] } else { $KgDigest.Substring(0, [Math]::Min(19, $KgDigest.Length)) }

    # ── WhatIf / Confirm gate ────────────────────────────────────────────
    $WhatIfMsg = "Deploy known-good image '$KgLabel' (digest: $($KgDigest.Substring(0, [Math]::Min(19, $KgDigest.Length)))...) via blue-green flow"
    if (-not $PSCmdlet.ShouldProcess($AppName, $WhatIfMsg)) {
        return
    }

    # ── Deploy via Deploy-TaxEditorImage ─────────────────────────────────
    $DeployParams = @{
        Tag             = 'known-good'
        Registry        = $Registry
        ResourceGroup   = $ResourceGroup
        AppName         = $AppName
        BaseUrl         = $BaseUrl
        Confirm         = $false
    }
    if ($SkipHealthCheck) { $DeployParams['SkipHealthCheck'] = $true }

    $DeployResult = Deploy-TaxEditorImage @DeployParams

    # ── Return enriched result ───────────────────────────────────────────
    [PSCustomObject]@{
        Action           = 'RestoreKnownGood'
        KnownGoodLabel   = $KgLabel
        KnownGoodDigest  = $KgDigest
        Image            = $DeployResult.Image
        NewRevision      = $DeployResult.NewRevision
        PreviousRevision = $DeployResult.PreviousRevision
        HealthCheck      = $DeployResult.HealthCheck
        SkippedDeactivations = if ($DeployResult.PSObject.Properties['SkippedDeactivations']) { @($DeployResult.SkippedDeactivations) } else { @() }
        AppName          = $AppName
        ResourceGroup    = $ResourceGroup
        Timestamp        = (Get-Date).ToString('o')
    }
}
