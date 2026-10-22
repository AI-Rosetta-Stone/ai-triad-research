# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Add-SituationEvidenceLink {
    <#
    .SYNOPSIS
        WS-B Stage 2 (t/3015): commit embedding-proposed situation->POV-node evidence links to
        ai-triad-data, provenance-stamped and purgeable. A guarded write — run -DryRun first.
    .DESCRIPTION
        Consumes the Stage-1 proposal JSON (`[{situation_id, camp, node_id, score, rank}]`, produced
        by research/comp-linguist/.../propose_links.py, t/3014) and applies each machine link in BOTH
        directions — preserving the WS-A reciprocity invariant:
            situation.linked_nodes += node_id   AND   node.situation_refs += situation_id
        Each committed link is stamped in a parallel provenance map on the SITUATION node
        (`evidence_provenance[node_id]`, keyed by node_id — never inline in linked_nodes, which stays
        string[] per the CL/TL schema t/2990-D2):
            { origin:'machine', method:'embedding-cosine-topN', model:'all-MiniLM-L6-v2',
              score, rank, batch_id:<BatchId>, generated_at:<ISO-8601 UTC> }

        COLLISION GUARD (defense-in-depth, t/3015 AC): Stage 1 already excludes authored links, but
        this re-checks at write time — a link already present WITHOUT a machine provenance stamp is
        AUTHORED and is never overwritten, duplicated, or stamped-over. This also covers authored
        links added by WS-A reciprocity since the proposal was snapshotted (CL caveat p/23#204).

        IDEMPOTENT: a link already present WITH this batch's machine stamp is skipped, so a re-run
        adds nothing (0 changes; byte-stable output — generated_at is not rewritten).

        REVERSIBILITY — -Purge removes every machine link for -BatchId (origin=='machine' AND
        batch_id==BatchId) in one predicate: strips node_id from linked_nodes, strips the situation
        from that node's situation_refs, and deletes the provenance entry (dropping the
        evidence_provenance map entirely when it empties) — restoring the pre-WSB state exactly.
        Authored links (no machine stamp) are never touched. This is the rollback handle that makes
        the auto-commit safe.

        Ergonomics mirror Repair-SituationReciprocity: situations.json is BLOCK-tier, so writes go
        through Write-Utf8NoBom -RequireCleanTree and a pre-flight aborts (writing nothing) if any
        target file is already dirty — there is NO -AllowDirty. Does NOT commit or push; a human
        reviews the diff on a clean ai-triad-data tree and pushes.
    .PARAMETER ProposalPath
        Path to the Stage-1 proposal JSON. Required in the default (Apply) parameter set.
    .PARAMETER BatchId
        Provenance batch id stamped on each link and the -Purge selector. Default 'wsb-1'.
    .PARAMETER Purge
        Remove this batch's machine links (+ provenance) instead of applying — the reversibility mode.
    .PARAMETER DryRun
        Report what WOULD change (counts + sample) and make NO writes. Always run this first.
    .PARAMETER RepoRoot
        Repository root containing taxonomy/Origin. Defaults to the module-resolved data root.
    .OUTPUTS
        [PSCustomObject] summary: Mode, LinksAdded, LinksPurged, SkippedAuthored, SkippedExisting,
        SkippedDangling, SituationsChanged, PovNodesChanged, FilesWritten, DryRun.
    .EXAMPLE
        Add-SituationEvidenceLink -ProposalPath ./proposal.json -DryRun
        # Preview the batch (always first).
    .EXAMPLE
        Add-SituationEvidenceLink -ProposalPath ./proposal.json -BatchId wsb-1
        # Apply on a clean tree; a human reviews the diff and pushes ai-triad-data.
    .EXAMPLE
        Add-SituationEvidenceLink -Purge -BatchId wsb-1 -DryRun
        # Preview the rollback of batch wsb-1.
    .LINK
        Repair-SituationReciprocity
    .LINK
        Test-TaxonomyIntegrity
    #>
    [CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Apply')]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Apply')]
        [string]$ProposalPath,

        [Parameter()]
        [ValidatePattern('^wsb-\w+$')]
        [string]$BatchId = 'wsb-1',

        [Parameter(Mandatory, ParameterSetName = 'Purge')]
        [switch]$Purge,

        [switch]$DryRun,

        [string]$RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir  = if ($RepoRoot) { Join-Path $RepoRoot 'taxonomy/Origin' } else { Get-TaxonomyDir }
    $PovKeys = @('accelerationist', 'safetyist', 'skeptic')
    $SitPath = Join-Path $TaxDir 'situations.json'

    if (-not (Test-Path -LiteralPath $SitPath)) {
        New-ActionableError `
            -Goal 'Commit situation evidence links' `
            -Problem "situations.json not found at $SitPath" `
            -Location 'Add-SituationEvidenceLink' `
            -NextSteps 'Verify the data root (Get-TaxonomyDir) or pass -RepoRoot to the repo containing taxonomy/Origin/situations.json.' `
            -Throw
    }

    # ── Load situations + POV camp files ──
    $SitData    = Read-PovTaxonomyFile -Path $SitPath   # shape-preserving read for the canonical write (t/4356)
    $SitIndex   = @{}
    foreach ($s in @($SitData.nodes)) { $SitIndex[$s.id] = $s }

    $PovFiles   = @{}   # povKey -> @{ Path; Data }
    $NodeIndex  = @{}   # POV node id -> node object
    $NodePovKey = @{}   # POV node id -> povKey (which file to mark dirty)
    foreach ($k in $PovKeys) {
        $p = Join-Path $TaxDir "$k.json"
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $d = Read-PovTaxonomyFile -Path $p
        $PovFiles[$k] = @{ Path = $p; Data = $d }
        foreach ($n in @($d.nodes)) { $NodeIndex[$n.id] = $n; $NodePovKey[$n.id] = $k }
    }

    # ── Helpers ──
    $GetArr = {
        param($Node, $Field)
        if ($Node.PSObject.Properties[$Field] -and $null -ne $Node.$Field) { return @($Node.$Field) }
        return @()
    }
    $AddToArr = {
        param($Node, $Field, $Value)
        $new = @(& $GetArr $Node $Field) + $Value
        if ($Node.PSObject.Properties[$Field]) { $Node.$Field = $new }
        else { Add-Member -InputObject $Node -NotePropertyName $Field -NotePropertyValue $new -Force }
    }
    $RemoveFromArr = {
        param($Node, $Field, $Value)
        $new = @(@(& $GetArr $Node $Field) | Where-Object { $_ -ne $Value })
        if ($Node.PSObject.Properties[$Field]) { $Node.$Field = $new }
    }
    # Machine provenance for (sit, node) if present, else $null.
    $GetProv = {
        param($Sit, $NodeId)
        if ($Sit.PSObject.Properties['evidence_provenance'] -and $null -ne $Sit.evidence_provenance -and
            $Sit.evidence_provenance.PSObject.Properties[$NodeId]) {
            return $Sit.evidence_provenance.$NodeId
        }
        return $null
    }
    $IsMachineProv = {
        param($Prov)
        ($null -ne $Prov) -and $Prov.PSObject.Properties['origin'] -and ($Prov.origin -eq 'machine')
    }

    $DirtyPovKeys = [System.Collections.Generic.HashSet[string]]::new()
    $SitDirty     = $false
    $SitTouched   = [System.Collections.Generic.HashSet[string]]::new()
    $PovTouched   = [System.Collections.Generic.HashSet[string]]::new()

    if ($Purge) {
        # ══ PURGE: remove this batch's machine links + provenance, both directions ══
        $Purged = [System.Collections.Generic.List[string]]::new()
        foreach ($sit in @($SitData.nodes)) {
            if (-not ($sit.PSObject.Properties['evidence_provenance'] -and $null -ne $sit.evidence_provenance)) { continue }
            $provMap = $sit.evidence_provenance
            $toRemove = foreach ($prop in @($provMap.PSObject.Properties)) {
                $v = $prop.Value
                if ($v -and $v.PSObject.Properties['origin'] -and $v.origin -eq 'machine' -and
                    $v.PSObject.Properties['batch_id'] -and $v.batch_id -eq $BatchId) { $prop.Name }
            }
            foreach ($nid in @($toRemove)) {
                & $RemoveFromArr $sit 'linked_nodes' $nid
                if ($NodeIndex.ContainsKey($nid)) {
                    & $RemoveFromArr $NodeIndex[$nid] 'situation_refs' $sit.id
                    if ($NodePovKey.ContainsKey($nid)) { [void]$DirtyPovKeys.Add($NodePovKey[$nid]); [void]$PovTouched.Add($nid) }
                }
                $provMap.PSObject.Properties.Remove($nid)
                $Purged.Add("$($sit.id) -/- $nid")
                $SitDirty = $true
                [void]$SitTouched.Add($sit.id)
            }
            # Drop an emptied provenance map so purge restores the exact pre-WSB shape.
            if (@($provMap.PSObject.Properties).Count -eq 0) {
                $sit.PSObject.Properties.Remove('evidence_provenance')
            }
        }

        $result = [ordered]@{
            Mode = 'Purge'; LinksAdded = 0; LinksPurged = $Purged.Count
            SkippedAuthored = 0; SkippedExisting = 0; SkippedDangling = 0
            SituationsChanged = $SitTouched.Count; PovNodesChanged = $PovTouched.Count
            FilesWritten = @(); DryRun = [bool]$DryRun
        }
        Write-Host ''
        Write-Host "=== Add-SituationEvidenceLink -Purge (batch $BatchId) ===" -ForegroundColor Cyan
        Write-Host "  Machine links to remove: $($Purged.Count)" -ForegroundColor White
        Write-Host "  Situations changed:      $($SitTouched.Count)" -ForegroundColor White
        Write-Host "  POV nodes changed:       $($PovTouched.Count)" -ForegroundColor White
        if ($Purged.Count -gt 0) {
            foreach ($s in (@($Purged) | Select-Object -First 10)) { Write-Host "    $s" -ForegroundColor DarkGray }
        }
        $written = Save-WsbChanges -SitDirty:$SitDirty -DirtyPovKeys $DirtyPovKeys -SitData $SitData `
            -SitPath $SitPath -PovFiles $PovFiles -DryRun:$DryRun -ShouldProcessCmdlet $PSCmdlet -ActionLabel "Purge batch $BatchId"
        $result.FilesWritten = @($written)
        Write-Host ''
        return [PSCustomObject]$result
    }

    # ══ APPLY: consume the proposal ══
    if (-not (Test-Path -LiteralPath $ProposalPath)) {
        New-ActionableError `
            -Goal 'Commit situation evidence links' `
            -Problem "proposal JSON not found at $ProposalPath" `
            -Location 'Add-SituationEvidenceLink' `
            -NextSteps 'Pass -ProposalPath to the Stage-1 proposal JSON (research/comp-linguist/analyses/situation-evidence/proposal.json).' `
            -Throw
    }
    $Proposal = Get-Content -Raw -LiteralPath $ProposalPath | ConvertFrom-Json
    $Proposal = @($Proposal)

    $GeneratedAt     = (Get-Date).ToUniversalTime().ToString('o')
    $Added           = [System.Collections.Generic.List[string]]::new()
    $SkippedAuthored = 0
    $SkippedExisting = 0
    $SkippedDangling = 0

    foreach ($link in $Proposal) {
        foreach ($f in 'situation_id', 'node_id', 'camp', 'score', 'rank') {
            if (-not $link.PSObject.Properties[$f]) {
                New-ActionableError `
                    -Goal 'Commit situation evidence links' `
                    -Problem "proposal entry is missing required field '$f': $($link | ConvertTo-Json -Compress -Depth 5)" `
                    -Location 'Add-SituationEvidenceLink' `
                    -NextSteps 'Regenerate the proposal via Stage-1 propose_links.py; the contract is [{situation_id, camp, node_id, score, rank}].' `
                    -Throw
            }
        }
        $sitId = [string]$link.situation_id
        $nodeId = [string]$link.node_id

        # Endpoint existence (both must exist; a dangling endpoint is skipped, mirror reciprocity).
        if (-not $SitIndex.ContainsKey($sitId) -or -not $NodeIndex.ContainsKey($nodeId)) {
            $SkippedDangling++
            continue
        }
        $sit  = $SitIndex[$sitId]
        $node = $NodeIndex[$nodeId]

        $prov = & $GetProv $sit $nodeId
        if (& $IsMachineProv $prov) {
            # Already a machine link (any batch) — idempotent skip; never double-stamp.
            $SkippedExisting++
            continue
        }
        $linkedHas = (@(& $GetArr $sit 'linked_nodes')  -contains $nodeId)
        $refsHas   = (@(& $GetArr $node 'situation_refs') -contains $sitId)
        if ($linkedHas -or $refsHas) {
            # Present without a machine stamp -> AUTHORED. Never overwrite/duplicate/stamp-over.
            $SkippedAuthored++
            continue
        }

        # ── Commit the machine link, both directions + provenance stamp ──
        if (-not $linkedHas) { & $AddToArr $sit 'linked_nodes' $nodeId }
        if (-not $refsHas)   { & $AddToArr $node 'situation_refs' $sitId }

        if (-not ($sit.PSObject.Properties['evidence_provenance'] -and $null -ne $sit.evidence_provenance)) {
            Add-Member -InputObject $sit -NotePropertyName 'evidence_provenance' -NotePropertyValue ([PSCustomObject]@{}) -Force
        }
        $provEntry = [PSCustomObject][ordered]@{
            origin       = 'machine'
            method       = 'embedding-cosine-topN'
            model        = 'all-MiniLM-L6-v2'  # model-lint:allow-pin embedding model (sentence-transformers), not an ai-models.json LLM backend
            score        = $link.score
            rank         = $link.rank
            batch_id     = $BatchId
            generated_at = $GeneratedAt
        }
        Add-Member -InputObject $sit.evidence_provenance -NotePropertyName $nodeId -NotePropertyValue $provEntry -Force

        $Added.Add("$sitId -> $nodeId (rank $($link.rank), score $($link.score))")
        $SitDirty = $true
        [void]$SitTouched.Add($sitId)
        [void]$DirtyPovKeys.Add($NodePovKey[$nodeId])
        [void]$PovTouched.Add($nodeId)
    }

    # ── Report ──
    Write-Host ''
    Write-Host "=== Add-SituationEvidenceLink (batch $BatchId) ===" -ForegroundColor Cyan
    Write-Host "  Proposal links:      $($Proposal.Count)" -ForegroundColor White
    Write-Host "  Links to add:        $($Added.Count)" -ForegroundColor White
    Write-Host "  Skipped (authored):  $SkippedAuthored" -ForegroundColor DarkGray
    Write-Host "  Skipped (existing):  $SkippedExisting" -ForegroundColor DarkGray
    Write-Host "  Skipped (dangling):  $SkippedDangling" -ForegroundColor DarkGray
    Write-Host "  Situations changed:  $($SitTouched.Count)" -ForegroundColor White
    Write-Host "  POV nodes changed:   $($PovTouched.Count)" -ForegroundColor White
    if ($Added.Count -gt 0) {
        foreach ($s in (@($Added) | Select-Object -First 10)) { Write-Host "    $s" -ForegroundColor DarkGray }
    }

    $written = Save-WsbChanges -SitDirty:$SitDirty -DirtyPovKeys $DirtyPovKeys -SitData $SitData `
        -SitPath $SitPath -PovFiles $PovFiles -DryRun:$DryRun -ShouldProcessCmdlet $PSCmdlet -ActionLabel "Commit $($Added.Count) evidence link(s), batch $BatchId"
    Write-Host ''

    [PSCustomObject]@{
        Mode              = 'Apply'
        LinksAdded        = $Added.Count
        LinksPurged       = 0
        SkippedAuthored   = $SkippedAuthored
        SkippedExisting   = $SkippedExisting
        SkippedDangling   = $SkippedDangling
        SituationsChanged = $SitTouched.Count
        PovNodesChanged   = $PovTouched.Count
        FilesWritten      = @($written)
        DryRun            = [bool]$DryRun
    }
}
