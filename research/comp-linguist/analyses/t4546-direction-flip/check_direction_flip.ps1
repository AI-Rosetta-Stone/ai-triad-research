<#
.SYNOPSIS
    t/4546 ask #1 (reproduce): lists every proposal where the live directional
    gate's EdgeType disagrees with the frozen snapshot's type in
    ../t4475-org-r2/proposals.json, with the deciding rep claim, the directional
    gate's verdict (confidence = NLI top1/top2 margin) and the tau_contra
    threshold that fired it.
.DESCRIPTION
    Same safe pattern as ../t4475-org-r2/check_endorsement.ps1: re-runs
    Invoke-OrgClaimMatching dry-run against the live corpus and joins back to
    proposals.json by (org, node) only, not type -- the type is exactly what
    we're checking for drift on, so joining on it would hide every flip.
    Read-only: -WriteProposals is never passed. -Force is passed because the 29
    frozen proposals are already status=proposed in organization_edges.json;
    without it the existing-edge skip excludes every one of them first.
.EXAMPLE
    pwsh -File check_direction_flip.ps1
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dataRoot = $env:AI_TRIAD_DATA_ROOT
if (-not $dataRoot) { $dataRoot = (Resolve-Path (Join-Path $here '..' '..' '..' '..' '..' 'ai-triad-data')).Path }

Import-Module (Join-Path $here '..' '..' '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

$frozenPath = Join-Path $here '..' 't4475-org-r2' 'proposals.json'
$labelsPath = Join-Path $here '..' 't4475-org-r2' 'labels.json'
$frozen = Get-Content $frozenPath -Raw | ConvertFrom-Json
$labels = Get-Content $labelsPath -Raw | ConvertFrom-Json

$frozenByKey = @{}
foreach ($p in $frozen) { $frozenByKey["$($p.source)::$($p.target)"] = $p }

$claimsPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'organization_stance_claims.json'
$embPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'embeddings-orgstance-6733.json'

Write-Host "Claims:     $claimsPath"
Write-Host "Embeddings: $embPath"
Write-Host "tau_contra (default, CL FINAL t/2751#3): 1.0"
Write-Host ''

$result = Invoke-OrgClaimMatching -ClaimsPath $claimsPath -EmbeddingsPath $embPath -PerOrgCap 100 -Force -SkipEndorsementGate 6>$null

$rows = [System.Collections.Generic.List[object]]::new()
foreach ($prop in @($result.Proposals)) {
    $key = "$($prop.OrgId)::$($prop.NodeId)"
    if (-not $frozenByKey.ContainsKey($key)) { continue }
    $old = $frozenByKey[$key]
    if ([string]$old.type -eq [string]$prop.EdgeType) { continue }   # not a flip
    $label = if ($labels.PSObject.Properties[$old.id]) { [string]$labels.($old.id) } else { $null }
    $decidingRep = if ($prop.Direction -eq 'opposes' -and @($prop.RepReps).Count -gt 0) {
        # The gate is opposes-if-ANY; RepProp is the highest-cosine rep's text,
        # which is the first rep judged (t/2744#10 verbatim-first ordering) and in
        # every flip observed here is also the one that fired -- reported as the
        # deciding rep. (DirConfidence is already the WINNING opposing rep's margin.)
        [string]$prop.RepProp
    } else { [string]$prop.RepProp }
    $rows.Add([PSCustomObject]@{
        Id          = $old.id
        Org         = $prop.OrgId
        Node        = $prop.NodeId
        Label       = $label
        OldType     = [string]$old.type
        NewType     = [string]$prop.EdgeType
        NliDirection = $prop.Direction
        NliMargin   = $prop.DirConfidence
        NliMethod   = $prop.DirMethod
        DecidingRep = $decidingRep
    })
}

Write-Host "Live run produced $($result.Proposals.Count) proposals; $($rows.Count) of the 29 frozen entries flip type (matched by org+node, old type ignored by design)."
Write-Host ''
Write-Host '=== Flips (old type -> new type), with the deciding rep and NLI margin ==='
foreach ($row in ($rows | Sort-Object Id)) {
    Write-Host "$($row.Id) [$($row.Org) -> $($row.Node)] label=$($row.Label)  $($row.OldType) -> $($row.NewType)  nli_direction=$($row.NliDirection) margin=$($row.NliMargin) (tau_contra=1.0) method=$($row.NliMethod)"
    Write-Host "    rep: $($row.DecidingRep)"
}

$rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $here 'flips.json') -Encoding utf8
Write-Host ''
Write-Host "Wrote $($rows.Count) rows to flips.json"
