<#
.SYNOPSIS
    t/4523 acceptance check: runs the endorsement-confirmation gate against the
    29 labelled proposals in labels.json (CL's precision estimate, t/4475) and
    reports the confusion table against the ticket's bar: >= 12/13 Y/P tagged
    endorses|partial, >= 10/16 N tagged none.
.DESCRIPTION
    Re-runs Invoke-OrgClaimMatching dry-run against the live corpus
    (organization_stance_claims.json + embeddings-orgstance-6733.json) and
    joins its Proposals output back to proposals.json by (source, target) —
    ORG AND NODE ONLY, not type. The directional gate (on by default, and run
    against the real NLI engine for the first time since proposals.json was
    frozen) flips the ADVOCATES_FOR/OPPOSES type on 19 of the 29 entries today
    — a separate, real finding about the directional gate's own stability,
    out of scope for t/4523. The endorsement label is about whether the claim
    asserts the node's proposition at all, which the type flip does not
    change, so (org, node) is the correct join key for THIS check. Matching
    on (source, target, type) instead silently drops to 10/29 matched and
    produces no result for this gate.

    Real AI calls (gemini-3.5-flash-lite), ~29-60 cheap calls. Read-only:
    -WriteProposals is never passed, so nothing in the data repo is touched.
    -Force is passed because the 29 frozen proposals are already written as
    status=proposed in organization_edges.json — without it the existing-edge
    skip excludes every one of them before comparison ever happens.
.EXAMPLE
    pwsh -File check_endorsement.ps1
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dataRoot = $env:AI_TRIAD_DATA_ROOT
if (-not $dataRoot) { $dataRoot = (Resolve-Path (Join-Path $here '..' '..' '..' '..' '..' 'ai-triad-data')).Path }

Import-Module (Join-Path $here '..' '..' '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

$proposals = Get-Content (Join-Path $here 'proposals.json') -Raw | ConvertFrom-Json
$labels = Get-Content (Join-Path $here 'labels.json') -Raw | ConvertFrom-Json

$keyToId = @{}
foreach ($p in $proposals) {
    $key = "$($p.source)::$($p.target)"
    $keyToId[$key] = $p.id
}

$claimsPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'organization_stance_claims.json'
$embPath = Join-Path $dataRoot 'taxonomy' 'Origin' 'embeddings-orgstance-6733.json'

Write-Host "Claims:     $claimsPath"
Write-Host "Embeddings: $embPath"
Write-Host ''

# -Force: the 29 frozen proposals are already written as status=proposed in
# organization_edges.json, so without -Force the existing-edge skip excludes
# every one of them from this run's output before comparison ever happens.
$result = Invoke-OrgClaimMatching -ClaimsPath $claimsPath -EmbeddingsPath $embPath -PerOrgCap 100 -Force 6>$null

$matched = 0
$unmatched = 0
$rows = [System.Collections.Generic.List[object]]::new()
foreach ($prop in @($result.Proposals)) {
    $key = "$($prop.OrgId)::$($prop.NodeId)"
    if ($keyToId.ContainsKey($key)) {
        $matched++
        $id = $keyToId[$key]
        $label = if ($labels.PSObject.Properties[$id]) { [string]$labels.$id } else { $null }
        $rows.Add([PSCustomObject]@{ Id = $id; Label = $label; Endorsement = $prop.Endorsement; EdgeType = $prop.EdgeType })
    } else {
        $unmatched++
    }
}
Write-Host "Live run produced $($result.Proposals.Count) proposals; matched $matched of the 29 frozen snapshot entries by (org, node); $unmatched live proposals are new since the snapshot."
$missingFromLive = @($proposals.id) | Where-Object { $_ -notin @($rows.Id) }
if (@($missingFromLive).Count -gt 0) {
    Write-Host "Frozen entries NOT reproduced by the live run (corpus drift, excluded below): $($missingFromLive -join ', ')"
}
Write-Host ''

function Tally([object[]]$Set) {
    $ok = @($Set | Where-Object { $_.Endorsement -in @('endorses', 'partial') }).Count
    $none = @($Set | Where-Object { $_.Endorsement -eq 'none' }).Count
    $unk = @($Set | Where-Object { $_.Endorsement -eq 'unknown' }).Count
    [PSCustomObject]@{ N = @($Set).Count; EndorsesOrPartial = $ok; None = $none; Unknown = $unk }
}

$yp = @($rows | Where-Object { $_.Label -in @('Y', 'P') })
$n = @($rows | Where-Object { $_.Label -eq 'N' })

Write-Host '=== Confusion table (full 29, modulo corpus drift) ==='
Write-Host "Y/P (n=$($yp.Count)): $(Tally $yp | Out-String)"
Write-Host "N   (n=$($n.Count)): $(Tally $n | Out-String)"

$ypNoO25 = @($yp | Where-Object { $_.Id -ne 'O25' })
$nNoO25 = @($n | Where-Object { $_.Id -ne 'O25' })
Write-Host '=== Confusion table, excluding O25 (the in-sample worked example) ==='
Write-Host "Y/P (n=$($ypNoO25.Count)): $(Tally $ypNoO25 | Out-String)"
Write-Host "N   (n=$($nNoO25.Count)): $(Tally $nNoO25 | Out-String)"

Write-Host '=== Per-item detail ==='
$rows | Sort-Object Id | Format-Table Id, Label, Endorsement -AutoSize | Out-String | Write-Host
