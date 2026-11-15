# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# t/4966: pure decision core for Remove-StaleContainerImages. The cmdlet fetches
# versions and manifests; this function decides what may be deleted.

function Get-StaleImageDeletionVerdict {
    <#
    .SYNOPSIS
        Pure. Decides which GHCR package versions a cleanup may delete.
    .DESCRIPTION
        Takes GitHub Packages container versions (id, name = digest,
        updated_at, metadata.container.tags) and returns the delete set.
        No network, no filesystem.

        A version may be deleted only if ALL of these hold:
          1. Its tags property is present and empty. An absent property is
             treated as unknown and kept (fail safe, t/3679#9 section 1).
          2. Its digest is not that of a version carrying a tag that matches
             one of -ProtectedTags (default: known-good and pinned-*). Rule 1
             already implies this; it is checked on its own so that a future
             change to rule 1 cannot delete the rollback target, or a digest
             a deploy pinned (t/121: deploy-azure tags the exact digest it
             pins as pinned-<run>-<attempt>-<hex12>, because a container.yml
             re-run can move sha-<commit> off it).
          3. Its digest is not in -ProtectedDigests. The caller passes the
             child manifests of every tagged image index here. GHCR lists an
             index's platform manifest and attestation manifest as separate
             UNTAGGED versions; deleting them leaves the tagged index (for
             example known-good, or the sha-* digest prod is pinned to)
             pointing at a manifest that no longer exists (t/4966).
          4. It is not among the -KeepLatest most recently updated untagged
             versions.
          5. Its updated_at is older than -Cutoff.
    .PARAMETER Versions
        GitHub Packages API version objects.
    .PARAMETER Cutoff
        Only versions updated before this instant are deletable.
    .PARAMETER KeepLatest
        Always keep this many of the most recently updated untagged versions.
    .PARAMETER ProtectedDigests
        Digests (sha256:...) that must never be deleted.
    .PARAMETER ProtectedTags
        Tags (wildcards allowed, -like) whose versions must never be deleted.
        Default: known-good, pinned-*.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Versions,

        [Parameter(Mandatory)]
        [datetimeoffset]$Cutoff,

        [Parameter()]
        [ValidateRange(0, 100)]
        [int]$KeepLatest = 5,

        [Parameter()]
        [AllowEmptyCollection()]
        [string[]]$ProtectedDigests = @(),

        [Parameter()]
        [AllowEmptyCollection()]
        [string[]]$ProtectedTags = @('known-good', 'pinned-*')
    )

    Set-StrictMode -Version Latest

    $Protected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($D in @($ProtectedDigests)) { if ($D) { [void]$Protected.Add($D) } }

    $HasTagsProperty = {
        param($V)
        $V.PSObject.Properties['metadata'] -and
        $V.metadata.PSObject.Properties['container'] -and
        $V.metadata.container.PSObject.Properties['tags']
    }

    $Untagged = @(
        $Versions | Where-Object {
            (& $HasTagsProperty $_) -and @($_.metadata.container.tags).Count -eq 0
        } | Sort-Object -Property { [datetimeoffset]$_.updated_at } -Descending
    )

    $Candidates = @($Untagged | Select-Object -Skip $KeepLatest | Where-Object {
        [datetimeoffset]$_.updated_at -lt $Cutoff
    })

    # Rule 2, independent of rule 1: the digest of any version carrying a protected tag is protected.
    $IsProtectedTag = {
        param([string]$Tag)
        foreach ($P in @($ProtectedTags)) { if ($P -and $Tag -like $P) { return $true } }
        $false
    }
    foreach ($V in @($Versions)) {
        $Tags = @(Get-GhcrVersionTag -Version $V)
        if (@($Tags | Where-Object { & $IsProtectedTag $_ }).Count -gt 0 -and $V.PSObject.Properties['name']) {
            [void]$Protected.Add([string]$V.name)
        }
    }

    $ToDelete = [System.Collections.Generic.List[object]]::new()
    $Spared   = [System.Collections.Generic.List[object]]::new()
    foreach ($V in $Candidates) {
        $Name = if ($V.PSObject.Properties['name']) { [string]$V.name } else { '' }
        if ($Name -and $Protected.Contains($Name)) {
            $Spared.Add($V)
        }
        else {
            $ToDelete.Add($V)
        }
    }

    [PSCustomObject]@{
        TotalUntagged = $Untagged.Count
        KeptCount     = [Math]::Min($Untagged.Count, $KeepLatest)
        ToDelete      = @($ToDelete)
        Protected     = @($Spared)
    }
}
