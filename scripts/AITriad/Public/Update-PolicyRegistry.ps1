# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-PolicyRegistry {
    <#
    .SYNOPSIS
        Rebuild and validate the policy action registry from taxonomy files.
    .DESCRIPTION
        Scans all POV and cross-cutting taxonomy files, collects every
        policy_actions entry, and rebuilds policy_actions.json.

        Detects and reports:
        - Orphaned policies (in registry but not referenced by any node)
        - Unregistered policies (referenced by nodes but missing from registry)
        - Stale member_count or source_povs fields

        Use -Fix to automatically repair issues (remove orphans, assign IDs
        to unregistered entries, update counts).

        This is the one registration entry point for every policy_actions writer (t/4004).
        Invoke-AttributeExtraction and Find-PolicyAction call it with -NodeId after their
        own writes, so IDs are minted by one implementation (Private/PolicyRegistryCore.ps1).
    .PARAMETER Fix
        Automatically fix detected issues.
    .PARAMETER PassThru
        Return a summary object.
    .PARAMETER NodeId
        Node-scoped mode (t/4004). Register only these nodes' policy_actions:
        mint IDs for their unregistered actions, re-add registry entries only for IDs
        they reference, and recount only the IDs in -PriorPolicyIds plus the IDs on
        these nodes now. Orphans are reported but never removed in this mode, so a
        scoped call never edits policies unrelated to the nodes just written.
    .PARAMETER PriorPolicyIds
        With -NodeId: the policy IDs the target nodes held BEFORE the caller's write.
        Recounting over these as well lets a dropped ID's member_count go down.
    .EXAMPLE
        Update-PolicyRegistry
    .EXAMPLE
        Update-PolicyRegistry -Fix
    .EXAMPLE
        Update-PolicyRegistry -Fix -NodeId skp-beliefs-313, skp-beliefs-314 -PriorPolicyIds pol-041
    .LINK
        Show-AITriadHelp
    .LINK
        Find-PolicyAction
    .LINK
        Get-Policy
    .LINK
        Invoke-PolicyRefinement
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [switch]$Fix,
        [switch]$PassThru,
        [string[]]$NodeId,
        [AllowEmptyCollection()]
        [string[]]$PriorPolicyIds = @()
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # t/4028: -Fix holds an advisory lock (policy_actions.lock beside the registry) from the registry
    # read to the registry write, so a concurrent -Fix cannot mint between our uniqueness check and
    # our write. Report-only runs write nothing and take no lock.
    $LockPath = Join-Path (Get-TaxonomyDir) 'policy_actions.lock'
    # t/4193: the lock object goes to the body, which checks ownership right before each final write.
    $Lock = if ($Fix) { Enter-PolicyRegistryLock -LockPath $LockPath } else { $null }
    try {
        Invoke-PolicyRegistryUpdate @PSBoundParameters -Lock $Lock
    }
    finally {
        Exit-GroundingLock -Lock $Lock
    }
}
