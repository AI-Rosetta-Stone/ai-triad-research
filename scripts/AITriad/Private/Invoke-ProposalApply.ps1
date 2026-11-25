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
    # pov_tags (validatePovTags rejects it on sit-*/cc-* nodes), so no branch touches it
    # when $IsCrossCutting. Accumulated by the action handlers, validated once below.
    $TagValidationEntries = [System.Collections.Generic.List[hashtable]]::new()

    # One handler per action. Each mutates $Raw in place (it is a reference), appends any
    # pov_tags carry-forward to $TagValidationEntries, and returns { Error; PolicyRecountNodeIds;
    # PolicyPriorIds }. A non-null Error means nothing downstream should run — refuse the apply.
    $Handlers = @{
        'NEW'          = 'Invoke-ProposalApplyNew'
        'RELABEL'      = 'Invoke-ProposalApplyRelabel'
        'MERGE'        = 'Invoke-ProposalApplyMerge'
        'SPLIT'        = 'Invoke-ProposalApplySplit'
        'REORDER'      = 'Invoke-ProposalApplyReorder'
        'DEPTH_EXPAND' = 'Invoke-ProposalApplyDepthExpand'
        'WIDTH_EXPAND' = 'Invoke-ProposalApplyWidthExpand'
    }

    $HandlerName = $Handlers[$Proposal.action]
    if (-not $HandlerName) {
        return [PSCustomObject]@{ Success = $false; Error = "Unknown action: $($Proposal.action)" }
    }

    $ActionResult = & $HandlerName -Proposal $Proposal -Raw $Raw -IsCrossCutting $IsCrossCutting -TagValidationEntries $TagValidationEntries
    if ($ActionResult.Error) {
        return [PSCustomObject]@{ Success = $false; Error = $ActionResult.Error }
    }

    # t/4035: MERGE deletes nodes, and their graph_attributes.policy_actions with them. The MERGE
    # handler surfaces the ids to recount; every other action returns empty.
    $PolicyRecountNodeIds = $ActionResult.PolicyRecountNodeIds
    $PolicyPriorIds       = $ActionResult.PolicyPriorIds

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

# -----------------------------------------------------------------------------------------
# Private action handlers (dot-sourced into module scope alongside Invoke-ProposalApply; NOT
# exported). Each takes the same signature and returns { Error; PolicyRecountNodeIds;
# PolicyPriorIds } so Invoke-ProposalApply can dispatch to them uniformly. They mutate the
# $Raw reference in place, exactly as the original inline switch branches did.
# -----------------------------------------------------------------------------------------

# Shared helper: apply RELABEL/MERGE text updates (label/description + history) and regenerate
# the aphorism when either changed. $ReasonText is the history Reason; $AphorismReason the
# Set-NodeAphorism Reason. Both callers use Source 'batch_audit'. t/1550 aphorism is fail-open.
function Update-ProposalNodeText {
    param($Node, $Proposal, [string]$ReasonText, [string]$AphorismReason)

    if ($Proposal.label) {
        Add-TextHistoryEntry -Node $Node -Field 'label' `
            -Previous $Node.label -Value $Proposal.label -Source 'batch_audit' -Reason $ReasonText
        $Node.label = $Proposal.label
    }
    if ($Proposal.description) {
        Add-TextHistoryEntry -Node $Node -Field 'description' `
            -Previous $Node.description -Value $Proposal.description -Source 'batch_audit' -Reason $ReasonText
        $Node.description = $Proposal.description
    }
    if ($Proposal.label -or $Proposal.description) {
        Set-NodeAphorism -Node $Node -Pov $Proposal.pov -Reason $AphorismReason
    }
}

