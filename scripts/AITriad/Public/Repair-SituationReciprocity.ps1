# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Repair-SituationReciprocity {
    <#
    .SYNOPSIS
        Reconcile situation `linked_nodes` <-> POV-node `situation_refs` so the two directions are
        MUTUAL (t/2979). A RECOVERY tool — run with -DryRun first.
    .DESCRIPTION
        `linked_nodes` (situation -> POV node) and `situation_refs` (POV node -> situation) are two
        representations of the SAME hand-authored links, but nothing ever kept them in sync, so they
        drifted — evidence authored on one side is invisible on the other (the t/2979 root cause; the
        UI reads only `linked_nodes`). This cmdlet unions both directions: for each link present on
        ONE side whose OTHER endpoint exists, it adds the missing back-ref on the other side. It
        reconciles two views of the SAME authored links; it invents no evidence.

        RECOVERY-OP CAVEAT (TL t/2979#7 — read before running): a union CANNOT distinguish a
        drifted-but-authored link from a half-DELETED one. If a curator intentionally removed one
        side of a link, this would resurrect it. So it is a deliberate, DRY-RUN-FIRST recovery tool,
        NOT routine auto-repair. (The current ~7-situation drift is entirely additive — nothing was
        deleted — so union is correct today; confirm the -DryRun report before writing.)

        Only links whose BOTH endpoints exist are reconciled. A ref to a non-existent node/situation
        is a DANGLING ref (fix it with `Test-TaxonomyIntegrity -Repair`, which prunes) — this cmdlet
        never reconciles a dangling ref into existence.

        Writes `situations.json` (BLOCK-tier) and any changed POV camp files. It requires a CLEAN
        working tree (writes go through Write-Utf8NoBom -RequireCleanTree; there is no -AllowDirty).
        A pre-flight aborts, writing nothing, if any target file is already dirty. It does NOT commit
        or push — landing the reconciled data in ai-triad-data is a separate human step.

        Pairs with the `Test-TaxonomyIntegrity` reciprocity check (Check 10, t/2979), which flags any
        future drift so the two directions stay mutual.
    .PARAMETER DryRun
        Report what WOULD be reconciled (forward/reverse counts + samples) and make NO writes.
    .PARAMETER RepoRoot
        Repository root containing taxonomy/Origin. Defaults to the module-resolved data root.
    .OUTPUTS
        [PSCustomObject] summary: ForwardAdded, ReverseAdded, SituationsChanged, PovNodesChanged, FilesWritten, DryRun.
    .EXAMPLE
        Repair-SituationReciprocity -DryRun
        # Preview the reconciliation (always do this first).
    .EXAMPLE
        Repair-SituationReciprocity
        # Apply on a clean tree; then a human reviews the diff and pushes ai-triad-data.
    .LINK
        Test-TaxonomyIntegrity
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [switch]$DryRun,
        [string]$RepoRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $TaxDir  = if ($RepoRoot) { Join-Path $RepoRoot 'taxonomy/Origin' } else { Get-TaxonomyDir }
    $PovKeys = @('accelerationist', 'safetyist', 'skeptic')
    $SitPath = Join-Path $TaxDir 'situations.json'

    if (-not (Test-Path -LiteralPath $SitPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Reconcile situation <-> POV reciprocity' `
            -Problem "situations.json not found at $SitPath" `
            -Location 'Repair-SituationReciprocity' `
            -NextSteps 'Verify the data root (Get-TaxonomyDir) or pass -RepoRoot to the repo containing taxonomy/Origin/situations.json.')
    }

    # ── Load ──
    $SitData = Read-PovTaxonomyFile -Path $SitPath   # shape-preserving read for the canonical write (t/4356)
    $PovFiles  = @{}                                 # povKey -> @{ Path; Data }
    $NodeIndex = @{}                                 # POV node id -> node object
    $NodePovKey = @{}                                # POV node id -> its povKey (which file to mark dirty)
    foreach ($k in $PovKeys) {
        $p = Join-Path $TaxDir "$k.json"
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $d = Read-PovTaxonomyFile -Path $p
        $PovFiles[$k] = @{ Path = $p; Data = $d }
        foreach ($n in @($d.nodes)) { $NodeIndex[$n.id] = $n; $NodePovKey[$n.id] = $k }
    }

    # Situation id -> node object, and the set of situation ids.
    $SitIndex = @{}
    foreach ($s in @($SitData.nodes)) { $SitIndex[$s.id] = $s }

    $Helpers = {
        param($Node, $Field)   # return the field's array (guarded), or @()
        if ($Node.PSObject.Properties[$Field] -and $null -ne $Node.$Field) { return @($Node.$Field) }
        return @()
    }
    $AddRef = {
        param($Node, $Field, $Value)   # append $Value to $Node.$Field (array), creating the field if absent
        $cur = & $Helpers $Node $Field
        $new = @($cur) + $Value
        if ($Node.PSObject.Properties[$Field]) { $Node.$Field = $new }
        else { Add-Member -InputObject $Node -NotePropertyName $Field -NotePropertyValue $new -Force }
    }

    $ForwardAdded = [System.Collections.Generic.List[string]]::new()   # POV node gained situation_ref
    $ReverseAdded = [System.Collections.Generic.List[string]]::new()   # situation gained linked_node
    $DirtyPovKeys = [System.Collections.Generic.HashSet[string]]::new()
    $SitDirty = $false

    # ── Forward: situation.linked_nodes -> ensure POV node.situation_refs contains the situation ──
    foreach ($sit in @($SitData.nodes)) {
        foreach ($nid in (& $Helpers $sit 'linked_nodes')) {
            if (-not $NodeIndex.ContainsKey($nid)) { continue }   # not a POV node / dangling -> Test-TaxonomyIntegrity -Repair
            $node = $NodeIndex[$nid]
            $refs = & $Helpers $node 'situation_refs'
            if ($refs -notcontains $sit.id) {
                & $AddRef $node 'situation_refs' $sit.id
                $ForwardAdded.Add("$nid += situation_ref $($sit.id)")
                if ($NodePovKey.ContainsKey($nid)) { [void]$DirtyPovKeys.Add($NodePovKey[$nid]) }
            }
        }
    }

    # ── Reverse: POV node.situation_refs -> ensure situation.linked_nodes contains the node ──
    foreach ($k in $PovKeys) {
        if (-not $PovFiles.ContainsKey($k)) { continue }
        foreach ($node in @($PovFiles[$k].Data.nodes)) {
            foreach ($sref in (& $Helpers $node 'situation_refs')) {
                if (-not $SitIndex.ContainsKey($sref)) { continue }   # dangling situation_ref -> Test-TaxonomyIntegrity -Repair
                $sit = $SitIndex[$sref]
                $linked = & $Helpers $sit 'linked_nodes'
                if ($linked -notcontains $node.id) {
                    & $AddRef $sit 'linked_nodes' $node.id
                    $ReverseAdded.Add("$sref += linked_node $($node.id)")
                    $SitDirty = $true
                }
            }
        }
    }

    $SituationsChanged = @($ReverseAdded | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object -Unique).Count
    $PovNodesChanged   = @($ForwardAdded | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object -Unique).Count
    $TotalAdds = $ForwardAdded.Count + $ReverseAdded.Count

    # ── Report ──
    Write-Host ''
    Write-Host '=== Situation <-> POV reciprocity reconciliation ===' -ForegroundColor Cyan
    Write-Host "  Forward (POV node += situation_ref): $($ForwardAdded.Count)" -ForegroundColor White
    Write-Host "  Reverse (situation += linked_node):  $($ReverseAdded.Count)" -ForegroundColor White
    Write-Host "  Situations changed:                  $SituationsChanged" -ForegroundColor White
    Write-Host "  POV nodes changed:                   $PovNodesChanged" -ForegroundColor White
    if ($TotalAdds -gt 0) {
        Write-Host '  Sample:' -ForegroundColor DarkGray
        foreach ($s in (@($ForwardAdded) + @($ReverseAdded) | Select-Object -First 10)) { Write-Host "    $s" -ForegroundColor DarkGray }
    }

    $FilesWritten = [System.Collections.Generic.List[string]]::new()

    if ($TotalAdds -eq 0) {
        Write-Host '  Already reciprocal — nothing to reconcile.' -ForegroundColor Green
    }
    elseif ($DryRun) {
        Write-Host ''
        Write-Host "  DRY RUN — no writes. Would reconcile $TotalAdds link(s) across $(($DirtyPovKeys.Count) + $(if ($SitDirty) { 1 } else { 0 })) file(s)." -ForegroundColor Yellow
    }
    else {
        # Pre-flight: require a CLEAN tree for every target BEFORE writing any (BLOCK-tier situations.json;
        # no -AllowDirty, TL t/2979#7). Abort atomically — write nothing — if any target is dirty.
        $Targets = [System.Collections.Generic.List[string]]::new()
        if ($SitDirty) { $Targets.Add($SitPath) }
        foreach ($k in $DirtyPovKeys) { $Targets.Add($PovFiles[$k].Path) }

        $DirtyTargets = @()
        if (Get-Command Assert-CleanDataTree -ErrorAction SilentlyContinue) {
            foreach ($t in $Targets) {
                try { Assert-CleanDataTree -Path $t } catch { $DirtyTargets += (Split-Path -Leaf $t) }
            }
        }
        if ($DirtyTargets.Count -gt 0) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Reconcile situation <-> POV reciprocity' `
                -Problem "target file(s) already have uncommitted changes: $($DirtyTargets -join ', '). A whole-file rewrite would sweep that concurrent state into your commit (situations.json is BLOCK-tier); nothing was written." `
                -Location 'Repair-SituationReciprocity' `
                -NextSteps 'Commit or stash the working-tree changes to these files first (clean-tree-required), then re-run. Use -DryRun to preview without writing.')
        }

        if ($SitDirty) {
            if ($PSCmdlet.ShouldProcess($SitPath, "Reconcile $($ReverseAdded.Count) linked_node(s)")) {
                Write-PovTaxonomyFile -Path $SitPath -Data $SitData -RequireCleanTree   # canonical TS format (t/4356)
                $FilesWritten.Add($SitPath)
                Write-Host "  Wrote $(Split-Path -Leaf $SitPath)" -ForegroundColor Green
            }
        }
        foreach ($k in $DirtyPovKeys) {
            $entry = $PovFiles[$k]
            if ($PSCmdlet.ShouldProcess($entry.Path, 'Reconcile situation_ref(s)')) {
                Write-PovTaxonomyFile -Path $entry.Path -Data $entry.Data -RequireCleanTree
                $FilesWritten.Add($entry.Path)
                Write-Host "  Wrote $(Split-Path -Leaf $entry.Path)" -ForegroundColor Green
            }
        }
        Write-Host ''
        Write-Host '  Reconciled. Review the diff and push ai-triad-data (this cmdlet does not commit/push).' -ForegroundColor Cyan
    }
    Write-Host ''

    [PSCustomObject]@{
        ForwardAdded      = $ForwardAdded.Count
        ReverseAdded      = $ReverseAdded.Count
        SituationsChanged = $SituationsChanged
        PovNodesChanged   = $PovNodesChanged
        FilesWritten      = @($FilesWritten)
        DryRun            = [bool]$DryRun
    }
}
