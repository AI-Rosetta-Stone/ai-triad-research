# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-ProposalApply {
    <#
    .SYNOPSIS
        Applies a single taxonomy proposal (NEW/SPLIT/MERGE/RELABEL) to the taxonomy files.
    .DESCRIPTION
        Internal helper called by Approve-TaxonomyProposal. Mutates the taxonomy
        JSON file on disk and returns a result object.
    .OUTPUTS
        [PSCustomObject] { Success; Error; PovTagReview } on success — Error is $null,
        PovTagReview is @() when the proposal carried no pov_tags change, otherwise one
        { NodeId; Tags; Reason } entry per node whose tags were set by this apply (t/3971):
        Reason is 'merge-union', 'split-inherit', or 'depth-inherit'. A Write-Warning is
        also emitted for console visibility, but PovTagReview is the data a batch/headless
        caller can act on. { Success = $false; Error = <message> } on failure (no PovTagReview;
        nothing was written).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [PSObject]$Proposal,

        [string]$RepoRoot = $script:RepoRoot
    )

    Set-StrictMode -Version Latest

    $TaxDir = Get-TaxonomyDir

    $PovFileMap = @{
        accelerationist = 'accelerationist.json'
        safetyist       = 'safetyist.json'
        skeptic         = 'skeptic.json'
        'situations' = 'situations.json'
    }

    $FileName = $PovFileMap[$Proposal.pov]
    if (-not $FileName) {
        return [PSCustomObject]@{ Success = $false; Error = "Unknown POV: $($Proposal.pov)" }
    }

    $FilePath = Join-Path $TaxDir $FileName
    if (-not (Test-Path $FilePath)) {
        return [PSCustomObject]@{ Success = $false; Error = "Taxonomy file not found: $FileName" }
    }

    try {
        $Raw = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read for the canonical write (t/4356)
    } catch {
        return [PSCustomObject]@{ Success = $false; Error = "Failed to parse $FileName`: $_" }
    }

    $IsCrossCutting = $Proposal.pov -eq 'situations'
    $Today = (Get-Date).ToString('yyyy-MM-dd')

    # t/3971 (CL t/3955#5): pov_tags carry-forward rule for MERGE/SPLIT/DEPTH_EXPAND, validated
    # as one batch against the registry before anything is written. Situations never carry
    # pov_tags (validatePovTags rejects it on sit-*/cc-* nodes), so no branch below touches it
    # when $IsCrossCutting. Accumulated here, validated once after the switch.
    $TagValidationEntries = [System.Collections.Generic.List[hashtable]]::new()

    # t/4035: MERGE deletes nodes, and their graph_attributes.policy_actions with them. Set in the MERGE
    # branch; the registry recount runs after the write (empty for every other action).
    $PolicyRecountNodeIds = @()
    $PolicyPriorIds       = @()

    switch ($Proposal.action) {
        'NEW' {
            # t/3971: NEW (like WIDTH_EXPAND) starts untagged (CL t/3955#5) — neither node
            # object below sets pov_tags, which is the "untagged" state by omission.
            # Validate node ID format + category consistency. $null = suppresses
            # Test-PovNodeId's $true return so it doesn't pollute the function's
            # result-object output stream (t/2332 pipeline hygiene).
            try { $null = Test-PovNodeId -Id $Proposal.suggested_id -Category $Proposal.category } catch {
                return [PSCustomObject]@{ Success = $false; Error = $_.Exception.Message }
            }

            # Check for ID collision
            $Existing = $Raw.nodes | Where-Object { $_.id -eq $Proposal.suggested_id }
            if ($Existing) {
                return [PSCustomObject]@{ Success = $false; Error = "Node ID '$($Proposal.suggested_id)' already exists" }
            }

            if ($IsCrossCutting) {
                # t/2332 gate + t/3887 shared creator — FAIL-CLOSED (TL t/2332#4): on
                # persistent enrichment failure, skip this single proposal (additive)
                # rather than commit an empty-interpretation node. The scheduled
                # trip-wire (t/3671) is a backstop, not the primary guard.
                try {
                    $NodeObj = New-SituationNode -Id $Proposal.suggested_id -Label $Proposal.label -Description $Proposal.description
                }
                catch {
                    return [PSCustomObject]@{ Success = $false; Error = $_.Exception.Message }
                }
                $HistoryFields = @('label', 'description', 'interpretations', 'linked_nodes', 'conflict_ids')
            } else {
                $NewNode = [ordered]@{
                    id                 = $Proposal.suggested_id
                    category           = $Proposal.category
                    label              = $Proposal.label
                    description        = $Proposal.description
                    parent_id          = $null
                    children           = @()
                    situation_refs = @()
                }
                $NodeObj = [PSCustomObject]$NewNode
                $HistoryFields = @($NewNode.Keys | Where-Object { $_ -ne 'id' })
            }

            Add-ChangeHistoryEntry -Node $NodeObj -Action 'created' -Fields $HistoryFields
            Add-TextHistoryEntry -Node $NodeObj -Field 'label' -Value $Proposal.label -Source 'initial'
            if ($Proposal.description) {
                Add-TextHistoryEntry -Node $NodeObj -Field 'description' -Value $Proposal.description -Source 'initial'
            }
            # t/1550 — generate aphorism on create. Fail-open (Set-NodeAphorism
            # skips situations/pillars and returns without mutating on AI failure).
            Set-NodeAphorism -Node $NodeObj -Pov $Proposal.pov -Reason 'proposal-NEW'

            $Raw.nodes += $NodeObj
        }

        'RELABEL' {
            $Target = $Raw.nodes | Where-Object { $_.id -eq $Proposal.target_node_id }
            if (-not $Target) {
                return [PSCustomObject]@{ Success = $false; Error = "Target node '$($Proposal.target_node_id)' not found" }
            }

            if ($Proposal.label) {
                Add-TextHistoryEntry -Node $Target -Field 'label' `
                    -Previous $Target.label -Value $Proposal.label -Source 'batch_audit' -Reason "RELABEL proposal"
                $Target.label = $Proposal.label
            }
            if ($Proposal.description) {
                Add-TextHistoryEntry -Node $Target -Field 'description' `
                    -Previous $Target.description -Value $Proposal.description -Source 'batch_audit' -Reason "RELABEL proposal"
                $Target.description = $Proposal.description
            }
            # t/1550 — regenerate aphorism after label/description modify. Fail-open.
            if ($Proposal.label -or $Proposal.description) {
                Set-NodeAphorism -Node $Target -Pov $Proposal.pov -Reason 'proposal-RELABEL'
            }
        }

        'MERGE' {
            $SurvivorId = $Proposal.surviving_node_id
            $MergeIds   = @($Proposal.merge_node_ids)

            $Survivor = $Raw.nodes | Where-Object { $_.id -eq $SurvivorId }
            if (-not $Survivor) {
                return [PSCustomObject]@{ Success = $false; Error = "Surviving node '$SurvivorId' not found" }
            }

            # Update survivor label/description if proposal provides them
            if ($Proposal.label) {
                Add-TextHistoryEntry -Node $Survivor -Field 'label' `
                    -Previous $Survivor.label -Value $Proposal.label -Source 'batch_audit' -Reason "MERGE proposal"
                $Survivor.label = $Proposal.label
            }
            if ($Proposal.description) {
                Add-TextHistoryEntry -Node $Survivor -Field 'description' `
                    -Previous $Survivor.description -Value $Proposal.description -Source 'batch_audit' -Reason "MERGE proposal"
                $Survivor.description = $Proposal.description
            }
            # t/1550 — regenerate aphorism on survivor if label/description changed. Fail-open.
            if ($Proposal.label -or $Proposal.description) {
                Set-NodeAphorism -Node $Survivor -Pov $Proposal.pov -Reason 'proposal-MERGE'
            }

            # Remove merged nodes (except survivor)
            $RemoveIds = $MergeIds | Where-Object { $_ -ne $SurvivorId }

            # t/3971: union pov_tags from every merged-away node into the survivor, de-duplicated
            # (CL t/3955#5). Computed BEFORE removal, while the merged nodes still exist in $Raw.
            if (-not $IsCrossCutting) {
                $MergedAwayNodes = @($Raw.nodes | Where-Object { $_.id -in $RemoveIds })
                $UnionSource = @($Survivor) + $MergedAwayNodes
                $UnionTags = @($UnionSource | ForEach-Object {
                    if ($_.PSObject.Properties['pov_tags']) { $_.pov_tags } else { $null }
                } | Where-Object { $null -ne $_ } | Select-Object -Unique)
                if (@($UnionTags).Count -gt 0) {
                    $Survivor | Add-Member -NotePropertyName 'pov_tags' -NotePropertyValue @($UnionTags) -Force
                    $TagValidationEntries.Add(@{ NodeId = $SurvivorId; Tags = @($UnionTags); Reason = 'merge-union' })
                    Write-Warning "MERGE: unioned pov_tags onto survivor '$SurvivorId': $($UnionTags -join ', ')"
                }
            }

            # t/4035: capture the policy ids on every merged-away node BEFORE removing it, so the recount
            # after the write can bring each dropped id's member_count down (otherwise it stays one high,
            # and a policy referenced only by a merged-away node becomes an orphan still claiming a member).
            $PolicyPriorIds = @(@($Raw.nodes | Where-Object { $_.id -in $RemoveIds }) | ForEach-Object {
                if ($_.PSObject.Properties['graph_attributes']) { Get-GraphAttributePolicyIds -GraphAttributes $_.graph_attributes }
            } | Sort-Object -Unique)
            $PolicyRecountNodeIds = @(@($SurvivorId) + @($RemoveIds))

            $Raw.nodes = @($Raw.nodes | Where-Object { $_.id -notin $RemoveIds })

            # Update references in remaining nodes
            foreach ($Node in $Raw.nodes) {
                if ($Node.PSObject.Properties['children'] -and $Node.children) {
                    $Node.children = @($Node.children | ForEach-Object {
                        if ($_ -in $RemoveIds) { $SurvivorId } else { $_ }
                    } | Select-Object -Unique)
                }
                if ($Node.PSObject.Properties['situation_refs'] -and $Node.situation_refs) {
                    $Node.situation_refs = @($Node.situation_refs | ForEach-Object {
                        if ($_ -in $RemoveIds) { $SurvivorId } else { $_ }
                    } | Select-Object -Unique)
                }
                if ($Node.PSObject.Properties['parent_id'] -and $Node.parent_id -in $RemoveIds) {
                    $Node.parent_id = $SurvivorId
                }
            }

            Write-Warning "Merged nodes removed: $($RemoveIds -join ', '). Summaries and edges referencing these IDs may need updating."
        }

        'SPLIT' {
            $TargetId = $Proposal.target_node_id
            $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
            if (-not $Target) {
                return [PSCustomObject]@{ Success = $false; Error = "Target node '$TargetId' not found for SPLIT" }
            }

            $ChildProposals = @($Proposal.children)
            if ($ChildProposals.Count -eq 0) {
                return [PSCustomObject]@{ Success = $false; Error = "SPLIT proposal has no children" }
            }

            # Create child nodes
            foreach ($Child in $ChildProposals) {
                if ($Child.PSObject.Properties['category']) { $ChildCat = $Child.category } else { $ChildCat = $Target.category }
                # Validate child node ID. t/3971: $null = suppresses Test-PovNodeId's $true
                # return (t/2332 pipeline hygiene) — pre-existing gap here let the function's
                # output stream carry a stray $true per child, corrupting a multi-child
                # caller's captured result (discovered via PovTagReview no longer being @()).
                try { $null = Test-PovNodeId -Id $Child.suggested_id -Category $ChildCat } catch {
                    return [PSCustomObject]@{ Success = $false; Error = "SPLIT child: $($_.Exception.Message)" }
                }
                if ($Target.PSObject.Properties['situation_refs']) { $ChildSitRefs = $Target.situation_refs } else { $ChildSitRefs = @() }
                $ChildNode = [ordered]@{
                    id                 = $Child.suggested_id
                    category           = $ChildCat
                    label              = $Child.label
                    description        = $Child.description
                    parent_id          = $TargetId
                    children           = @()
                    situation_refs = $ChildSitRefs
                }
                $ChildObj = [PSCustomObject]$ChildNode
                # t/3971: children inherit the parent's pov_tags as-is (CL t/3955#5) — not
                # inheriting would silently drop them out of Scope-mode debates. Flagged below
                # for editor review, not silent.
                if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
                    $InheritedTags = @($Target.pov_tags)
                    $ChildObj | Add-Member -NotePropertyName 'pov_tags' -NotePropertyValue $InheritedTags -Force
                    $TagValidationEntries.Add(@{ NodeId = $Child.suggested_id; Tags = $InheritedTags; Reason = 'split-inherit' })
                }
                Add-TextHistoryEntry -Node $ChildObj -Field 'label' -Value $Child.label -Source 'initial'
                if ($Child.description) {
                    Add-TextHistoryEntry -Node $ChildObj -Field 'description' -Value $Child.description -Source 'initial'
                }
                # t/1550 — new child node from SPLIT gets an aphorism. Fail-open.
                Set-NodeAphorism -Node $ChildObj -Pov $Proposal.pov -Reason 'proposal-SPLIT-child'
                $Raw.nodes += $ChildObj
            }

            # Update parent to reference children
            $Target.children = @($ChildProposals | ForEach-Object { $_.suggested_id })

            Write-Warning "Split '$TargetId' into $($ChildProposals.Count) children. Summaries referencing '$TargetId' may need re-processing."
            if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
                Write-Warning "SPLIT: children of '$TargetId' inherited pov_tags [$($Target.pov_tags -join ', ')] — flag for editor review."
            }
        }

        'REORDER' {
            $TargetId = $Proposal.target_node_id
            $NewParentId = $Proposal.new_parent_id

            $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
            if (-not $Target) {
                return [PSCustomObject]@{ Success = $false; Error = "Target node '$TargetId' not found for REORDER" }
            }

            $NewParent = $Raw.nodes | Where-Object { $_.id -eq $NewParentId }
            if (-not $NewParent) {
                return [PSCustomObject]@{ Success = $false; Error = "New parent '$NewParentId' not found — exact match required" }
            }

            # Remove from old parent's children array
            $OldParentId = $Target.parent_id
            if ($OldParentId) {
                $OldParent = $Raw.nodes | Where-Object { $_.id -eq $OldParentId }
                if ($OldParent -and $OldParent.PSObject.Properties['children']) {
                    $OldParent.children = @($OldParent.children | Where-Object { $_ -ne $TargetId })
                }
            }

            # Set new parent
            $Target.parent_id = $NewParentId

            # Add to new parent's children
            if ($NewParent.PSObject.Properties['children']) {
                if ($TargetId -notin @($NewParent.children)) {
                    $NewParent.children = @($NewParent.children) + @($TargetId)
                }
            }
            else {
                $NewParent | Add-Member -NotePropertyName 'children' -NotePropertyValue @($TargetId) -Force
            }
        }

        'DEPTH_EXPAND' {
            $TargetId = $Proposal.target_node_id
            $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
            if (-not $Target) {
                return [PSCustomObject]@{ Success = $false; Error = "Target node '$TargetId' not found for DEPTH_EXPAND" }
            }

            $SubGroups = @($Proposal.children)
            if ($SubGroups.Count -eq 0) {
                return [PSCustomObject]@{ Success = $false; Error = "DEPTH_EXPAND has no sub-group proposals" }
            }
            if ($SubGroups.Count -gt 3) {
                return [PSCustomObject]@{ Success = $false; Error = "DEPTH_EXPAND exceeds max 3 node changes per proposal" }
            }

            # Create intermediate parent nodes under the dense parent
            foreach ($SubGroup in $SubGroups) {
                if ($SubGroup.PSObject.Properties['category']) { $SubGrpCat = $SubGroup.category } else { $SubGrpCat = $Target.category }
                # Validate intermediate node ID. t/3971: $null = suppresses the same stray
                # output (see the SPLIT branch's identical fix above).
                try { $null = Test-PovNodeId -Id $SubGroup.suggested_id -Category $SubGrpCat } catch {
                    return [PSCustomObject]@{ Success = $false; Error = "DEPTH_EXPAND: $($_.Exception.Message)" }
                }
                $IntNode = [ordered]@{
                    id          = $SubGroup.suggested_id
                    category    = $SubGrpCat
                    label       = $SubGroup.label
                    description = $SubGroup.description
                    parent_id   = $TargetId
                    children    = @()
                    situation_refs = @()
                }
                $IntObj = [PSCustomObject]$IntNode
                # t/3971: the new intermediate node inherits the parent's pov_tags as-is (CL
                # t/3955#5), flagged below for editor review — same rule as SPLIT.
                if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
                    $InheritedTags = @($Target.pov_tags)
                    $IntObj | Add-Member -NotePropertyName 'pov_tags' -NotePropertyValue $InheritedTags -Force
                    $TagValidationEntries.Add(@{ NodeId = $SubGroup.suggested_id; Tags = $InheritedTags; Reason = 'depth-inherit' })
                }
                Add-TextHistoryEntry -Node $IntObj -Field 'label' -Value $SubGroup.label -Source 'initial'
                if ($SubGroup.description) {
                    Add-TextHistoryEntry -Node $IntObj -Field 'description' -Value $SubGroup.description -Source 'initial'
                }
                # t/1550 — intermediate parent from DEPTH_EXPAND gets an aphorism. Fail-open.
                # Note: pillar-shaped descriptions ("A thematic pillar…") are skipped by the helper.
                Set-NodeAphorism -Node $IntObj -Pov $Proposal.pov -Reason 'proposal-DEPTH_EXPAND'
                $Raw.nodes += $IntObj

                # Move assigned children under the new intermediate node
                if ($SubGroup.PSObject.Properties['assigned_children']) {
                    foreach ($ChildId in @($SubGroup.assigned_children)) {
                        $Child = $Raw.nodes | Where-Object { $_.id -eq $ChildId }
                        if ($Child) {
                            $Child.parent_id = $SubGroup.suggested_id
                            $IntObj.children = @($IntObj.children) + @($ChildId)
                        }
                    }
                    # Remove moved children from original parent's children array
                    if ($Target.PSObject.Properties['children']) {
                        $Target.children = @($Target.children | Where-Object { $_ -notin @($SubGroup.assigned_children) })
                    }
                }
            }

            # Add new intermediate nodes to parent's children
            if ($Target.PSObject.Properties['children']) {
                $Target.children = @($Target.children) + @($SubGroups | ForEach-Object { $_.suggested_id })
            }

            if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
                Write-Warning "DEPTH_EXPAND: intermediate node(s) under '$TargetId' inherited pov_tags [$($Target.pov_tags -join ', ')] — flag for editor review."
            }
        }

        'WIDTH_EXPAND' {
            # Same as NEW but motivated by density signals
            # t/3971: WIDTH_EXPAND and NEW both start untagged (CL t/3955#5) — the new node
            # object below has no pov_tags key, which is the "untagged" state by omission.
            # t/3971: $null = suppresses the same stray output (see SPLIT's identical fix).
            try { $null = Test-PovNodeId -Id $Proposal.suggested_id -Category $Proposal.category } catch {
                return [PSCustomObject]@{ Success = $false; Error = "WIDTH_EXPAND: $($_.Exception.Message)" }
            }
            if ($Raw.nodes | Where-Object { $_.id -eq $Proposal.suggested_id }) {
                return [PSCustomObject]@{ Success = $false; Error = "Node ID '$($Proposal.suggested_id)' already exists" }
            }

            $NewNode = [ordered]@{
                id          = $Proposal.suggested_id
                category    = $Proposal.category
                label       = $Proposal.label
                description = $Proposal.description
                parent_id   = $null
                children    = @()
                situation_refs = @()
            }
            $NewObj = [PSCustomObject]$NewNode
            Add-TextHistoryEntry -Node $NewObj -Field 'label' -Value $Proposal.label -Source 'initial'
            if ($Proposal.description) {
                Add-TextHistoryEntry -Node $NewObj -Field 'description' -Value $Proposal.description -Source 'initial'
            }
            # t/1550 — WIDTH_EXPAND is functionally NEW, so it gets an aphorism too. Fail-open.
            Set-NodeAphorism -Node $NewObj -Pov $Proposal.pov -Reason 'proposal-WIDTH_EXPAND'
            $Raw.nodes += $NewObj
        }

        default {
            return [PSCustomObject]@{ Success = $false; Error = "Unknown action: $($Proposal.action)" }
        }
    }

    # t/3971: validate every pov_tags change this apply is about to make (MERGE's union,
    # SPLIT/DEPTH_EXPAND's inheritance) in ONE call to the registry gate, BEFORE the write
    # below. An invalid carry-forward refuses the whole apply — nothing is written.
    if ($TagValidationEntries.Count -gt 0) {
        try {
            Invoke-PovTagsValidation -Entries $TagValidationEntries.ToArray() `
                -Goal "Validate pov_tags carried forward by $($Proposal.action) on '$($Proposal.pov)'"
        } catch {
            return [PSCustomObject]@{ Success = $false; Error = $_.Exception.Message }
        }
    }

    $Raw.last_modified = $Today
    try {
        Write-PovTaxonomyFile -Path $FilePath -Data $Raw   # canonical TS format (t/4356)
    }
    catch {
        return [PSCustomObject]@{ Success = $false; Error = "Failed to write $FileName — $($_.Exception.Message)" }
    }

    # t/4035: recount exactly the ids the merged-away nodes held (plus the survivor's) — the same hook the
    # other policy_actions writers use (t/4004). Only when they held any, so a policy-less MERGE never
    # touches the BLOCK-tier registry. A registration failure WARNs with the remedy; it never undoes the
    # taxonomy write above.
    if (@($PolicyPriorIds).Count -gt 0) {
        Invoke-NodePolicyRegistration -NodeId $PolicyRecountNodeIds -PriorPolicyIds $PolicyPriorIds -Caller 'Invoke-ProposalApply'
    }

    # t/3971 (TL review of #2855): the flag must be DATA, not just console output — Write-Warning
    # disappears in batch/headless runs, so nobody could later list which nodes need review.
    $PovTagReview = @($TagValidationEntries | ForEach-Object {
        [PSCustomObject]@{ NodeId = $_.NodeId; Tags = $_.Tags; Reason = $_.Reason }
    })
    return [PSCustomObject]@{ Success = $true; Error = $null; PovTagReview = $PovTagReview }
}