function Invoke-ProposalApplyNew {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    # t/3971: NEW (like WIDTH_EXPAND) starts untagged (CL t/3955#5) — neither node object
    # below sets pov_tags, which is the "untagged" state by omission.
    # $null = suppresses Test-PovNodeId's $true return so it doesn't pollute the output stream (t/2332).
    try { $null = Test-PovNodeId -Id $Proposal.suggested_id -Category $Proposal.category } catch {
        return [PSCustomObject]@{ Error = $_.Exception.Message }
    }

    $Existing = $Raw.nodes | Where-Object { $_.id -eq $Proposal.suggested_id }
    if ($Existing) {
        return [PSCustomObject]@{ Error = "Node ID '$($Proposal.suggested_id)' already exists" }
    }

    if ($IsCrossCutting) {
        # t/2332 gate + t/3887 shared creator — FAIL-CLOSED (TL t/2332#4): on persistent
        # enrichment failure, skip this single proposal (additive) rather than commit an
        # empty-interpretation node.
        try {
            $NodeObj = New-SituationNode -Id $Proposal.suggested_id -Label $Proposal.label -Description $Proposal.description
        }
        catch {
            return [PSCustomObject]@{ Error = $_.Exception.Message }
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
    # t/1550 — generate aphorism on create. Fail-open.
    Set-NodeAphorism -Node $NodeObj -Pov $Proposal.pov -Reason 'proposal-NEW'

    $Raw.nodes += $NodeObj
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}

function Invoke-ProposalApplyRelabel {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    $Target = $Raw.nodes | Where-Object { $_.id -eq $Proposal.target_node_id }
    if (-not $Target) {
        return [PSCustomObject]@{ Error = "Target node '$($Proposal.target_node_id)' not found" }
    }

    # t/1550 — regenerate aphorism after label/description modify. Fail-open.
    Update-ProposalNodeText -Node $Target -Proposal $Proposal -ReasonText 'RELABEL proposal' -AphorismReason 'proposal-RELABEL'
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}

# MERGE helper: union pov_tags from every merged-away node into the survivor, de-duplicated
# (CL t/3955#5). Computed BEFORE removal, while the merged nodes still exist in $Raw.
function Add-MergeSurvivorPovTags {
    param($Raw, $Survivor, [string]$SurvivorId, $RemoveIds, $TagValidationEntries)

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

# MERGE helper: capture the policy ids on every merged-away node BEFORE removal (t/4035), plus
# the survivor's id for the recount. Returns { PriorIds; RecountIds }.
function Get-MergePolicyData {
    param($Raw, [string]$SurvivorId, $RemoveIds)

    $priorIds = @(@($Raw.nodes | Where-Object { $_.id -in $RemoveIds }) | ForEach-Object {
        if ($_.PSObject.Properties['graph_attributes']) { Get-GraphAttributePolicyIds -GraphAttributes $_.graph_attributes }
    } | Sort-Object -Unique)
    return [PSCustomObject]@{ PriorIds = $priorIds; RecountIds = @(@($SurvivorId) + @($RemoveIds)) }
}

# MERGE helper: rewrite children/situation_refs/parent_id references on the remaining nodes so
# a pointer to a merged-away node points at the survivor instead.
function Update-MergeNodeReferences {
    param($Raw, [string]$SurvivorId, $RemoveIds)

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
}

function Invoke-ProposalApplyMerge {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    $SurvivorId = $Proposal.surviving_node_id
    $MergeIds   = @($Proposal.merge_node_ids)

    $Survivor = $Raw.nodes | Where-Object { $_.id -eq $SurvivorId }
    if (-not $Survivor) {
        return [PSCustomObject]@{ Error = "Surviving node '$SurvivorId' not found" }
    }

    # Update survivor label/description + aphorism if proposal provides them. Fail-open aphorism.
    Update-ProposalNodeText -Node $Survivor -Proposal $Proposal -ReasonText 'MERGE proposal' -AphorismReason 'proposal-MERGE'

    # Remove merged nodes (except survivor)
    $RemoveIds = $MergeIds | Where-Object { $_ -ne $SurvivorId }

    if (-not $IsCrossCutting) {
        Add-MergeSurvivorPovTags -Raw $Raw -Survivor $Survivor -SurvivorId $SurvivorId -RemoveIds $RemoveIds -TagValidationEntries $TagValidationEntries
    }

    # Capture policy ids + recount list BEFORE removal (t/4035).
    $policy = Get-MergePolicyData -Raw $Raw -SurvivorId $SurvivorId -RemoveIds $RemoveIds

    $Raw.nodes = @($Raw.nodes | Where-Object { $_.id -notin $RemoveIds })

    Update-MergeNodeReferences -Raw $Raw -SurvivorId $SurvivorId -RemoveIds $RemoveIds

    Write-Warning "Merged nodes removed: $($RemoveIds -join ', '). Summaries and edges referencing these IDs may need updating."
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = $policy.RecountIds; PolicyPriorIds = $policy.PriorIds }
}

# SPLIT helper: create one child node under $TargetId, inheriting the parent's pov_tags
# (CL t/3955#5) and flagging the carry-forward. Appends to $Raw.nodes. Returns { Error }.
function New-SplitChildNode {
    param($Child, $Target, [string]$TargetId, [bool]$IsCrossCutting, $Proposal, $Raw, $TagValidationEntries)

    if ($Child.PSObject.Properties['category']) { $ChildCat = $Child.category } else { $ChildCat = $Target.category }
    # $null = suppresses Test-PovNodeId's $true return (t/2332 pipeline hygiene).
    try { $null = Test-PovNodeId -Id $Child.suggested_id -Category $ChildCat } catch {
        return [PSCustomObject]@{ Error = "SPLIT child: $($_.Exception.Message)" }
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
    # t/3971: children inherit the parent's pov_tags as-is (CL t/3955#5). Flagged for editor review.
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
    return [PSCustomObject]@{ Error = $null }
}

function Invoke-ProposalApplySplit {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    $TargetId = $Proposal.target_node_id
    $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
    if (-not $Target) {
        return [PSCustomObject]@{ Error = "Target node '$TargetId' not found for SPLIT" }
    }

    $ChildProposals = @($Proposal.children)
    if ($ChildProposals.Count -eq 0) {
        return [PSCustomObject]@{ Error = "SPLIT proposal has no children" }
    }

    foreach ($Child in $ChildProposals) {
        $childResult = New-SplitChildNode -Child $Child -Target $Target -TargetId $TargetId `
            -IsCrossCutting $IsCrossCutting -Proposal $Proposal -Raw $Raw -TagValidationEntries $TagValidationEntries
        if ($childResult.Error) {
            return [PSCustomObject]@{ Error = $childResult.Error }
        }
    }

    # Update parent to reference children
    $Target.children = @($ChildProposals | ForEach-Object { $_.suggested_id })

    Write-Warning "Split '$TargetId' into $($ChildProposals.Count) children. Summaries referencing '$TargetId' may need re-processing."
    if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
        Write-Warning "SPLIT: children of '$TargetId' inherited pov_tags [$($Target.pov_tags -join ', ')] — flag for editor review."
    }
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}

function Invoke-ProposalApplyReorder {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    $TargetId = $Proposal.target_node_id
    $NewParentId = $Proposal.new_parent_id

    $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
    if (-not $Target) {
        return [PSCustomObject]@{ Error = "Target node '$TargetId' not found for REORDER" }
    }

    $NewParent = $Raw.nodes | Where-Object { $_.id -eq $NewParentId }
    if (-not $NewParent) {
        return [PSCustomObject]@{ Error = "New parent '$NewParentId' not found — exact match required" }
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
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}

# DEPTH_EXPAND helper: create one intermediate parent node under $TargetId, inherit the parent's
# pov_tags, move its assigned children under it, and drop those from the dense parent. Appends to
# $Raw.nodes. Returns { Error }.
function New-DepthExpandIntermediateNode {
    param($SubGroup, $Target, [string]$TargetId, [bool]$IsCrossCutting, $Proposal, $Raw, $TagValidationEntries)

    if ($SubGroup.PSObject.Properties['category']) { $SubGrpCat = $SubGroup.category } else { $SubGrpCat = $Target.category }
    # $null = suppresses the stray Test-PovNodeId output (see SPLIT's identical fix).
    try { $null = Test-PovNodeId -Id $SubGroup.suggested_id -Category $SubGrpCat } catch {
        return [PSCustomObject]@{ Error = "DEPTH_EXPAND: $($_.Exception.Message)" }
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
    # t/3971: the new intermediate node inherits the parent's pov_tags as-is (CL t/3955#5),
    # flagged below for editor review — same rule as SPLIT.
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
    return [PSCustomObject]@{ Error = $null }
}

function Invoke-ProposalApplyDepthExpand {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    $TargetId = $Proposal.target_node_id
    $Target = $Raw.nodes | Where-Object { $_.id -eq $TargetId }
    if (-not $Target) {
        return [PSCustomObject]@{ Error = "Target node '$TargetId' not found for DEPTH_EXPAND" }
    }

    $SubGroups = @($Proposal.children)
    if ($SubGroups.Count -eq 0) {
        return [PSCustomObject]@{ Error = "DEPTH_EXPAND has no sub-group proposals" }
    }
    if ($SubGroups.Count -gt 3) {
        return [PSCustomObject]@{ Error = "DEPTH_EXPAND exceeds max 3 node changes per proposal" }
    }

    # Create intermediate parent nodes under the dense parent
    foreach ($SubGroup in $SubGroups) {
        $subResult = New-DepthExpandIntermediateNode -SubGroup $SubGroup -Target $Target -TargetId $TargetId `
            -IsCrossCutting $IsCrossCutting -Proposal $Proposal -Raw $Raw -TagValidationEntries $TagValidationEntries
        if ($subResult.Error) {
            return [PSCustomObject]@{ Error = $subResult.Error }
        }
    }

    # Add new intermediate nodes to parent's children
    if ($Target.PSObject.Properties['children']) {
        $Target.children = @($Target.children) + @($SubGroups | ForEach-Object { $_.suggested_id })
    }

    if (-not $IsCrossCutting -and $Target.PSObject.Properties['pov_tags'] -and @($Target.pov_tags).Count -gt 0) {
        Write-Warning "DEPTH_EXPAND: intermediate node(s) under '$TargetId' inherited pov_tags [$($Target.pov_tags -join ', ')] — flag for editor review."
    }
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}

function Invoke-ProposalApplyWidthExpand {
    param($Proposal, $Raw, [bool]$IsCrossCutting, $TagValidationEntries)

    # Same as NEW but motivated by density signals.
    # t/3971: WIDTH_EXPAND and NEW both start untagged (CL t/3955#5) — the new node object
    # below has no pov_tags key, which is the "untagged" state by omission.
    # $null = suppresses the stray Test-PovNodeId output (see SPLIT's identical fix).
    try { $null = Test-PovNodeId -Id $Proposal.suggested_id -Category $Proposal.category } catch {
        return [PSCustomObject]@{ Error = "WIDTH_EXPAND: $($_.Exception.Message)" }
    }
    if ($Raw.nodes | Where-Object { $_.id -eq $Proposal.suggested_id }) {
        return [PSCustomObject]@{ Error = "Node ID '$($Proposal.suggested_id)' already exists" }
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
    return [PSCustomObject]@{ Error = $null; PolicyRecountNodeIds = @(); PolicyPriorIds = @() }
}
