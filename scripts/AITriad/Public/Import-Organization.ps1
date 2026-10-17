# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Import-Organization {
    <#
    .SYNOPSIS
        Create or update an organization record in organizations.json.
    .DESCRIPTION
        Adds a new organization if -Id does not exist, otherwise updates the
        existing record. Runs Test-OrganizationIntegrity after the write and
        rolls back if the integrity check fails.

        Writes are atomic: staged to a temp file, then File.Move'd over the
        target, so a mid-write crash leaves the previous file intact.

        Invalidates the module-scope cache so subsequent reads see the change.
    .PARAMETER Id
        Organization id (org-NNN). Must match ^org-\d{3,}$.
    .PARAMETER Name
        Organization full name.
    .PARAMETER Type
        Organization type enum.
    .PARAMETER InputObject
        Alternative: supply a full pre-built hashtable or PSCustomObject that
        will be spliced into the record. Fields override the individual
        parameters above.
    .PARAMETER WhatIf
        Show the planned write without touching the file.
    .OUTPUTS
        [Organization]
    .EXAMPLE
        Import-Organization -Id org-026 -Name 'New Org' -Type advocacy
    .EXAMPLE
        $rec = @{ id = 'org-027'; name = 'X'; type = 'academic'; pov_alignment = @{ safetyist = @{ score = 0.5; rationale = 'r' } } }
        Import-Organization -InputObject $rec
    .LINK
        Show-AITriadHelp
    .LINK
        Get-Organization
    .LINK
        Find-OrganizationByPOV
    .LINK
        Find-OrganizationByTopic
    .LINK
        Get-OrganizationStakeholders
    .LINK
        Compare-OrganizationPositions
    #>
    [CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Fields')]
    [OutputType('Organization')]
    param(
        [Parameter(Mandatory, ParameterSetName='Fields')]
        [ValidatePattern('^org-\d{3,}$')]
        [string]$Id,

        [Parameter(Mandatory, ParameterSetName='Fields')]
        [string]$Name,

        [Parameter(Mandatory, ParameterSetName='Fields')]
        [ValidateSet('think_tank','advocacy','regulatory','academic','corporate','intergovernmental','civil_society','standards_body','research_lab')]
        [string]$Type,

        [Parameter(ParameterSetName='Fields')]
        [string]$ShortName = '',

        [Parameter(ParameterSetName='Fields')]
        [string]$Description = '',

        [Parameter(ParameterSetName='Fields')]
        [string]$Url = '',

        [Parameter(Mandatory, ParameterSetName='InputObject')]
        [object]$InputObject
    )

    Set-StrictMode -Version Latest

    $path = Get-OrganizationsFilePath
    $store = Get-OrganizationsStore -Force

    # Build the incoming record
    if ($PSCmdlet.ParameterSetName -eq 'InputObject') {
        $incoming = $InputObject
        if (-not $incoming.PSObject.Properties['id']) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Import organization' `
                -Problem '-InputObject is missing required field: id' `
                -Location 'Import-Organization' `
                -NextSteps @('Add id = "org-NNN" to the input record'))
        }
        $incomingId = [string]$incoming.id
    } else {
        $now = (Get-Date).ToString('yyyy-MM-dd')
        $incoming = [PSCustomObject]@{
            id            = $Id
            name          = $Name
            short_name    = $ShortName
            type          = $Type
            description   = $Description
            url           = $Url
            status        = 'active'
            pov_alignment = [PSCustomObject]@{}
            topic_engagement  = @()
            policy_engagement = @()
            key_figures       = @()
            external_links    = @()
            source_refs       = @()
            tags              = @()
            created_at        = $now
            last_modified     = $now
        }
        $incomingId = $Id
    }

    # Upsert
    if ($store.PSObject.Properties['organizations']) {
        $existing = @($store.organizations)
    } else {
        $existing = @()
    }
    $index = -1
    for ($i = 0; $i -lt @($existing).Count; $i++) {
        $rid = if ($existing[$i].PSObject.Properties['id']) { [string]$existing[$i].id } else { '' }
        if ($rid -eq $incomingId) { $index = $i; break }
    }
    if ($index -ge 0) {
        # t/1555 — preserve/refresh assessed_at on pov_alignment across upserts.
        # Rule: if pov_alignment scores/rationales changed, stamp today; else
        # carry over the existing assessed_at so unrelated updates don't churn
        # the staleness signal.
        $incoming = Set-OrgAssessedAt -Existing $existing[$index] -Incoming $incoming
        # t/1560 — preserve pov_alignment_derived across partial upserts.
        # A caller who edits an unrelated field without carrying forward the
        # derived block would otherwise wipe it (this cmdlet replaces the
        # whole record). Only Invoke-OrgDerivedCampScores rewrites the block.
        $incoming = Set-OrgPreserveDerived -Existing $existing[$index] -Incoming $incoming
        $existing[$index] = $incoming
        Write-Verbose "Updating existing organization: $incomingId"
    } else {
        # Create — carry through whatever the caller supplied (pov_alignment
        # may already have assessed_at from an external source; if not, they
        # can add one on a later upsert). Nothing stamped implicitly.
        $existing += $incoming
        Write-Verbose "Adding new organization: $incomingId"
    }

    if ($store.PSObject.Properties['organizations']) {
        $store.organizations = @($existing)
    } else {
        Add-Member -InputObject $store -MemberType NoteProperty -Name 'organizations' -Value (@($existing))
    }
    if ($store.PSObject.Properties['org_count']) {
        $store.org_count = @($existing).Count
    } else {
        Add-Member -InputObject $store -MemberType NoteProperty -Name 'org_count' -Value (@($existing).Count)
    }
    $stamp = (Get-Date).ToString('yyyy-MM-dd')
    if ($store.PSObject.Properties['last_modified']) {
        $store.last_modified = $stamp
    } else {
        Add-Member -InputObject $store -MemberType NoteProperty -Name 'last_modified' -Value $stamp
    }

    if (-not $PSCmdlet.ShouldProcess($path, "Upsert organization $incomingId")) {
        return (ConvertTo-OrganizationObject -Raw $incoming)
    }

    # Atomic write: temp + File.Move
    Assert-DataWriteAllowed -Path $path  # t/2902
    $temp = "$path.tmp"
    $json = $store | ConvertTo-Json -Depth 12
    try {
        Set-Content -Path $temp -Value $json -Encoding utf8NoBOM
        [System.IO.File]::Move($temp, $path, $true)
    } catch {
        if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Write organizations.json' `
            -Problem "Failed to write registry: $($_.Exception.Message)" `
            -Location 'Import-Organization' `
            -NextSteps @(
                "Verify write access to $path",
                'Check disk space',
                'Restore from git if the file is corrupted'
            ))
    }

    Clear-OrganizationsCache

    # Post-write validation — rollback recommendation only, we don't auto-revert
    # since git is the safety net for data-repo files.
    $report = Test-OrganizationIntegrity
    if (-not $report.Pass) {
        Write-Warning "Post-write integrity check FAILED: $($report.Errors) errors, $($report.Warnings) warnings. Review with: (Test-OrganizationIntegrity).Issues"
    }

    return (ConvertTo-OrganizationObject -Raw $incoming)
}
