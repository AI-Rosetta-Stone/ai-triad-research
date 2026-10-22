# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Update-NodeTestingRecord {
    <#
    .SYNOPSIS
        Recomputes tier + sort_key on every node's existing debate-tested
        record under current constant values, without ever touching
        historical fields (Phase 2 of t/1523; ticket t/1579).
    .DESCRIPTION
        Sweeps POV taxonomy files, applies the pure Get-DebateTestedTier
        function against each node's existing `record[]` + `revisions[]`,
        and rewrites ONLY `tier` and `sort_key` when they differ from
        what's currently stored. Everything else in the debate_tested
        block — `record`, `engagements`, `challenges`, `held`, `weakened`,
        `revisions`, `last_tested`, `description_hash` — is historical
        fact and is never rewritten.

        Purpose: when a debate-tested constant changes (e.g. raising
        WELL_TESTED_MIN_CHALLENGES 2 → 3), this cmdlet applies the change
        across all accumulated data in one pass, without re-running any
        debates. The operation is idempotent: run twice, second run
        reports zero changes.

        The pure recompute logic (Get-DebateTestedTier) is a faithful
        port of the TypeScript writer at lib/debate/debateTested.ts.
        AC #10 of t/1579 enforces cross-language consistency via
        tests/fixtures/tier-sort-key-cases.json — both suites consume
        the same fixture so any drift fails both sides.

    .PARAMETER Pov
        Restrict to a single camp (acc / saf / skp). Default: all.
    .PARAMETER NodeId
        Restrict to specific node id(s). Default: every node with a
        debate_tested record.
    .PARAMETER RecomputeOnly
        Required for phase-2 write mode — the cmdlet's only current
        operation. Present to reserve the parameter name for future
        modes (e.g. `-BackfillDescriptionHash`).
    .OUTPUTS
        [PSCustomObject] per changed node with NodeId, Pov, OldTier,
        NewTier, OldSortKey, NewSortKey. Emits nothing for nodes whose
        tier + sort_key were already up-to-date.
    .EXAMPLE
        Update-NodeTestingRecord -RecomputeOnly -WhatIf
    .EXAMPLE
        Update-NodeTestingRecord -RecomputeOnly -Pov saf
    .LINK
        Get-NodeTestingRecord
    .LINK
        Get-Tax
    .LINK
        Get-TaxonomyHealth
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
    param(
        [Parameter()]
        [ValidateSet('acc', 'saf', 'skp')]
        [string]$Pov,

        [Parameter()]
        [string[]]$NodeId,

        [Parameter(Mandatory)]
        [switch]$RecomputeOnly
    )

    Set-StrictMode -Version Latest

    $povFullByShort = @{ acc = 'accelerationist'; saf = 'safetyist'; skp = 'skeptic' }
    $povFiles = if ($Pov) { @($povFullByShort[$Pov]) } else { @('accelerationist', 'safetyist', 'skeptic') }
    $wantedIds = if ($NodeId -and $NodeId.Count -gt 0) { [System.Collections.Generic.HashSet[string]]::new([string[]]$NodeId, [System.StringComparer]::OrdinalIgnoreCase) } else { $null }

    $taxDir = Get-TaxonomyDir
    $changes = [System.Collections.Generic.List[PSObject]]::new()
    $dirtyFiles = @{}

    foreach ($povName in $povFiles) {
        $filePath = Join-Path $taxDir "$povName.json"
        if (-not (Test-Path $filePath)) {
            Write-Warning "Update-NodeTestingRecord: POV file not found: $filePath — skipping"
            continue
        }
        $store = Read-PovTaxonomyFile -Path $filePath   # shape-preserving read for the canonical write (t/4356)
        if (-not $store.PSObject.Properties['nodes']) {
            Write-Warning "Update-NodeTestingRecord: $filePath has no 'nodes' — skipping"
            continue
        }

        $mutated = $false
        foreach ($node in @($store.nodes)) {
            $nodeIdStr = if ($node.PSObject.Properties['id']) { [string]$node.id } else { $null }
            if (-not $nodeIdStr) { continue }
            if ($wantedIds -and -not $wantedIds.Contains($nodeIdStr)) { continue }

            if (-not $node.PSObject.Properties['graph_attributes']) { continue }
            $ga = $node.graph_attributes
            if ($null -eq $ga -or
                -not $ga.PSObject.Properties['debate_tested'] -or
                $null -eq $ga.debate_tested) { continue }
            $dt = $ga.debate_tested

            # Historical fields required for recompute
            $record    = if ($dt.PSObject.Properties['record'])    { @($dt.record) }    else { @() }
            $revisions = if ($dt.PSObject.Properties['revisions']) { @($dt.revisions) } else { @() }

            $r = Get-DebateTestedTier -Record $record -Revisions $revisions
            $newTier = [string]$r.tier
            $newSort = [double]$r.sort_key

            $oldTier = if ($dt.PSObject.Properties['tier'])     { [string]$dt.tier }        else { '' }
            $oldSort = if ($dt.PSObject.Properties['sort_key']) { [double]$dt.sort_key }    else { 0.0 }

            if ($oldTier -eq $newTier -and $oldSort -eq $newSort) { continue }

            $changes.Add([PSCustomObject]@{
                NodeId     = $nodeIdStr
                Pov        = $povName
                OldTier    = $oldTier
                NewTier    = $newTier
                OldSortKey = $oldSort
                NewSortKey = $newSort
            })

            if ($PSCmdlet.ShouldProcess("$povName/$nodeIdStr", "recompute tier ($oldTier→$newTier), sort_key ($oldSort→$newSort)")) {
                # In-place rewrite of ONLY tier + sort_key.
                if ($dt.PSObject.Properties['tier']) { $dt.tier = $newTier }
                else { Add-Member -InputObject $dt -MemberType NoteProperty -Name 'tier' -Value $newTier -Force }
                if ($dt.PSObject.Properties['sort_key']) { $dt.sort_key = $newSort }
                else { Add-Member -InputObject $dt -MemberType NoteProperty -Name 'sort_key' -Value $newSort -Force }
                $mutated = $true
            }
        }

        if ($mutated) { $dirtyFiles[$povName] = $store }
    }

    if ($dirtyFiles.Count -gt 0 -and -not $WhatIfPreference) {
        foreach ($povName in $dirtyFiles.Keys) {
            $filePath = Join-Path $taxDir "$povName.json"
            Write-PovTaxonomyFile -Path $filePath -Data $dirtyFiles[$povName]   # canonical TS format (t/4356)
            Write-Verbose "Update-NodeTestingRecord: wrote $filePath"
        }
    }

    Write-Host ''
    if ($WhatIfPreference) {
        Write-Host "Would recompute tier/sort_key on $($changes.Count) node(s). No changes written."
    } else {
        Write-Host "Recomputed tier/sort_key on $($changes.Count) node(s). Files updated: $($dirtyFiles.Count)."
    }

    $changes
}
