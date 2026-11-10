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

        It never deletes a version tagged known-good, nor the child manifests
        (platform and attestation manifests, listed by GHCR as separate
        untagged versions) of any tagged image index. Deleting those would
        leave known-good, or the sha-* digest prod is pinned to, unpullable
        (t/4966). The decision is Get-StaleImageDeletionVerdict (pure). If any
        tagged index's manifest can't be read, nothing is deleted and the
        reason is returned in Failures.

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

    # ── Decide the delete set (pure: Get-StaleImageDeletionVerdict) ──────
    # DEPLOY-BY-DIGEST COUPLING (t/3679 condition 1) — SYNC WITH the per-SHA tag block in
    # .github/workflows/container.yml. Only UNTAGGED versions are candidates; a TAGGED version never
    # is. A version whose `tags` property is ABSENT is kept, not swept in (fail safe, t/3679#9 §1).
    #
    # t/4966: "tagged = preserved" is not enough on its own. container.yml pushes an image INDEX
    # (tagged sha-<commit>) whose platform manifest and buildx attestation manifest GHCR lists as
    # separate UNTAGGED versions; the sigstore referrer index (tagged sha256-<digest>) has an untagged
    # bundle child too. Deleting those children leaves the tagged index pointing at a missing manifest,
    # so known-good, rollback-* and the sha-* digest prod is pinned to would stop pulling. So the
    # children of every tagged version are protected, read from the registry below. If any can't be
    # read, nothing is deleted. Consequence ACCEPTED: permanent sha- tags accumulate (never pruned by
    # this cmdlet); bounded retention of old sha- tags is a future decision.
    $VerdictArgs = @{ Versions = @($AllVersions); Cutoff = [datetimeoffset]$Cutoff; KeepLatest = $KeepLatest }
    $Verdict = Get-StaleImageDeletionVerdict @VerdictArgs
    $Failures = [System.Collections.Generic.List[string]]::new()

    $Tagged = @($AllVersions | Where-Object { @(Get-GhcrVersionTag -Version $_).Count -gt 0 })
    if (@($Verdict.ToDelete).Count -gt 0 -and $Tagged.Count -gt 0) {
        $Children = [System.Collections.Generic.List[string]]::new()
        try {
            $PullToken = Get-GhcrAuthToken -Package "$Owner/$Package" -Scope 'pull' -CallerName 'Remove-StaleContainerImages'
            foreach ($T in $Tagged) {
                foreach ($C in @(Get-GhcrManifestChildDigest -Package "$Owner/$Package" -Reference ([string]$T.name) -Token $PullToken)) {
                    $Children.Add($C)
                }
            }
            $Verdict = Get-StaleImageDeletionVerdict @VerdictArgs -ProtectedDigests @($Children)
        }
        catch {
            $Why = "could not read the child manifests of the $($Tagged.Count) tagged version(s), so no version was deleted: $($_.Exception.Message)"
            Write-Warning "Remove-StaleContainerImages: $Why"
            $Failures.Add("protection-unresolved: $Why")
            $Verdict = [PSCustomObject]@{
                TotalUntagged = $Verdict.TotalUntagged
                KeptCount     = $Verdict.KeptCount
                ToDelete      = @()
                Protected     = @($Verdict.ToDelete)
            }
        }
    }

    $ToDelete = @($Verdict.ToDelete)
    Write-Verbose "Untagged versions found: $($Verdict.TotalUntagged); to delete: $($ToDelete.Count); protected: $(@($Verdict.Protected).Count)"

    # ── Delete (guarded by ShouldProcess) ────────────────────────────────
    $DeletedIds = [System.Collections.Generic.List[long]]::new()
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
    $Result.TotalUntagged   = $Verdict.TotalUntagged
    $Result.KeptCount       = $Verdict.KeptCount
    $Result.ProtectedCount  = @($Verdict.Protected).Count
    $Result.DeletedCount    = $DeletedIds.Count
    $Result.DeletedIds      = @($DeletedIds)
    $Result.Failures        = @($Failures)
    $Result.CutoffUtc       = $Cutoff.ToString('o')
    $Result
}
