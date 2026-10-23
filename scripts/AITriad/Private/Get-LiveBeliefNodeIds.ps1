# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-LiveBeliefNodeIds {
    <#
    .SYNOPSIS
        The belief-node id sets shared by Build-NodeSourceIndex and Test-CitationLinkIntegrity leg-c
        (t/4441, SO C4 for the t/4147 leg-c promotion). One function, so the builder and the gate can't drift.
    .DESCRIPTION
        Reads accelerationist/safetyist/skeptic.json under -TaxonomyDir. A missing POV file THROWS: a blocking
        gate must fail closed (CL t/4441 item 2), and the builder already threw.
        Superseded nodes (t/4278 C1, mirrors the TS load boundary via New-TaxonomySupersessionIndex):
          - Live: the source-index keys = every node's RESOLVED id. A superseded node with a survivor is not a key
            (its links fold onto the survivor); a cycle member or a dangling chain resolves to itself and stays a
            key (t/4278 C6).
          - All: every stored id, superseded included. A summary that cites a node later superseded still cites
            a known node (leg a), so validity checks use All, not Live.
          - ResolveMap: superseded id -> survivor id, only for ids that resolve elsewhere. The builder maps a
            link's node through it before the Live check.
    .OUTPUTS
        [pscustomobject] @{ Live; All; ResolveMap } (HashSet[string], HashSet[string], Dictionary[string,string]).
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$TaxonomyDir,
        [string]$Caller = 'Get-LiveBeliefNodeIds'
    )
    Set-StrictMode -Version Latest

    $nodes = [System.Collections.Generic.List[object]]::new()
    foreach ($f in @('accelerationist.json', 'safetyist.json', 'skeptic.json')) {
        $p = Join-Path $TaxonomyDir $f
        if (-not (Test-Path -LiteralPath $p)) {
            throw (New-ActionableError -PassThru `
                -Goal 'Load the live belief-node ids' `
                -Problem "POV node file not found: $p" `
                -Location $Caller `
                -NextSteps @('Confirm the taxonomy dir (Get-TaxonomyDir) holds the three POV files', 'A missing POV file fails closed: the node-source gate cannot judge a partial node set'))
        }
        $doc = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json
        if ($doc.PSObject.Properties['nodes']) {
            foreach ($n in @($doc.nodes)) { if ($n -and $n.PSObject.Properties['id'] -and $n.id) { $nodes.Add($n) } }
        }
    }

    $idx = New-TaxonomySupersessionIndex -Nodes $nodes.ToArray()
    $all = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $live = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $map = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($n in $nodes) {
        $id = [string]$n.id
        [void]$all.Add($id)
        $resolved = [string](Resolve-TaxonomyNode -Index $idx -Id $id).id
        [void]$live.Add($resolved)
        if ($resolved -cne $id) { $map[$id] = $resolved }
    }
    [pscustomobject]@{ Live = $live; All = $all; ResolveMap = $map }
}
