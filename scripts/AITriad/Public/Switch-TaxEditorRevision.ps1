# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Switch-TaxEditorRevision {
    <#
    .SYNOPSIS
        Shifts ACA traffic to a specific or previous revision (T1 rollback).
    .DESCRIPTION
        Moves 100% traffic to the target revision, deactivates the previously
        active revision, then runs Test-TaxEditorHealth to verify. Supports
        -WhatIf/-Confirm for safe operation.
    .PARAMETER Revision
        The exact revision name to switch to.
    .PARAMETER Previous
        Switch to the most recent non-active revision (one-command rollback).
    .PARAMETER ResourceGroup
        Azure resource group name. Default: ai-triad.
    .PARAMETER AppName
        Container App name. Default: taxonomy-editor.
    .PARAMETER BaseUrl
        URL for post-switch health check. Default: production.
    .PARAMETER SkipHealthCheck
        Skip the post-switch health check.
    .EXAMPLE
        Switch-TaxEditorRevision -Previous
    .EXAMPLE
        Switch-TaxEditorRevision -Revision 'taxonomy-editor--deploy-abc1234'
    .EXAMPLE
        Switch-TaxEditorRevision -Previous -WhatIf
    .LINK
        Show-AITriadHelp
    .LINK
        Deploy-TaxEditorImage
    .LINK
        Deploy-TaxEditorInfra
    .LINK
        Get-TaxEditorImage
    .LINK
        Get-TaxEditorRevision
    .LINK
        Test-TaxEditorInfra
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High',
                   DefaultParameterSetName = 'ByName')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'ByName', Position = 0)]
        [string]$Revision,

        [Parameter(Mandatory, ParameterSetName = 'Previous')]
        [switch]$Previous,

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

    # ── Validate az CLI ──────────────────────────────────────────────────
    $AzCmd = Get-Command az -ErrorAction SilentlyContinue
    if (-not $AzCmd) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Switch ACA revision' `
            -Problem 'Azure CLI (az) not found on PATH' `
            -Location 'Switch-TaxEditorRevision' `
            -NextSteps @('Install Azure CLI: https://aka.ms/installazurecli'))
    }

    $AccountJson = & az account show --output json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $AccountJson) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Switch ACA revision' `
            -Problem 'Azure CLI is not logged in' `
            -Location 'Switch-TaxEditorRevision' `
            -NextSteps @('Run: az login', 'Verify subscription: az account show'))
    }

    # ── Get current revisions ────────────────────────────────────────────
    $Revisions = @(Get-TaxEditorRevision -ResourceGroup $ResourceGroup -AppName $AppName)

    if ($Revisions.Count -eq 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Switch ACA revision' `
            -Problem "No revisions found for '$AppName' in '$ResourceGroup'" `
            -Location 'Switch-TaxEditorRevision' `
            -NextSteps @("Verify app exists: az containerapp show -g $ResourceGroup -n $AppName"))
    }

    $CurrentActive = @($Revisions | Where-Object { $_.Active })

    # ── Resolve target revision ──────────────────────────────────────────
    $TargetName = $null

    if ($Previous) {
        $Inactive = @($Revisions | Where-Object { -not $_.Active } |
            Sort-Object { $_.CreatedAt } -Descending)

        if ($Inactive.Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Roll back to previous revision' `
                -Problem 'No inactive revisions found — nothing to roll back to' `
                -Location 'Switch-TaxEditorRevision' `
                -NextSteps @('Use Get-TaxEditorRevision to inspect available revisions',
                             'There may only be one revision deployed'))
        }
        $TargetName = $Inactive[0].Name
    }
    else {
        $Match = @($Revisions | Where-Object { $_.Name -eq $Revision })
        if ($Match.Count -eq 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Switch to revision '$Revision'" `
                -Problem "Revision '$Revision' not found" `
                -Location 'Switch-TaxEditorRevision' `
                -NextSteps @('Run Get-TaxEditorRevision to list available revisions',
                             'Verify the revision name is spelled correctly'))
        }
        $TargetName = $Revision
    }

    # ── Build action description ─────────────────────────────────────────
    $CurrentNames = if ($CurrentActive.Count -gt 0) { ($CurrentActive | ForEach-Object { $_.Name }) -join ', ' } else { '(none)' }
    $ActionDesc = "Shift 100% traffic to '$TargetName' (currently active: $CurrentNames)"

    if (-not $PSCmdlet.ShouldProcess($AppName, $ActionDesc)) {
        return
    }

    # ── Activate target revision if not running ──────────────────────────
    $TargetRev = @($Revisions | Where-Object { $_.Name -eq $TargetName })
    if ($TargetRev.Count -gt 0 -and $TargetRev[0].RunningState -ne 'Running') {
        Write-Verbose "Activating revision '$TargetName'..."
        & az containerapp revision activate -g $ResourceGroup -n $AppName --revision $TargetName 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Activate revision '$TargetName'" `
                -Problem "az containerapp revision activate failed (exit code $LASTEXITCODE)" `
                -Location 'Switch-TaxEditorRevision' `
                -NextSteps @("Check revision state: az containerapp revision show -g $ResourceGroup -n $AppName --revision $TargetName"))
        }
    }

    # ── Shift traffic ────────────────────────────────────────────────────
    Write-Verbose "Shifting 100% traffic to '$TargetName'..."
    & az containerapp ingress traffic set -g $ResourceGroup -n $AppName `
        --revision-weight "${TargetName}=100" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal "Shift traffic to '$TargetName'" `
            -Problem "az containerapp ingress traffic set failed (exit code $LASTEXITCODE)" `
            -Location 'Switch-TaxEditorRevision' `
            -NextSteps @("Verify revision is active: az containerapp revision show -g $ResourceGroup -n $AppName --revision $TargetName",
                         "Check ingress config: az containerapp ingress show -g $ResourceGroup -n $AppName"))
    }

    # ── Deactivate old active revisions ──────────────────────────────────
    foreach ($Old in $CurrentActive) {
        if ($Old.Name -ne $TargetName) {
            Write-Verbose "Deactivating previous revision '$($Old.Name)'..."
            & az containerapp revision deactivate -g $ResourceGroup -n $AppName `
                --revision $Old.Name 2>$null
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Failed to deactivate revision '$($Old.Name)' — traffic already shifted, manual cleanup needed."
            }
        }
    }

    # ── Post-switch health check ─────────────────────────────────────────
    if (-not $SkipHealthCheck) {
        Write-Verbose 'Running post-switch health check...'
        $Health = Test-TaxEditorHealth -BaseUrl $BaseUrl
        if (-not $Health.Healthy) {
            Write-Warning "Post-switch health check FAILED — the target revision may not be healthy. Run Test-TaxEditorHealth for details."
        }
        else {
            Write-Verbose "Post-switch health check passed (avg $($Health.AverageMs)ms)."
        }
    }

    [PSCustomObject]@{
        Action           = 'RevisionSwitch'
        TargetRevision   = $TargetName
        PreviousRevision = $CurrentNames
        AppName          = $AppName
        ResourceGroup    = $ResourceGroup
        HealthCheck      = if ($SkipHealthCheck) { 'Skipped' } elseif ($Health.Healthy) { 'Passed' } else { 'Failed' }
        Timestamp        = (Get-Date).ToString('o')
    }
}
