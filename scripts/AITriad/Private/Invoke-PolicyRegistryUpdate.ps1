# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-PolicyRegistryUpdate {
    <#
    .SYNOPSIS
        The body of Update-PolicyRegistry, moved here unchanged so the public cmdlet can hold the
        t/4028 advisory lock around it with a plain try/finally. See Update-PolicyRegistry for the
        parameters and behaviour. The only addition is the registry-writable preflight before
        Set-PolicyIdsOnNodes (marked t/4028), and the lock-ownership check before each -Fix write
        (marked t/4193).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [switch]$Fix,
        [switch]$PassThru,
        [string[]]$NodeId,
        [AllowEmptyCollection()]
        [string[]]$PriorPolicyIds = @(),
        # The lock object from Enter-PolicyRegistryLock ($null for report-only runs, which never write).
        [AllowNull()][object]$Lock
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir = Get-TaxonomyDir
    $RegistryPath = Join-Path $TaxDir 'policy_actions.json'
    $Scoped = $PSBoundParameters.ContainsKey('NodeId')

    # ── Load existing registry ──
    $Policies = @{}
    $Registry = Read-PolicyRegistryFile -RegistryPath $RegistryPath
    if ($Registry) {
        foreach ($Pol in $Registry.policies) { $Policies[$Pol.id] = $Pol }
        Write-OK "Loaded registry: $($Registry.policies.Count) policies"
    }
    else {
        Write-Info 'No existing registry found — will create new one'
    }
    # Every id already on disk, captured before orphan removal: minting never reuses a just-removed
    # orphan's number, and Assert-PolicyIdsUnminted checks exactly this same taken set.
    $RegistryIdsOnDisk = @($Policies.Keys)

    # ── Scan all taxonomy files and detect issues ──
    $Scan = Get-PolicyReferenceScan -TaxDir $TaxDir
    $Targets = $null
    $Unregistered = @($Scan.Unregistered)
    if ($Scoped) {
        $Targets = [System.Collections.Generic.HashSet[string]]::new([string[]]@($NodeId))
        $Unregistered = @($Unregistered | Where-Object { $Targets.Contains($_.NodeId) })
    }
    $Orphans = @($Policies.Keys | Where-Object { -not $Scan.Referenced.ContainsKey($_) })
    $Missing = @($Scan.Referenced.Keys | Where-Object { -not $Policies.ContainsKey($_) })
    if ($Scoped) {
        $OnTargets = Get-PolicyIdsOnNodes -Referenced $Scan.Referenced -Targets $Targets
        $Missing = @($Missing | Where-Object { $OnTargets -contains $_ })
    }

    Write-PolicyRegistryReport -Referenced $Scan.Referenced -Policies $Policies -Orphans $Orphans -Missing $Missing -Unregistered $Unregistered

    # ── Fix if requested ──
    if ($Fix) {
        Write-Step 'Fixing registry...'

        # Orphan removal is corpus-wide only: a node-scoped call must not delete unrelated policies.
        if (-not $Scoped -and $Orphans.Count -gt 0 -and $PSCmdlet.ShouldProcess("$($Orphans.Count) orphaned policies", 'Remove')) {
            foreach ($Oid in $Orphans) { $Policies.Remove($Oid) }
            Write-OK "Removed $($Orphans.Count) orphaned policies"
        }

        if ($Unregistered.Count -gt 0 -and $PSCmdlet.ShouldProcess("$($Unregistered.Count) unregistered actions", 'Assign IDs')) {
            $Taken = @($RegistryIdsOnDisk) + @($Scan.Referenced.Keys)
            $Minted = New-PolicyRegistryAssignments -Unregistered $Unregistered -Policies $Policies -TakenIds $Taken
            Assert-PolicyIdsUnminted -TaxDir $TaxDir -RegistryPath $RegistryPath -MintedIds @($Minted.Assignments | ForEach-Object { $_.NewId })
            # t/4028 preflight: minting always changes the registry, so apply the registry write's own
            # guard NOW, before any node file is written. policy_actions.json is BLOCK-tier: with an
            # earlier run's change still uncommitted, the registry write would be refused AFTER the
            # node ids had landed, leaving minted ids that no registry entry backs.
            Assert-DataWriteAllowed -Path $RegistryPath
            Assert-GroundingLockHeld -Lock $Lock   # t/4193 TL condition 2: no write once the lock is lost
            Set-PolicyIdsOnNodes -TaxDir $TaxDir -Assignments $Minted.Assignments
        }

        if ($Missing.Count -gt 0 -and $PSCmdlet.ShouldProcess("$($Missing.Count) missing-from-registry ids", 'Re-add to registry')) {
            Add-MissingPolicyEntries -Policies $Policies -Referenced $Scan.Referenced -Missing $Missing
        }

        # ── Recount member_count and source_povs from a fresh scan ──
        $Final = Get-PolicyReferenceScan -TaxDir $TaxDir
        if ($Scoped) {
            $RecountIds = @(@($PriorPolicyIds) + @(Get-PolicyIdsOnNodes -Referenced $Final.Referenced -Targets $Targets) | Sort-Object -Unique)
            Update-PolicyMemberCounts -Policies $Policies -Referenced $Final.Referenced -Ids $RecountIds
        }
        else {
            Update-PolicyMemberCounts -Policies $Policies -Referenced $Final.Referenced
        }

        Assert-GroundingLockHeld -Lock $Lock   # t/4193 TL condition 2
        Save-PolicyRegistry -RegistryPath $RegistryPath -Policies $Policies -Cmdlet $PSCmdlet
    }

    if ($PassThru) {
        [PSCustomObject]@{
            TotalPolicies = $Policies.Count
            Referenced    = $Scan.Referenced.Count
            Orphans       = $Orphans.Count
            Unregistered  = $Unregistered.Count
            Missing       = $Missing.Count
        }
    }
}
