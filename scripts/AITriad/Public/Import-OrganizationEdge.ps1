# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Import-OrganizationEdge {
    <#
    .SYNOPSIS
        Create or update an organization actor-relationship edge in organization_edges.json.
    .DESCRIPTION
        Upserts by composite key (source, target, type). Adds a new edge if the triple
        doesn't exist, otherwise updates the existing record's rationale/source_refs/status/
        discovered_at. Type is validated via Resolve-OrganizationEdgeType — unknown types
        are rejected before any write.

        Post-write, runs Test-OrganizationEdgeIntegrity and emits a warning (not an
        exception) if it fails — mirroring Import-Organization's rollback signal
        pattern. Git is the safety net for data-repo files.

        Writes are atomic: staged to a temp file, then File.Move'd over the target.

        Invalidates the module-scope cache so subsequent reads see the change.
    .PARAMETER Source
        The source org id (org-NNN). Must match ^org-\d{3,}$.
    .PARAMETER Target
        The target id — org-*, sit-*, pol-*, src-*, or POV BDI node id.
        Family must match the -Type per the HLD; integrity check confirms.
    .PARAMETER Type
        Edge type — any casing; validated + normalized via Resolve-OrganizationEdgeType.
    .PARAMETER Rationale
        Free-text justification for the relationship.
    .PARAMETER SourceRefs
        Optional citation/source ids supporting the relationship.
    .PARAMETER Status
        approved (default) | proposed | disputed | rejected.
    .PARAMETER DiscoveredAt
        YYYY-MM-DD. Defaults to today.
    .PARAMETER InputObject
        Alternative: supply a full pre-built hashtable / PSCustomObject with fields
        source, target, type, and optional rationale, source_refs, status, discovered_at.
    .OUTPUTS
        [OrganizationEdge]
    .EXAMPLE
        Import-OrganizationEdge -Source org-001 -Target org-002 -Type COMPETES_WITH -Rationale 'Direct rivals in frontier model training.'
    .EXAMPLE
        Import-OrganizationEdge -InputObject @{ source='org-001'; target='sit-042'; type='ADVOCATES_FOR'; rationale='...' }
    .LINK
        Show-AITriadHelp
    .LINK
        Get-OrganizationEdge
    .LINK
        Get-Organization
    #>
    [CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Fields')]
    [OutputType('OrganizationEdge')]
    param(
        [Parameter(Mandatory, ParameterSetName='Fields')]
        [ValidatePattern('^org-\d{3,}$')]
        [string]$Source,

        [Parameter(Mandatory, ParameterSetName='Fields')]
        [string]$Target,

        [Parameter(Mandatory, ParameterSetName='Fields')]
        [string]$Type,

        [Parameter(ParameterSetName='Fields')]
        [string]$Rationale = '',

        [Parameter(ParameterSetName='Fields')]
        [string[]]$SourceRefs = @(),

        [Parameter(ParameterSetName='Fields')]
        [ValidateSet('approved','proposed','disputed','rejected')]
        [string]$Status = 'approved',

        [Parameter(ParameterSetName='Fields')]
        [string]$DiscoveredAt,

        [Parameter(Mandatory, ParameterSetName='InputObject')]
        [object]$InputObject
    )

    Set-StrictMode -Version Latest

    $path = Get-OrganizationEdgesFilePath
    $store = Get-OrganizationEdgesStore -Force

    # Build the incoming record
    if ($PSCmdlet.ParameterSetName -eq 'InputObject') {
        foreach ($f in @('source','target','type')) {
            if (-not $InputObject.PSObject.Properties[$f]) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal 'Import organization edge' `
                    -Problem "-InputObject is missing required field: $f" `
                    -Location 'Import-OrganizationEdge' `
                    -NextSteps @("Add $f to the input record"))
            }
        }
        $srcIn  = [string]$InputObject.source
        $tgtIn  = [string]$InputObject.target
        $typeIn = [string]$InputObject.type
        $ratIn  = if ($InputObject.PSObject.Properties['rationale'])   { [string]$InputObject.rationale }   else { '' }
        $refsIn = if ($InputObject.PSObject.Properties['source_refs']) { @($InputObject.source_refs | ForEach-Object { [string]$_ }) } else { @() }
        $statIn = if ($InputObject.PSObject.Properties['status'])      { [string]$InputObject.status }     else { 'approved' }
        $daIn   = if ($InputObject.PSObject.Properties['discovered_at']) { [string]$InputObject.discovered_at } else { (Get-Date).ToString('yyyy-MM-dd') }
    } else {
        $srcIn  = $Source
        $tgtIn  = $Target
        $typeIn = $Type
        $ratIn  = $Rationale
        $refsIn = @($SourceRefs)
        $statIn = $Status
        $daIn   = if ($DiscoveredAt) { $DiscoveredAt } else { (Get-Date).ToString('yyyy-MM-dd') }
    }

    # Validate + normalize the type BEFORE writing. Unknown types are rejected outright —
    # different from the integrity validator (which reports on already-written data).
    $res = Resolve-OrganizationEdgeType -Type $typeIn
    if ($res.Action -ne 'accept') {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Import organization edge' `
            -Problem "type '$typeIn' rejected: $($res.Reason)" `
            -Location 'Import-OrganizationEdge' `
            -NextSteps @(
                'List valid types with: Get-OrganizationEdgeType',
                'Registry lives in scripts/AITriad/Private/Resolve-OrganizationEdgeType.ps1'
            ))
    }
    $typeIn = $res.Type

    # Prevent self-loops early — the integrity check would flag them post-write, but no
    # reason to write them and then complain.
    if ($srcIn -eq $tgtIn) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Import organization edge' `
            -Problem "self-loop rejected: source and target are both '$srcIn'" `
            -Location 'Import-OrganizationEdge' `
            -NextSteps @('Choose a distinct target — actor edges are directed and reflexive edges have no meaning here'))
    }

    # source_refs must be a typed array so ConvertTo-Json preserves the
    # array shape on single-element inputs (t/1553#7 — CL flagged that
    # Stage 0's one-element proposals were being unwrapped to bare strings
    # in the serialized store).
    $incoming = [PSCustomObject]@{
        source        = $srcIn
        target        = $tgtIn
        type          = $typeIn
        rationale     = $ratIn
        source_refs   = [string[]]$refsIn
        status        = $statIn
        discovered_at = $daIn
    }

    # Upsert by composite key (source, target, type)
    if ($store.PSObject.Properties['edges']) {
        $existing = @($store.edges)
    } else {
        $existing = @()
    }
    $index = -1
    for ($i = 0; $i -lt @($existing).Count; $i++) {
        $es = if ($existing[$i].PSObject.Properties['source']) { [string]$existing[$i].source } else { '' }
        $et = if ($existing[$i].PSObject.Properties['target']) { [string]$existing[$i].target } else { '' }
        $ey = if ($existing[$i].PSObject.Properties['type'])   { [string]$existing[$i].type }   else { '' }
        if ($es -eq $srcIn -and $et -eq $tgtIn -and $ey.ToUpperInvariant() -eq $typeIn) {
            $index = $i; break
        }
    }
    if ($index -ge 0) {
        $existing[$index] = $incoming
        Write-Verbose "Updating existing organization edge: $srcIn --[$typeIn]--> $tgtIn"
    } else {
        $existing += $incoming
        Write-Verbose "Adding new organization edge: $srcIn --[$typeIn]--> $tgtIn"
    }

    if ($store.PSObject.Properties['edges']) {
        $store.edges = @($existing)
    } else {
        Add-Member -InputObject $store -MemberType NoteProperty -Name 'edges' -Value (@($existing))
    }
    $stamp = (Get-Date).ToString('yyyy-MM-dd')
    if ($store.PSObject.Properties['last_modified']) {
        $store.last_modified = $stamp
    } else {
        Add-Member -InputObject $store -MemberType NoteProperty -Name 'last_modified' -Value $stamp
    }

    if (-not $PSCmdlet.ShouldProcess($path, "Upsert organization edge $srcIn -[$typeIn]-> $tgtIn")) {
        return (ConvertTo-OrganizationEdgeObject -Raw $incoming)
    }

    # Atomic write: temp + File.Move
    Assert-DataWriteAllowed -Path $path  # t/2902
    $temp = "$path.tmp"
    $json = $store | ConvertTo-Json -Depth 8
    try {
        Set-Content -Path $temp -Value $json -Encoding utf8NoBOM
        [System.IO.File]::Move($temp, $path, $true)
    } catch {
        if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Write organization_edges.json' `
            -Problem "Failed to write registry: $($_.Exception.Message)" `
            -Location 'Import-OrganizationEdge' `
            -NextSteps @(
                "Verify write access to $path",
                'Check disk space',
                'Restore from git if the file is corrupted'
            ))
    }

    Clear-OrganizationEdgesCache

    # Post-write validation — warn-only, matches Import-Organization (git is the safety net)
    $report = Test-OrganizationEdgeIntegrity
    if (-not $report.Pass) {
        Write-Warning "Post-write integrity check FAILED: $($report.Errors) errors, $($report.Warnings) warnings. Review with: (Test-OrganizationEdgeIntegrity).Issues"
    }

    return (ConvertTo-OrganizationEdgeObject -Raw $incoming)
}
