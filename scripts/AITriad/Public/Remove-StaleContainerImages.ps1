# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Remove-StaleContainerImages {
    <#
    .SYNOPSIS
        Deletes untagged GHCR container image versions older than a cutoff, keeping N most recent.
    .DESCRIPTION
        Consolidates the paginate→filter→delete pattern hand-rolled in
        `.github/workflows/ghcr-cleanup.yml` (t/1492). Paginates the GitHub
        Packages API for a container package, filters to untagged versions
        older than the cutoff, and deletes all but the N most recent.

        Supports -WhatIf and -Confirm — the delete step is guarded by
        ShouldProcess, so `-WhatIf` lists exactly what would be deleted
        without touching the registry.

        Returns a StaleImageCleanupResult with kept/deleted counts, the
        list of deleted version IDs, and any per-version failure messages.
    .PARAMETER Owner
        GitHub owner (user or org) that owns the package. Defaults to the
        GHCR_OWNER env var, then GITHUB_REPOSITORY_OWNER, then 'ai-rosetta-stone'.
    .PARAMETER Package
        Container package name (e.g. 'taxonomy-editor').
    .PARAMETER OlderThanDays
        Only delete versions whose updated_at is older than this many days.
        Default: 30.
    .PARAMETER KeepLatest
        Always keep the N most recently updated untagged versions,
        regardless of age. Default: 5.
    .PARAMETER MaxPages
        Safety cap on pagination. Default: 10 (up to 1000 versions).
    .EXAMPLE
        Remove-StaleContainerImages -Package taxonomy-editor -WhatIf
    .EXAMPLE
        Remove-StaleContainerImages -Package ai-triad-base -KeepLatest 10 -OlderThanDays 14
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AzureHealth
    .LINK
        Get-ContainerAppRevision
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Test-TaxEditorInfra
    .LINK
        Deploy-TaxEditorInfra
    #>
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
    param(
        [Parameter()]
        [string]$Owner,

        [Parameter(Mandatory)]
        [string]$Package,

        [Parameter()]
        [ValidateRange(0, 3650)]
        [int]$OlderThanDays = 30,

        [Parameter()]
        [ValidateRange(0, 100)]
        [int]$KeepLatest = 5,

        [Parameter()]
        [ValidateRange(1, 50)]
        [int]$MaxPages = 10
    )

    Set-StrictMode -Version Latest

    if (-not $Owner) {
        $Owner = if ($env:GHCR_OWNER) { $env:GHCR_OWNER }
                 elseif ($env:GITHUB_REPOSITORY_OWNER) { $env:GITHUB_REPOSITORY_OWNER }
                 else { 'ai-rosetta-stone' }
    }

    $Cutoff = (Get-Date).ToUniversalTime().AddDays(-$OlderThanDays)
    Write-Verbose "Owner=$Owner Package=$Package OlderThanDays=$OlderThanDays KeepLatest=$KeepLatest Cutoff=$($Cutoff.ToString('o'))"

    # ── Paginate versions ────────────────────────────────────────────────
    $AllVersions = [System.Collections.Generic.List[object]]::new()
    for ($Page = 1; $Page -le $MaxPages; $Page++) {
        $Endpoint = "/orgs/$Owner/packages/container/$Package/versions?per_page=100&page=$Page"
        $Batch = $null
        try {
            $Batch = Invoke-GitHubApi -Endpoint $Endpoint -Method 'GET' -CallerName 'Remove-StaleContainerImages'
        } catch {
            # Missing package → nothing to do (matches workflow's early-exit behavior).
            if ($_.Exception.Message -match 'Resource not found') {
                Write-Verbose "Package '$Package' not found under owner '$Owner' — nothing to clean up"
                $Result = [StaleImageCleanupResult]::new()
                $Result.Package         = $Package
                $Result.Owner           = $Owner
                $Result.TotalUntagged   = 0
                $Result.KeptCount       = 0
                $Result.DeletedCount    = 0
                $Result.DeletedIds      = @()
                $Result.Failures        = @()
                $Result.CutoffUtc       = $Cutoff.ToString('o')
                return $Result
            }
            throw
        }
        if (-not $Batch) { break }
        $BatchArray = @($Batch)
        foreach ($v in $BatchArray) { $AllVersions.Add($v) }
        if ($BatchArray.Count -lt 100) { break }  # last page
    }

    # ── Filter to untagged, sort newest first ────────────────────────────
    # DEPLOY-BY-DIGEST COUPLING (t/3679 condition 1) — SYNC WITH the per-SHA tag block in
    # .github/workflows/container.yml. This filter deletes ONLY untagged versions (tags.Count -eq 0);
    # a TAGGED version is never a candidate. That is the load-bearing invariant behind deploy-by-digest:
    # container.yml pushes a PERMANENT `sha-<commit>` tag for every built image, so a digest a deploy has
    # pinned stays TAGGED -> PRESERVED here -> pullable on a pod recycle indefinitely (the t/3679#8 SO
    # finding-1 outage-preventer; also why t/3756 rollback anchors survive going forward). The predicate
    # fails SAFE: a version whose `tags` property is ABSENT is excluded (all three PSObject.Properties
    # guards must hold), not swept in — verified t/3679#9 §1. TRAP (t/3679#9 §4): GHCR also lists
    # `sha256-<digest>` COSIGN/attestation versions; those carry that tag so they are `tags.Count -ne 0`
    # and are likewise preserved — do NOT special-case them here, and do not mistake them for per-SHA
    # image tags. Consequence ACCEPTED: permanent sha- tags accumulate (never pruned by this cmdlet) —
    # bounded-retention of old sha- tags is a future decision, not this change.
    $Untagged = @(
        $AllVersions | Where-Object {
            $_.PSObject.Properties['metadata'] -and
            $_.metadata.PSObject.Properties['container'] -and
            $_.metadata.container.PSObject.Properties['tags'] -and
            @($_.metadata.container.tags).Count -eq 0
        } | Sort-Object -Property updated_at -Descending
    )

    $TotalUntagged = $Untagged.Count
    Write-Verbose "Untagged versions found: $TotalUntagged"

    # ── Compute delete set ───────────────────────────────────────────────
    $ToDelete = @()
    if ($TotalUntagged -gt $KeepLatest) {
        $Candidates = $Untagged | Select-Object -Skip $KeepLatest
        $ToDelete = @(
            $Candidates | Where-Object {
                ([datetime]$_.updated_at).ToUniversalTime() -lt $Cutoff
            }
        )
    }

    Write-Verbose "Versions to delete: $($ToDelete.Count)"

    # ── Delete (guarded by ShouldProcess) ────────────────────────────────
    $DeletedIds = [System.Collections.Generic.List[long]]::new()
    $Failures   = [System.Collections.Generic.List[string]]::new()
    foreach ($v in $ToDelete) {
        $Target = "version $($v.id) (updated $($v.updated_at))"
        if ($PSCmdlet.ShouldProcess($Target, "Delete untagged $Package")) {
            try {
                $null = Invoke-GitHubApi `
                    -Endpoint "/orgs/$Owner/packages/container/$Package/versions/$($v.id)" `
                    -Method DELETE `
                    -CallerName 'Remove-StaleContainerImages'
                $DeletedIds.Add([long]$v.id)
            } catch {
                $Failures.Add("$($v.id): $($_.Exception.Message)")
                Write-Warning "Failed to delete version $($v.id): $($_.Exception.Message)"
            }
        }
    }

    $Result = [StaleImageCleanupResult]::new()
    $Result.Package         = $Package
    $Result.Owner           = $Owner
    $Result.TotalUntagged   = $TotalUntagged
    $Result.KeptCount       = [Math]::Min($TotalUntagged, $KeepLatest)
    $Result.DeletedCount    = $DeletedIds.Count
    $Result.DeletedIds      = @($DeletedIds)
    $Result.Failures        = @($Failures)
    $Result.CutoffUtc       = $Cutoff.ToString('o')
    $Result
}
