# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Save-WsbChanges {
    <#
    .SYNOPSIS
        Clean-tree-guarded write of the WS-B situation/POV changes (t/3015 support helper).
    .DESCRIPTION
        Shared save path for Add-SituationEvidenceLink's Apply and Purge modes. Mirrors the
        Repair-SituationReciprocity write contract exactly:
          - BLOCK-tier: pre-flight every target through Assert-CleanDataTree and abort atomically
            (write nothing) if ANY is already dirty — there is no -AllowDirty.
          - Writes via Write-PovTaxonomyFile -RequireCleanTree: canonical TS format through Node (t/4356).
          - Honors -WhatIf / -DryRun; never commits or pushes.
        Returns the list of file paths written (empty on dry-run / no-op).
    .OUTPUTS
        [string[]] paths written.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [switch]$SitDirty,
        [Parameter(Mandatory)][AllowNull()]$DirtyPovKeys,
        [Parameter(Mandatory)]$SitData,
        [Parameter(Mandatory)][string]$SitPath,
        [Parameter(Mandatory)]$PovFiles,
        [switch]$DryRun,
        [Parameter(Mandatory)]$ShouldProcessCmdlet,
        [Parameter(Mandatory)][string]$ActionLabel
    )

    Set-StrictMode -Version Latest

    $written  = [System.Collections.Generic.List[string]]::new()
    $povDirty = @(if ($null -ne $DirtyPovKeys) { $DirtyPovKeys } else { @() })
    $sitCount = if ($SitDirty) { 1 } else { 0 }
    $fileCount = $sitCount + $povDirty.Count

    if (-not $SitDirty -and $povDirty.Count -eq 0) {
        Write-Host '  Nothing to write.' -ForegroundColor Green
        return @()
    }
    if ($DryRun) {
        Write-Host "  DRY RUN — no writes. Would update $fileCount file(s)." -ForegroundColor Yellow
        return @()
    }

    # Pre-flight: require a CLEAN tree for EVERY target before writing any (atomic abort).
    $Targets = [System.Collections.Generic.List[string]]::new()
    if ($SitDirty) { $Targets.Add($SitPath) }
    foreach ($k in $povDirty) { $Targets.Add($PovFiles[$k].Path) }

    $DirtyTargets = @()
    if (Get-Command Assert-CleanDataTree -ErrorAction SilentlyContinue) {
        foreach ($t in $Targets) {
            try { Assert-CleanDataTree -Path $t } catch { $DirtyTargets += (Split-Path -Leaf $t) }
        }
    }
    if ($DirtyTargets.Count -gt 0) {
        New-ActionableError `
            -Goal 'Commit situation evidence links' `
            -Problem "target file(s) already have uncommitted changes: $($DirtyTargets -join ', '). A whole-file rewrite would sweep that concurrent state into your commit (situations.json is BLOCK-tier); nothing was written." `
            -Location 'Add-SituationEvidenceLink' `
            -NextSteps 'Commit or stash the working-tree changes to these files first (clean-tree-required), then re-run. Use -DryRun to preview without writing.' `
            -Throw
    }

    if ($SitDirty) {
        if ($ShouldProcessCmdlet.ShouldProcess($SitPath, $ActionLabel)) {
            Write-PovTaxonomyFile -Path $SitPath -Data $SitData -RequireCleanTree
            $written.Add($SitPath)
            Write-Host "  Wrote $(Split-Path -Leaf $SitPath)" -ForegroundColor Green
        }
    }
    foreach ($k in $povDirty) {
        $entry = $PovFiles[$k]
        if ($ShouldProcessCmdlet.ShouldProcess($entry.Path, $ActionLabel)) {
            Write-PovTaxonomyFile -Path $entry.Path -Data $entry.Data -RequireCleanTree
            $written.Add($entry.Path)
            Write-Host "  Wrote $(Split-Path -Leaf $entry.Path)" -ForegroundColor Green
        }
    }
    Write-Host ''
    Write-Host '  Written. Review the diff and push ai-triad-data (this cmdlet does not commit/push).' -ForegroundColor Cyan

    return @($written)
}
