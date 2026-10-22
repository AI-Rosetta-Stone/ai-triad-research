# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-TaxonomyHierarchy {
    <#
    .SYNOPSIS
        Applies an approved hierarchy proposal to the taxonomy files.
    .DESCRIPTION
        Reads a hierarchy proposal JSON (from Invoke-HierarchyProposal), creates new parent
        nodes where needed, sets parent_id on child nodes, and populates children arrays.
        Validates structural constraints before writing.
    .EXAMPLE
        Set-TaxonomyHierarchy -ProposalFile './taxonomy/hierarchy-proposals/hierarchy-proposal-2026-03-27-143000.json'
        Set-TaxonomyHierarchy -ProposalFile './proposal.json' -DryRun
    .LINK
        Show-AITriadHelp
    .LINK
        Approve-TaxonomyProposal
    .LINK
        Invoke-TaxonomyProposal
    .LINK
        Invoke-HierarchyProposal
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$ProposalFile,

        [switch]$DryRun,
        [switch]$Force
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    # ── Load proposal ────────────────────────────────────────────────────────
    if (-not (Test-Path $ProposalFile)) {
        Write-Fail "Proposal file not found: $ProposalFile"
        return
    }

    Write-Step 'Loading hierarchy proposal'
    $ProposalData = Get-Content -Raw -Path $ProposalFile | ConvertFrom-Json
    $Buckets = @($ProposalData.buckets)
    Write-OK "Loaded $($Buckets.Count) buckets from proposal"

    # ── Load taxonomy files ──────────────────────────────────────────────────
    $TaxDir = Get-TaxonomyDir

    $PovFileMap = @{
        accelerationist = 'accelerationist.json'
        safetyist       = 'safetyist.json'
        skeptic         = 'skeptic.json'
        'situations' = 'situations.json'
    }

    $TaxFiles = @{}
    foreach ($PovKey in $PovFileMap.Keys) {
        $FilePath = Join-Path $TaxDir $PovFileMap[$PovKey]
        if (Test-Path $FilePath) {
            $TaxFiles[$PovKey] = @{
                Path = $FilePath
                Data = Read-PovTaxonomyFile -Path $FilePath   # shape-preserving read (t/4356)
                Modified = $false
            }
        }
    }

    # ── Collect all existing node IDs ────────────────────────────────────────
    $ExistingIds = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($PovKey in $TaxFiles.Keys) {
        foreach ($Node in $TaxFiles[$PovKey].Data.nodes) {
            [void]$ExistingIds.Add($Node.id)
        }
    }

    # ── Process each bucket ──────────────────────────────────────────────────
    $Stats = @{
        NewParents       = 0
        PromotedParents  = 0
        ChildAssignments = 0
        Outliers         = 0
        Errors           = 0
    }

    foreach ($Bucket in $Buckets) {
        $PovKey  = $Bucket.pov
        if ($Bucket.PSObject.Properties['category'] -and $Bucket.category) {
            $CatLabel = $Bucket.category
        } else { $CatLabel = '(situations)' }

        Write-Step "$PovKey / $CatLabel"

        if (-not $TaxFiles.ContainsKey($PovKey)) {
            Write-Fail "No taxonomy file for POV '$PovKey'"
            $Stats.Errors++
            continue
        }

        $FileEntry = $TaxFiles[$PovKey]
        $IsCrossCutting = $PovKey -eq 'situations'

        if (-not $Bucket.PSObject.Properties['parents']) { continue }

        # Determine next available sequence number for new parent IDs
        $PovPrefix = switch ($PovKey) {
            'accelerationist' { 'acc' }
            'safetyist'       { 'saf' }
            'skeptic'         { 'skp' }
            'situations'      { 'cc'  }
        }

        # For new parent IDs, find the max existing sequence number in this category
        $CatPrefix = switch ($Bucket.category) {
            'Beliefs'    { 'beliefs' }
            'Desires'    { 'desires' }
            'Intentions' { 'intentions' }
            default      { '' }
        }

        $MaxSeq = 0
        foreach ($Node in $FileEntry.Data.nodes) {
            if ($IsCrossCutting) {
                if ($Node.id -match '^sit-(\d+)$') {
                    $Seq = [int]$Matches[1]
                    if ($Seq -gt $MaxSeq) { $MaxSeq = $Seq }
                }
            }
            else {
                if ($CatPrefix -and $Node.id -match "^$PovPrefix-$CatPrefix-(\d+)$") {
                    $Seq = [int]$Matches[1]
                    if ($Seq -gt $MaxSeq) { $MaxSeq = $Seq }
                }
            }
        }

        $NextSeq = $MaxSeq + 1

        foreach ($Parent in @($Bucket.parents)) {
            $ParentId  = $null
            $ParentNode = $null

            if ($Parent.promoted_from) {
                # ── Promote existing node ────────────────────────────────
                $ParentId = $Parent.promoted_from
                $ParentNode = $FileEntry.Data.nodes |
                    Where-Object { $_.id -eq $ParentId } |
                    Select-Object -First 1

                if (-not $ParentNode) {
                    Write-Warn "Promoted node '$ParentId' not found — skipping"
                    $Stats.Errors++
                    continue
                }

                Write-Info "Promoting existing node: $ParentId ($($ParentNode.label))"
                $Stats.PromotedParents++
            }
            else {
                # ── Create new parent node ───────────────────────────────
                # t/3887: resolve the FINAL id (incl. any collision bump) BEFORE
                # minting, so the cross-cutting branch's BDI gate call (inside
                # New-SituationNode) sees the real id, not a provisional one.
                # One prefix, computed once, so collision-bump doesn't repeat
                # the IsCrossCutting branch (complexity-ratchet, t/3829).
                if ($IsCrossCutting) { $IdPrefix = 'sit' } else { $IdPrefix = "$PovPrefix-$CatPrefix" }
                $ParentId = "$IdPrefix-$($NextSeq.ToString('D3'))"
                $NextSeq++

                if ($ExistingIds.Contains($ParentId)) {
                    Write-Warn "ID collision: $ParentId — incrementing"
                    $ParentId = "$IdPrefix-$($NextSeq.ToString('D3'))"
                    $NextSeq++
                }

                # t/2332 gate + t/3887 shared creator — FAIL-CLOSED: on gate
                # failure, skip this single parent (and, critically, its
                # children too — this `continue` is at the parent-loop level,
                # so no child is assigned an unminted parent_id). The gate's own
                # try/catch lives inside New-TaxonomyParentNode, not here, so it
                # doesn't add a second decision point to this already-baselined
                # function (complexity-ratchet, t/3829).
                $NewObj = New-TaxonomyParentNode -IsCrossCutting $IsCrossCutting -Id $ParentId -Label $Parent.label -Description $Parent.description -Category $Bucket.category
                if (-not $NewObj) {
                    $Stats.Errors++
                    continue
                }

                Add-TextHistoryEntry -Node $NewObj -Field 'label' -Value $Parent.label -Source 'initial'
                if ($Parent.description) {
                    Add-TextHistoryEntry -Node $NewObj -Field 'description' -Value $Parent.description -Source 'initial'
                }
                $FileEntry.Data.nodes += $NewObj
                [void]$ExistingIds.Add($ParentId)
                $ParentNode = $FileEntry.Data.nodes | Where-Object { $_.id -eq $ParentId } | Select-Object -First 1

                Write-Info "Created new parent: $ParentId ($($Parent.label))"
                $Stats.NewParents++
            }

            # ── Assign children ──────────────────────────────────────────
            $ChildIds = [System.Collections.Generic.List[string]]::new()

            foreach ($Child in @($Parent.children)) {
                $ChildNode = $FileEntry.Data.nodes |
                    Where-Object { $_.id -eq $Child.node_id } |
                    Select-Object -First 1

                if (-not $ChildNode) {
                    Write-Warn "Child node '$($Child.node_id)' not found — skipping"
                    $Stats.Errors++
                    continue
                }

                # Check if already has a parent (and we're not forcing)
                $ExistingParent = $null
                if ($ChildNode.PSObject.Properties['parent_id']) {
                    $ExistingParent = $ChildNode.parent_id
                }
                if ($ExistingParent -and -not $Force) {
                    Write-Warn "$($Child.node_id) already has parent_id '$ExistingParent' — use -Force to override"
                    continue
                }

                # Set parent_id
                if ($ChildNode.PSObject.Properties['parent_id']) {
                    $ChildNode.parent_id = $ParentId
                }
                else {
                    $ChildNode | Add-Member -NotePropertyName 'parent_id' -NotePropertyValue $ParentId -Force
                }

                # Set parent_relationship (is_a, part_of, specializes)
                if ($Child.PSObject.Properties['relationship']) { $Relationship = $Child.relationship } else { $Relationship = $null }
                if ($ChildNode.PSObject.Properties['parent_relationship']) {
                    $ChildNode.parent_relationship = $Relationship
                }
                else {
                    $ChildNode | Add-Member -NotePropertyName 'parent_relationship' -NotePropertyValue $Relationship -Force
                }

                # Set parent_rationale
                if ($Child.PSObject.Properties['rationale']) { $Rationale = $Child.rationale } else { $Rationale = $null }
                if ($ChildNode.PSObject.Properties['parent_rationale']) {
                    $ChildNode.parent_rationale = $Rationale
                }
                else {
                    $ChildNode | Add-Member -NotePropertyName 'parent_rationale' -NotePropertyValue $Rationale -Force
                }

                $ChildIds.Add($Child.node_id)
                $Stats.ChildAssignments++
            }

            # ── Populate parent's children array ─────────────────────────
            if ($ParentNode.PSObject.Properties['children']) {
                # Merge with any existing children
                $AllChildren = [System.Collections.Generic.List[string]]::new()
                if ($ParentNode.children) {
                    foreach ($Existing in @($ParentNode.children)) {
                        if (-not $AllChildren.Contains($Existing)) {
                            $AllChildren.Add($Existing)
                        }
                    }
                }
                foreach ($NewChild in $ChildIds) {
                    if (-not $AllChildren.Contains($NewChild)) {
                        $AllChildren.Add($NewChild)
                    }
                }
                $ParentNode.children = @($AllChildren.ToArray())
            }
            else {
                $ParentNode | Add-Member -NotePropertyName 'children' -NotePropertyValue @($ChildIds.ToArray()) -Force
            }

            $FileEntry.Modified = $true
        }

        # Track outliers
        if ($Bucket.PSObject.Properties['outliers']) {
            $Stats.Outliers += $Bucket.outliers.Count
        }
    }

    # ── Validation ───────────────────────────────────────────────────────────
    Write-Step 'Validating hierarchy'
    $ValidationErrors = [System.Collections.Generic.List[string]]::new()

    foreach ($PovKey in $TaxFiles.Keys) {
        $FileData = $TaxFiles[$PovKey].Data

        foreach ($Node in $FileData.nodes) {
            # Check parent_id references a real node in the same file
            if ($Node.PSObject.Properties['parent_id'] -and $Node.parent_id) {
                $ParentExists = $FileData.nodes | Where-Object { $_.id -eq $Node.parent_id } | Select-Object -First 1
                if (-not $ParentExists) {
                    $ValidationErrors.Add("$($Node.id): parent_id '$($Node.parent_id)' not found in $PovKey")
                }
            }

            # Check children array references real nodes
            if ($Node.PSObject.Properties['children'] -and $Node.children) {
                foreach ($ChildId in @($Node.children)) {
                    $ChildExists = $FileData.nodes | Where-Object { $_.id -eq $ChildId } | Select-Object -First 1
                    if (-not $ChildExists) {
                        $ValidationErrors.Add("$($Node.id): child '$ChildId' not found in $PovKey")
                    }
                }
            }

            # Check no self-parenting
            if ($Node.PSObject.Properties['parent_id'] -and $Node.parent_id -eq $Node.id) {
                $ValidationErrors.Add("$($Node.id): self-parenting detected")
            }

            # Check depth <= 2 (no grandchildren)
            if ($Node.PSObject.Properties['parent_id'] -and $Node.parent_id) {
                $ParentNode = $FileData.nodes | Where-Object { $_.id -eq $Node.parent_id } | Select-Object -First 1
                if ($ParentNode -and $ParentNode.PSObject.Properties['parent_id'] -and $ParentNode.parent_id) {
                    $ValidationErrors.Add("$($Node.id): depth > 2 (grandchild of '$($ParentNode.parent_id)')")
                }
            }
        }

        # Check children/parent_id consistency
        foreach ($Node in $FileData.nodes) {
            if ($Node.PSObject.Properties['children'] -and $Node.children) {
                foreach ($ChildId in @($Node.children)) {
                    $ChildNode = $FileData.nodes | Where-Object { $_.id -eq $ChildId } | Select-Object -First 1
                    if ($ChildNode -and $ChildNode.PSObject.Properties['parent_id'] -and
                        $ChildNode.parent_id -ne $Node.id) {
                        $ValidationErrors.Add("$($Node.id): listed child '$ChildId' has parent_id '$($ChildNode.parent_id)' (mismatch)")
                    }
                }
            }
        }
    }

    if ($ValidationErrors.Count -gt 0) {
        Write-Fail "$($ValidationErrors.Count) validation errors:"
        foreach ($Err in $ValidationErrors) {
            Write-Warn "  $Err"
        }
        if (-not $Force) {
            Write-Fail 'Aborting — use -Force to write despite errors'
            return
        }
        Write-Warn 'Proceeding despite errors (-Force specified)'
    }
    else {
        Write-OK 'Validation passed'
    }

    # ── Summary ──────────────────────────────────────────────────────────────
    Write-Step 'Summary'
    Write-Info "New parent nodes created:  $($Stats.NewParents)"
    Write-Info "Existing nodes promoted:   $($Stats.PromotedParents)"
    Write-Info "Child assignments:         $($Stats.ChildAssignments)"
    Write-Info "Outliers (no parent):      $($Stats.Outliers)"
    Write-Info "Errors/warnings:           $($Stats.Errors)"

    if ($DryRun) {
        Write-Warn 'DryRun — no files written'
        return [PSCustomObject]$Stats
    }

    # ── Write files ──────────────────────────────────────────────────────────
    Write-Step 'Writing taxonomy files'
    $Today = (Get-Date).ToString('yyyy-MM-dd')

    foreach ($PovKey in $TaxFiles.Keys) {
        $FileEntry = $TaxFiles[$PovKey]
        if (-not $FileEntry.Modified) { continue }

        $FileEntry.Data.last_modified = $Today

        if ($PSCmdlet.ShouldProcess($FileEntry.Path, 'Write updated taxonomy file')) {
            try {
                # Canonical TS format (t/4356). The funnel carries the t/2902 guard and the 10 MB
                # corrupted-content block; either throws into the catch below, so the file is skipped.
                Write-PovTaxonomyFile -Path $FileEntry.Path -Data $FileEntry.Data
                Write-OK "Saved $PovKey ($($FileEntry.Path))"
            }
            catch {
                Write-Fail "Failed to write $PovKey`: $($_.Exception.Message)"
            }
        }
    }

    Write-Step 'Done'
    Write-OK 'Hierarchy applied. Next steps:'
    Write-Info '1. Run Update-TaxEmbeddings to generate embeddings for new parent nodes'
    Write-Info '2. Run Invoke-AttributeExtraction -Force to generate graph attributes'
    Write-Info '3. Run Invoke-EdgeDiscovery -StaleOnly to discover edges for new parents'
    Write-Info '4. Bump TAXONOMY_VERSION if needed'

    return [PSCustomObject]$Stats
}
